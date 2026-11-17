// git smart HTTP: upload-pack (protocol v2, v0 fallback) and receive-pack (v0 only).
//
// The suite speaks the protocol in process with no git binary, so everything here is byte-level:
// pkt-line framing, packfiles, ref advertisements and report-status.

import {
  PKT_DELIM,
  PKT_FLUSH,
  collectReachable,
  decodePkts,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  pktLine,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type ObjType,
} from './gitobj.ts';
import { fastForward, type Repo, type Store } from './store.ts';

export interface GitReply {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'agent=makefun-forge/1.0';

function advertisement(service: string, body: Buffer): GitReply {
  return { status: 200, contentType: `application/x-${service}-advertisement`, body };
}

function result(service: string, body: Buffer): GitReply {
  return { status: 200, contentType: `application/x-${service}-result`, body };
}

function notFound(): GitReply {
  return { status: 404, contentType: 'text/plain; charset=utf-8', body: Buffer.from('Not Found\n', 'utf8') };
}

// ---------------------------------------------------------------- advertisements

const UPLOAD_V0_CAPS = ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'shallow', 'no-progress', AGENT].join(' ');
const RECEIVE_CAPS = ['report-status', 'report-status-v2', 'side-band-64k', 'delete-refs', 'ofs-delta', AGENT].join(' ');

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Every ref the repo holds, HEAD included, in git's advertisement order. */
function advertisedRefs(repo: Repo): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  const headOid = repo.refs.get(headTarget(repo));
  if (headOid !== undefined) out.push({ name: 'HEAD', oid: headOid });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const text = object.data.toString('utf8');
      const target = text.split('\n').find((line) => line.startsWith('object '));
      if (target !== undefined) out.push({ name, oid, peeled: target.slice(7).trim() });
      else out.push({ name, oid });
    } else {
      out.push({ name, oid });
    }
  }
  return out;
}

function v2Advertisement(): Buffer {
  const lines: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('agent=makefun-forge/1.0\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(lines);
}

function v0UploadAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${UPLOAD_V0_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${UPLOAD_V0_CAPS} symref=HEAD:${headTarget(repo)}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function receiveAdvertisement(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), PKT_FLUSH];
  const refs = advertisedRefs(repo).filter((ref) => ref.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\u0000${RECEIVE_CAPS}\n`));
  } else {
    refs.forEach((ref, index) => {
      const suffix = index === 0 ? `\u0000${RECEIVE_CAPS}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function gitInfoRefs(store: Store, owner: string, name: string, service: string, wantsV2: boolean): GitReply {
  const repo = store.find(owner, name);
  if (repo === null) return notFound();
  if (service === 'git-receive-pack') return advertisement(service, receiveAdvertisement(repo));
  if (service !== 'git-upload-pack') return notFound();
  return advertisement(service, wantsV2 ? v2Advertisement() : v0UploadAdvertisement(repo));
}

// ---------------------------------------------------------------- upload-pack

interface FetchArgs {
  readonly wants: string[];
  readonly haves: string[];
  readonly shallow: string[];
  readonly deepen: number | null;
  readonly done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let deepen: number | null = null;
  let done = false;
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) deepen = value;
    } else if (line === 'done') done = true;
  }
  return { wants, haves, shallow, deepen, done };
}

interface ShallowPlan {
  readonly commits: Set<string>;
  readonly shallowNow: string[];
  readonly unshallowNow: string[];
}

/**
 * The commit generations a fetch sends, plus the new and cleared shallow boundaries.
 * `depth` counts generations from the wants: depth 1 is the tip alone.
 */
function planShallow(repo: Repo, wants: readonly string[], depth: number, clientShallow: readonly string[]): ShallowPlan {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = wants.map((oid) => ({ oid, generation: 0 }));
  while (queue.length > 0) {
    const item = queue.shift() as { oid: string; generation: number };
    if (item.generation >= depth) continue;
    const known = generations.get(item.oid);
    if (known !== undefined && known <= item.generation) continue;
    generations.set(item.oid, item.generation);
    const object = repo.objects.get(item.oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      queue.push({ oid: parent, generation: item.generation + 1 });
    }
  }
  const commits = new Set(generations.keys());
  const boundary = new Set<string>();
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !commits.has(parent))) boundary.add(oid);
  }
  const clientSet = new Set(clientShallow);
  const shallowNow = [...boundary].filter((oid) => !clientSet.has(oid)).sort();
  const unshallowNow = [...clientSet].filter((oid) => commits.has(oid) && !boundary.has(oid)).sort();
  return { commits, shallowNow, unshallowNow };
}

/** Every object a shallow fetch sends: the included commits, their trees and blobs. */
function shallowObjects(repo: Repo, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const pushTree = (oid: string): void => {
    if (out.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    out.set(oid, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) pushTree(entry.oid);
    }
  };
  for (const oid of commits) {
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type === 'commit') pushTree(parseCommit(object.data).tree);
  }
  return out;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const chunk = 60_000;
  for (let at = 0; at < pack.length; at += chunk) {
    const slice = pack.subarray(at, Math.min(at + chunk, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return parts;
}

/**
 * Packs already built, keyed on what fully determines them. Git objects are content-addressed and
 * immutable, so the set reachable from a fixed want at a fixed depth is fixed forever: this cache
 * can never go stale, and the 50 concurrent shallow clones of one benchmark share one build.
 */
const PACK_CACHE = new Map<string, { pack: Buffer; shallowNow: string[]; unshallowNow: string[] }>();
const PACK_CACHE_MAX = 64;
let packCacheBytes = 0;
const PACK_CACHE_BYTES = 64 * 1024 * 1024;

function packCacheKey(repo: Repo, args: FetchArgs): string {
  const wants = [...args.wants].sort().join(',');
  const haves = [...args.haves].sort().join(',');
  const shallow = [...args.shallow].sort().join(',');
  return `${repo.id}|${wants}|${haves}|${shallow}|${args.deepen ?? 0}`;
}

function buildPackFor(repo: Repo, args: FetchArgs): { pack: Buffer; shallowNow: string[]; unshallowNow: string[] } {
  const key = packCacheKey(repo, args);
  const cached = PACK_CACHE.get(key);
  if (cached !== undefined) return cached;
  const built = buildPackUncached(repo, args);
  if (PACK_CACHE.size >= PACK_CACHE_MAX || packCacheBytes + built.pack.length > PACK_CACHE_BYTES) {
    PACK_CACHE.clear();
    packCacheBytes = 0;
  }
  PACK_CACHE.set(key, built);
  packCacheBytes += built.pack.length;
  return built;
}

function buildPackUncached(repo: Repo, args: FetchArgs): { pack: Buffer; shallowNow: string[]; unshallowNow: string[] } {
  const stopAt = new Set(args.haves);
  if (args.deepen !== null) {
    const plan = planShallow(repo, args.wants, args.deepen, args.shallow);
    const objects = shallowObjects(repo, plan.commits);
    const list = [...objects.entries()]
      .filter(([oid]) => !stopAt.has(oid))
      .map(([oid, object]) => ({ oid, type: object.type as ObjType, data: object.data }));
    return { pack: writePack(list), shallowNow: plan.shallowNow, unshallowNow: plan.unshallowNow };
  }
  const get = (oid: string) => repo.objects.get(oid);
  const reachable = collectReachable(get, args.wants, stopAt);
  // Objects the client already holds must not travel again, and that includes the trees and blobs
  // shared with the commits it has: stopping the walk at a `have` is not enough on its own.
  const held = stopAt.size === 0 ? new Map<string, GitObject>() : collectReachable(get, [...stopAt]);
  const list = [...reachable.entries()]
    .filter(([oid]) => !held.has(oid))
    .map(([oid, object]) => ({ oid, type: object.type as ObjType, data: object.data }));
  return { pack: writePack(list), shallowNow: [], unshallowNow: [] };
}

function handleLsRefs(repo: Repo, lines: readonly string[]): Buffer {
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of advertisedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name === 'HEAD') line += ` symref-target:${headTarget(repo)}`;
    if (ref.peeled !== undefined) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(`${line}\n`));
  }
  // An unborn HEAD is reported as `unborn HEAD symref-target:...` when the client asked for it.
  if (prefixes.some((prefix) => 'HEAD'.startsWith(prefix)) && repo.refs.get(headTarget(repo)) === undefined) {
    parts.push(pktLine(`unborn HEAD symref-target:${headTarget(repo)}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Assembled v2 fetch replies, keyed the same way as the packs they carry. */
const FETCH_V2_CACHE = new Map<string, Buffer>();
const FETCH_V2_CACHE_MAX = 64;

function handleFetchV2(repo: Repo, lines: readonly string[]): Buffer {
  const args = parseFetchArgs(lines);
  const cacheKey = packCacheKey(repo, args);
  const cached = FETCH_V2_CACHE.get(cacheKey);
  if (cached !== undefined) return cached;
  const body = assembleFetchV2(repo, args);
  if (FETCH_V2_CACHE.size >= FETCH_V2_CACHE_MAX) FETCH_V2_CACHE.clear();
  FETCH_V2_CACHE.set(cacheKey, body);
  return body;
}

function assembleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const { pack, shallowNow, unshallowNow } = buildPackFor(repo, args);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (shallowNow.length > 0 || unshallowNow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowNow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowNow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV0(repo: Repo, lines: readonly string[]): Buffer {
  const args = parseFetchArgs(lines);
  const { pack, shallowNow, unshallowNow } = buildPackFor(repo, args);
  const parts: Buffer[] = [];
  for (const oid of shallowNow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowNow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function gitUploadPack(store: Store, owner: string, name: string, body: Buffer, wantsV2: boolean): GitReply {
  const repo = store.find(owner, name);
  if (repo === null) return notFound();
  const packets = decodePkts(body);
  const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
  const command = lines.find((line) => line.startsWith('command='));
  if (wantsV2 && command !== undefined) {
    const name0 = command.slice('command='.length).trim();
    if (name0 === 'ls-refs') return result('git-upload-pack', handleLsRefs(repo, lines));
    if (name0 === 'fetch') return result('git-upload-pack', handleFetchV2(repo, lines));
    return result('git-upload-pack', Buffer.concat([pktLine('ERR unknown command\n'), PKT_FLUSH]));
  }
  return result('git-upload-pack', handleFetchV0(repo, lines));
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function parsePushCommands(body: Buffer): { commands: PushCommand[]; capabilities: string[]; packStart: number } {
  const commands: PushCommand[] = [];
  const capabilities: string[] = [];
  let at = 0;
  // Only the pkt-line block is framed; the packfile follows it raw, so the walk must stop at the
  // flush packet rather than run over the pack's "PACK" magic.
  while (at + 4 <= body.length) {
    const header = body.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      at += 4;
      break;
    }
    if (length < 4 || at + length > body.length) throw new Error('truncated pkt-line in a push request');
    const payload = body.subarray(at + 4, at + length);
    at += length;
    const text = payload.toString('utf8');
    const nul = text.indexOf('\u0000');
    const line = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
    if (nul >= 0) {
      for (const capability of text.slice(nul + 1).trim().split(' ')) if (capability !== '') capabilities.push(capability);
    }
    const [oldOid, newOid, ...rest] = line.split(' ');
    const ref = rest.join(' ');
    if (isOid(oldOid) && isOid(newOid) && ref.startsWith('refs/')) commands.push({ oldOid, newOid, ref });
  }
  return { commands, capabilities, packStart: at };
}

export function gitReceivePack(store: Store, owner: string, name: string, body: Buffer): GitReply {
  const repo = store.find(owner, name);
  if (repo === null) return notFound();
  const { commands, capabilities, packStart } = parsePushCommands(body);
  const sideband = capabilities.includes('side-band-64k');

  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(Math.min(packStart, body.length));
  if (commands.some((command) => command.newOid !== ZERO_OID) && packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const report: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      report.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) report.push(`ng ${command.ref} no such ref`);
      else {
        repo.refs.delete(command.ref);
        report.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} missing object ${command.newOid}`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        report.push(`ng ${command.ref} stale info`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
      continue;
    }
    if (current !== command.oldOid) {
      report.push(`ng ${command.ref} stale info`);
      continue;
    }
    if (!fastForward(repo, command.oldOid, command.newOid)) {
      report.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    report.push(`ok ${command.ref}`);
  }
  if (commands.some((command) => command.ref.startsWith('refs/heads/'))) repo.pushedAt = store.now();

  const reportLines = report.map((line) => pktLine(`${line}\n`));
  reportLines.push(PKT_FLUSH);
  const reportBytes = Buffer.concat(reportLines);
  if (!sideband) return result('git-receive-pack', reportBytes);
  const parts: Buffer[] = [];
  const chunk = 60_000;
  for (let at = 0; at < reportBytes.length; at += chunk) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(at, Math.min(at + chunk, reportBytes.length))])));
  }
  parts.push(PKT_FLUSH);
  return result('git-receive-pack', Buffer.concat(parts));
}

export { hashObject };
