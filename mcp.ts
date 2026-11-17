// Model Context Protocol over Streamable HTTP: JSON-RPC 2.0, answering application/json.
//
// Two revisions are supported: the stateless 2026-07-28 shape (every request declares it and
// server/discover lists the supported revisions) and the older handshake shape (initialize, then
// notifications/initialized). The tools act on the same store REST serves, so an object created
// over MCP reads back over /api/v3 with the same id.

import { repoJson, issueJson, pullJson } from './rest.ts';
import { createCommit } from './worktree.ts';
import type { Repo, Store } from './store.ts';

export const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];
export const DEFAULT_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };

interface ToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

function schema(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required, additionalProperties: false };
}

const STRING = { type: 'string', description: 'A value.' };

const TOOLS: ToolSpec[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated account and return it.',
    inputSchema: schema({ name: { type: 'string', description: 'Repository name.' } }, ['name']),
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: schema({ owner: STRING, repo: STRING, full_name: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_issue',
    description: 'Open an issue on a repository and return it.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, body: STRING, full_name: STRING }, ['owner', 'repo', 'title']),
  },
  {
    name: 'list_issues',
    description: 'List a repository issues, optionally filtered by state.',
    inputSchema: schema({ owner: STRING, repo: STRING, state: STRING, full_name: STRING }, ['owner', 'repo']),
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, title: STRING, head: STRING, base: STRING, body: STRING, full_name: STRING }, ['owner', 'repo', 'title', 'head', 'base']),
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request onto its base branch.',
    inputSchema: schema({ owner: STRING, repo: STRING, pull_number: { type: 'number', description: 'Pull request number.' }, full_name: STRING }, ['owner', 'repo', 'pull_number']),
  },
];

const TOOLS_JSON = JSON.stringify(TOOLS);

export interface RpcReply {
  readonly status: number;
  readonly body: string;
}

function rpcError(id: unknown, code: number, text: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message: text } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function argString(args: Record<string, unknown>, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** owner/repo from the arguments, falling back to a full_name the client filled in. */
function ownerRepo(args: Record<string, unknown>): { owner: string; name: string } | null {
  const owner = argString(args, 'owner');
  const name = argString(args, 'repo') ?? argString(args, 'repository');
  if (owner !== null && name !== null) return { owner, name };
  const full = argString(args, 'full_name');
  if (full !== null && full.includes('/')) {
    const [left, right] = full.split('/');
    return { owner: left, name: right };
  }
  return null;
}

function textContent(payload: unknown, isError = false): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...(isError ? { isError: true } : {}),
  };
}

interface CallOutcome {
  readonly result?: Record<string, unknown>;
  readonly error?: { code: number; message: string };
}

function callTool(store: Store, toolName: string, args: Record<string, unknown>): CallOutcome {
  const normalized = toolName.toLowerCase().replace(/^.*__/, '');
  const resolve = (): { repo: Repo; owner: string } | CallOutcome => {
    const pair = ownerRepo(args);
    if (pair === null) return { error: { code: -32602, message: 'owner and repo are required' } };
    const repo = store.find(pair.owner, pair.name);
    if (repo === null) return { error: { code: -32602, message: `repository ${pair.owner}/${pair.name} not found` } };
    return { repo, owner: pair.owner };
  };

  switch (normalized) {
    case 'create_repo': {
      const name = argString(args, 'name');
      if (name === null) return { error: { code: -32602, message: 'name is required' } };
      const existing = store.repos.get(name.toLowerCase());
      if (existing !== undefined) return { result: textContent(repoJson(store, existing)) };
      const repo = store.createRepo(name, argString(args, 'description') ?? '', args.private === true, null);
      return { result: textContent(repoJson(store, repo)) };
    }
    case 'get_repo': {
      const resolved = resolve();
      if ('error' in resolved) return resolved;
      return { result: textContent(repoJson(store, resolved.repo)) };
    }
    case 'create_issue': {
      const resolved = resolve();
      if ('error' in resolved) return resolved;
      const title = argString(args, 'title');
      if (title === null) return { error: { code: -32602, message: 'title is required' } };
      const issue = store.newIssue(resolved.repo, title, argString(args, 'body') ?? '', []);
      return { result: textContent(issueJson(store, resolved.repo, issue)) };
    }
    case 'list_issues': {
      const resolved = resolve();
      if ('error' in resolved) return resolved;
      const state = argString(args, 'state') ?? 'open';
      const items = [...resolved.repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return { result: textContent(items.map((issue) => issueJson(store, resolved.repo, issue))) };
    }
    case 'create_pull_request': {
      const resolved = resolve();
      if ('error' in resolved) return resolved;
      const title = argString(args, 'title');
      const headRaw = argString(args, 'head');
      const baseRef = argString(args, 'base') ?? resolved.repo.defaultBranch;
      if (title === null || headRaw === null) return { error: { code: -32602, message: 'title, head and base are required' } };
      const headRef = headRaw.includes(':') ? (headRaw.split(':').pop() as string) : headRaw;
      const headSha = resolved.repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = resolved.repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return { error: { code: -32602, message: `head branch ${headRef} has no commits` } };
      if (baseSha === undefined) return { error: { code: -32602, message: `base branch ${baseRef} not found` } };
      const pull = store.newPull(resolved.repo, {
        title,
        body: argString(args, 'body') ?? '',
        headRef,
        headSha,
        baseRef,
        baseSha,
      });
      return { result: textContent(pullJson(store, resolved.repo, pull)) };
    }
    case 'merge_pull_request': {
      const resolved = resolve();
      if ('error' in resolved) return resolved;
      const raw = args.pull_number ?? args.number ?? args.pullNumber;
      const number = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
      if (!Number.isFinite(number)) return { error: { code: -32602, message: 'pull_number is required' } };
      const pull = resolved.repo.pulls.get(number);
      if (pull === undefined) return { error: { code: -32602, message: `pull request ${number} not found` } };
      if (pull.state !== 'open') return { result: textContent({ merged: false, message: 'Pull request is not open' }, true) };
      const baseRef = `refs/heads/${pull.baseRef}`;
      const currentBase = resolved.repo.refs.get(baseRef);
      if (currentBase === undefined || currentBase !== pull.baseSha) {
        return { result: textContent({ merged: false, message: 'Pull request is not mergeable' }, true) };
      }
      const headTree = resolved.repo.refs.get(`refs/heads/${pull.headRef}`);
      if (headTree === undefined) return { result: textContent({ merged: false, message: 'head branch is gone' }, true) };
      const object = resolved.repo.objects.get(headTree);
      const tree = object !== undefined && object.type === 'commit' ? object.data.toString('utf8').split('\n')[0].slice(5).trim() : null;
      if (tree === null) return { result: textContent({ merged: false, message: 'head branch is not a commit' }, true) };
      const commit = createCommit(resolved.repo, { tree, parents: [currentBase], message: `${pull.title} (#${pull.number})` });
      resolved.repo.refs.set(baseRef, commit);
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = store.now();
      pull.mergeCommitSha = commit;
      pull.closedAt = pull.mergedAt;
      return { result: textContent({ sha: commit, merged: true, message: 'Pull Request successfully merged' }) };
    }
    default:
      return { error: { code: -32601, message: `Unknown tool: ${toolName}` } };
  }
}

export interface McpRequest {
  readonly bodyText: string;
  readonly token: string | null;
  readonly store: Store;
}

export function handleMcp(req: McpRequest): RpcReply {
  if (req.token === null) {
    return { status: 401, body: JSON.stringify(rpcError(null, -32001, 'Authorization header required')) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(req.bodyText);
  } catch {
    return { status: 400, body: JSON.stringify(rpcError(null, -32700, 'Parse error')) };
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const replies: unknown[] = [];
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      replies.push(rpcError(null, -32600, 'Invalid Request'));
      continue;
    }
    const request = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const id = request.id ?? null;
    const method = typeof request.method === 'string' ? request.method : '';
    const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

    if (method === 'initialize') {
      replies.push(
        rpcResult(id, {
          protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : DEFAULT_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        }),
      );
      continue;
    }
    if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
      continue;
    }
    if (method === 'server/discover' || method === 'discover') {
      replies.push(rpcResult(id, { supportedVersions: SUPPORTED_VERSIONS, serverInfo: SERVER_INFO, capabilities: { tools: {} } }));
      continue;
    }
    if (method === 'ping') {
      replies.push(rpcResult(id, {}));
      continue;
    }
    if (method === 'tools/list') {
      replies.push({ jsonrpc: '2.0', id, result: { tools: JSON.parse(TOOLS_JSON) as unknown } });
      continue;
    }
    if (method === 'tools/call') {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      if (toolName === '') {
        replies.push(rpcError(id, -32602, 'tools/call needs a tool name'));
        continue;
      }
      const outcome = callTool(req.store, toolName, args);
      if (outcome.error !== undefined) {
        replies.push(rpcError(id, outcome.error.code, outcome.error.message));
        continue;
      }
      replies.push(rpcResult(id, outcome.result));
      continue;
    }
    replies.push(rpcError(id, -32601, `Method not found: ${method}`));
  }
  if (replies.length === 0) return { status: 202, body: '' };
  const body = Array.isArray(parsed) ? JSON.stringify(replies) : JSON.stringify(replies[0]);
  return { status: 200, body };
}
