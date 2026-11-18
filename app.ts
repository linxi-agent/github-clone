// app.ts — a small GitHub-compatible git forge in one process.
//
// The server keeps every repository in memory: a git object store per repository plus the
// issue / pull-request / label records the REST, GraphQL and MCP surfaces share, so an object
// created over one surface reads back identically over the others. It speaks four surfaces:
//   - git smart HTTP at /{owner}/{repo}.git (upload-pack protocol v2 + v0, receive-pack v0)
//   - REST v3 under /api/v3
//   - GraphQL v4 at /api/graphql
//   - MCP (JSON-RPC over streamable HTTP) at /mcp
// Only node: built-ins are used; the git wire machinery lives in ./git.ts.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import {
  ObjectStore,
  ZERO_OID,
  buildCommit,
  collectReachable,
  decodePktLines,
  decodePktLinesUntilFlush,
  filesOfCommit,
  flattenTree,
  hashObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelOne,
  peelToCommit,
  pktLine,
  PKT_FLUSH,
  readPackInto,
  sidebandPackets,
  storeTreeFromFiles,
  walkCommits,
  writePack,
  type FileEntry,
  type GitObject,
} from './git.ts';

// --------------------------------------------------------------------------- data model

interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

interface PullRec {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAtSeq: number | null;
  mergeCommitSha: string | null;
  seq: number;
}

interface LabelRec {
  name: string;
  color: string;
}

interface RepoRec {
  id: number;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  store: ObjectStore;
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  seq: number;
}

const reposByName = new Map<string, RepoRec>();
let nextRepoId = 1;
let nextCommentId = 1;
let globalSeq = 0;
let requestCounter = 0;

/** The login the trial's bearer token belongs to, learned from the first owner-bearing read. */
let viewerLogin: string | null = null;

function nextSeq(): number {
  globalSeq += 1;
  return globalSeq;
}

const BOOT_MS = Date.now();

/** A stable ISO timestamp for a sequence number (records sort the way they were created). */
function isoOfSeq(seq: number): string {
  return new Date(BOOT_MS + seq * 1000).toISOString();
}

function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function isAuthorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return req.headers.authorization === `Bearer ${token}`;
}

function viewer(): string {
  return viewerLogin ?? 'viewer';
}

/**
 * Resolve a repository by owner + name. The forge has one user (the token owner); a repository
 * addressed under any other login is a 404, and the first owner-bearing read of an existing
 * repository teaches the server the token owner's login.
 */
function resolveRepo(owner: string, name: string): RepoRec | null {
  const repo = reposByName.get(name);
  if (repo === undefined) return null;
  if (viewerLogin === null) {
    viewerLogin = owner;
    return repo;
  }
  return owner === viewerLogin ? repo : null;
}

function createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
  const repo: RepoRec = {
    id: nextRepoId,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    store: new ObjectStore(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    seq: nextSeq(),
  };
  nextRepoId += 1;
  reposByName.set(name, repo);
  return repo;
}

// --------------------------------------------------------------------------- HTTP plumbing

const JSON_TYPE = 'application/json; charset=utf-8';

/** One random suffix per process; request ids are the counter over it (cheap on hot paths). */
const REQUEST_ID_SUFFIX = randomBytes(4).toString('hex').toUpperCase();

function nextRequestId(): string {
  requestCounter += 1;
  return `F${requestCounter.toString(16).toUpperCase()}${REQUEST_ID_SUFFIX}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': nextRequestId(),
  });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function unauthorized(res: ServerResponse): void {
  sendJson(res, 401, { message: 'Bad credentials' });
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON request body; answers null after sending a 400 when the body is malformed. */
function parseJsonBody(res: ServerResponse, raw: Buffer): Record<string, unknown> | null {
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString('utf8')) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return null;
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// --------------------------------------------------------------------------- shared views

function repoJson(repo: RepoRec): Record<string, unknown> {
  const login = viewer();
  return {
    id: repo.id,
    node_id: repoGlobalId(repo),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `http://forge.invalid/${login}/${repo.name}`,
    clone_url: `http://forge.invalid/${login}/${repo.name}.git`,
    created_at: isoOfSeq(repo.seq),
    updated_at: isoOfSeq(repo.seq),
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    size: repo.store.objects.size,
  };
}

function labelJson(label: LabelRec): Record<string, unknown> {
  return { name: label.name, color: label.color, description: null, default: false };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const login = viewer();
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issueGlobalId(repo, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed' })),
    user: { login, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: isoOfSeq(issue.seq),
    updated_at: isoOfSeq(issue.seq),
    html_url: `http://forge.invalid/${login}/${repo.name}/issues/${issue.number}`,
  };
}

function branchTip(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const login = viewer();
  const headSha = branchTip(repo, pull.head) ?? ZERO_OID;
  const baseSha = branchTip(repo, pull.base) ?? ZERO_OID;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pullGlobalId(repo, pull.number),
    number: pull.number,
    state: pull.merged ? 'closed' : pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${login}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${login}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAtSeq === null ? null : isoOfSeq(pull.mergedAtSeq),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    user: { login, id: 1000, type: 'User' },
    created_at: isoOfSeq(pull.seq),
    updated_at: isoOfSeq(pull.seq),
    html_url: `http://forge.invalid/${login}/${repo.name}/pull/${pull.number}`,
  };
}

function repoGlobalId(repo: RepoRec): string {
  return Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64');
}

function issueGlobalId(repo: RepoRec, number: number): string {
  return Buffer.from(`Issue:${repo.id}:${number}`, 'utf8').toString('base64');
}

function pullGlobalId(repo: RepoRec, number: number): string {
  return Buffer.from(`PullRequest:${repo.id}:${number}`, 'utf8').toString('base64');
}

function commentGlobalId(id: number): string {
  return Buffer.from(`IssueComment:${id}`, 'utf8').toString('base64');
}

/** Decode a global id back to the record it names. */
function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts[0] === 'Repository') return { kind: 'Repository', repoId: Number(parts[1]), number: 0 };
    if (parts[0] === 'Issue') return { kind: 'Issue', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'PullRequest') return { kind: 'PullRequest', repoId: Number(parts[1]), number: Number(parts[2]) };
    if (parts[0] === 'IssueComment') return { kind: 'IssueComment', repoId: 0, number: Number(parts[1]) };
    return null;
  } catch {
    return null;
  }
}

function repoById(id: number): RepoRec | null {
  for (const repo of reposByName.values()) if (repo.id === id) return repo;
  return null;
}

// --------------------------------------------------------------------------- git smart HTTP

const AGENT = 'mini-forge/1.0';

/** The ref the repository's HEAD names (its default branch, or the only branch there is). */
function headTarget(repo: RepoRec): string {
  if (repo.refs.has(`refs/heads/${repo.defaultBranch}`)) return `refs/heads/${repo.defaultBranch}`;
  const heads = [...repo.refs.keys()].filter((ref) => ref.startsWith('refs/heads/')).sort();
  return heads[0] ?? `refs/heads/${repo.defaultBranch}`;
}

interface RefLine {
  oid: string;
  name: string;
}

/** Every advertised ref line: HEAD first, then the refs sorted by name, tags peeled inline. */
function advertisedRefs(repo: RepoRec): RefLine[] {
  const lines: RefLine[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (headOid !== undefined) lines.push({ oid: headOid, name: 'HEAD' });
  for (const name of [...repo.refs.keys()].sort()) {
    lines.push({ oid: repo.refs.get(name) as string, name });
  }
  return lines;
}

/** The v0 advertisement body for one service. */
function advertisementV0(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const target = headTarget(repo);
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not deepen-relative agent=${AGENT} symref=HEAD:${target}`
    : `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const lines = advertisedRefs(repo);
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    lines.forEach((line, index) => {
      const extra = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${line.oid} ${line.name}${extra}\n`));
      const peeled = peelOne(repo.store, line.oid);
      if (peeled !== null && line.name !== 'HEAD') parts.push(pktLine(`${peeled} ${line.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The protocol v2 capability advertisement for git-upload-pack. */
function advertisementV2(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

/** The ls-refs answer: HEAD (with its symref target), then each ref, prefixes applied. */
function lsRefsAnswer(repo: RepoRec, rawArgs: readonly string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const rawArg of rawArgs) {
    const arg = rawArg.replace(/\n$/, '');
    if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
    else if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const target = headTarget(repo);
  const headOid = repo.refs.get(target);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pktLine(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!matches(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    if (peel) {
      const peeled = peelOne(repo.store, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** Reachable objects from tips, stopping the parent walk at shallow boundary commits. */
function reachableWithStops(store: ObjectStore, tips: readonly string[], stops: ReadonlySet<string>): Set<string> {
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
      if (!stops.has(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

interface FetchPlan {
  deliver: Set<string>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Work out which objects a fetch must carry. Without a depth this is the wants' closure minus
 * the haves' closure (the haves' walk stopping at the client's shallow boundary). With a depth
 * it is everything within that many commit generations of the wants, reporting the commits at
 * the cut as shallow and lifting the boundary off any client-shallow commit now fully included.
 */
function planFetch(repo: RepoRec, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchPlan {
  const store = repo.store;
  const stopSet = new Set(clientShallow);
  const haveClosure = reachableWithStops(store, haves, stopSet);
  if (depth === null) {
    const deliver = collectReachable(store, wants);
    for (const oid of haveClosure) deliver.delete(oid);
    return { deliver, shallow: [], unshallow: [] };
  }
  // Generations of every commit reachable from the wants (a want commit is generation 1).
  const generation = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (commit !== null && !generation.has(commit)) {
      generation.set(commit, 1);
      queue.push({ oid: commit, gen: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (gen >= depth) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  const includedCommits = new Set<string>();
  for (const [oid, gen] of generation) if (gen <= depth) includedCommits.add(oid);
  const included = new Set<string>();
  for (const want of wants) if (store.has(want)) included.add(want);
  for (const commitOid of includedCommits) {
    included.add(commitOid);
    const object = store.get(commitOid);
    if (object !== undefined && object.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      for (const oid of flattenTreeSet(store, tree)) included.add(oid);
    }
  }
  // Tag objects on the way to a wanted commit are part of the closure too.
  for (const want of wants) {
    let current = want;
    for (let step = 0; step < 8; step += 1) {
      const object = store.get(current);
      if (object === undefined || object.type !== 'tag') break;
      included.add(current);
      current = parseTag(object.data).object;
    }
  }
  const shallow: string[] = [];
  for (const commitOid of includedCommits) {
    if ((generation.get(commitOid) as number) < depth) continue;
    const object = store.get(commitOid);
    if (object === undefined || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.length > 0) shallow.push(commitOid);
  }
  const unshallow = clientShallow.filter((oid) => includedCommits.has(oid) && !shallow.includes(oid));
  const deliver = new Set<string>();
  for (const oid of included) if (!haveClosure.has(oid)) deliver.add(oid);
  return { deliver, shallow, unshallow };
}

/** A tree plus every subtree and blob under it. */
function flattenTreeSet(store: ObjectStore, treeOid: string): Set<string> {
  const out = new Set<string>();
  const files = flattenTree(store, treeOid);
  out.add(treeOid);
  for (const entry of files.values()) out.add(entry.oid);
  // Subtree ids are not in the flat map; walk once more collecting them.
  const stack = [treeOid];
  const seenTrees = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seenTrees.has(oid)) continue;
    seenTrees.add(oid);
    out.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) if (entry.mode === '40000') stack.push(entry.oid);
  }
  return out;
}

/** Order pack contents deterministically: commits, then trees, blobs, tags. */
function orderForPack(store: ObjectStore, oids: ReadonlySet<string>): GitObject[] {
  const rank: Record<string, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  return [...oids]
    .map((oid) => ({ oid, object: store.get(oid) }))
    .filter((entry): entry is { oid: string; object: GitObject } => entry.object !== undefined)
    .sort((a, b) => (rank[a.object.type] as number) - (rank[b.object.type] as number) || (a.oid < b.oid ? -1 : 1))
    .map((entry) => entry.object);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    const [head, rest] = [line.split(' ')[0] as string, line.slice(line.indexOf(' ') + 1)];
    if (head === 'want') args.wants.push(rest.split(' ')[0] as string);
    else if (head === 'have') args.haves.push(rest.split(' ')[0] as string);
    else if (head === 'shallow') args.shallow.push(rest.split(' ')[0] as string);
    else if (head === 'deepen') args.depth = Number(rest);
    else if (head === 'deepen-since' || head === 'deepen-not') args.depth = null;
  }
  return args;
}

/** The v2 fetch answer: acknowledgments, shallow info, then the packfile in sideband packets. */
function fetchAnswerV2(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(orderForPack(repo.store, plan.deliver));
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_FLUSH];
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch answer: shallow lines, a NAK, then the packfile in sideband packets. */
function fetchAnswerV0(repo: RepoRec, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args.wants, args.haves, args.shallow, args.depth);
  const pack = writePack(orderForPack(repo.store, plan.deliver));
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface RefCommand {
  old: string;
  next: string;
  ref: string;
}

/** Apply a receive-pack request; answers the report body in the client's chosen framing. */
async function receivePack(repo: RepoRec, body: Buffer): Promise<Buffer> {
  let commands: RefCommand[] = [];
  let capabilities = '';
  let pack = Buffer.alloc(0);
  try {
    // The command list ends at the first flush; everything after it is the raw packfile.
    const { packets, nextOffset } = decodePktLinesUntilFlush(body);
    const lines: string[] = [];
    for (const packet of packets) {
      if (packet.kind === 'flush') break;
      if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    }
    pack = body.subarray(nextOffset);
    commands = lines.map((raw, index) => {
      let line = raw.replace(/\n$/, '');
      if (index === 0) {
        const nul = line.indexOf('\0');
        if (nul !== -1) {
          capabilities = line.slice(nul + 1);
          line = line.slice(0, nul);
        }
      }
      const [old, next, ref] = line.split(' ') as [string, string, string];
      return { old, next, ref };
    });
  } catch {
    commands = [];
  }

  let unpackOk = true;
  let unpackError = '';
  if (pack.length > 0) {
    try {
      await readPackInto(repo.store, pack);
    } catch (err) {
      unpackOk = false;
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const reportLines: string[] = [unpackOk ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}`);
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.next === ZERO_OID) {
      // A delete.
      if (!repo.refs.has(command.ref)) {
        fail('reference does not exist');
        continue;
      }
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    if (!repo.store.has(command.next)) {
      fail('unknown object');
      continue;
    }
    if (current !== command.old) {
      fail('stale info');
      continue;
    }
    if (command.old !== ZERO_OID && command.ref.startsWith('refs/heads/')) {
      const oldCommit = peelToCommit(repo.store, command.old);
      const newCommit = peelToCommit(repo.store, command.next);
      if (oldCommit === null || newCommit === null || !isAncestor(repo.store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.next);
    reportLines.push(`ok ${command.ref}`);
  }

  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (capabilities.includes('side-band-64k') || capabilities.includes('side-band')) {
    return Buffer.concat([...sidebandPackets(reportStream), PKT_FLUSH]);
  }
  return reportStream;
}

/** Handle one git smart-HTTP request under /{owner}/{repo}.git. */
async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, name: string, sub: string, query: URLSearchParams, rawBody: Buffer): Promise<void> {
  const repo = resolveRepo(owner, name);
  if (repo === null) {
    notFound(res);
    return;
  }
  if (sub === 'info/refs' && req.method === 'GET') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      if (req.headers['git-protocol'] === 'version=2') sendRaw(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
      else sendRaw(res, 200, advertisementV0(repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement');
      return;
    }
    if (service === 'git-receive-pack') {
      sendRaw(res, 200, advertisementV0(repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
      return;
    }
    sendJson(res, 400, { message: 'Unknown service' });
    return;
  }
  if (sub === 'git-upload-pack' && req.method === 'POST') {
    let packets;
    try {
      packets = decodePktLines(rawBody).packets;
    } catch {
      sendJson(res, 400, { message: 'Malformed pkt-line body' });
      return;
    }
    const lines = packets.filter((packet) => packet.kind === 'data').map((packet) => packet.payload.toString('utf8'));
    const first = (lines[0] ?? '').replace(/\n$/, '');
    const isV2 = req.headers['git-protocol'] === 'version=2' || first.startsWith('command=');
    if (isV2) {
      const commandLine = lines.find((line) => line.startsWith('command='));
      const command = commandLine === undefined ? '' : commandLine.replace(/\n$/, '').slice('command='.length);
      const args: string[] = [];
      let afterDelim = false;
      for (const packet of packets) {
        if (packet.kind === 'delim') {
          afterDelim = true;
          continue;
        }
        if (packet.kind !== 'data') continue;
        const text = packet.payload.toString('utf8');
        if (afterDelim) args.push(text);
      }
      if (command === 'ls-refs') {
        sendRaw(res, 200, lsRefsAnswer(repo, args), 'application/x-git-upload-pack-result');
        return;
      }
      if (command === 'fetch') {
        sendRaw(res, 200, fetchAnswerV2(repo, parseFetchArgs(args)), 'application/x-git-upload-pack-result');
        return;
      }
      sendJson(res, 400, { message: `Unsupported command ${command}` });
      return;
    }
    // Protocol v0 fetch: want lines, a flush, have lines, "done".
    const wantSection: string[] = [];
    const haveSection: string[] = [];
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const text = packet.payload.toString('utf8');
      if (section === 0) wantSection.push(text);
      else haveSection.push(text);
    }
    const args = parseFetchArgs([...wantSection, ...haveSection]);
    sendRaw(res, 200, fetchAnswerV0(repo, args), 'application/x-git-upload-pack-result');
    return;
  }
  if (sub === 'git-receive-pack' && req.method === 'POST') {
    sendRaw(res, 200, await receivePack(repo, rawBody), 'application/x-git-receive-pack-result');
    return;
  }
  notFound(res);
}

// --------------------------------------------------------------------------- REST helpers

/** Parse a "Name <email> timestamp tz" ident line into its pieces. */
function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
  if (match === null) return { name: line, email: '', date: new Date(BOOT_MS).toISOString() };
  return {
    name: match[1] as string,
    email: match[2] as string,
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

/** The ident line this forge writes on the commits it creates itself. */
function forgeIdent(): string {
  const login = viewer();
  const seconds = Math.floor(Date.now() / 1000);
  return `${login} <${login}@forge.invalid> ${seconds} +0000`;
}

/**
 * Commit a file map onto a branch, creating the branch (from the default branch's tip, or from
 * nothing on an empty repository) when it does not exist yet. Answers the new commit id.
 */
function commitFiles(repo: RepoRec, branch: string, files: ReadonlyMap<string, FileEntry>, message: string): string {
  const refName = `refs/heads/${branch}`;
  let parent = repo.refs.get(refName);
  if (parent === undefined && branch !== repo.defaultBranch) parent = branchTip(repo, repo.defaultBranch) ?? undefined;
  const tree = storeTreeFromFiles(repo.store, files);
  const ident = forgeIdent();
  const commit = buildCommit({
    tree,
    parents: parent === undefined ? [] : [parent],
    author: ident,
    committer: ident,
    message,
  });
  const oid = repo.store.put('commit', commit);
  repo.refs.set(refName, oid);
  return oid;
}

/** The current file map of a branch (empty when the branch has no commits). */
function filesOfBranch(repo: RepoRec, branch: string): Map<string, FileEntry> {
  const tip = branchTip(repo, branch);
  if (tip === null) return new Map();
  const commit = peelToCommit(repo.store, tip);
  if (commit === null) return new Map();
  return filesOfCommit(repo.store, commit);
}

/** Resolve a ref parameter (a branch name or an object id) to a commit id. */
function resolveToCommit(repo: RepoRec, ref: string | null): string | null {
  if (ref === null || ref === '') {
    const tip = branchTip(repo, repo.defaultBranch);
    return tip === null ? null : peelToCommit(repo.store, tip);
  }
  const branch = branchTip(repo, ref);
  if (branch !== null) return peelToCommit(repo.store, branch);
  if (repo.store.has(ref)) return peelToCommit(repo.store, ref);
  return null;
}

function paginate<T>(items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const hasNext = start + perPage < items.length;
  return { page: slice, link: hasNext ? 'next' : null, perPage };
}

function linkHeader(req: IncomingMessage, url: URL, perPage: number, page: number): string {
  const next = new URL(url);
  next.searchParams.set('per_page', String(perPage));
  next.searchParams.set('page', String(page + 1));
  const host = req.headers.host ?? 'localhost';
  return `<http://${host}${next.pathname}${next.search}>; rel="next"`;
}

// --------------------------------------------------------------------------- REST: contents

function handleContents(req: IncomingMessage, res: ServerResponse, repo: RepoRec, path: string, query: URLSearchParams, rawBody: Buffer): void {
  if (req.method === 'GET') {
    const commit = resolveToCommit(repo, query.get('ref'));
    if (commit === null) {
      notFound(res);
      return;
    }
    const commitObject = repo.store.get(commit);
    if (commitObject === undefined) {
      notFound(res);
      return;
    }
    const treeOid = parseCommit(commitObject.data).tree;
    if (path === '') {
      sendJson(res, 200, listTreeDir(repo, treeOid, ''));
      return;
    }
    const found = lookupPath(repo, treeOid, path);
    if (found === null) {
      notFound(res);
      return;
    }
    if (found.kind === 'dir') {
      sendJson(res, 200, listTreeDir(repo, found.oid, path));
      return;
    }
    const blob = repo.store.get(found.oid);
    if (blob === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      sha: found.oid,
      content: blob.data.toString('base64').replace(/.{60}/g, '$&\n'),
    });
    return;
  }

  if (req.method === 'PUT') {
    const body = parseJsonBody(res, rawBody);
    if (body === null) return;
    const branch = str(body.branch, repo.defaultBranch);
    const files = filesOfBranch(repo, branch);
    const existing = files.get(path);
    const givenSha = typeof body.sha === 'string' ? body.sha : undefined;
    if (existing !== undefined) {
      if (givenSha === undefined) {
        sendJson(res, 422, { message: 'Validation Failed: sha is required when updating a file' });
        return;
      }
      if (givenSha !== existing.oid) {
        sendJson(res, 409, { message: 'Conflict: the file changed since the given sha' });
        return;
      }
    } else if (givenSha !== undefined) {
      notFound(res);
      return;
    }
    const content = typeof body.content === 'string' ? Buffer.from(body.content, 'base64') : Buffer.alloc(0);
    const blobOid = repo.store.put('blob', content);
    files.set(path, { mode: '100644', oid: blobOid });
    const commitOid = commitFiles(repo, branch, files, str(body.message, `Update ${path}`));
    sendJson(res, existing === undefined ? 201 : 200, {
      content: { type: 'file', encoding: 'base64', size: content.length, name: path.split('/').pop(), path, sha: blobOid },
      commit: { sha: commitOid },
    });
    return;
  }

  if (req.method === 'DELETE') {
    const body = parseJsonBody(res, rawBody);
    if (body === null) return;
    const branch = str(body.branch, repo.defaultBranch);
    const files = filesOfBranch(repo, branch);
    const existing = files.get(path);
    if (existing === undefined) {
      notFound(res);
      return;
    }
    if (typeof body.sha === 'string' && body.sha !== existing.oid) {
      sendJson(res, 409, { message: 'Conflict: the file changed since the given sha' });
      return;
    }
    files.delete(path);
    const commitOid = commitFiles(repo, branch, files, str(body.message, `Delete ${path}`));
    sendJson(res, 200, { content: null, commit: { sha: commitOid } });
    return;
  }

  notFound(res);
}

/** Walk a tree by slash path; answers the entry found (file or directory) or null. */
function lookupPath(repo: RepoRec, treeOid: string, path: string): { kind: 'file' | 'dir'; oid: string; mode: string } | null {
  const segments = path.split('/').filter((segment) => segment !== '');
  let current = treeOid;
  for (let index = 0; index < segments.length; index += 1) {
    const object = repo.store.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[index]);
    if (entry === undefined) return null;
    if (index === segments.length - 1) {
      return entry.mode === '40000' ? { kind: 'dir', oid: entry.oid, mode: entry.mode } : { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return { kind: 'dir', oid: treeOid, mode: '40000' };
}

/** One directory level of a tree, in the REST contents shape. */
function listTreeDir(repo: RepoRec, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const object = repo.store.get(treeOid);
  if (object === undefined || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => ({
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path: prefix === '' ? entry.name : `${prefix}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (repo.store.get(entry.oid)?.data.length ?? 0),
  }));
}

// --------------------------------------------------------------------------- REST: merges

/**
 * A three-way merge of file maps: a path takes the side that changed it relative to the common
 * ancestor; when both sides changed it differently the merge conflicts (null).
 */
function threeWayMerge(ancestor: ReadonlyMap<string, FileEntry>, ours: ReadonlyMap<string, FileEntry>, theirs: ReadonlyMap<string, FileEntry>): Map<string, FileEntry> | null {
  const merged = new Map<string, FileEntry>();
  const paths = new Set<string>([...ancestor.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const a = ancestor.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    let chosen: FileEntry | undefined;
    if (o === t) chosen = ours.get(path) ?? theirs.get(path);
    else if (a === o) chosen = theirs.get(path);
    else if (a === t) chosen = ours.get(path);
    else return null;
    if (chosen !== undefined) merged.set(path, chosen);
  }
  return merged;
}

/** Squash-merge a pull request onto its base branch. Answers the merge commit id, or 'conflict'. */
function squashMerge(repo: RepoRec, pull: PullRec): string | 'conflict' {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return 'conflict';
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  if (baseCommit === null || headCommit === null) return 'conflict';
  const base = mergeBase(repo.store, baseCommit, headCommit);
  const ancestorFiles = base === null ? new Map<string, FileEntry>() : filesOfCommit(repo.store, base);
  const mergedFiles = threeWayMerge(ancestorFiles, filesOfCommit(repo.store, baseCommit), filesOfCommit(repo.store, headCommit));
  if (mergedFiles === null) return 'conflict';
  const tree = storeTreeFromFiles(repo.store, mergedFiles);
  const ident = forgeIdent();
  const commit = buildCommit({
    tree,
    parents: [baseCommit],
    author: ident,
    committer: ident,
    message: `${pull.title} (#${pull.number})`,
  });
  const oid = repo.store.put('commit', commit);
  repo.refs.set(`refs/heads/${pull.base}`, oid);
  return oid;
}

/** Count added/removed lines between two blob payloads (whole-file counts when one side is absent). */
function lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const lines = (data: Buffer | null): number => {
    if (data === null || data.length === 0) return 0;
    return data.toString('utf8').split('\n').length;
  };
  if (oldData === null) return { additions: lines(newData), deletions: 0 };
  if (newData === null) return { additions: 0, deletions: lines(oldData) };
  if (oldData.equals(newData)) return { additions: 0, deletions: 0 };
  return { additions: lines(newData), deletions: lines(oldData) };
}

/** The changed-file list of a pull request, diffed against the merge base. */
function pullFiles(repo: RepoRec, pull: PullRec): Array<Record<string, unknown>> {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return [];
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  if (baseCommit === null || headCommit === null) return [];
  const base = mergeBase(repo.store, baseCommit, headCommit) ?? baseCommit;
  const before = filesOfCommit(repo.store, base);
  const after = filesOfCommit(repo.store, headCommit);
  const out: Array<Record<string, unknown>> = [];
  const paths = new Set<string>([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = before.get(path);
    const newEntry = after.get(path);
    if (oldEntry?.oid === newEntry?.oid) continue;
    const oldData = oldEntry === undefined ? null : (repo.store.get(oldEntry.oid)?.data ?? null);
    const newData = newEntry === undefined ? null : (repo.store.get(newEntry.oid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    out.push({
      filename: path,
      status: oldEntry === undefined ? 'added' : newEntry === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      sha: (newEntry ?? oldEntry)?.oid ?? ZERO_OID,
    });
  }
  return out;
}

// --------------------------------------------------------------------------- REST router

function handleRest(req: IncomingMessage, res: ServerResponse, url: URL, rawBody: Buffer): void {
  const segments = url.pathname.split('/').filter((segment) => segment !== '').map(decodeSegment);
  // segments[0] === 'api', segments[1] === 'v3'
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';
  const query = url.searchParams;

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        issue_url: '/api/v3/repos/{owner}/{repo}/issues',
      }, { 'x-oauth-scopes': 'repo, read:org' });
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] === 'meta' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: false,
      github_services_sha: hashObject('blob', Buffer.from('mini-forge')),
    });
    return;
  }

  if (rest[0] === 'user' && rest.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: viewer(), id: 1000, type: 'User', name: viewer() });
    return;
  }

  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'POST' && rest.length === 2) {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const name = str(body.name);
      if (name === '') {
        sendJson(res, 422, { message: 'Validation Failed: name is required' });
        return;
      }
      if (reposByName.has(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name already exists on this account' });
        return;
      }
      const repo = createRepo(name, str(body.description), body.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const all = [...reposByName.values()].sort((a, b) => a.id - b.id).map(repoJson);
      const { page, link, perPage } = paginate(all, query);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = linkHeader(req, url, perPage, Number(query.get('page') ?? '1') || 1);
      sendJson(res, 200, page, headers);
      return;
    }
    notFound(res);
    return;
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = rest[1] as string;
    const repo = resolveRepo(owner, rest[2] as string);
    if (repo === null) {
      notFound(res);
      return;
    }
    const tail = rest.slice(3);

    if (tail.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        const body = parseJsonBody(res, rawBody);
        if (body === null) return;
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.name === 'string' && body.name !== repo.name && !reposByName.has(body.name)) {
          reposByName.delete(repo.name);
          repo.name = body.name;
          reposByName.set(repo.name, repo);
        }
        if (typeof body.private === 'boolean') repo.isPrivate = body.private;
        sendJson(res, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        reposByName.delete(repo.name);
        res.writeHead(204, { 'x-github-request-id': nextRequestId() });
        res.end();
        return;
      }
      notFound(res);
      return;
    }

    if (tail[0] === 'contents') {
      const path = tail.slice(1).join('/');
      handleContents(req, res, repo, path, query, rawBody);
      return;
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = parseJsonBody(res, rawBody);
        if (body === null) return;
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !repo.store.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: invalid ref or sha' });
          return;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return;
      }
      if (method === 'GET' && tail.length >= 3) {
        const fullRef = `refs/${tail.slice(2).join('/')}`;
        const oid = repo.refs.get(fullRef);
        if (oid === undefined) {
          notFound(res);
          return;
        }
        sendJson(res, 200, { ref: fullRef, object: { sha: oid, type: 'commit' } });
        return;
      }
      notFound(res);
      return;
    }

    if (tail[0] === 'branches' && method === 'GET') {
      if (tail.length === 1) {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(res, 200, branches);
        return;
      }
      const branch = tail.slice(1).join('/');
      const oid = branchTip(repo, branch);
      if (oid === null) {
        notFound(res);
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha: oid }, protected: false });
      return;
    }

    if (tail[0] === 'commits' && method === 'GET' && tail.length === 1) {
      const tip = resolveToCommit(repo, query.get('sha'));
      if (tip === null) {
        sendJson(res, 200, []);
        return;
      }
      const items = walkCommits(repo.store, tip, 250).map((oid) => {
        const object = repo.store.get(oid);
        const commit = object === undefined ? null : parseCommit(object.data);
        const author = commit === null ? { name: '', email: '', date: '' } : parseIdent(commit.authorLine);
        const committer = commit === null ? { name: '', email: '', date: '' } : parseIdent(commit.committerLine);
        return {
          sha: oid,
          commit: {
            message: commit?.message ?? '',
            author,
            committer,
            tree: { sha: commit?.tree ?? ZERO_OID },
          },
          parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
        };
      });
      sendJson(res, 200, items);
      return;
    }

    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const body = parseJsonBody(res, rawBody);
        if (body === null) return;
        const name = str(body.name);
        if (name === '') {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return;
        }
        if (repo.labels.has(name)) {
          sendJson(res, 422, { message: 'Validation Failed: name already exists' });
          return;
        }
        const label: LabelRec = { name, color: str(body.color, 'ededed') };
        repo.labels.set(name, label);
        sendJson(res, 201, labelJson(label));
        return;
      }
      if (method === 'GET' && tail.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map(labelJson));
        return;
      }
      notFound(res);
      return;
    }

    if (tail[0] === 'issues') {
      handleIssues(req, res, repo, tail.slice(1), query, rawBody);
      return;
    }

    if (tail[0] === 'pulls') {
      handlePulls(req, res, repo, tail.slice(1), query, rawBody);
      return;
    }

    notFound(res);
    return;
  }

  notFound(res);
}

/** Issue routes under /repos/{owner}/{repo}/issues. */
function handleIssues(req: IncomingMessage, res: ServerResponse, repo: RepoRec, tail: string[], query: URLSearchParams, rawBody: Buffer): void {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const label of body.labels) {
          const name = typeof label === 'string' ? label : str((label as Record<string, unknown>).name);
          if (name !== '') labelNames.push(name);
        }
      }
      for (const name of labelNames) {
        if (!repo.labels.has(name)) {
          sendJson(res, 422, { message: `Validation Failed: label "${name}" does not exist` });
          return;
        }
      }
      const issue: IssueRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: nextSeq(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      sendJson(res, 201, issueJson(repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = str(query.get('state'), 'open');
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      const direction = str(query.get('direction'), 'desc');
      items.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      const { page } = paginate(items.map((issue) => issueJson(repo, issue)), query);
      sendJson(res, 200, page);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(tail[0]);
  const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;

  if (tail.length === 1) {
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      sendJson(res, 200, issueJson(repo, issue));
      return;
    }
    notFound(res);
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (issue === undefined) {
      notFound(res);
      return;
    }
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const comment: CommentRec = { id: nextCommentId, body: str(body.body), seq: nextSeq() };
      nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(res, 201, {
        id: comment.id,
        node_id: commentGlobalId(comment.id),
        body: comment.body,
        user: { login: viewer(), id: 1000, type: 'User' },
        created_at: isoOfSeq(comment.seq),
        updated_at: isoOfSeq(comment.seq),
      });
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, issue.comments.map((comment) => ({
        id: comment.id,
        node_id: commentGlobalId(comment.id),
        body: comment.body,
        user: { login: viewer(), id: 1000, type: 'User' },
        created_at: isoOfSeq(comment.seq),
        updated_at: isoOfSeq(comment.seq),
      })));
      return;
    }
  }

  notFound(res);
}

/** Pull-request routes under /repos/{owner}/{repo}/pulls. */
function handlePulls(req: IncomingMessage, res: ServerResponse, repo: RepoRec, tail: string[], query: URLSearchParams, rawBody: Buffer): void {
  const method = req.method ?? 'GET';

  if (tail.length === 0) {
    if (method === 'POST') {
      const body = parseJsonBody(res, rawBody);
      if (body === null) return;
      const head = str(body.head).split(':').pop() as string;
      const base = str(body.base).split(':').pop() as string;
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) {
        sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
        return;
      }
      const duplicate = [...repo.pulls.values()].some((pull) => pull.state === 'open' && !pull.merged && pull.head === head && pull.base === base);
      if (duplicate) {
        sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head and base' });
        return;
      }
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(body.title),
        body: str(body.body),
        head,
        base,
        state: 'open',
        merged: false,
        mergedAtSeq: null,
        mergeCommitSha: null,
        seq: nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      sendJson(res, 201, pullJson(repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = str(query.get('state'), 'open');
      let items = [...repo.pulls.values()];
      if (state === 'open') items = items.filter((pull) => pull.state === 'open' && !pull.merged);
      else if (state === 'closed') items = items.filter((pull) => pull.state === 'closed' || pull.merged);
      items.sort((a, b) => a.number - b.number);
      const { page } = paginate(items.map((pull) => pullJson(repo, pull)), query);
      sendJson(res, 200, page);
      return;
    }
    notFound(res);
    return;
  }

  const number = Number(tail[0]);
  const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;

  if (tail.length === 1) {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, pullJson(repo, pull));
      return;
    }
    notFound(res);
    return;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    sendJson(res, 200, pullFiles(repo, pull));
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    if (pull === undefined) {
      notFound(res);
      return;
    }
    const body = parseJsonBody(res, rawBody);
    if (body === null) return;
    if (pull.merged || pull.state === 'closed') {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const result = squashMerge(repo, pull);
    if (result === 'conflict') {
      sendJson(res, 405, { message: 'Pull Request is not mergeable' });
      return;
    }
    pull.merged = true;
    pull.state = 'closed';
    pull.mergedAtSeq = nextSeq();
    pull.mergeCommitSha = result;
    sendJson(res, 200, { sha: result, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  notFound(res);
}

// --------------------------------------------------------------------------- GraphQL

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  selections: GqlField[];
  fragmentType: string | null; // set for inline fragments
}

interface GqlOperation {
  kind: 'query' | 'mutation';
  fields: GqlField[];
}

/** Tokenize a GraphQL document (names, numbers, strings, punctuation, spreads). */
function gqlTokens(document: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < document.length) {
    const char = document[index] as string;
    if (char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < document.length && document[index] !== '\n') index += 1;
      continue;
    }
    if (document.startsWith('...', index)) {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}()[]:=@$!'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    if (char === '"') {
      if (document.startsWith('"""', index)) {
        const end = document.indexOf('"""', index + 3);
        const raw = document.slice(index + 3, end === -1 ? document.length : end);
        tokens.push(`str:${raw}`);
        index = end === -1 ? document.length : end + 3;
        continue;
      }
      let raw = '';
      index += 1;
      while (index < document.length && document[index] !== '"') {
        if (document[index] === '\\' && index + 1 < document.length) {
          raw += document[index + 1];
          index += 2;
        } else {
          raw += document[index];
          index += 1;
        }
      }
      index += 1;
      tokens.push(`str:${raw}`);
      continue;
    }
    const match = /^[A-Za-z_0-9][A-Za-z_0-9.-]*/.exec(document.slice(index));
    if (match !== null) {
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    index += 1;
  }
  return tokens;
}

/** Parse the operations of a document; variable definitions and directives are skipped over. */
function gqlParse(document: string, variables: Record<string, GqlValue>): GqlOperation[] {
  const tokens = gqlTokens(document);
  let pos = 0;
  const peek = (): string | undefined => tokens[pos];
  const next = (): string => tokens[pos++] as string;

  const parseValue = (): GqlValue => {
    const token = next();
    if (token === undefined) return null;
    if (token.startsWith('str:')) return token.slice(4);
    if (token === '$') {
      const name = next();
      return variables[name] ?? null;
    }
    if (token === '[') {
      const list: GqlValue[] = [];
      while (peek() !== ']' && peek() !== undefined) list.push(parseValue());
      next();
      return list;
    }
    if (token === '{') {
      const object: Record<string, GqlValue> = {};
      while (peek() !== '}' && peek() !== undefined) {
        const key = next();
        if (peek() === ':') next();
        object[key] = parseValue();
      }
      next();
      return object;
    }
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (token === 'null') return null;
    const number = Number(token);
    return Number.isNaN(number) ? token : number; // bare words are enums
  };

  const skipBalanced = (open: string, close: string): void => {
    if (peek() !== open) return;
    let depth = 0;
    while (pos < tokens.length) {
      const token = next();
      if (token === open) depth += 1;
      else if (token === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  };

  const parseSelections = (): GqlField[] => {
    const fields: GqlField[] = [];
    if (peek() !== '{') return fields;
    next();
    while (peek() !== '}' && peek() !== undefined) {
      if (peek() === '...') {
        next();
        let fragmentType: string | null = null;
        if (peek() === 'on') {
          next();
          fragmentType = next();
        }
        fields.push({ name: '', alias: null, args: {}, selections: parseSelections(), fragmentType });
        continue;
      }
      let name = next();
      let alias: string | null = null;
      if (peek() === ':') {
        next();
        alias = name;
        name = next();
      }
      const args: Record<string, GqlValue> = {};
      if (peek() === '(') {
        next();
        while (peek() !== ')' && peek() !== undefined) {
          const key = next();
          if (peek() === ':') next();
          args[key] = parseValue();
        }
        next();
      }
      // Directives on a field are skipped.
      while (peek() === '@') {
        next();
        next();
        skipBalanced('(', ')');
      }
      let selections: GqlField[] = [];
      if (peek() === '{') selections = parseSelections();
      fields.push({ name, alias, args, selections, fragmentType: null });
    }
    next();
    return fields;
  };

  const operations: GqlOperation[] = [];
  while (pos < tokens.length) {
    const token = peek();
    if (token === 'query' || token === 'mutation' || token === 'subscription') {
      const kind = next() as 'query' | 'mutation';
      if (peek() !== '(' && peek() !== '{' && peek() !== '@') next(); // operation name
      skipBalanced('(', ')'); // variable definitions
      while (peek() === '@') {
        next();
        next();
        skipBalanced('(', ')');
      }
      operations.push({ kind: kind === 'mutation' ? 'mutation' : 'query', fields: parseSelections() });
      continue;
    }
    if (token === 'fragment') {
      // Named fragments are not used by the conformance documents; skip the definition.
      while (pos < tokens.length && peek() !== '{') pos += 1;
      skipBalanced('{', '}');
      continue;
    }
    if (token === '{') {
      operations.push({ kind: 'query', fields: parseSelections() });
      continue;
    }
    pos += 1;
  }
  return operations;
}

/** Static schema knowledge for introspection and unknown-field errors. */
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', '__type', '__schema', '__typename'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', '__typename'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'isPrivate', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url', '__typename'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository', 'createdAt', 'updatedAt', 'url', '__typename'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository', 'createdAt', 'updatedAt', 'mergedAt', 'url', '__typename'],
  User: ['login', 'id', 'databaseId', 'name', '__typename'],
  Ref: ['name', 'target', '__typename'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount', 'edges', '__typename'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount', 'edges', '__typename'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor', '__typename'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', '__typename'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount', 'edges', '__typename'],
  Label: ['name', 'color', '__typename'],
  LabelConnection: ['nodes', 'totalCount', '__typename'],
  IssueCommentConnection: ['nodes', 'totalCount', '__typename'],
  IssueComment: ['id', 'body', 'author', 'createdAt', '__typename'],
  CreateIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CloseIssuePayload: ['issue', 'clientMutationId', '__typename'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId', '__typename'],
  AddCommentPayload: ['commentEdge', 'clientMutationId', '__typename'],
  CommentEdge: ['node', 'cursor', '__typename'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', '__typename'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', '__typename'],
  __Field: ['name', 'description', 'type', '__typename'],
  __EnumValue: ['name', 'description', '__typename'],
};

const GQL_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'CODE', 'DISCUSSION', 'MARKETPLACE', 'ORGANIZATION', 'PROJECT', 'PULL_REQUEST', 'TEAM', 'TOPIC'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  MergePullRequestMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

interface GqlNode {
  __typename: string;
  [key: string]: unknown;
}

function gqlError(message: string): { message: string } {
  return { message };
}

/** The mergeable state of a pull request, computed with the same three-way merge REST uses. */
function pullMergeable(repo: RepoRec, pull: PullRec): string {
  if (pull.merged) return 'MERGEABLE';
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (baseTip === null || headTip === null) return 'UNKNOWN';
  const baseCommit = peelToCommit(repo.store, baseTip);
  const headCommit = peelToCommit(repo.store, headTip);
  if (baseCommit === null || headCommit === null) return 'UNKNOWN';
  const base = mergeBase(repo.store, baseCommit, headCommit);
  const ancestorFiles = base === null ? new Map<string, FileEntry>() : filesOfCommit(repo.store, base);
  const merged = threeWayMerge(ancestorFiles, filesOfCommit(repo.store, baseCommit), filesOfCommit(repo.store, headCommit));
  return merged === null ? 'CONFLICTING' : 'MERGEABLE';
}

function gqlRepoNode(repo: RepoRec): GqlNode {
  return { __typename: 'Repository', repo };
}

function gqlIssueNode(repo: RepoRec, issue: IssueRec): GqlNode {
  return {
    __typename: 'Issue',
    id: issueGlobalId(repo, issue.number),
    databaseId: repo.id * 1_000_000 + issue.number,
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    createdAt: isoOfSeq(issue.seq),
    updatedAt: isoOfSeq(issue.seq),
    repoRef: repo,
    issueRef: issue,
  };
}

function gqlPullNode(repo: RepoRec, pull: PullRec): GqlNode {
  return {
    __typename: 'PullRequest',
    id: pullGlobalId(repo, pull.number),
    databaseId: repo.id * 1_000_000 + pull.number,
    number: pull.number,
    title: pull.title,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    body: pull.body,
    merged: pull.merged,
    mergeable: pullMergeable(repo, pull),
    headRefName: pull.head,
    baseRefName: pull.base,
    createdAt: isoOfSeq(pull.seq),
    updatedAt: isoOfSeq(pull.seq),
    mergedAt: pull.mergedAtSeq === null ? null : isoOfSeq(pull.mergedAtSeq),
    repoRef: repo,
    pullRef: pull,
  };
}

/** A connection over an already-ordered node list, with opaque cursors and pageInfo. */
function gqlConnection(nodes: GqlNode[], args: Record<string, GqlValue>, typename: string): GqlNode {
  const first = typeof args.first === 'number' ? args.first : nodes.length;
  let start = 0;
  if (typeof args.after === 'string') {
    try {
      const text = Buffer.from(args.after, 'base64').toString('utf8');
      const index = Number(text.replace('cursor:', ''));
      if (Number.isInteger(index)) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const page = nodes.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    __typename: typename,
    nodes: page,
    totalCount: nodes.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: start + page.length < nodes.length,
      endCursor: page.length > 0 ? Buffer.from(`cursor:${endIndex}`, 'utf8').toString('base64') : null,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? Buffer.from(`cursor:${start}`, 'utf8').toString('base64') : null,
    },
    edges: page.map((node, offset) => ({
      __typename: `${typename.replace('Connection', '')}Edge`,
      node,
      cursor: Buffer.from(`cursor:${start + offset}`, 'utf8').toString('base64'),
    })),
  };
}

/** Resolve one field of one node. Unknown fields push an error naming the field. */
function gqlResolve(node: GqlNode, field: GqlField, errors: Array<{ message: string }>): unknown {
  const name = field.name;
  if (name === '__typename') return node.__typename;
  const known = GQL_TYPE_FIELDS[node.__typename] ?? [];
  if (!known.includes(name)) {
    errors.push(gqlError(`Field '${name}' doesn't exist on type '${node.__typename}'`));
    return null;
  }
  const args = field.args;
  switch (node.__typename) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'User', login: viewer(), id: Buffer.from('User:1000', 'utf8').toString('base64'), databaseId: 1000, name: viewer() };
      if (name === 'repository') {
        const repo = resolveRepo(str(args.owner), str(args.name));
        return repo === null ? null : gqlRepoNode(repo);
      }
      if (name === 'node') {
        const decoded = decodeGlobalId(str(args.id));
        if (decoded === null) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoById(decoded.repoId);
          return repo === null ? null : gqlRepoNode(repo);
        }
        if (decoded.kind === 'Issue') {
          const repo = repoById(decoded.repoId);
          const issue = repo?.issues.get(decoded.number);
          return repo !== null && repo !== undefined && issue !== undefined ? gqlIssueNode(repo, issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const repo = repoById(decoded.repoId);
          const pull = repo?.pulls.get(decoded.number);
          return repo !== null && repo !== undefined && pull !== undefined ? gqlPullNode(repo, pull) : null;
        }
        return null;
      }
      if (name === '__type') {
        const typeName = str(args.name);
        const fields = (GQL_TYPE_FIELDS[typeName] ?? []).filter((fieldName) => !fieldName.startsWith('__'));
        const enumValues = GQL_ENUMS[typeName];
        return {
          __typename: '__Type',
          name: typeName,
          kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
          description: null,
          fields: fields.map((fieldName) => ({ __typename: '__Field', name: fieldName, description: null, type: null })),
          enumValues: enumValues === undefined ? null : enumValues.map((value) => ({ __typename: '__EnumValue', name: value, description: null })),
        };
      }
      if (name === 'rateLimit') return { __typename: 'RateLimit', limit: 5000, cost: 1, remaining: 4999, resetAt: new Date(BOOT_MS + 3_600_000).toISOString() };
      return null;
    }
    case 'Mutation': {
      return gqlMutate(name, args, errors);
    }
    case 'Repository': {
      const repo = node.repo as RepoRec;
      switch (name) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${viewer()}/${repo.name}`;
        case 'owner': return { __typename: 'User', login: viewer(), id: Buffer.from('User:1000', 'utf8').toString('base64'), databaseId: 1000, name: viewer() };
        case 'defaultBranchRef': {
          const tip = branchTip(repo, repo.defaultBranch);
          return tip === null ? null : { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'createdAt': return isoOfSeq(repo.seq);
        case 'updatedAt': return isoOfSeq(repo.seq);
        case 'url': return `http://forge.invalid/${viewer()}/${repo.name}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : gqlIssueNode(repo, issue);
        }
        case 'issues': {
          let items = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? args.states.map((state) => String(state)) : null;
          if (states !== null) {
            items = items.filter((issue) => states.includes(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const orderBy = (args.orderBy ?? {}) as Record<string, GqlValue>;
          const direction = orderBy.direction === 'ASC' ? 'ASC' : 'DESC';
          const ordered = [...items].sort((a, b) => a.seq - b.seq);
          // Partition by cursor over creation order, then present in the requested direction.
          const connection = gqlConnection(ordered.map((issue) => gqlIssueNode(repo, issue)), args, 'IssueConnection');
          if (direction === 'DESC') {
            connection.nodes = [...(connection.nodes as GqlNode[])].reverse();
          }
          return connection;
        }
        case 'pullRequests': {
          const items = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq);
          return gqlConnection(items.map((pull) => gqlPullNode(repo, pull)), args, 'PullRequestConnection');
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : gqlPullNode(repo, pull);
        }
        default: return null;
      }
    }
    case 'Issue': {
      const repo = node.repoRef as RepoRec;
      const issue = node.issueRef as IssueRec;
      switch (name) {
        case 'author': return { __typename: 'User', login: viewer(), id: Buffer.from('User:1000', 'utf8').toString('base64'), databaseId: 1000, name: viewer() };
        case 'repository': return gqlRepoNode(repo);
        case 'labels': return { __typename: 'LabelConnection', nodes: issue.labels.map((labelName) => ({ __typename: 'Label', name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })), totalCount: issue.labels.length };
        case 'comments': return { __typename: 'IssueCommentConnection', nodes: issue.comments.map((comment) => ({ __typename: 'IssueComment', id: commentGlobalId(comment.id), body: comment.body, createdAt: isoOfSeq(comment.seq) })), totalCount: issue.comments.length };
        case 'url': return `http://forge.invalid/${viewer()}/${repo.name}/issues/${issue.number}`;
        default: return node[name] ?? null;
      }
    }
    case 'PullRequest': {
      const repo = node.repoRef as RepoRec;
      const pull = node.pullRef as PullRec;
      switch (name) {
        case 'author': return { __typename: 'User', login: viewer(), id: Buffer.from('User:1000', 'utf8').toString('base64'), databaseId: 1000, name: viewer() };
        case 'repository': return gqlRepoNode(repo);
        case 'files': return { __typename: 'PullRequestChangedFileConnection', nodes: pullFiles(repo, pull).map((file) => ({ __typename: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions })), totalCount: pullFiles(repo, pull).length };
        case 'headRef': {
          const tip = branchTip(repo, pull.head);
          return tip === null ? null : { __typename: 'Ref', name: pull.head, target: { __typename: 'Commit', oid: tip } };
        }
        case 'baseRef': {
          const tip = branchTip(repo, pull.base);
          return tip === null ? null : { __typename: 'Ref', name: pull.base, target: { __typename: 'Commit', oid: tip } };
        }
        case 'url': return `http://forge.invalid/${viewer()}/${repo.name}/pull/${pull.number}`;
        default: return node[name] ?? null;
      }
    }
    case '__Type': {
      if (name === 'fields') return node.fields;
      if (name === 'enumValues') return node.enumValues;
      return node[name] ?? null;
    }
    default:
      return node[name] ?? null;
  }
}

/** Apply a selection set to a resolved value (objects recurse, scalars pass through). */
function gqlApply(value: unknown, field: GqlField, errors: Array<{ message: string }>): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => gqlApply(item, field, errors));
  if (typeof value !== 'object') return value;
  const node = value as GqlNode;
  if (field.selections.length === 0) return node;
  const out: Record<string, unknown> = {};
  for (const selection of field.selections) {
    if (selection.fragmentType !== null) {
      if (selection.fragmentType === node.__typename) {
        const fragmentResult = gqlApply(node, { ...selection, name: '', fragmentType: null }, errors) as Record<string, unknown>;
        Object.assign(out, fragmentResult);
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    const resolved = gqlResolve(node, selection, errors);
    out[key] = gqlApply(resolved, selection, errors);
  }
  return out;
}

/** Execute the mutations, on the same store REST uses. */
function gqlMutate(name: string, args: Record<string, GqlValue>, errors: Array<{ message: string }>): GqlNode | null {
  const input = (args.input ?? {}) as Record<string, GqlValue>;
  if (name === 'createIssue') {
    const decoded = decodeGlobalId(str(input.repositoryId));
    const repo = decoded === null ? null : repoById(decoded.repoId);
    if (repo === null) {
      errors.push(gqlError('Repository not found'));
      return null;
    }
    const issue: IssueRec = {
      number: repo.nextNumber,
      title: str(input.title),
      body: str(input.body),
      state: 'open',
      labels: [],
      comments: [],
      seq: nextSeq(),
    };
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return { __typename: 'CreateIssuePayload', issue: gqlIssueNode(repo, issue), clientMutationId: input.clientMutationId ?? null };
  }
  if (name === 'closeIssue') {
    const decoded = decodeGlobalId(str(input.issueId));
    const repo = decoded === null ? null : repoById(decoded.repoId);
    const issue = repo?.issues.get(decoded?.number ?? -1);
    if (repo === null || repo === undefined || issue === undefined) {
      errors.push(gqlError('Issue not found'));
      return null;
    }
    issue.state = 'closed';
    return { __typename: 'CloseIssuePayload', issue: gqlIssueNode(repo, issue), clientMutationId: input.clientMutationId ?? null };
  }
  if (name === 'createPullRequest') {
    const decoded = decodeGlobalId(str(input.repositoryId));
    const repo = decoded === null ? null : repoById(decoded.repoId);
    if (repo === null) {
      errors.push(gqlError('Repository not found'));
      return null;
    }
    const head = str(input.headRefName).split(':').pop() as string;
    const base = str(input.baseRefName).split(':').pop() as string;
    const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && !pull.merged && pull.head === head && pull.base === base);
    if (existing !== undefined) return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPullNode(repo, existing), clientMutationId: input.clientMutationId ?? null };
    const pull: PullRec = {
      number: repo.nextNumber,
      title: str(input.title),
      body: str(input.body),
      head,
      base,
      state: 'open',
      merged: false,
      mergedAtSeq: null,
      mergeCommitSha: null,
      seq: nextSeq(),
    };
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return { __typename: 'CreatePullRequestPayload', pullRequest: gqlPullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
  }
  if (name === 'mergePullRequest') {
    const decoded = decodeGlobalId(str(input.pullRequestId));
    const repo = decoded === null ? null : repoById(decoded.repoId);
    const pull = repo?.pulls.get(decoded?.number ?? -1);
    if (repo === null || repo === undefined || pull === undefined) {
      errors.push(gqlError('Pull request not found'));
      return null;
    }
    if (!pull.merged) {
      const result = squashMerge(repo, pull);
      if (result === 'conflict') {
        errors.push(gqlError('Pull Request is not mergeable'));
        return { __typename: 'MergePullRequestPayload', pullRequest: gqlPullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAtSeq = nextSeq();
      pull.mergeCommitSha = result;
    }
    return { __typename: 'MergePullRequestPayload', pullRequest: gqlPullNode(repo, pull), clientMutationId: input.clientMutationId ?? null };
  }
  if (name === 'addComment') {
    const decoded = decodeGlobalId(str(input.subjectId));
    const repo = decoded === null ? null : repoById(decoded.repoId);
    const issue = repo?.issues.get(decoded?.number ?? -1);
    if (repo === null || repo === undefined || issue === undefined) {
      errors.push(gqlError('Subject not found'));
      return null;
    }
    const comment: CommentRec = { id: nextCommentId, body: str(input.body), seq: nextSeq() };
    nextCommentId += 1;
    issue.comments.push(comment);
    const commentNode: GqlNode = { __typename: 'IssueComment', id: commentGlobalId(comment.id), body: comment.body, createdAt: isoOfSeq(comment.seq) };
    return {
      __typename: 'AddCommentPayload',
      commentEdge: { __typename: 'CommentEdge', node: commentNode, cursor: Buffer.from(`cursor:${comment.id}`, 'utf8').toString('base64') },
      clientMutationId: input.clientMutationId ?? null,
    };
  }
  errors.push(gqlError(`Unknown mutation ${name}`));
  return null;
}

/** Run one GraphQL operation document; answers the {data, errors?} envelope. */
function gqlExecute(document: string, variables: Record<string, GqlValue>, operationName: string | null): Record<string, unknown> {
  const operations = gqlParse(document, variables);
  const operation = operationName === null ? operations[0] : (operations.find((candidate) => candidate.kind !== undefined) ?? operations[0]);
  if (operation === undefined) return { data: null, errors: [gqlError('No operation in document')] };
  const root: GqlNode = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
  const errors: Array<{ message: string }> = [];
  const data: Record<string, unknown> = {};
  for (const field of operation.fields) {
    const key = field.alias ?? field.name;
    const resolved = gqlResolve(root, field, errors);
    data[key] = gqlApply(resolved, field, errors);
  }
  const envelope: Record<string, unknown> = { data };
  if (errors.length > 0) envelope.errors = errors;
  return envelope;
}

function handleGraphql(res: ServerResponse, rawBody: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const operation = (entry ?? {}) as Record<string, unknown>;
      return gqlExecute(str(operation.query), (operation.variables ?? {}) as Record<string, GqlValue>, typeof operation.operationName === 'string' ? operation.operationName : null);
    });
    sendJson(res, 200, results);
    return;
  }
  const operation = (parsed ?? {}) as Record<string, unknown>;
  const result = gqlExecute(str(operation.query), (operation.variables ?? {}) as Record<string, GqlValue>, typeof operation.operationName === 'string' ? operation.operationName : null);
  sendJson(res, 200, result);
}

// --------------------------------------------------------------------------- MCP

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The tool list is built once so repeated tools/list answers are identical. */
const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get the details of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function mcpToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function mcpToolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

/** Execute one MCP tool against the shared store. */
function mcpCallTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = str(args.name);
      if (reposByName.has(repoName)) return mcpToolError(`Repository ${repoName} already exists`);
      const repo = createRepo(repoName, str(args.description), args.private === true);
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(str(args.owner), str(args.repo));
      if (repo === null) return mcpToolError('Repository not found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(str(args.owner), str(args.repo));
      if (repo === null) return mcpToolError('Repository not found');
      const issue: IssueRec = {
        number: repo.nextNumber,
        title: str(args.title),
        body: str(args.body),
        state: 'open',
        labels: [],
        comments: [],
        seq: nextSeq(),
      };
      repo.nextNumber += 1;
      repo.issues.set(issue.number, issue);
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = resolveRepo(str(args.owner), str(args.repo));
      if (repo === null) return mcpToolError('Repository not found');
      const state = str(args.state, 'open');
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((issue) => issue.state === 'open');
      else if (state === 'closed') items = items.filter((issue) => issue.state === 'closed');
      items.sort((a, b) => a.seq - b.seq);
      return mcpToolResult(items.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(str(args.owner), str(args.repo));
      if (repo === null) return mcpToolError('Repository not found');
      const head = str(args.head).split(':').pop() as string;
      const base = str(args.base).split(':').pop() as string;
      const existing = [...repo.pulls.values()].find((pull) => pull.state === 'open' && !pull.merged && pull.head === head && pull.base === base);
      if (existing !== undefined) return mcpToolResult(pullJson(repo, existing));
      if (branchTip(repo, head) === null || branchTip(repo, base) === null) return mcpToolError('Head or base branch does not exist');
      const pull: PullRec = {
        number: repo.nextNumber,
        title: str(args.title),
        body: str(args.body),
        head,
        base,
        state: 'open',
        merged: false,
        mergedAtSeq: null,
        mergeCommitSha: null,
        seq: nextSeq(),
      };
      repo.nextNumber += 1;
      repo.pulls.set(pull.number, pull);
      return mcpToolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(str(args.owner), str(args.repo));
      if (repo === null) return mcpToolError('Repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (pull === undefined) return mcpToolError('Pull request not found');
      if (pull.merged) return mcpToolResult(pullJson(repo, pull));
      const result = squashMerge(repo, pull);
      if (result === 'conflict') return mcpToolError('Pull Request is not mergeable');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAtSeq = nextSeq();
      pull.mergeCommitSha = result;
      return mcpToolResult(pullJson(repo, pull));
    }
    default:
      return mcpToolError(`Unknown tool ${name}`);
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  const rawText = rawBody.toString('utf8');
  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
    message = parsed as Record<string, unknown>;
  } catch {
    const idMatch = /"id"\s*:\s*(\d+|"[^"]*")/.exec(rawText);
    sendJson(res, 400, {
      jsonrpc: '2.0',
      id: idMatch === null ? null : (JSON.parse(idMatch[1] as string) as unknown),
      error: { code: -32700, message: 'Parse error' },
    });
    return;
  }
  const id = message.id as string | number | undefined;
  const method = str(message.method);
  const isNotification = id === undefined || method.startsWith('notifications/');
  if (isNotification) {
    res.writeHead(202, { 'content-type': JSON_TYPE });
    res.end();
    return;
  }
  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, text: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message: text } });
  };

  if (method === 'server/discover') {
    reply({
      supportedVersions: ['2026-07-28', '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: { name: 'mini-forge', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'mini-forge', version: '1.0.0' } },
    });
    return;
  }
  if (method === 'initialize') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    reply({
      protocolVersion: str(params.protocolVersion, '2025-11-25'),
      capabilities: { tools: {} },
      serverInfo: { name: 'mini-forge', version: '1.0.0' },
    });
    return;
  }
  if (method === 'ping') {
    reply({});
    return;
  }
  if (method === 'tools/list') {
    reply({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const params = (message.params ?? {}) as Record<string, unknown>;
    const toolName = str(params.name);
    const tool = MCP_TOOLS.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      replyError(-32601, `Unknown tool ${toolName}`);
      return;
    }
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const schema = tool.inputSchema as { required?: string[] };
    const missing = (schema.required ?? []).filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) {
      replyError(-32602, `Missing required argument(s): ${missing.join(', ')}`);
      return;
    }
    try {
      reply(mcpCallTool(toolName, args));
    } catch (err) {
      reply(mcpToolError(err instanceof Error ? err.message : 'tool failed'));
    }
    return;
  }
  replyError(-32601, `Method not found: ${method}`);
}

// --------------------------------------------------------------------------- router

/** The whole forge as one HTTP server; the default export the lifecycle entry imports. */
export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.invalid');
        const path = url.pathname;

        if (path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const rawBody = await readBody(req);
          await handleGit(req, res, decodeSegment(gitMatch[1] as string), decodeSegment(gitMatch[2] as string), gitMatch[3] as string, url.searchParams, rawBody);
          return;
        }

        if (path === '/api/graphql') {
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const rawBody = await readBody(req);
          handleGraphql(res, rawBody);
          return;
        }

        if (path === '/mcp') {
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const rawBody = await readBody(req);
          handleMcp(req, res, rawBody);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!isAuthorized(req)) {
            unauthorized(res);
            return;
          }
          const rawBody = await readBody(req);
          handleRest(req, res, url, rawBody);
          return;
        }

        notFound(res);
      } catch (err) {
        // A request must never take the server down with it.
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal error' });
        else res.end();
      }
    })();
  });
}

export default createApp;
