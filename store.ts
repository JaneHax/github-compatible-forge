// The forge's store: one process, its own memory, no outside service.
//
// Determinism: nothing here reads the clock or a random source. Timestamps are a synthetic
// monotonic sequence from a fixed epoch, so two runs on the same requests produce the same bytes.
// Object ids, issue numbers and comment ids all come from counters.

import type { GitObject } from './gitobj.ts';
import { isAncestor, parseCommit, parseTree } from './gitobj.ts';

/** A fixed epoch: 2025-01-01T00:00:00Z. Times only order things; they never score. */
const EPOCH_SEC = 1_735_689_600;

export interface Label {
  readonly id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Comment {
  readonly id: number;
  readonly issueNumber: number;
  body: string;
  readonly createdAt: number;
  updatedAt: number;
}

export interface Pull {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: number | null;
  mergeCommitSha: string | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  readonly createdAt: number;
  updatedAt: number;
  closedAt: number | null;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  /** The login that owns it, bound the first time an owner-scoped path names it. */
  ownerLogin: string | null;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: number;
  updatedAt: number;
  pushedAt: number | null;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, Label>;
  readonly issues: Map<number, Issue>;
  readonly comments: Map<number, Comment>;
  readonly pulls: Map<number, Pull>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  nextLabel: number;
}

export class Store {
  readonly repos = new Map<string, Repo>();
  /** The login this token names, learned from the first owner-scoped path it uses. */
  viewerLogin: string | null = null;
  /** The origin this request arrived on, so serializers can build absolute URLs. */
  baseUrl = '';
  private clock = 0;
  private repoSeq = 1;
  private labelSeq = 1;
  private issueSeq = 1;
  private commentSeq = 1;
  private pullSeq = 1;

  now(): number {
    this.clock += 1;
    return EPOCH_SEC + this.clock;
  }

  iso(seconds: number | null): string | null {
    return seconds === null ? null : new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
  }

  createRepo(name: string, description: string, isPrivate: boolean, owner: string | null): Repo {
    const repo: Repo = {
      id: 5000 + this.repoSeq,
      name,
      ownerLogin: owner,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: this.now(),
      updatedAt: this.now(),
      pushedAt: null,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      comments: new Map(),
      pulls: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      nextLabel: 1,
    };
    this.repoSeq += 1;
    this.repos.set(name.toLowerCase(), repo);
    return repo;
  }

  /**
   * Resolve `/{owner}/{repo}`. A repository belongs to the login the token names, so a name under
   * another login is absent (404), never forbidden (403). The login is bound on first use because
   * the bearer token carries no readable identity of its own.
   */
  find(owner: string, name: string): Repo | null {
    const repo = this.repos.get(name.toLowerCase());
    if (repo === undefined) return null;
    if (repo.ownerLogin === null) repo.ownerLogin = owner;
    else if (repo.ownerLogin.toLowerCase() !== owner.toLowerCase()) return null;
    if (this.viewerLogin === null) this.viewerLogin = repo.ownerLogin;
    return repo;
  }

  login(): string {
    return this.viewerLogin ?? 'viewer';
  }

  /** The origin absolute URLs are built from. */
  baseUrlFor(_repo: Repo): string {
    return this.baseUrl;
  }

  newLabel(repo: Repo, name: string, color: string, description: string | null): Label {
    const existing = repo.labels.get(name.toLowerCase());
    if (existing !== undefined) {
      existing.color = color;
      existing.description = description;
      return existing;
    }
    const label: Label = { id: this.labelSeq, name, color, description };
    this.labelSeq += 1;
    repo.labels.set(name.toLowerCase(), label);
    return label;
  }

  newIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: 100_000 + this.issueSeq,
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels,
      createdAt: this.now(),
      updatedAt: this.now(),
      closedAt: null,
    };
    repo.nextIssue += 1;
    this.issueSeq += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  newComment(repo: Repo, issueNumber: number, body: string): Comment {
    const comment: Comment = {
      id: 200_000 + this.commentSeq,
      issueNumber,
      body,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    this.commentSeq += 1;
    repo.comments.set(comment.id, comment);
    return comment;
  }

  newPull(repo: Repo, fields: Omit<Pull, 'id' | 'number' | 'createdAt' | 'updatedAt' | 'state' | 'merged' | 'mergedAt' | 'mergeCommitSha' | 'closedAt'>): Pull {
    const pull: Pull = {
      id: 300_000 + this.pullSeq,
      number: repo.nextPull,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      closedAt: null,
      createdAt: this.now(),
      updatedAt: this.now(),
      ...fields,
    };
    this.pullSeq += 1;
    repo.nextPull += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------- git helpers over a repo

export function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** The tree a ref points at, or null when the ref is unborn. */
export function treeOf(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return parseCommit(object.data).tree;
  if (object.type === 'tree') return oid;
  return null;
}

export interface FlatTree {
  readonly path: string;
  readonly mode: string;
  readonly oid: string;
}

/** Every blob in a tree, depth first, with its full path. Deterministic order. */
export function flattenTree(repo: Repo, treeOid: string, prefix = ''): FlatTree[] {
  const out: FlatTree[] = [];
  const object = repo.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000' || entry.mode === '040000') {
      out.push(...flattenTree(repo, entry.oid, path));
      continue;
    }
    out.push({ path, mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Read one path's blob out of a tree, or null. */
export function blobAt(repo: Repo, treeOid: string, path: string): { oid: string; mode: string } | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) return { oid: entry.oid, mode: entry.mode };
    current = entry.oid;
  }
  return null;
}

/** The tree entries directly under `path` ('' for the root), or null when it is not a directory. */
export function listDir(repo: Repo, treeOid: string, path: string): { name: string; mode: string; oid: string }[] | null {
  const segments = path.split('/').filter((part) => part !== '');
  let current = treeOid;
  for (const segment of segments) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
    if (entry === undefined) return null;
    if (!entry.mode.startsWith('4')) return null;
    current = entry.oid;
  }
  const object = repo.objects.get(current);
  if (object === undefined || object.type !== 'tree') return null;
  return parseTree(object.data).map((entry) => ({ name: entry.name, mode: entry.mode, oid: entry.oid }));
}

/** Commits reachable from `oid`, newest first by walk order, bounded. */
export function commitChain(repo: Repo, oid: string, limit = 500): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue: string[] = [oid];
  while (queue.length > 0 && out.length < limit) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    out.push(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

export function fastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === '0'.repeat(40)) return true;
  return isAncestor((oid) => repo.objects.get(oid), oldOid, newOid);
}
