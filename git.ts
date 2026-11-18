// git.ts — the git object model and packfile machinery for a small GitHub-compatible forge.
//
// Everything here is built on node:crypto (SHA-1) and node:zlib only: the trial pod has no git
// binary, so the forge hashes, stores, packs and unpacks git objects itself. Objects are kept
// in memory as their raw payload bytes (the bytes after the "<type> <size>\0" header); the id of
// an object is the SHA-1 of that header plus payload, exactly as git computes it.

import { createHash } from 'node:crypto';
import { createInflate, deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_IDS: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 id of an object payload, as git defines it. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** An in-memory object database: id -> object. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  has(oid: string): boolean {
    return this.objects.has(oid);
  }

  get(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  /** Store a payload and answer its id (storing the same payload twice is a no-op). */
  put(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putWithId(oid: string, type: GitObjectType, data: Buffer): void {
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
  }
}

// --------------------------------------------------------------------------- commits and trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  authorLine: string;
  committerLine: string;
}

/** Parse a commit payload into its tree, parents and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let authorLine = '';
  let committerLine = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
    else if (line.startsWith('committer ')) committerLine = line.slice(10);
  }
  return { tree, parents, message, authorLine, committerLine };
}

/** Build a commit payload from its parts. */
export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree payload: a run of "<mode> <name>\0<20-byte id>" entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) break;
    const mode = data.toString('ascii', offset, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1 || nul + 21 > data.length) break;
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree ordering: entries sort by name, directories as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize tree entries (sorted the way git sorts them) into a tree payload. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tag payload: the object it points at and its type. */
export function parseTag(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Follow tags (and answer commits directly) until a commit id comes back, or null. */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The commit a tag peels to (one level of peeling for advertisements), or null for non-tags. */
export function peelOne(store: ObjectStore, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

/** Every object reachable from the given tips (commits walk parents, trees walk entries, tags peel). */
export function collectReachable(store: ObjectStore, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/**
 * Walk commits from `tip` newest-first (a breadth walk by generation, parents in order),
 * answering each commit id once. Used for the REST commit list.
 */
export function walkCommits(store: ObjectStore, tip: string, limit = 1000): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0 && order.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** True when `ancestor` is reachable from `descendant` by following commit parents (or equal). */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits (first shared commit on a breadth walk), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stackA = [a];
  while (stackA.length > 0) {
    const oid = stackA.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    ancestorsOfA.add(oid);
    for (const parent of parseCommit(object.data).parents) stackA.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancestorsOfA.has(oid)) return oid;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

// --------------------------------------------------------------------------- tree <-> file map

export interface FileEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (recursively) into a map of slash paths to blob entries. */
export function flattenTree(store: ObjectStore, treeOid: string, prefix = '', out = new Map<string, FileEntry>()): Map<string, FileEntry> {
  const object = store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** The files of a commit: flatten its tree. */
export function filesOfCommit(store: ObjectStore, commitOid: string): Map<string, FileEntry> {
  const object = store.get(commitOid);
  if (object === undefined || object.type !== 'commit') return new Map();
  return flattenTree(store, parseCommit(object.data).tree);
}

/** Rebuild nested trees from a flat file map and store them; answers the root tree id. */
export function storeTreeFromFiles(store: ObjectStore, files: ReadonlyMap<string, FileEntry>): string {
  interface Dir {
    files: Map<string, FileEntry>;
    dirs: Map<string, Dir>;
  }
  const root: Dir = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of files) {
    const segments = path.split('/');
    let dir = root;
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        dir.dirs.set(segment, next);
      }
      dir = next;
    }
    dir.files.set(segments[segments.length - 1] as string, entry);
  }
  const writeDir = (dir: Dir): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of dir.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, sub] of dir.dirs) entries.push({ mode: '40000', name, oid: writeDir(sub) });
    return store.put('tree', buildTree(entries));
  };
  return writeDir(root);
}

// --------------------------------------------------------------------------- packfiles

/** The variable-length object header a pack entry starts with. */
function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let first = (TYPE_IDS[type] << 4) | (size & 0x0f);
  size = Math.floor(size / 16);
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size = Math.floor(size / 128);
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialize objects into a complete packfile (header, plain deflated objects, SHA-1 trailer). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    // Level 1: pack writing sits on the clone/fetch hot path, and a slightly larger pack is
    // cheaper than the CPU the higher levels spend squeezing it.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one pack entry whose compressed length is unknown. A zlib stream knows where its own
 * stream ends: feed it the rest of the pack and it reports exactly how many input bytes it
 * consumed (its bytesWritten), which is where the next entry begins. One stream per entry is
 * far cheaper than probing candidate windows with repeated synchronous inflates.
 */
function inflateEntry(pack: Buffer, offset: number, expectedSize: number): Promise<{ data: Buffer; nextOffset: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('end', () => {
      const data = Buffer.concat(chunks);
      const consumed = (stream as unknown as { bytesWritten: number }).bytesWritten;
      if (data.length !== expectedSize) {
        reject(new Error(`inflated to ${data.length}, expected ${expectedSize}`));
        return;
      }
      resolve({ data, nextOffset: offset + consumed });
    });
    stream.on('error', reject);
    stream.end(pack.subarray(offset));
  });
}

/** Apply a git delta payload to a base payload. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta base is ${base.length} bytes, delta expects ${sourceSize}`);
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      if (op & 0x01) { copyOffset = delta[offset] as number; offset += 1; }
      if (op & 0x02) { copyOffset |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x04) { copyOffset |= (delta[offset] as number) << 16; offset += 1; }
      if (op & 0x08) { copyOffset |= (delta[offset] as number) << 24; offset += 1; }
      if (op & 0x10) { copySize = delta[offset] as number; offset += 1; }
      if (op & 0x20) { copySize |= (delta[offset] as number) << 8; offset += 1; }
      if (op & 0x40) { copySize |= (delta[offset] as number) << 16; offset += 1; }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(parts);
  if (produced !== targetSize || out.length !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read every object out of a packfile into the store. Delta bases may live in the same pack or
 * already in the store (a thin pack). Answers the number of objects the pack carried.
 */
export async function readPackInto(store: ObjectStore, pack: Buffer): Promise<number> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  interface Pending { type: GitObjectType | 'ofs-delta' | 'ref-delta'; data: Buffer; baseOid?: string; baseOffset?: number }
  const pending: Pending[] = [];
  const entryOffsets: number[] = [];
  for (let index = 0; index < count; index += 1) {
    entryOffsets.push(offset);
    let byte = pack[offset] as number;
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | undefined;
    let baseOffset: number | undefined;
    if (typeId === 6) {
      let b = pack[offset] as number;
      offset += 1;
      let back = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset] as number;
        offset += 1;
        back = ((back + 1) << 7) | (b & 0x7f);
      }
      baseOffset = (entryOffsets[index] as number) - back;
    } else if (typeId === 7) {
      baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    }
    const inflated = await inflateEntry(pack, offset, size);
    offset = inflated.nextOffset;
    if (typeId === 6) pending.push({ type: 'ofs-delta', data: inflated.data, baseOffset });
    else if (typeId === 7) pending.push({ type: 'ref-delta', data: inflated.data, baseOid });
    else {
      const type = ID_TYPES[typeId];
      if (type === undefined) throw new Error(`pack entry type ${typeId} is not an object type`);
      pending.push({ type, data: inflated.data });
    }
  }
  // Resolve in passes: plain objects first, then deltas whose bases are known, until none move.
  const byOffset = new Map<number, string>();
  let progress = true;
  const remaining = new Set(pending.keys());
  while (remaining.size > 0 && progress) {
    progress = false;
    for (const index of [...remaining]) {
      const entry = pending[index] as Pending;
      if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
        const oid = store.put(entry.type, entry.data);
        byOffset.set(entryOffsets[index] as number, oid);
        remaining.delete(index);
        progress = true;
        continue;
      }
      let base: GitObject | undefined;
      if (entry.type === 'ref-delta' && entry.baseOid !== undefined) base = store.get(entry.baseOid);
      if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) {
        const baseOid = byOffset.get(entry.baseOffset);
        if (baseOid !== undefined) base = store.get(baseOid);
      }
      if (base === undefined) continue;
      const data = applyDelta(base.data, entry.data);
      const oid = store.put(base.type, data);
      byOffset.set(entryOffsets[index] as number, oid);
      remaining.delete(index);
      progress = true;
    }
  }
  if (remaining.size > 0) throw new Error(`${remaining.size} pack object(s) have unresolvable delta bases`);
  return count;
}

// --------------------------------------------------------------------------- pkt-lines

/** Encode one pkt-line payload (or pass 'flush' / 'delim' for the control packets). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer, start = 0): { packets: PktPacket[]; nextOffset: number } {
  const packets: PktPacket[] = [];
  let offset = start;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

/**
 * Decode pkt-lines up to and including the first flush packet, tolerating arbitrary bytes
 * after it (a receive-pack body continues with a raw packfile). Answers the packets and the
 * offset just past the flush, where the trailing bytes begin.
 */
export function decodePktLinesUntilFlush(buffer: Buffer): { packets: PktPacket[]; nextOffset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const head = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, nextOffset: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line overruns the body');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, nextOffset: offset };
}

/** Split a byte stream into sideband-64k pkt-lines: band byte + chunk, each packet within the cap. */
export function sidebandPackets(stream: Buffer, band = 1, chunkSize = 32768): Buffer[] {
  const packets: Buffer[] = [];
  for (let offset = 0; offset < stream.length; offset += chunkSize) {
    const chunk = stream.subarray(offset, Math.min(stream.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([band]), chunk]);
    packets.push(pktLine(payload));
  }
  if (packets.length === 0) packets.push(pktLine(Buffer.from([band])));
  return packets;
}
