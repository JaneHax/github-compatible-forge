// GitHub REST v3: repositories, branches, commits, contents, labels, issues, comments, pulls.
//
// Every reply is application/json (never HTML), carries a non-empty X-GitHub-Request-Id, and an
// error body is {message: string}. A repository belongs to the login the token names, so a name
// under another login is 404, never 403.

import {
  commitChain,
  blobAt,
  fastForward,
  listDir,
  type Comment,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import {
  applyChanges,
  createCommit,
  refTree,
  treeToMap,
  type FileChange,
} from './worktree.ts';
import { parseCommit, type GitObject } from './gitobj.ts';

export interface RestReply {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly empty?: boolean;
}

export interface RestRequest {
  readonly method: string;
  readonly segments: string[];
  readonly query: URLSearchParams;
  readonly bodyText: string;
  readonly token: string | null;
  readonly baseUrl: string;
  readonly requestId: string;
  readonly store: Store;
  readonly expectedToken: string;
}

export const API_VERSION = '1.0.0';

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, body: unknown, headers: Record<string, string> = {}): RestReply {
  return { status, body, headers };
}

function message(status: number, text: string): RestReply {
  return json(status, { message: text });
}

// ---------------------------------------------------------------- serializers

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: 1000,
    node_id: `U_${login}`,
    type: 'User',
    site_admin: false,
    avatar_url: 'https://avatars.invalid/u/1',
    html_url: `https://github.invalid/${login}`,
  };
}

function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    private: repo.private,
    owner: userJson(owner),
    description: repo.description,
    fork: false,
    url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    html_url: `${base}/${owner}/${repo.name}`,
    clone_url: `${base}/${owner}/${repo.name}.git`,
    git_url: `${base}/${owner}/${repo.name}.git`,
    ssh_url: `git@makefun.invalid:${owner}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: store.iso(repo.createdAt),
    updated_at: store.iso(repo.updatedAt),
    pushed_at: store.iso(repo.pushedAt),
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  const labels = issue.labels
    .map((name) => repo.labels.get(name.toLowerCase()))
    .filter((label): label is Label => label !== undefined)
    .map(labelJson);
  const comments = [...repo.comments.values()].filter((comment) => comment.issueNumber === issue.number).length;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.closedAt === null ? null : 'completed',
    labels,
    user: userJson(owner),
    assignee: null,
    assignees: [],
    milestone: null,
    comments,
    locked: false,
    author_association: 'OWNER',
    created_at: store.iso(issue.createdAt),
    updated_at: store.iso(issue.updatedAt),
    closed_at: store.iso(issue.closedAt),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `${base}/api/v3/repos/${owner}/${repo.name}`,
    html_url: `${base}/${owner}/${repo.name}/issues/${issue.number}`,
  };
}

function commentJson(store: Store, repo: Repo, comment: Comment): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    body: comment.body,
    user: userJson(owner),
    created_at: store.iso(comment.createdAt),
    updated_at: store.iso(comment.updatedAt),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `${base}/${owner}/${repo.name}/issues/${comment.issueNumber}#issuecomment-${comment.id}`,
    issue_url: `${base}/api/v3/repos/${owner}/${repo.name}/issues/${comment.issueNumber}`,
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  const mergeable = pull.state === 'open' ? repo.refs.get(`refs/heads/${pull.baseRef}`) === pull.baseSha : false;
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: store.iso(pull.mergedAt),
    merge_commit_sha: pull.mergeCommitSha,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    draft: false,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${owner}:${pull.headRef}`,
      user: userJson(owner),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${owner}:${pull.baseRef}`,
      user: userJson(owner),
    },
    user: userJson(owner),
    created_at: store.iso(pull.createdAt),
    updated_at: store.iso(pull.updatedAt),
    closed_at: store.iso(pull.closedAt),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${base}/${owner}/${repo.name}/pull/${pull.number}`,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commitJson(store: Store, repo: Repo, oid: string): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  const object = repo.objects.get(oid);
  const view = object === undefined ? null : object.type === 'commit' ? parseCommit(object.data) : null;
  const splitIdentity = (raw: string): { name: string; email: string; date: string } => {
    const match = /^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/.exec(raw);
    if (match === null) return { name: raw, email: '', date: store.iso(repo.createdAt) as string };
    return {
      name: match[1],
      email: match[2],
      date: new Date(parseInt(match[3], 10) * 1000).toISOString().replace('.000Z', 'Z'),
    };
  };
  return {
    sha: oid,
    node_id: `K_${oid}`,
    commit: {
      author: view === null ? { name: '', email: '', date: null } : splitIdentity(view.author),
      committer: view === null ? { name: '', email: '', date: null } : splitIdentity(view.committer),
      message: view?.message ?? '',
      tree: { sha: view?.tree ?? '' },
    },
    parents: (view?.parents ?? []).map((parent) => ({ sha: parent })),
    url: `${base}/api/v3/repos/${owner}/${repo.name}/commits/${oid}`,
    html_url: `${base}/${owner}/${repo.name}/commit/${oid}`,
  };
}

function contentJson(store: Store, repo: Repo, path: string, oid: string, size: number, mode: string): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  const object = repo.objects.get(oid);
  const bytes = object?.data ?? Buffer.alloc(0);
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name: path.split('/').pop() ?? path,
    path,
    content: bytes.toString('base64'),
    sha: oid,
    mode,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/blobs/${oid}`,
    html_url: `${base}/${owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

// ---------------------------------------------------------------- diffing

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function diffCounts(before: string, after: string): { additions: number; deletions: number } {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) counts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of counts.values()) deletions += left;
  return { additions, deletions };
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
  readonly sha: string;
  readonly previousFilename: string | null;
}

function pullFiles(repo: Repo, pull: Pull): PullFile[] {
  const baseTree = refTree(repo, `refs/heads/${pull.baseRef}`);
  const headTree = refTree(repo, `refs/heads/${pull.headRef}`);
  const baseMap = treeToMap(repo, baseTree);
  const headMap = treeToMap(repo, headTree);
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  const out: PullFile[] = [];
  for (const path of [...paths].sort()) {
    const before = baseMap.get(path);
    const after = headMap.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const beforeText = before === undefined ? '' : (repo.objects.get(before.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
    const afterText = after === undefined ? '' : (repo.objects.get(after.oid)?.data ?? Buffer.alloc(0)).toString('utf8');
    const counts = diffCounts(beforeText, afterText);
    const status: PullFile['status'] = before === undefined ? 'added' : after === undefined ? 'removed' : 'modified';
    out.push({
      filename: path,
      status,
      additions: status === 'removed' ? 0 : counts.additions,
      deletions: status === 'added' ? 0 : counts.deletions,
      changes: (status === 'removed' ? 0 : counts.additions) + (status === 'added' ? 0 : counts.deletions),
      sha: after?.oid ?? before?.oid ?? '',
      previousFilename: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------- request helpers

function bodyJson(req: RestRequest): Record<string, unknown> | null {
  const text = req.bodyText.trim();
  if (text === '') return {};
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function intOf(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** GitHub's pagination: per_page, page, and a Link header with rel="next" when another page exists. */
function paginate<T>(items: readonly T[], query: URLSearchParams, baseUrl: string, path: string): { page: T[]; link: string | null } {
  const perPage = Math.min(100, intOf(query.get('per_page'), 30));
  const pageNumber = intOf(query.get('page'), 1);
  const start = (pageNumber - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  let link: string | null = null;
  if (hasNext) {
    const url = new URL(`${baseUrl}${path}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(pageNumber + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page, link };
}

function linkHeaders(link: string | null): Record<string, string> {
  return link === null ? {} : { Link: link };
}

// ---------------------------------------------------------------- the router

export function handleRest(req: RestRequest): RestReply | null {
  const { segments, method, store } = req;
  if (segments.length === 0 || segments[0] !== 'api' || segments[1] !== 'v3') return null;
  const parts = segments.slice(2);

  if (req.token === null) return message(401, 'Requires authentication');
  if (req.expectedToken !== '' && req.token !== req.expectedToken) {
    return message(401, 'Bad credentials');
  }

  // GET /api/v3/
  if (parts.length === 0) {
    return json(
      200,
      {
        current_user_url: `${req.baseUrl}/api/v3/user`,
        repository_url: `${req.baseUrl}/api/v3/repos/{owner}/{repo}`,
        user_repositories_url: `${req.baseUrl}/api/v3/user/repos`,
        graphql_url: `${req.baseUrl}/api/graphql`,
        installed_version: API_VERSION,
      },
      { 'X-OAuth-Scopes': 'repo, read:org' },
    );
  }

  if (parts[0] === 'meta' && parts.length === 1 && method === 'GET') {
    return json(200, { installed_version: API_VERSION, verifiable_password_authentication: false });
  }

  if (parts[0] === 'user' && parts.length === 1 && method === 'GET') {
    const login = store.login();
    return json(200, { ...userJson(login), public_repos: store.repos.size, total_private_repos: store.repos.size });
  }

  if (parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET' && parts.length === 2) {
      const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
      const { page, link } = paginate(all, req.query, req.baseUrl, '/api/v3/user/repos');
      return json(200, page.map((repo) => repoJson(store, repo)), linkHeaders(link));
    }
    if (method === 'POST' && parts.length === 2) {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const name = str(body.name);
      if (name === null || name === '') return message(422, 'Repository name is required');
      const existing = store.repos.get(name.toLowerCase());
      if (existing !== undefined) return message(422, `Repository creation failed: name already exists on this account`);
      // The owner is bound on first owner-scoped access, never here: the bearer token carries no
      // readable login, so binding at creation would lock the repository to a guess.
      const repo = store.createRepo(name, str(body.description) ?? '', body.private === true, null);
      return json(201, repoJson(store, repo));
    }
    return message(404, 'Not Found');
  }

  if (parts[0] !== 'repos' || parts.length < 3) return message(404, 'Not Found');

  const owner = decodeURIComponent(parts[1]);
  const name = decodeURIComponent(parts[2]);
  const repo = store.find(owner, name);
  if (repo === null) return message(404, 'Not Found');
  const rest = parts.slice(3);

  // /repos/{owner}/{repo}
  if (rest.length === 0) {
    if (method === 'GET') return json(200, repoJson(store, repo));
    if (method === 'PATCH' || method === 'POST') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const description = str(body.description);
      if (description !== null) repo.description = description;
      const isPrivate = body.private;
      if (typeof isPrivate === 'boolean') repo.private = isPrivate;
      repo.updatedAt = store.now();
      return json(200, repoJson(store, repo));
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name.toLowerCase());
      return { status: 204, empty: true };
    }
    return message(404, 'Not Found');
  }

  // /repos/{o}/{r}/branches
  if (rest[0] === 'branches' && rest.length === 1 && method === 'GET') {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha, url: `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/commits/${sha}` },
        protected: false,
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return json(200, branches);
  }

  // /repos/{o}/{r}/commits
  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
    const sha = req.query.get('sha');
    const ref = sha === null ? `refs/heads/${repo.defaultBranch}` : sha.startsWith('refs/') ? sha : `refs/heads/${sha}`;
    const tip = repo.refs.get(ref) ?? (repo.objects.has(sha ?? '') ? (sha as string) : undefined);
    if (tip === undefined) return json(200, []);
    return json(200, commitChain(repo, tip).map((oid) => commitJson(store, repo, oid)));
  }

  // /repos/{o}/{r}/git/refs
  if (rest[0] === 'git' && rest[1] === 'refs' && rest.length === 2) {
    if (method === 'POST') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const ref = str(body.ref);
      const sha = str(body.sha);
      if (ref === null || sha === null) return message(422, 'ref and sha are required');
      if (!ref.startsWith('refs/')) return message(422, 'ref must start with refs/');
      if (!repo.objects.has(sha)) return message(422, `Object does not exist: ${sha}`);
      repo.refs.set(ref, sha);
      repo.pushedAt = store.now();
      return json(201, { ref, node_id: `R_${ref}`, url: `${req.baseUrl}/api/v3/repos/${owner}/${repo.name}/git/refs${ref}`, object: { sha, type: 'commit' } });
    }
    if (method === 'GET') {
      const refs = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, node_id: `R_${ref}`, object: { sha, type: 'commit' } }));
      return json(200, refs);
    }
  }

  // /repos/{o}/{r}/labels
  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const labelName = str(body.name);
      if (labelName === null || labelName === '') return message(422, 'name is required');
      const label = store.newLabel(repo, labelName, str(body.color) ?? 'ededed', str(body.description));
      return json(201, labelJson(label));
    }
    if (method === 'GET') return json(200, [...repo.labels.values()].map(labelJson));
  }

  // /repos/{o}/{r}/contents/{path...}
  if (rest[0] === 'contents') {
    const path = rest.slice(1).map((part) => decodeURIComponent(part)).join('/');
    const ref = req.query.get('ref');
    const treeOid = ref === null ? refTree(repo, `refs/heads/${repo.defaultBranch}`) : refTree(repo, ref.startsWith('refs/') ? ref : `refs/heads/${ref}`);

    if (method === 'GET') {
      if (treeOid === null) return message(404, 'Not Found');
      if (path === '') {
        const entries = listDir(repo, treeOid, '');
        if (entries === null) return message(404, 'Not Found');
        return json(200, entries.map((entry) => entryJson(store, repo, entry.name, entry.name, entry.mode, entry.oid)));
      }
      const blob = blobAt(repo, treeOid, path);
      if (blob !== null && !blob.mode.startsWith('4')) {
        const size = repo.objects.get(blob.oid)?.data.length ?? 0;
        return json(200, contentJson(store, repo, path, blob.oid, size, blob.mode));
      }
      const entries = listDir(repo, treeOid, path);
      if (entries !== null) {
        return json(200, entries.map((entry) => entryJson(store, repo, entry.name, `${path}/${entry.name}`, entry.mode, entry.oid)));
      }
      return message(404, 'Not Found');
    }

    if (method === 'PUT') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const messageText = str(body.message) ?? `Update ${path}`;
      const raw = str(body.content);
      if (raw === null) return message(422, 'content is required');
      const branch = str(body.branch) ?? repo.defaultBranch;
      const targetRef = `refs/heads/${branch}`;
      const parent = repo.refs.get(targetRef);
      const currentTree = refTree(repo, targetRef);
      const existing = currentTree === null ? null : blobAt(repo, currentTree, path);
      const givenSha = str(body.sha);
      if (givenSha !== null) {
        if (existing === null || existing.oid !== givenSha) {
          return message(409, `sha does not match the current contents of ${path}`);
        }
      } else if (existing !== null) {
        return message(422, `Invalid request: ${path} already exists (sha is required)`);
      }
      const bytes = Buffer.from(raw, 'base64');
      const tree = applyChanges(repo, currentTree, [{ path, content: bytes }]);
      const commit = createCommit(repo, {
        tree,
        parents: parent === undefined ? [] : [parent],
        message: messageText,
      });
      repo.refs.set(targetRef, commit);
      repo.pushedAt = store.now();
      repo.updatedAt = store.now();
      const blobOid = blobAt(repo, tree, path)?.oid ?? '';
      return json(existing === null ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
        commit: { sha: commit, message: messageText, tree: { sha: tree } },
      });
    }

    if (method === 'DELETE') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const branch = str(body.branch) ?? repo.defaultBranch;
      const targetRef = `refs/heads/${branch}`;
      const parent = repo.refs.get(targetRef);
      const currentTree = refTree(repo, targetRef);
      const existing = currentTree === null ? null : blobAt(repo, currentTree, path);
      if (existing === null) return message(404, 'Not Found');
      const givenSha = str(body.sha);
      if (givenSha !== null && givenSha !== existing.oid) return message(409, 'sha does not match the current contents');
      const tree = applyChanges(repo, currentTree, [{ path, content: null }]);
      const commit = createCommit(repo, {
        tree,
        parents: parent === undefined ? [] : [parent],
        message: str(body.message) ?? `Delete ${path}`,
      });
      repo.refs.set(targetRef, commit);
      repo.pushedAt = store.now();
      return json(200, { content: null, commit: { sha: commit, tree: { sha: tree } } });
    }
    return message(404, 'Not Found');
  }

  // /repos/{o}/{r}/issues
  if (rest[0] === 'issues') {
    if (rest.length === 1 && method === 'POST') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const title = str(body.title);
      if (title === null || title === '') return message(422, 'title is required');
      const wanted = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
      const unknown = wanted.filter((label) => !repo.labels.has(label.toLowerCase()));
      if (unknown.length > 0) return message(422, `Label does not exist: ${unknown[0]}`);
      const issue = store.newIssue(repo, title, str(body.body) ?? '', wanted);
      return json(201, issueJson(store, repo, issue));
    }

    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      const sort = req.query.get('sort') ?? 'created';
      const direction = req.query.get('direction') ?? 'desc';
      let items = [...repo.issues.values()];
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      const key = (issue: Issue): number =>
        sort === 'updated' ? issue.updatedAt : sort === 'comments' ? issue.number : issue.createdAt;
      items.sort((a, b) => (direction === 'asc' ? key(a) - key(b) : key(b) - key(a)));
      const { page, link } = paginate(items, req.query, req.baseUrl, `/api/v3/repos/${owner}/${repo.name}/issues`);
      return json(200, page.map((issue) => issueJson(store, repo, issue)), linkHeaders(link));
    }

    if (rest.length >= 2) {
      const number = parseInt(rest[1], 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) return message(404, 'Not Found');

      if (rest.length === 2 && method === 'GET') return json(200, issueJson(store, repo, issue));

      if (rest.length === 2 && (method === 'PATCH' || method === 'POST')) {
        const body = bodyJson(req);
        if (body === null) return message(400, 'Problems parsing JSON');
        const title = str(body.title);
        if (title !== null) issue.title = title;
        const text = str(body.body);
        if (text !== null) issue.body = text;
        const state = str(body.state);
        if (state === 'closed' || state === 'open') {
          if (state !== issue.state) {
            issue.state = state;
            issue.closedAt = state === 'closed' ? store.now() : null;
          }
        }
        if (Array.isArray(body.labels)) {
          const wanted = body.labels.filter((value): value is string => typeof value === 'string');
          const unknown = wanted.filter((label) => !repo.labels.has(label.toLowerCase()));
          if (unknown.length > 0) return message(422, `Label does not exist: ${unknown[0]}`);
          issue.labels = wanted;
        }
        issue.updatedAt = store.now();
        return json(200, issueJson(store, repo, issue));
      }

      if (rest[2] === 'comments' && rest.length === 3) {
        if (method === 'POST') {
          const body = bodyJson(req);
          if (body === null) return message(400, 'Problems parsing JSON');
          const text = str(body.body);
          if (text === null || text === '') return message(422, 'body is required');
          const comment = store.newComment(repo, issue.number, text);
          return json(201, commentJson(store, repo, comment));
        }
        if (method === 'GET') {
          const items = [...repo.comments.values()].filter((comment) => comment.issueNumber === issue.number);
          return json(200, items.map((comment) => commentJson(store, repo, comment)));
        }
      }
    }
    return message(404, 'Not Found');
  }

  // /repos/{o}/{r}/pulls
  if (rest[0] === 'pulls') {
    if (rest.length === 1 && method === 'POST') {
      const body = bodyJson(req);
      if (body === null) return message(400, 'Problems parsing JSON');
      const title = str(body.title);
      const headRaw = str(body.head);
      const baseRef = str(body.base) ?? repo.defaultBranch;
      if (title === null || headRaw === null) return message(422, 'title, head and base are required');
      const headRef = headRaw.includes(':') ? headRaw.split(':').pop() as string : headRaw;
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) return message(422, `No commits between ${baseRef} and ${headRef}: head branch not found`);
      if (baseSha === undefined) return message(422, `base branch ${baseRef} not found`);
      const pull = store.newPull(repo, {
        title,
        body: str(body.body) ?? '',
        headRef,
        headSha,
        baseRef,
        baseSha,
      });
      return json(201, pullJson(store, repo, pull));
    }

    if (rest.length === 1 && method === 'GET') {
      const state = req.query.get('state') ?? 'open';
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open');
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed');
      items.sort((a, b) => b.number - a.number);
      const { page, link } = paginate(items, req.query, req.baseUrl, `/api/v3/repos/${owner}/${repo.name}/pulls`);
      return json(200, page.map((pull) => pullJson(store, repo, pull)), linkHeaders(link));
    }

    if (rest.length >= 2) {
      const number = parseInt(rest[1], 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) return message(404, 'Not Found');

      if (rest.length === 2 && method === 'GET') return json(200, pullJson(store, repo, pull));

      if (rest[2] === 'files' && rest.length === 3 && method === 'GET') {
        return json(200, pullFiles(repo, pull));
      }

      if (rest[2] === 'merge' && rest.length === 3 && method === 'PUT') {
        if (pull.state !== 'open') return message(405, 'Pull request is not open');
        const baseRef = `refs/heads/${pull.baseRef}`;
        const currentBase = repo.refs.get(baseRef);
        if (currentBase === undefined || currentBase !== pull.baseSha) {
          return message(405, 'Pull Request is not mergeable: the base branch has moved');
        }
        const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
        if (headTip === undefined) return message(405, 'Pull Request is not mergeable: the head branch is gone');
        const headTree = refTree(repo, `refs/heads/${pull.headRef}`);
        if (headTree === null) return message(405, 'Pull Request is not mergeable');
        const mergeMessage = `${pull.title} (#${pull.number})`;
        const commit = createCommit(repo, { tree: headTree, parents: [currentBase], message: mergeMessage });
        repo.refs.set(baseRef, commit);
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = store.now();
        pull.mergeCommitSha = commit;
        pull.closedAt = pull.mergedAt;
        pull.updatedAt = store.now();
        repo.pushedAt = store.now();
        return json(200, { sha: commit, merged: true, message: 'Pull Request successfully merged' });
      }
    }
    return message(404, 'Not Found');
  }

  return message(404, 'Not Found');
}

function entryJson(store: Store, repo: Repo, name: string, path: string, mode: string, oid: string): Record<string, unknown> {
  const owner = repo.ownerLogin ?? store.login();
  const base = store.baseUrlFor(repo);
  const isDir = mode.startsWith('4');
  const object: GitObject | undefined = repo.objects.get(oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: isDir ? 0 : object?.data.length ?? 0,
    name,
    path,
    sha: oid,
    mode: isDir ? '040000' : mode,
    url: `${base}/api/v3/repos/${owner}/${repo.name}/contents/${path}`,
    git_url: `${base}/api/v3/repos/${owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${oid}`,
    html_url: `${base}/${owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
    download_url: null,
  };
}

export { JSON_TYPE, fastForward, diffCounts, pullFiles, splitLines, repoJson, issueJson, pullJson, commentJson, labelJson };
