// Writing commits: the tree edits the contents API and the merge do.
//
// A change is a path plus its new bytes (or null to delete it). Trees are rebuilt bottom-up from a
// flat path map, which keeps the code small and the result identical to what git would write.

import {
  buildCommit,
  buildTree,
  hashObject,
  parseTree,
  type GitObject,
  type ObjType,
  type TreeEntry,
} from './gitobj.ts';
import { flattenTree, type Repo } from './store.ts';

export const DEFAULT_IDENTITY = 'makefun <forge@makefun.invalid> 1735689600 +0000';

export interface FileChange {
  readonly path: string;
  /** The blob's bytes, or null to remove the path. */
  readonly content: Buffer | null;
}

export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Every blob and the tree structure, as a flat path map. */
export function treeToMap(repo: Repo, treeOid: string | null): Map<string, { mode: string; oid: string }> {
  const map = new Map<string, { mode: string; oid: string }>();
  if (treeOid === null) return map;
  for (const entry of flattenTree(repo, treeOid)) map.set(entry.path, { mode: entry.mode, oid: entry.oid });
  return map;
}

/** Build the tree objects for a flat path map, returning the root tree id. */
export function mapToTree(repo: Repo, map: ReadonlyMap<string, { mode: string; oid: string }>): string {
  interface Node {
    readonly files: Map<string, { mode: string; oid: string }>;
    readonly dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of map) {
    const segments = path.split('/').filter((part) => part !== '');
    if (segments.length === 0) continue;
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(segment, next);
      }
      node = next;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const write = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: write(child) });
    const data = buildTree(entries);
    return storeObject(repo, 'tree', data);
  };
  return write(root);
}

/** Apply changes to a base tree and write the resulting tree, returning its id. */
export function applyChanges(repo: Repo, baseTree: string | null, changes: readonly FileChange[]): string {
  const map = treeToMap(repo, baseTree);
  for (const change of changes) {
    const path = change.path.replace(/^\/+/, '').replace(/\/+$/, '');
    if (path === '') continue;
    if (change.content === null) {
      map.delete(path);
      // A delete of a directory removes everything under it.
      for (const key of [...map.keys()]) if (key.startsWith(`${path}/`)) map.delete(key);
      continue;
    }
    const oid = storeObject(repo, 'blob', change.content);
    map.set(path, { mode: '100644', oid });
  }
  return mapToTree(repo, map);
}

export interface NewCommit {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly message: string;
  readonly author?: string;
}

export function createCommit(repo: Repo, commit: NewCommit): string {
  const identity = commit.author ?? DEFAULT_IDENTITY;
  const data = buildCommit({
    tree: commit.tree,
    parents: commit.parents,
    author: identity,
    committer: identity,
    message: commit.message,
  });
  return storeObject(repo, 'commit', data);
}

/** The tree of a ref's tip, or null when the ref is unborn or missing. */
export function refTree(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (oid === undefined) return null;
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') {
    const text = object.data.toString('utf8');
    const line = text.split('\n').find((candidate) => candidate.startsWith('tree '));
    return line === undefined ? null : line.slice(5).trim();
  }
  return object.type === 'tree' ? oid : null;
}

export function parseTreeOf(repo: Repo, oid: string): TreeEntry[] {
  const object: GitObject | undefined = repo.objects.get(oid);
  return object === undefined || object.type !== 'tree' ? [] : parseTree(object.data);
}
