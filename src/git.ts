// The git core: object store, tree/commit/tag encoding, pkt-lines, packfiles (read/write,
// deltas), the fetch planner (what a clone/fetch sends), ancestry, and tree diffs. No git
// binary, no outside service: every byte is built here, on node:crypto and node:zlib.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const PKT_LINE_MAX = 65520;
/** The largest pkt-line payload (length minus the 4-byte header). */
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;
/** The largest sideband data chunk: one band byte plus data inside one pkt-line. */
export const SIDEBAND_CHUNK = PKT_LINE_MAX_PAYLOAD - 1;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** SHA-1 of a buffer. */
export function sha1(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The object id of a git object: SHA-1 of "<type> <size>\0" + data. */
export function objectId(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

/** An in-memory object store: id -> object. */
export class ObjectStore {
  private map = new Map<string, GitObject>();

  /** Store an object, returning its id (idempotent). */
  put(type: GitObjectType, data: Buffer): string {
    const id = objectId(type, data);
    if (!this.map.has(id)) this.map.set(id, { type, data });
    return id;
  }

  /** Store an object under a known id (used when unpacking a pack). */
  putExisting(id: string, type: GitObjectType, data: Buffer): void {
    if (!this.map.has(id)) this.map.set(id, { type, data });
  }

  get(id: string): GitObject | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }
}

// -------------------------------------------------------------------------------------------------
// Trees, commits, tags
// -------------------------------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

/** Sort key: directories compare as name + '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Parse a tree object into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode');
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) throw new Error('tree entry has no name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('tree entry has no object id');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    offset = nul + 21;
  }
  return entries;
}

/** Serialize tree entries (sorted git's way) into a tree object. */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitData {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Header lines up to the blank line, then the message. */
export function parseCommit(data: Buffer): CommitData {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialize a commit object, byte-exact for the fields given. */
export function buildCommit(commit: CommitData): Buffer {
  const lines: string[] = [`tree ${commit.tree}`];
  for (const parent of commit.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${commit.author}`);
  lines.push(`committer ${commit.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${commit.message}`, 'utf8');
}

export interface TagData {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. */
export function parseTag(data: Buffer): TagData {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Serialize an annotated tag object. */
export function buildTag(tag: TagData): Buffer {
  const lines = [`object ${tag.object}`, `type ${tag.type}`, `tag ${tag.tag}`, `tagger ${tag.tagger}`];
  return Buffer.from(`${lines.join('\n')}\n\n${tag.message}`, 'utf8');
}

/** An identity line: "Name <email> epochSec +0000". */
export function identLine(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// -------------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------------

export type GitPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' };

/** One pkt-line: 4 hex digits of length (including the 4) + payload. */
export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  if (payload.length > PKT_LINE_MAX_PAYLOAD) {
    throw new Error(`pkt-line payload is ${payload.length} bytes, over the ${PKT_LINE_MAX_PAYLOAD}-byte maximum`);
  }
  const length = payload.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktLineFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktLineDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

/** Encode a list of pkt-line items ('flush' / 'delim' or a string/Buffer payload). */
export function encodePktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktLineFlush());
    else if (item === 'delim') parts.push(pktLineDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode a whole buffer of pkt-lines. */
export function decodePktLines(buffer: Buffer): GitPacket[] {
  const packets: GitPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line header is truncated');
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('pkt-line header is not hex');
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line is truncated');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Frame data into sideband packets (band byte + chunk), each a pkt-line. */
export function sidebandPackets(band: 1 | 2 | 3, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  if (data.length === 0) return out;
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// Packfiles
// -------------------------------------------------------------------------------------------------

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++] as number;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++] as number;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Inflate one zlib stream at `offset`; returns its bytes and the offset just past the stream. */
export function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (the copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[offset++] as number;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++] as number;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= delta.length) throw new Error('delta copy size is truncated');
          copySize += (delta[offset++] as number) * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
  checksumOk: boolean;
}

/**
 * Read a packfile (version 2 or 3) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base object a thin pack leaves out (the client already has it).
 * Every object's SHA-1 is recomputed and its declared size checked.
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computedTrailer = sha1(pack.subarray(0, trailerStart));
  const checksumOk = trailer === computedTrailer;

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      if (base.baseOffset <= 0 || base.baseOffset > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset ${base.baseOffset}`);
      }
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const objects = new Map<string, GitObject>();
  const resolving = new Set<number>();
  const resolvedByOid = new Map<string, RawEntry>();
  let deltaCount = 0;

  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      deltaCount += 1;
      const baseEntry = byOffset.get(entry.baseOffset as number);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      deltaCount += 1;
      const wanted = entry.baseOid as string;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) {
          throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied by the client`);
        }
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode] as GitObjectType;
      data = entry.data;
    }
    const oid = objectId(type, data);
    entry.resolvedType = type;
    entry.resolved = data;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return { objects, deltaCount, checksumOk };
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Buffer): string {
  if (pack.length < 20) throw new Error('pack is shorter than its trailer');
  return sha1(pack.subarray(0, pack.length - 20));
}

/** Whether a pack's trailer SHA-1 matches its bytes. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  const expected = packChecksum(pack);
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: actual === expected, actual, expected };
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const typeCode = TYPE_CODE[type];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size === 0) return Buffer.from([first]);
  const bytes: number[] = [first | 0x80];
  while (size > 0) {
    const byte = size & 0x7f;
    size >>>= 7;
    bytes.push(size > 0 ? byte | 0x80 : byte);
  }
  return Buffer.from(bytes);
}

/** Write a packfile of full objects only (no deltas), version 2, with a valid trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// -------------------------------------------------------------------------------------------------
// Reachability, ancestry, fetch planning
// -------------------------------------------------------------------------------------------------

/** All commits reachable from `tips` (following parents), including the tips. */
export function reachableCommits(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return seen;
}

/**
 * Every object reachable from `tips` (commits, their trees and blobs, tags and their targets).
 * `maxDepth` limits how many commits from a tip are included (1 = the tip only); null walks all.
 */
export function reachableObjects(
  store: ObjectStore,
  tips: Iterable<string>,
  maxDepth: number | null,
): { objects: Map<string, GitObject>; commits: Set<string>; boundaries: Set<string> } {
  const objects = new Map<string, GitObject>();
  const commits = new Set<string>();
  const boundaries = new Set<string>();
  // Depth-first from each tip, tracking distance from the nearest tip. The queue is
  // walked with an index, not shift(): shift() re-indexes the whole array on every
  // pop, which turns a 200-commit walk quadratic. (v2 perf.)
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const tip of tips) queue.push({ oid: tip, depth: 0 });
  let queueHead = 0;
  const visitedCommits = new Map<string, number>();
  const addObject = (oid: string): void => {
    const object = store.get(oid);
    if (object !== undefined && !objects.has(oid)) objects.set(oid, object);
  };
  const addTree = (treeSha: string): void => {
    addObject(treeSha);
    const object = store.get(treeSha);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      addObject(entry.sha);
      if (entry.mode === '40000') addTree(entry.sha);
    }
  };
  while (queueHead < queue.length) {
    const { oid, depth } = queue[queueHead] as { oid: string; depth: number };
    queueHead += 1;
    const known = visitedCommits.get(oid);
    if (known !== undefined && known <= depth) continue;
    visitedCommits.set(oid, depth);
    const object = store.get(oid);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      addObject(oid);
      const tag = parseTag(object.data);
      queue.push({ oid: tag.object, depth });
      continue;
    }
    if (object.type !== 'commit') continue;
    commits.add(oid);
    addObject(oid);
    const commit = parseCommit(object.data);
    addTree(commit.tree);
    const cut = maxDepth !== null && depth + 1 >= maxDepth;
    if (cut) {
      if (commit.parents.length > 0) boundaries.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, depth: depth + 1 });
  }
  return { objects, commits, boundaries };
}

/** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Walk down from the descendant and stop the moment the ancestor is found. A
  // fast-forward check only needs that answer, not the whole reachable history: the
  // old form walked every reachable commit first, so each push on a 200-deep branch
  // paid for all 200 commits even though its old tip is usually the direct parent.
  // (v2 perf: this is the push workload's hot path — 200 sequential pushes.)
  const seen = new Set<string>();
  const stack: string[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (oid === ancestor) return true;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The merge base of two commits: the first common ancestor found walking from `b`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = reachableCommits(store, [a]);
  const queue: string[] = [b];
  let queueHead = 0;
  const seen = new Set<string>();
  while (queueHead < queue.length) {
    const oid = queue[queueHead] as string;
    queueHead += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

export interface FetchPlan {
  /** Objects to send, self-contained (no deltas, nothing the client already holds). */
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

/**
 * Plan a fetch: which objects the client still needs, which boundaries are new, which old
 * boundaries are now regular commits, and the ACK/NAK negotiation answer.
 */
export function computeFetch(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth: number | null,
  shallowBoundaries: string[],
): FetchPlan {
  // What the client already holds: every object reachable from its haves — except that a
  // have named as a shallow boundary is held only as that commit and its tree, not its
  // parents: the client has a shallow clone, so its history stops at the boundary. Without
  // this, a deepen would conclude the parent is already held and send nothing.
  const shallowSet = new Set(shallowBoundaries);
  const heldIds = new Set<string>();
  for (const have of haves) {
    const held = shallowSet.has(have)
      ? reachableObjects(store, [have], 1)
      : reachableObjects(store, [have], null);
    for (const oid of held.objects.keys()) heldIds.add(oid);
  }
  // What the wants reach, within the depth limit.
  const wanted = reachableObjects(store, wants, depth);
  const objects = new Map<string, GitObject>();
  for (const [oid, object] of wanted.objects) {
    if (!heldIds.has(oid)) objects.set(oid, object);
  }
  // Boundaries the depth cut created, minus ones the client already holds as regular history.
  const shallow = [...wanted.boundaries].filter((oid) => !heldIds.has(oid));
  // Old boundaries that are now included and are no longer boundaries.
  const unshallow = shallowBoundaries.filter(
    (oid) => wanted.commits.has(oid) && !wanted.boundaries.has(oid),
  );
  // Negotiation: ACK every have we hold; NAK when none are held.
  const acks: string[] = [];
  for (const have of haves) {
    if (store.has(have)) acks.push(have);
  }
  const nak = haves.length === 0 || acks.length === 0;
  return { objects, shallow, unshallow, acks, nak };
}

// -------------------------------------------------------------------------------------------------
// Tree paths and diffs
// -------------------------------------------------------------------------------------------------

export interface PathEntry {
  mode: string;
  name: string;
  sha: string;
  type: GitObjectType;
}

/** The entry at `path` under a tree (or null when absent). */
export function getEntryAtPath(store: ObjectStore, rootTreeSha: string | null, path: string): PathEntry | null {
  if (rootTreeSha === null) return null;
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return null;
  let treeSha: string | null = rootTreeSha;
  for (let index = 0; index < parts.length; index += 1) {
    if (treeSha === null) return null;
    const object = store.get(treeSha);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((item) => item.name === parts[index]);
    if (entry === undefined) return null;
    if (index === parts.length - 1) {
      const target = store.get(entry.sha);
      return { mode: entry.mode, name: entry.name, sha: entry.sha, type: target?.type ?? 'blob' };
    }
    if (entry.mode !== '40000') return null;
    treeSha = entry.sha;
  }
  return null;
}

/** Every file (blob) under a tree, keyed by path. */
export function flattenTree(store: ObjectStore, rootTreeSha: string | null, prefix = ''): Map<string, PathEntry> {
  const out = new Map<string, PathEntry>();
  if (rootTreeSha === null) return out;
  const walk = (treeSha: string, base: string): void => {
    const object = store.get(treeSha);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.sha, path);
      else out.set(path, { mode: entry.mode, name: entry.name, sha: entry.sha, type: 'blob' });
    }
  };
  walk(rootTreeSha, prefix);
  return out;
}

/**
 * A new root tree with `path` set to `blobSha` (creating intermediate trees). Returns the new
 * root tree's id. `rootTreeSha` may be null for an empty tree.
 */
export function setPath(store: ObjectStore, rootTreeSha: string | null, path: string, blobSha: string): string {
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) throw new Error('cannot set an empty path');
  const build = (treeSha: string | null, index: number): string => {
    const entries = treeSha === null ? [] : parseTree(store.get(treeSha)?.data ?? Buffer.alloc(0));
    const name = parts[index] as string;
    const last = index === parts.length - 1;
    const next: TreeEntry[] = [];
    let found = false;
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      found = true;
      if (last) next.push({ mode: '100644', name, sha: blobSha });
      else {
        const child = build(entry.mode === '40000' ? entry.sha : null, index + 1);
        next.push({ mode: '40000', name, sha: child });
      }
    }
    if (!found) {
      if (last) next.push({ mode: '100644', name, sha: blobSha });
      else {
        const child = build(null, index + 1);
        next.push({ mode: '40000', name, sha: child });
      }
    }
    return store.put('tree', buildTree(next));
  };
  return build(rootTreeSha, 0);
}

/**
 * A new root tree with `path` removed (pruning directories left empty). Returns the new root
 * tree's id, or null when the tree becomes empty.
 */
export function removePath(store: ObjectStore, rootTreeSha: string | null, path: string): string | null {
  if (rootTreeSha === null) return null;
  const parts = path.split('/').filter((part) => part !== '');
  if (parts.length === 0) return rootTreeSha;
  const build = (treeSha: string, index: number): string | null => {
    const entries = parseTree(store.get(treeSha)?.data ?? Buffer.alloc(0));
    const name = parts[index] as string;
    const last = index === parts.length - 1;
    const next: TreeEntry[] = [];
    for (const entry of entries) {
      if (entry.name !== name) {
        next.push(entry);
        continue;
      }
      if (last) continue;
      if (entry.mode !== '40000') continue;
      const child = build(entry.sha, index + 1);
      if (child !== null) next.push({ mode: '40000', name, sha: child });
    }
    if (next.length === 0) return null;
    return store.put('tree', buildTree(next));
  };
  return build(rootTreeSha, 0);
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Count lines in a blob's text (a trailing newline does not make an extra line). */
export function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** Line counts between two blob versions, by multiset difference. */
function lineDiff(baseData: Buffer | null, headData: Buffer | null): { additions: number; deletions: number } {
  const baseLines = baseData === null ? [] : baseData.toString('utf8').split('\n');
  const headLines = headData === null ? [] : headData.toString('utf8').split('\n');
  const trim = (lines: string[]): string[] => {
    const copy = lines.slice();
    if (copy.length > 0 && copy[copy.length - 1] === '') copy.pop();
    return copy;
  };
  const baseCounts = new Map<string, number>();
  for (const line of trim(baseLines)) baseCounts.set(line, (baseCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of trim(headLines)) {
    const remaining = baseCounts.get(line) ?? 0;
    if (remaining > 0) baseCounts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of baseCounts.values()) deletions += remaining;
  return { additions, deletions };
}

/** The file changes between two trees (null = the empty tree). */
export function diffTrees(store: ObjectStore, baseTreeSha: string | null, headTreeSha: string | null): FileChange[] {
  const base = flattenTree(store, baseTreeSha);
  const head = flattenTree(store, headTreeSha);
  const changes: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const baseEntry = base.get(path);
    const headEntry = head.get(path);
    if (baseEntry !== undefined && headEntry === undefined) {
      const data = store.get(baseEntry.sha)?.data ?? null;
      const deletions = data === null ? 0 : countLines(data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (baseEntry === undefined && headEntry !== undefined) {
      const data = store.get(headEntry.sha)?.data ?? null;
      const additions = data === null ? 0 : countLines(data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (baseEntry !== undefined && headEntry !== undefined && baseEntry.sha !== headEntry.sha) {
      const baseData = store.get(baseEntry.sha)?.data ?? null;
      const headData = store.get(headEntry.sha)?.data ?? null;
      const { additions, deletions } = lineDiff(baseData, headData);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}
