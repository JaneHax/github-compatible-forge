// The forge's HTTP surface: one process, one store, four protocols.
//
//   GET  /healthz                     the env's boot probe
//   *    /api/v3/...                  GitHub REST v3
//   POST /api/graphql                 GitHub GraphQL v4
//   POST /mcp                         Model Context Protocol
//   *    /{owner}/{repo}.git/...      git smart HTTP
//   *    anything else                JSON 404

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { gitInfoRefs, gitReceivePack, gitUploadPack, type GitReply } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestReply } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY = 128 * 1024 * 1024;
const EMPTY_BODY = Buffer.alloc(0);

const GIT_PATH = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/;

function bearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

function send(res: ServerResponse, status: number, contentType: string, body: Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, payload: unknown, headers: Record<string, string> = {}): void {
  send(res, status, JSON_TYPE, Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'), headers);
}

function sendGit(res: ServerResponse, reply: GitReply, headers: Record<string, string>): void {
  send(res, reply.status, reply.contentType, reply.body, { 'cache-control': 'no-cache', ...headers });
}

/**
 * The body, or an empty buffer when the request cannot carry one. Reading the request stream costs
 * an async iteration and a tick per request; the read and write benchmark workloads are thousands of
 * bodyless GETs, so the fast path is worth having.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  const method = req.method ?? 'GET';
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS' || method === 'DELETE') return Promise.resolve(EMPTY_BODY);
  const length = req.headers['content-length'];
  if (length === undefined && req.headers['transfer-encoding'] === undefined) return Promise.resolve(EMPTY_BODY);
  if (length === '0') return Promise.resolve(EMPTY_BODY);
  return readBodySlow(req);
}

async function readBodySlow(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, 'utf8');
    total += buffer.length;
    if (total > MAX_BODY) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function createApp(): Server {
  const store = new Store();
  let requestCounter = 0;
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      requestCounter += 1;
      const requestId = `makefun-${requestCounter}`;
      const requestHeaders: Record<string, string> = { 'x-github-request-id': requestId };
      const host = req.headers.host ?? 'forge.local';
      const origin = `http://${host}`;
      store.baseUrl = origin;

      let url: URL;
      try {
        url = new URL(req.url ?? '/', origin);
      } catch {
        sendJson(res, 404, { message: 'Not Found' }, requestHeaders);
        return;
      }
      const path = url.pathname;
      const token = bearer(req.headers.authorization);

      if (path === '/healthz') {
        sendJson(res, 200, { ok: true }, requestHeaders);
        return;
      }

      const git = GIT_PATH.exec(path);
      if (git !== null) {
        const owner = decodeURIComponent(git[1]);
        const repoName = decodeURIComponent(git[2]);
        const rest = git[3] ?? '';
        const wantsV2 = String(req.headers['git-protocol'] ?? '').toLowerCase().includes('version=2');
        if (rest === '/info/refs' && req.method === 'GET') {
          const service = url.searchParams.get('service') ?? '';
          sendGit(res, gitInfoRefs(store, owner, repoName, service, wantsV2), requestHeaders);
          return;
        }
        if (rest === '/git-upload-pack' && req.method === 'POST') {
          sendGit(res, gitUploadPack(store, owner, repoName, await readBody(req), wantsV2), requestHeaders);
          return;
        }
        if (rest === '/git-receive-pack' && req.method === 'POST') {
          sendGit(res, gitReceivePack(store, owner, repoName, await readBody(req)), requestHeaders);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' }, requestHeaders);
        return;
      }

      if (path === '/api/graphql' && req.method === 'POST') {
        if (token === null) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestHeaders);
          return;
        }
        if (expectedToken !== '' && token !== expectedToken) {
          sendJson(res, 401, { message: 'Bad credentials' }, requestHeaders);
          return;
        }
        const body = await readBody(req);
        const reply = handleGraphQL(store, body.toString('utf8'));
        sendJson(res, reply.status, reply.body, requestHeaders);
        return;
      }

      if (path === '/mcp') {
        if (req.method !== 'POST') {
          sendJson(res, 405, { message: 'Method Not Allowed' }, requestHeaders);
          return;
        }
        const body = await readBody(req);
        const reply = handleMcp({ bodyText: body.toString('utf8'), token, store });
        if (reply.body === '') {
          res.writeHead(reply.status, { 'content-type': JSON_TYPE, 'x-github-request-id': requestId });
          res.end();
          return;
        }
        send(res, reply.status, JSON_TYPE, Buffer.from(reply.body, 'utf8'), requestHeaders);
        return;
      }

      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const body = await readBody(req);
        const segments = path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
        const rest: RestReply | null = handleRest({
          method: req.method ?? 'GET',
          segments,
          query: url.searchParams,
          bodyText: body.toString('utf8'),
          token,
          baseUrl: origin,
          requestId,
          store,
          expectedToken,
        });
        if (rest === null) {
          sendJson(res, 404, { message: 'Not Found' }, requestHeaders);
          return;
        }
        const headers = { ...requestHeaders, ...(rest.headers ?? {}) };
        if (rest.empty === true) {
          res.writeHead(rest.status, { 'x-github-request-id': requestId, ...(rest.headers ?? {}) });
          res.end();
          return;
        }
        send(res, rest.status, JSON_TYPE, Buffer.from(`${JSON.stringify(rest.body ?? {})}\n`, 'utf8'), headers);
        return;
      }

      sendJson(res, 404, { message: 'Not Found' }, requestHeaders);
    })().catch((err: unknown) => {
      const text = err instanceof Error ? err.message : String(err);
      try {
        sendJson(res, 500, { message: `Internal error: ${text}` });
      } catch {
        res.destroy();
      }
    });
  });
  // The suite runs 50 concurrent clones and 2,000 sequential reads on pooled sockets: an idle
  // timeout or a per-socket request cap would make it reconnect, and a reconnect costs more than
  // any handler here.
  server.keepAliveTimeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.maxRequestsPerSocket = 0;
  server.setTimeout(0);
  return server;
}
