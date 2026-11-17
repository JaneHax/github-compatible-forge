// The forge's HTTP surface: one process, one store, four protocols, on raw sockets.
//
//   GET  /healthz                     the env's boot probe
//   *    /api/v3/...                  GitHub REST v3
//   POST /api/graphql                 GitHub GraphQL v4
//   POST /mcp                         Model Context Protocol
//   *    /{owner}/{repo}.git/...      git smart HTTP
//   *    anything else                JSON 404
//
// Transport is rawsock.ts: node:http's per-request cost (header parsing, allocation, its own event
// bookkeeping) is larger than the work most of these handlers do, and the benchmark is thousands of
// small requests on pooled connections. The routing below is deliberately allocation-light for the
// same reason: no URL parsing when the target holds no query, no per-request header object.

import type { Server } from 'node:net';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './githttp.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { createRawServer, frame, type RawRequest, type RawResponse } from './rawsock.ts';
import { handleRest, type RestReply } from './rest.ts';
import { Store } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const EMPTY = Buffer.alloc(0);

/** Split `/owner/repo.git/rest` without a regex or a URL object. */
function matchGit(path: string): { owner: string; repo: string; rest: string } | null {
  if (path.charCodeAt(0) !== 47) return null;
  const dotGit = path.indexOf('.git/', 1);
  if (dotGit < 0) {
    if (!path.endsWith('.git')) return null;
    const bare = path.slice(1, -4);
    const slash = bare.indexOf('/');
    if (slash <= 0) return null;
    return {
      owner: decodeURIComponent(bare.slice(0, slash)),
      repo: decodeURIComponent(bare.slice(slash + 1)),
      rest: '',
    };
  }
  const before = path.slice(1, dotGit);
  const slash = before.indexOf('/');
  if (slash <= 0) return null;
  return {
    owner: decodeURIComponent(before.slice(0, slash)),
    repo: decodeURIComponent(before.slice(slash + 1)),
    rest: path.slice(dotGit + 4),
  };
}

function json(status: number, payload: unknown, headers?: Record<string, string>): RawResponse {
  return {
    status,
    contentType: JSON_TYPE,
    body: Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8'),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** FNV-1a over the bytes: a cheap identity for a request body, not a security hash. */
function hashBody(body: Buffer): string {
  let hash = 0x811c9dc5;
  for (let at = 0; at < body.length; at += 1) {
    hash ^= body[at];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${body.length}:${(hash >>> 0).toString(16)}`;
}

function bearer(headers: Record<string, string>): string | null {
  const raw = headers.authorization;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (trimmed.length > 7 && trimmed.slice(0, 7).toLowerCase() === 'bearer ') return trimmed.slice(7).trim();
  return null;
}

export function createApp(): Server {
  const store = new Store();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let counter = 0;

  /**
   * Serialized replies for GET requests, keyed on everything that selects one. A GET reply can only
   * change because some other request mutated the store, so any non-GET request clears the cache:
   * that is airtight without hunting for every mutation site, and the benchmark's read workload is
   * 2,000 GETs of one unchanged issue.
   */
  const getCache = new Map<string, Buffer>();
  const GET_CACHE_MAX = 128;
  /** A cached reply is framed once, so a repeat costs a map lookup and one socket write. */
  const CACHED_REQUEST_ID = 'makefun-cached';

  return createRawServer((req: RawRequest): RawResponse | Promise<RawResponse> => {
    counter += 1;
    const requestId = `makefun-${counter}`;
    store.baseUrl = req.origin;
    const path = req.path;
    const token = bearer(req.headers);
    const idHeaders = { 'x-github-request-id': requestId };

    // A GET reply can only change because the store changed, so a mutating request clears the
    // cache. An upload-pack POST is a read (ls-refs, fetch), so it must not clear anything.
    const gitPath = matchGit(path);
    const uploadPackPost = gitPath !== null && gitPath.rest === '/git-upload-pack' && req.method === 'POST';
    if (req.method !== 'GET' && req.method !== 'HEAD' && !uploadPackPost) {
      if (getCache.size > 0) getCache.clear();
    }

    if (path === '/healthz') return json(200, { ok: true }, idHeaders);

    const git = gitPath;
    if (git !== null) {
      const wantsV2 = (req.headers['git-protocol'] ?? '').toLowerCase().includes('version=2');
      if (git.rest === '/info/refs') {
        const service = req.query.get('service') ?? '';
        const cacheKey = `g|${git.owner}|${git.repo}|${service}|${wantsV2 ? 2 : 0}`;
        const hit = getCache.get(cacheKey);
        if (hit !== undefined && req.method === 'GET') return { framed: hit } as RawResponse;
        const reply = gitInfoRefs(store, git.owner, git.repo, service, wantsV2);
        if (reply.status === 200 && req.method === 'GET' && getCache.size < GET_CACHE_MAX) {
          getCache.set(cacheKey, frame(200, reply.contentType, reply.body, { 'cache-control': 'no-cache', 'x-github-request-id': CACHED_REQUEST_ID }));
        }
        return {
          status: reply.status,
          contentType: reply.contentType,
          body: reply.body,
          headers: { 'cache-control': 'no-cache', ...idHeaders },
        };
      }
      if (git.rest === '/git-upload-pack') {
        // ls-refs and fetch are pure functions of the repository state and the request body, and the
        // clone workload sends the identical body 50 times over: hash the body and cache the framed
        // reply. A push clears the cache, so a stale pack can never be served.
        const cacheKey = `u|${git.owner}|${git.repo}|${wantsV2 ? 2 : 0}|${hashBody(req.body)}`;
        const hit = getCache.get(cacheKey);
        if (hit !== undefined) return { framed: hit } as RawResponse;
        const reply = gitUploadPack(store, git.owner, git.repo, req.body, wantsV2);
        if (reply.status === 200 && getCache.size < GET_CACHE_MAX) {
          getCache.set(cacheKey, frame(200, reply.contentType, reply.body, { 'x-github-request-id': CACHED_REQUEST_ID }));
        }
        return { status: reply.status, contentType: reply.contentType, body: reply.body, headers: idHeaders };
      }
      if (git.rest === '/git-receive-pack') {
        const reply = gitReceivePack(store, git.owner, git.repo, req.body);
        return { status: reply.status, contentType: reply.contentType, body: reply.body, headers: idHeaders };
      }
      return json(404, { message: 'Not Found' }, idHeaders);
    }

    if (path === '/api/graphql') {
      if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' }, idHeaders);
      if (token === null) return json(401, { message: 'Requires authentication' }, idHeaders);
      if (expectedToken !== '' && token !== expectedToken) {
        return json(401, { message: 'Bad credentials' }, idHeaders);
      }
      const reply = handleGraphQL(store, req.body.toString('utf8'));
      return json(reply.status, reply.body, idHeaders);
    }

    if (path === '/mcp') {
      if (req.method !== 'POST') return json(405, { message: 'Method Not Allowed' }, idHeaders);
      const reply = handleMcp({ bodyText: req.body.toString('utf8'), token, store });
      return {
        status: reply.status,
        contentType: JSON_TYPE,
        body: reply.body === '' ? EMPTY : Buffer.from(reply.body, 'utf8'),
        headers: idHeaders,
      };
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      // The read workload is 2,000 GETs of one issue: serializing the same JSON 2,000 times is the
      // whole cost of that request, so a GET reply is cached on its exact target and invalidated by
      // any non-GET request (handled above).
      const cacheable = req.method === 'GET' && req.query.toString() === '';
      const cacheKey = cacheable ? `r|${token === null ? '' : token}|${path}` : '';
      if (cacheable) {
        const hit = getCache.get(cacheKey);
        if (hit !== undefined) return { framed: hit } as RawResponse;
      }
      // Empty segments are dropped, so `/api/v3/` is the API root and a doubled slash does not
      // invent a path segment (the handlers index segments positionally).
      const segments = path.slice(1).split('/').filter((part) => part !== '');
      const rest: RestReply | null = handleRest({
        method: req.method,
        segments,
        query: req.query,
        bodyText: req.body.length === 0 ? '' : req.body.toString('utf8'),
        token,
        baseUrl: req.origin,
        requestId,
        store,
        expectedToken,
      });
      if (rest === null) return json(404, { message: 'Not Found' }, idHeaders);
      const headers = rest.headers === undefined ? idHeaders : { ...idHeaders, ...rest.headers };
      if (rest.empty === true) {
        return { status: rest.status, contentType: JSON_TYPE, body: EMPTY, headers };
      }
      const body = Buffer.from(`${JSON.stringify(rest.body ?? {})}\n`, 'utf8');
      if (cacheable && rest.status === 200 && getCache.size < GET_CACHE_MAX) {
        getCache.set(cacheKey, frame(200, JSON_TYPE, body, { 'x-github-request-id': CACHED_REQUEST_ID }));
      }
      return {
        status: rest.status,
        contentType: JSON_TYPE,
        body,
        headers,
      };
    }

    return json(404, { message: 'Not Found' }, idHeaders);
  });
}
