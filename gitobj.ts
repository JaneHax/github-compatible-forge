// Git object model, pkt-line framing, pack read/write. Standard library only.
//
// Everything here is deterministic: no clock, no randomness. Object ids are sha1 over
// "<type> <len>\0<data>", exactly as git computes them.

import { createHash } from 'node:crypto';
import { deflateSync, inflateRawSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
export const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && HEX40.test(value);
}

export function sha1(...parts: Array<Buffer | string>): string {
  const hash = createHash('sha1');
  for (const part of parts) hash.update(typeof part === 'string' ? Buffer.from(part, 'utf8') : part);
  return hash.digest('hex');
}

/** The canonical header git hashes in front of every object's bytes. */
export function objectHeader(type: ObjType, length: number): Buffer {
  return Buffer.from(`${type} ${length}\u0000`, 'utf8');
}

export function hashObject(type: ObjType, data: Buffer): string {
  return sha1(objectHeader(type, data.length), data);
}

// ---------------------------------------------------------------- pkt-line

export const PKT_MAX = 65520;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length + 4 > PKT_MAX) throw new Error(`pkt-line payload ${body.length} is too long`);
  const header = (body.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface Pkt {
  readonly kind: 'data' | 'flush' | 'delim' | 'response-end';
  readonly payload: Buffer;
}

/** Decode a pkt-line stream; a truncated tail is ignored the way git ignores it. */
export function decodePkts(input: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let at = 0;
  while (at + 4 <= input.length) {
    const header = input.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line length ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > input.length) break;
    out.push({ kind: 'data', payload: input.subarray(at + 4, at + length) });
    at += length;
  }
  return out;
}

/** The pkt-line stream split into text lines, control packets dropped. */
export function pktTexts(input: Buffer): string[] {
  return decodePkts(input)
    .filter((p) => p.kind === 'data')
    .map((p) => p.payload.toString('utf8'));
}

// ---------------------------------------------------------------- tree / commit

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let at = 0;
  while (at < data.length) {
    const space = data.indexOf(0x20, at);
    if (space < 0) break;
    const mode = data.subarray(at, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    at = nul + 21;
  }
  return entries;
}

/** Tree entries are sorted by name with directories compared as `name + '/'`. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode.startsWith('4') ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
  readonly extra: string[];
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  const extra: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
    else if (line.length > 0) extra.push(line);
  }
  return { tree, parents, author, committer, message, extra };
}

export interface BuildCommitFields {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** The identity the suite's own fixture commits use, so pushed objects look ordinary. */
export const CONFORMANCE_IDENTITY = 'Conformance <conformance@makefun.invalid> 1735689600 +0000';

// ---------------------------------------------------------------- pack reading

const TYPE_COMMIT = 1;
const TYPE_TREE = 2;
const TYPE_BLOB = 3;
const TYPE_TAG = 4;
const TYPE_OFS_DELTA = 6;
const TYPE_REF_DELTA = 7;

const CODE_TO_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const TYPE_TO_CODE: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value >>> 0;
  };
  const baseSize = readVarint();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
  const resultSize = readVarint();
  const out = Buffer.allocUnsafe(resultSize);
  let written = 0;
  while (at < delta.length) {
    const op = delta[at];
    at += 1;
    if (op === 0) throw new Error('delta opcode 0 is reserved');
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset |= delta[at]; at += 1; }
      if (op & 0x02) { offset |= delta[at] << 8; at += 1; }
      if (op & 0x04) { offset |= delta[at] << 16; at += 1; }
      if (op & 0x08) { offset |= delta[at] << 24; at += 1; }
      if (op & 0x10) { size |= delta[at]; at += 1; }
      if (op & 0x20) { size |= delta[at] << 8; at += 1; }
      if (op & 0x40) { size |= delta[at] << 16; at += 1; }
      if (size === 0) size = 0x10000;
      base.copy(out, written, offset, offset + size);
      written += size;
      continue;
    }
    const literal = op;
    delta.copy(out, written, at, at + literal);
    at += literal;
    written += literal;
  }
  if (written !== resultSize) throw new Error(`delta produced ${written} bytes, expected ${resultSize}`);
  return out;
}

export interface PackRead {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/** Read a packfile into loose objects, resolving OFS_DELTA and REF_DELTA. */
export function readPack(pack: Buffer, resolveExternal?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 32) throw new Error('pack is shorter than its header and trailer');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const end = pack.length - 20;
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let deltaCount = 0;
  let at = 12;
  for (let index = 0; index < count; index += 1) {
    const start = at;
    let byte = pack[at];
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[at];
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    if (typeCode === TYPE_OFS_DELTA) {
      let byte2 = pack[at];
      at += 1;
      let offset = byte2 & 0x7f;
      while ((byte2 & 0x80) !== 0) {
        byte2 = pack[at];
        at += 1;
        offset = ((offset + 1) << 7) | (byte2 & 0x7f);
      }
      const baseOffset = start - offset;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error(`ofs-delta base at ${baseOffset} is not in this pack`);
      const base_inflated = inflateAt(pack.subarray(at));
      at += base_inflated.consumed;
      const data = applyDelta(base.data, base_inflated.data);
      byOffset.set(start, { type: base.type, data });
      objects.set(hashObject(base.type, data), { type: base.type, data });
      deltaCount += 1;
      continue;
    }
    if (typeCode === TYPE_REF_DELTA) {
      const baseOid = pack.subarray(at, at + 20).toString('hex');
      at += 20;
      const base = objects.get(baseOid) ?? resolveExternal?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is missing`);
      const ref_inflated = inflateAt(pack.subarray(at));
      at += ref_inflated.consumed;
      const data = applyDelta(base.data, ref_inflated.data);
      byOffset.set(start, { type: base.type, data });
      objects.set(hashObject(base.type, data), { type: base.type, data });
      deltaCount += 1;
      continue;
    }
    const type = CODE_TO_TYPE[typeCode];
    if (type === undefined) throw new Error(`unsupported pack object type ${typeCode}`);
    const plain = inflateAt(pack.subarray(at));
    at += plain.consumed;
    const inflated = plain.data;
    if (inflated.length !== size) throw new Error(`object ${index} inflated to ${inflated.length} bytes, header said ${size}`);
    byOffset.set(start, { type, data: inflated });
    objects.set(hashObject(type, inflated), { type, data: inflated });
  }
  if (at !== end) throw new Error(`pack body ended at ${at}, trailer starts at ${end}`);
  const expected = pack.subarray(end).toString('hex');
  const actual = sha1(pack.subarray(0, end));
  if (expected !== actual) throw new Error(`pack trailer ${expected} does not match its bytes ${actual}`);
  return { objects, deltaCount };
}

/**
 * Inflate the zlib stream at the start of `input` and report how many input bytes it consumed.
 * Node's `info: true` hands back the engine, whose `bytesWritten` is exactly that count; walking
 * the stream by hand is neither correct nor fast enough for a 200-push workload.
 */
function inflateAt(input: Buffer): { data: Buffer; consumed: number } {
  type Inflated = { buffer: Buffer; engine: { bytesWritten: number } };
  // The suite's client writes object streams with zlib.deflateSync (a zlib wrapper); a real git
  // binary would use raw deflate. Accept both, zlib first, so either producer reads back.
  for (const inflate of [inflateSync, inflateRawSync]) {
    try {
      const result = inflate(input, { info: true }) as unknown as Inflated;
      if (!result || !result.engine || !result.buffer) continue;
      const consumed = result.engine.bytesWritten;
      if (consumed <= 0) continue;
      return { data: result.buffer, consumed };
    } catch {
      continue;
    }
  }
  throw new Error('object stream did not inflate as zlib or raw deflate');
}

export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  return sha1(pack.subarray(0, pack.length - 20)) === expected;
}

// ---------------------------------------------------------------- pack writing

function packObjectHeader(type: ObjType, size: number): Buffer {
  const bytes: number[] = [];
  let byte = (TYPE_TO_CODE[type] << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(byte | 0x80);
    byte = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(byte);
  return Buffer.from(bytes);
}

/** A packfile of full objects (no deltas), which every client accepts. */
export function writePack(objects: readonly { oid?: string; type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1(body), 'hex')]);
}

/** Every object reachable from `tips`, tips first. Deterministic order. */
export function collectReachable(
  get: (oid: string) => GitObject | undefined,
  tips: readonly string[],
  stopAt?: ReadonlySet<string>,
): Map<string, GitObject> {
  const seen = new Map<string, GitObject>();
  const queue: string[] = [];
  for (const tip of tips) if (!seen.has(tip) && !stopAt?.has(tip)) queue.push(tip);
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid) || stopAt?.has(oid)) continue;
    const object = get(oid);
    if (object === undefined) continue;
    seen.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) if (!seen.has(parent)) queue.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) queue.push(entry.oid);
    } else if (object.type === 'tag') {
      const text = object.data.toString('utf8');
      const objectLine = text.split('\n').find((line) => line.startsWith('object '));
      if (objectLine) queue.push(objectLine.slice(7).trim());
    }
  }
  return seen;
}

/** True when `ancestor` is reachable from `descendant` by following parent links. */
export function isAncestor(
  get: (oid: string) => GitObject | undefined,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}
