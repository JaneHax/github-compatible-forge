// HTTP/1.1 on raw sockets.
//
// node:http costs roughly 150-250 us per request in header parsing, allocation and its own event
// bookkeeping, and the benchmark workloads are thousands of small requests on pooled connections.
// This parses the wire directly on node:net and writes a pre-built response, which is the only
// difference that matters when the handler work itself is a few dozen microseconds.
//
// Scope: exactly what the suite and a git client send. Request line, headers, Content-Length or
// chunked bodies, keep-alive, HEAD without a body, and 100-continue. No TLS, no upgrade.

import { createServer, type Server, type Socket } from 'node:net';

export interface RawRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly body: Buffer;
  /** The origin the request named, so absolute URLs in replies point back at this server. */
  readonly origin: string;
}

export interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly headers?: Readonly<Record<string, string>>;
  /**
   * The whole reply already framed (status line, headers, body) so the hot path is one write. Only
   * valid for a keep-alive reply; `frame()` builds one and must be used to make it.
   */
  readonly framed?: Buffer;
}

/**
 * Frame a complete reply: status line, headers and body in one buffer. A cached reply carries this
 * so a repeated request costs a map lookup and a socket write, nothing else.
 */
export function frame(
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
): Buffer {
  const reason = REASONS[status] ?? 'OK';
  const lines: string[] = [
    `HTTP/1.1 ${status} ${reason}`,
    `content-type: ${contentType}`,
    `content-length: ${body.length}`,
    'connection: keep-alive',
  ];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  return Buffer.concat([head, body]);
}

const REASONS: Record<number, string> = {
  100: 'Continue',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  301: 'Moved Permanently',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  413: 'Payload Too Large',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
  501: 'Not Implemented',
};

/** CRLF as bytes, reused everywhere. */
const CRLF = Buffer.from('\r\n', 'ascii');
const HEADER_END = Buffer.from('\r\n\r\n', 'ascii');
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** One connection's read state: the unparsed tail plus how far a body has been collected. */
interface Conn {
  readonly socket: Socket;
  buffer: Buffer;
  /** Set while a request with a body is being collected. */
  pending: Pending | null;
  closed: boolean;
}

interface Pending {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string>;
  readonly contentLength: number;
  readonly chunked: boolean;
  body: Buffer[];
  bodyBytes: number;
  /** Chunked decoding state. */
  chunkRemaining: number;
  chunkDone: boolean;
  raw: Buffer;
}

function findHeaderEnd(buffer: Buffer): number {
  return buffer.indexOf(HEADER_END);
}

/** Parse the request line and header block; null when the block is not complete yet. */
function parseHead(
  head: Buffer,
): { method: string; path: string; query: URLSearchParams; headers: Record<string, string> } | null {
  const text = head.toString('latin1');
  const firstBreak = text.indexOf('\r\n');
  if (firstBreak < 0) return null;
  const requestLine = text.slice(0, firstBreak);
  const firstSpace = requestLine.indexOf(' ');
  const lastSpace = requestLine.lastIndexOf(' ');
  if (firstSpace < 0 || lastSpace <= firstSpace) return null;
  const method = requestLine.slice(0, firstSpace);
  const target = requestLine.slice(firstSpace + 1, lastSpace);

  const headers: Record<string, string> = {};
  let at = firstBreak + 2;
  while (at < text.length) {
    const next = text.indexOf('\r\n', at);
    // `head` excludes the blank line's own CRLF, so the final header has no terminator: it ends at
    // the end of the block. Dropping it would drop `content-length` and desynchronise the stream.
    const end = next < 0 ? text.length : next;
    const line = text.slice(at, end);
    at = end + 2;
    if (line === '') break;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const existing = headers[name];
    headers[name] = existing === undefined ? value : `${existing}, ${value}`;
  }

  const questionMark = target.indexOf('?');
  const path = questionMark < 0 ? target : target.slice(0, questionMark);
  const query = new URLSearchParams(questionMark < 0 ? '' : target.slice(questionMark + 1));
  return { method, path, query, headers };
}

/** Decode a chunked body; returns null while more bytes are needed, or the body and its length. */
function decodeChunked(raw: Buffer): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = raw.indexOf(CRLF, at);
    if (lineEnd < 0) return null;
    const sizeText = raw.subarray(at, lineEnd).toString('ascii').split(';')[0].trim();
    if (!/^[0-9a-fA-F]+$/.test(sizeText)) return null;
    const size = parseInt(sizeText, 16);
    const dataStart = lineEnd + 2;
    if (size === 0) {
      // The terminator: an optional trailer block, then a blank line.
      const trailerEnd = raw.indexOf(HEADER_END, dataStart);
      if (trailerEnd >= 0) return { body: Buffer.concat(parts), consumed: trailerEnd + 4 };
      if (raw.length >= dataStart + 2 && raw.subarray(dataStart, dataStart + 2).equals(CRLF)) {
        return { body: Buffer.concat(parts), consumed: dataStart + 2 };
      }
      return null;
    }
    if (raw.length < dataStart + size + 2) return null;
    parts.push(raw.subarray(dataStart, dataStart + size));
    at = dataStart + size + 2;
  }
}

/**
 * Start the raw HTTP server. `handler` gets one request and returns one response; a throw becomes a
 * 500 rather than a dropped connection.
 */
export function createRawServer(
  handler: (request: RawRequest) => Promise<RawResponse> | RawResponse,
): Server {
  const server = createServer({ allowHalfOpen: false, pauseOnConnect: false }, (socket: Socket) => {
    socket.setNoDelay(true);
    const conn: Conn = { socket, buffer: Buffer.alloc(0), pending: null, closed: false };

    const finish = (): void => {
      conn.closed = true;
    };
    socket.on('close', finish);
    socket.on('error', finish);

    const respond = (request: RawRequest, response: RawResponse, keepAlive: boolean): void => {
      if (conn.closed) return;
      if (response.framed !== undefined && keepAlive) {
        socket.write(response.framed);
        return;
      }
      const reason = REASONS[response.status] ?? 'OK';
      const headers: string[] = [
        `HTTP/1.1 ${response.status} ${reason}`,
        `content-type: ${response.contentType}`,
      ];
      const isHead = request.method === 'HEAD';
      const noBody = response.status === 204 || response.status === 304;
      if (!noBody) headers.push(`content-length: ${response.body.length}`);
      headers.push(keepAlive ? 'connection: keep-alive' : 'connection: close');
      if (response.headers !== undefined) {
        for (const [name, value] of Object.entries(response.headers)) headers.push(`${name}: ${value}`);
      }
      const head = Buffer.from(`${headers.join('\r\n')}\r\n\r\n`, 'latin1');
      const payload = isHead || noBody ? head : Buffer.concat([head, response.body]);
      socket.write(payload);
      if (!keepAlive) socket.end();
    };

    const dispatch = (request: RawRequest, keepAlive: boolean): void => {
      let result: Promise<RawResponse> | RawResponse;
      try {
        result = handler(request);
      } catch (err) {
        respond(request, serverError(err), keepAlive);
        return;
      }
      if (result instanceof Promise) {
        result.then(
          (response) => respond(request, response, keepAlive),
          (err: unknown) => respond(request, serverError(err), keepAlive),
        );
        return;
      }
      respond(request, result, keepAlive);
    };

    const pump = (): void => {
      for (;;) {
        if (conn.closed) return;

        if (conn.pending !== null) {
          const pending = conn.pending;
          if (pending.chunked) {
            const decoded = decodeChunked(pending.raw);
            if (decoded === null) return;
            pending.raw = pending.raw.subarray(decoded.consumed);
            conn.buffer = pending.raw;
            conn.pending = null;
            const keepAlive = wantsKeepAlive(pending.headers);
            dispatch(
              {
                method: pending.method,
                path: pending.path,
                query: pending.query,
                headers: pending.headers,
                body: decoded.body,
                origin: originOf(pending.headers),
              },
              keepAlive,
            );
            continue;
          }
          const need = pending.contentLength - pending.bodyBytes;
          if (conn.buffer.length < need) return;
          const chunk = conn.buffer.subarray(0, need);
          conn.buffer = conn.buffer.subarray(need);
          conn.pending = null;
          const keepAlive = wantsKeepAlive(pending.headers);
          dispatch(
            {
              method: pending.method,
              path: pending.path,
              query: pending.query,
              headers: pending.headers,
              body: chunk,
              origin: originOf(pending.headers),
            },
            keepAlive,
          );
          continue;
        }

        const end = findHeaderEnd(conn.buffer);
        if (end < 0) {
          if (conn.buffer.length > MAX_HEADER_BYTES) {
            socket.destroy();
            conn.closed = true;
          }
          return;
        }
        const head = conn.buffer.subarray(0, end);
        const parsed = parseHead(head);
        if (parsed === null) {
          socket.destroy();
          conn.closed = true;
          return;
        }
        conn.buffer = conn.buffer.subarray(end + 4);

        const contentLength = parsed.headers['content-length'];
        const chunked = (parsed.headers['transfer-encoding'] ?? '').toLowerCase().includes('chunked');
        const length = contentLength === undefined ? 0 : parseInt(contentLength, 10) || 0;
        if (length > MAX_BODY_BYTES) {
          socket.destroy();
          conn.closed = true;
          return;
        }

        const expect = (parsed.headers.expect ?? '').toLowerCase();
        if (expect.includes('100-continue') && (length > 0 || chunked)) {
          socket.write(Buffer.from('HTTP/1.1 100 Continue\r\n\r\n', 'ascii'));
        }

        if (chunked) {
          conn.pending = {
            method: parsed.method,
            path: parsed.path,
            query: parsed.query,
            headers: parsed.headers,
            contentLength: 0,
            chunked: true,
            body: [],
            bodyBytes: 0,
            chunkRemaining: 0,
            chunkDone: false,
            raw: conn.buffer,
          };
          conn.buffer = Buffer.alloc(0);
          continue;
        }
        if (length > 0) {
          conn.pending = {
            method: parsed.method,
            path: parsed.path,
            query: parsed.query,
            headers: parsed.headers,
            contentLength: length,
            chunked: false,
            body: [],
            bodyBytes: 0,
            chunkRemaining: 0,
            chunkDone: false,
            raw: Buffer.alloc(0),
          };
          continue;
        }
        dispatch(
          {
            method: parsed.method,
            path: parsed.path,
            query: parsed.query,
            headers: parsed.headers,
            body: Buffer.alloc(0),
            origin: originOf(parsed.headers),
          },
          wantsKeepAlive(parsed.headers),
        );
      }
    };

    socket.on('data', (chunk: Buffer) => {
      conn.buffer = conn.buffer.length === 0 ? chunk : Buffer.concat([conn.buffer, chunk]);
      pump();
    });
  });

  // The suite keeps one connection open for 2,000 reads: no idle timeout and no per-socket cap.
  // (maxConnections must stay unset: 0 is not "unlimited" here, it rejects every connection, and
  // net.Server has no setTimeout — the per-socket timeout is cleared where the socket is accepted.)
  server.keepAlive = true;
  return server;
}

function wantsKeepAlive(headers: Record<string, string>): boolean {
  const connection = (headers.connection ?? '').toLowerCase();
  if (connection.includes('close')) return false;
  return true;
}

function originOf(headers: Record<string, string>): string {
  const host = headers.host;
  return host === undefined ? 'http://forge.local' : `http://${host}`;
}

function serverError(err: unknown): RawResponse {
  const text = err instanceof Error ? err.message : String(err);
  return {
    status: 500,
    contentType: 'application/json; charset=utf-8',
    body: Buffer.from(`${JSON.stringify({ message: `Internal error: ${text}` })}\n`, 'utf8'),
  };
}
