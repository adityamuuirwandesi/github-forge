// github-forge: a GitHub-compatible git forge (REST v3, GraphQL v4, MCP, git smart HTTP).
// Stdlib only (node:http, node:crypto, node:zlib). In-memory store; deterministic timestamps
// derived from a monotonic sequence counter so replays are byte-for-byte identical.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------- constants
const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER = { login: 'adaiversen', id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const AGENT = 'github-forge/1.0';
const ZERO_OID = '0000000000000000000000000000000000000000';
const EPOCH = 1735689600; // 2025-01-01T00:00:00Z, base for deterministic timestamps
const MAX_BODY = 64 * 1024 * 1024;

// Deterministic clock: every mutation consumes one tick.
let tick = 0;
function tickIso(): string { tick += 1; return new Date((EPOCH + tick) * 1000).toISOString(); }
function tickTs(): number { tick += 1; return EPOCH + tick; }

// ---------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer }
const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1(buf: Buffer): string { return createHash('sha1').update(buf).digest('hex'); }
function hashObject(type: ObjType, data: Buffer): string {
  return sha1(Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'latin1'), data]));
}
interface ParsedCommit { tree: string; parents: string[]; author: string; committer: string; message: string; raw: Buffer }
function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('latin1');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = ''; const parents: string[] = []; let author = ''; let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message, raw: data };
}
function identLine(ident: string, ts: number): string { return `${ident} ${ts} +0000`; }
function buildCommit(tree: string, parents: string[], message: string, ts: number): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${identLine(`${VIEWER.name} <${VIEWER.email}>`, ts)}`);
  lines.push(`committer ${identLine(`${VIEWER.name} <${VIEWER.email}>`, ts)}`);
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}
interface TreeEntry { mode: string; name: string; oid: string }
function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp < 0) break;
    const mode = data.toString('latin1', off, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('latin1', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}
function treeSortKey(e: TreeEntry): string { return e.mode === '40000' ? `${e.name}/` : e.name; }
function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'latin1'), Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
function parseTag(data: Buffer): { object: string; type: ObjType; tag: string } {
  const text = data.toString('latin1');
  const object = (text.match(/^object ([0-9a-f]{40})/m) ?? [])[1] ?? '';
  const type = ((text.match(/^type (\w+)/m) ?? [])[1] ?? 'commit') as ObjType;
  const tag = (text.match(/^tag (.*)$/m) ?? [])[1] ?? '';
  return { object, type, tag };
}
function parseIdent(ident: string): { name: string; email: string; date: string } {
  const m = ident.match(/^(.*?) <([^>]*)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: ident, email: '', date: '' };
  return { name: m[1], email: m[2], date: new Date(Number(m[3]) * 1000).toISOString() };
}

// ---------------------------------------------------------------- store
interface Label { id: number; name: string; color: string; description: string }
interface Comment { id: number; body: string; user: string; createdAt: string; updatedAt: string }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: string[]; seq: number; createdAt: string; updatedAt: string; closedAt: string | null;
  comments: Comment[]; cachedJson: string | null;
}
interface PR {
  number: number; title: string; body: string; state: 'open' | 'closed'; merged: boolean;
  headRef: string; baseRef: string; headSha: string; baseSha: string;
  mergeSha: string | null; mergedAt: string | null; seq: number;
  createdAt: string; updatedAt: string; closedAt: string | null;
  files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }>;
}
interface Repo {
  id: number; owner: string; name: string; description: string; priv: boolean;
  defaultBranch: string; seq: number; createdAt: string; updatedAt: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>; nextIssue: number;
  pulls: Map<number, PR>; nextPull: number;
}
const repos = new Map<string, Repo>();
let nextRepoId = 10000;
let nextLabelId = 1;
let nextCommentId = 1;
let nextGlobalSeq = 0;
let reqCounter = 0;
function repoKey(owner: string, name: string): string { return `${owner}/${name}`; }
function findRepo(owner: string, name: string): Repo | undefined {
  return owner === VIEWER.login ? repos.get(repoKey(owner, name)) : undefined;
}
function newRepo(name: string, description: string, priv: boolean): Repo {
  const id = nextRepoId; nextRepoId += 1;
  const now = tickIso();
  const repo: Repo = {
    id, owner: VIEWER.login, name, description, priv, defaultBranch: 'main',
    seq: ++nextGlobalSeq, createdAt: now, updatedAt: now,
    objects: new Map(), refs: new Map(), labels: new Map(),
    issues: new Map(), nextIssue: 1, pulls: new Map(), nextPull: 1,
  };
  for (const [n, c] of [['bug', 'd73a4a'], ['enhancement', 'a2eeef'], ['documentation', '0075ca'],
    ['question', 'd876e3'], ['good first issue', '7057ff'], ['help wanted', '008672']] as Array<[string, string]>) {
    repo.labels.set(n, { id: nextLabelId++, name: n, color: c, description: '' });
  }
  repos.set(repoKey(VIEWER.login, name), repo);
  return repo;
}
function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`).toString('base64');
}
function decodeGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch { return null; }
}
function repoById(id: number): Repo | undefined {
  for (const r of repos.values()) if (r.id === id) return r;
  return undefined;
}

// ---- tree helpers on a repo (file-path -> blob oid maps)
function flattenTree(repo: Repo, treeOid: string, prefix: string, out: Map<string, string>): void {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, e.oid);
  }
}
function fileMapAt(repo: Repo, commitOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const c = repo.objects.get(commitOid);
  if (!c || c.type !== 'commit') return out;
  flattenTree(repo, parseCommit(c.data).tree, '', out);
  return out;
}
function buildTreeFromFiles(repo: Repo, files: Map<string, string>): string {
  // Build nested trees bottom-up.
  type Node = Map<string, string | Node>;
  const root: Node = new Map();
  for (const [path, oid] of files) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const p = parts[i]!;
      let child = node.get(p);
      if (!child || typeof child === 'string') { child = new Map(); node.set(p, child); }
      node = child as Node;
    }
    node.set(parts[parts.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, v] of node) {
      if (typeof v === 'string') entries.push({ mode: '100644', name, oid: v });
      else entries.push({ mode: '40000', name, oid: build(v) });
    }
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    repo.objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}
function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function peelToCommit(repo: Repo, oid: string): string | null {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const obj = repo.objects.get(cur);
    if (!obj) return null;
    if (obj.type === 'commit') return cur;
    if (obj.type === 'tag') cur = parseTag(obj.data).object;
    else return null;
  }
  return null;
}
function commitParents(repo: Repo, oid: string): string[] {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return [];
  return parseCommit(obj.data).parents;
}
function isDescendant(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const p of commitParents(repo, cur)) stack.push(p);
  }
  return false;
}
function refTipCommit(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  return peelToCommit(repo, oid);
}
function resolveRef(repo: Repo, ref: string): string | null {
  // branch name, full ref, or sha
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const head = `refs/heads/${ref}`;
  if (repo.refs.has(head)) return repo.refs.get(head)!;
  const tag = `refs/tags/${ref}`;
  if (repo.refs.has(tag)) return repo.refs.get(tag)!;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

// ---------------------------------------------------------------- pkt-lines
function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([head, data]);
}
const FLUSH = Buffer.from('0000', 'latin1');
const DELIM = Buffer.from('0001', 'latin1');
function pktLines(payloads: Array<Buffer | string>): Buffer {
  return Buffer.concat(payloads.map((p) => pktLine(p)));
}
/** Decode pkt-lines; returns {lines, rest} where lines are payload Buffers, 'flush'/'delim' markers.
 * With stopAtFlush, decoding stops at the first flush packet and the rest of the buffer (e.g. a
 * raw packfile) is returned untouched. */
function decodePkt(buf: Buffer, stopAtFlush = false): { items: Array<Buffer | 'flush' | 'delim'>; rest: Buffer } {
  const items: Array<Buffer | 'flush' | 'delim'> = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const hex = buf.toString('latin1', off, off + 4);
    const len = parseInt(hex, 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) throw new Error(`bad pkt-line length ${hex}`);
    if (len === 0) {
      items.push('flush'); off += 4;
      if (stopAtFlush) break;
      continue;
    }
    if (len === 1) { items.push('delim'); off += 4; continue; }
    if (off + len > buf.length) throw new Error('truncated pkt-line');
    items.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return { items, rest: buf.subarray(off) };
}

// ---------------------------------------------------------------- packs
function writePackObject(type: ObjType, data: Buffer): Buffer {
  const z = deflateSync(data, { level: 1 });
  let size = data.length;
  const bytes: number[] = [];
  let first = (TYPE_CODE[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.concat([Buffer.from(bytes), z]);
}
function writePack(objs: Array<{ oid: string; type: ObjType; data: Buffer }>): Buffer {
  const sorted = [...objs].sort((a, b) => (a.oid < b.oid ? -1 : 1));
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'latin1');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(sorted.length, 8);
  const parts: Buffer[] = [head];
  for (const o of sorted) parts.push(writePackObject(o.type, o.data));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
interface PackEntry { oid: string; type: ObjType; data: Buffer }
function parsePackHeader(data: Buffer, off: number): { type: number; size: number; next: number } {
  let b = data[off]!;
  const type = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  let next = off + 1;
  while (b & 0x80) {
    b = data[next]!;
    size |= (b & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { type, size, next };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let v = 0; let s = 0;
    for (;;) {
      const b = delta[off]!; off += 1;
      v |= (b & 0x7f) << s; s += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readVarint();
  const dstSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (off < delta.length) {
    const op = delta[off]!; off += 1;
    if (op & 0x80) {
      let cpOff = 0; let cpSize = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) { cpOff |= delta[off]! << (8 * i); off += 1; }
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) { cpSize |= delta[off]! << (8 * i); off += 1; }
      if (cpSize === 0) cpSize = 0x10000;
      out.push(base.subarray(cpOff, cpOff + cpSize));
      total += cpSize;
    } else if (op > 0) {
      out.push(delta.subarray(off, off + op));
      off += op; total += op;
    } else throw new Error('delta opcode 0');
  }
  const result = Buffer.concat(out);
  if (result.length !== dstSize || total !== dstSize) throw new Error('delta result size mismatch');
  return result;
}
function readPack(buf: Buffer, lookup: (oid: string) => GitObj | undefined): PackEntry[] {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const start = off;
    const { type, size, next } = parsePackHeader(buf, off);
    off = next;
    let ofsBase = -1;
    let refBaseOid: string | null = null;
    if (type === 6) {
      // OFS_DELTA: negative-offset varint precedes the deflate stream.
      let b = buf[off]!; off += 1;
      let baseOff = b & 0x7f;
      while (b & 0x80) { b = buf[off]!; off += 1; baseOff = ((baseOff + 1) << 7) | (b & 0x7f); }
      ofsBase = start - baseOff;
    } else if (type === 7) {
      refBaseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    }
    const inflated = inflateSync(buf.subarray(off), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    const data = inflated.buffer;
    const used = inflated.engine.bytesWritten;
    if (!(used > 0)) throw new Error('could not measure deflate stream length');
    off += used;
    if (type === 6 || type === 7) {
      let baseEntry: PackEntry | undefined;
      if (type === 6) {
        baseEntry = byOffset.get(ofsBase);
        if (!baseEntry) throw new Error('ofs-delta base not in pack');
      } else {
        const found = entries.find((e) => e.oid === refBaseOid) ?? lookup(refBaseOid!);
        if (found) baseEntry = { oid: refBaseOid!, type: found.type, data: found.data };
        else throw new Error(`ref-delta base ${refBaseOid} missing`);
      }
      const resolved = applyDelta(baseEntry.data, data);
      const entry: PackEntry = { oid: hashObject(baseEntry.type, resolved), type: baseEntry.type, data: resolved };
      entries.push(entry);
      byOffset.set(start, entry);
    } else {
      const t = CODE_TYPE[type];
      if (!t) throw new Error(`unknown pack object type ${type}`);
      if (data.length !== size) throw new Error('object size mismatch in pack');
      const entry: PackEntry = { oid: hashObject(t, data), type: t, data };
      entries.push(entry);
      byOffset.set(start, entry);
    }
  }
  return entries;
}

// ---- fetch object computation
interface FetchPlan { objects: PackEntry[]; shallow: string[]; unshallow: string[] }
function commitClosure(repo: Repo, roots: string[], stopAt: Set<string>): Set<string> {
  // All commits reachable from roots; commits in stopAt are included but their parents are not.
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (out.has(cur)) continue;
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.add(cur);
    if (stopAt.has(cur)) continue;
    for (const p of parseCommit(obj.data).parents) stack.push(p);
  }
  return out;
}
function computeFetch(repo: Repo, wants: string[], haves: string[], shallowOld: string[], depth: number | null): FetchPlan {
  const stopOld = new Set(shallowOld);
  const held = commitClosure(repo, haves.map((h) => peelToCommit(repo, h) ?? h).filter((x) => x !== null) as string[], stopOld);
  const heldObjs = new Set<string>();
  for (const c of held) {
    const obj = repo.objects.get(c);
    if (!obj) continue;
    heldObjs.add(c);
    const tree = parseCommit(obj.data).tree;
    const fm = new Map<string, string>();
    flattenTree(repo, tree, '', fm);
    heldObjs.add(tree);
    for (const b of fm.values()) heldObjs.add(b);
    // nested trees
    const collectTrees = (t: string): void => {
      const o = repo.objects.get(t);
      if (!o || o.type !== 'tree') return;
      heldObjs.add(t);
      for (const e of parseTree(o.data)) if (e.mode === '40000') collectTrees(e.oid);
    };
    collectTrees(tree);
  }
  // Wanted commits with distances.
  const dist = new Map<string, number>();
  const queue: string[] = [];
  const tagObjs: string[] = [];
  for (const w of wants) {
    const obj = repo.objects.get(w);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tagObjs.push(w);
      const target = peelToCommit(repo, w);
      if (target && !dist.has(target)) { dist.set(target, 0); queue.push(target); }
    } else if (obj.type === 'commit' && !dist.has(w)) { dist.set(w, 0); queue.push(w); }
  }
  let qi = 0;
  while (qi < queue.length) {
    const cur = queue[qi++]!;
    const d = dist.get(cur)!;
    if (depth !== null && d + 1 >= depth) continue;
    for (const p of commitParents(repo, cur)) {
      if (!dist.has(p)) { dist.set(p, d + 1); queue.push(p); }
    }
  }
  const include = new Set<string>();
  const shallow: string[] = [];
  for (const [c, d] of dist) {
    include.add(c);
    if (depth !== null && d === depth - 1 && commitParents(repo, c).length > 0) shallow.push(c);
  }
  const unshallow: string[] = [];
  for (const s of shallowOld) {
    const d = dist.get(s);
    if (d !== undefined && (depth === null || d < depth - 1)) unshallow.push(s);
  }
  // Expand included commits to trees+blobs, minus held.
  const toSend = new Map<string, PackEntry>();
  const addObj = (oid: string): void => {
    if (heldObjs.has(oid) || toSend.has(oid)) return;
    const o = repo.objects.get(oid);
    if (!o) return;
    toSend.set(oid, { oid, type: o.type, data: o.data });
  };
  for (const t of tagObjs) addObj(t);
  for (const c of include) {
    if (heldObjs.has(c)) continue;
    addObj(c);
    const obj = repo.objects.get(c);
    if (!obj) continue;
    const tree = parseCommit(obj.data).tree;
    const fm = new Map<string, string>();
    flattenTree(repo, tree, '', fm);
    const addTree = (t: string): void => {
      addObj(t);
      const o = repo.objects.get(t);
      if (!o || o.type !== 'tree') return;
      for (const e of parseTree(o.data)) if (e.mode === '40000') addTree(e.oid);
    };
    addTree(tree);
    for (const b of fm.values()) addObj(b);
  }
  return { objects: [...toSend.values()], shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 60000) {
    const slice = pack.subarray(off, Math.min(pack.length, off + 60000));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat([...chunks, FLUSH]);
}

// ---------------------------------------------------------------- git smart HTTP
function sortedRefs(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}
function refLinesV0(repo: Repo, caps: string): Buffer {
  const parts: Buffer[] = [];
  const heads = sortedRefs(repo).filter((r) => r.startsWith('refs/heads/'));
  const tags = sortedRefs(repo).filter((r) => r.startsWith('refs/tags/'));
  const tip = repo.refs.get('refs/heads/main') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const firstCaps = `\0${caps}`;
  if (!tip && heads.length === 0 && tags.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}${firstCaps}\n`));
    parts.push(FLUSH);
    return Buffer.concat(parts);
  }
  let first = true;
  const line = (oid: string, name: string): Buffer => {
    const b = pktLine(`${oid} ${name}${first ? firstCaps : ''}\n`);
    first = false;
    return b;
  };
  if (tip) parts.push(line(tip, 'HEAD'));
  for (const r of heads) parts.push(line(repo.refs.get(r)!, r));
  for (const r of tags) {
    const oid = repo.refs.get(r)!;
    parts.push(line(oid, r));
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const target = peelToCommit(repo, oid);
      if (target) parts.push(pktLine(`${target} ${r}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}
function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow agent=${AGENT} object-format=sha1`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} object-format=sha1`;
  return Buffer.concat([pktLine(`# service=${service}\n`), FLUSH, refLinesV0(repo, caps)]);
}
function advertiseV2(repo: Repo): Buffer {
  const lines = [
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    FLUSH,
  ];
  return Buffer.concat(lines);
}
interface LsRefsOpts { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }
function lsRefsResponse(repo: Repo, opts: LsRefsOpts): Buffer {
  const out: Buffer[] = [];
  const mainRef = `refs/heads/${repo.defaultBranch}`;
  const mainTip = repo.refs.get(mainRef);
  const emit = (oid: string, name: string, attrs: string): void => {
    out.push(pktLine(`${oid} ${name}${attrs}\n`));
  };
  const matches = (name: string): boolean => opts.prefixes.length === 0 || opts.prefixes.some((p) => name.startsWith(p));
  if (opts.prefixes.length === 0) {
    if (mainTip) {
      emit(mainTip, 'HEAD', opts.symrefs ? ` symref-target:${mainRef}` : '');
    } else if (opts.unborn) {
      emit('unborn', 'HEAD', opts.symrefs ? ` symref-target:${mainRef}` : '');
    }
  }
  for (const r of sortedRefs(repo)) {
    if (!matches(r)) continue;
    const oid = repo.refs.get(r)!;
    let attrs = '';
    if (opts.peel) {
      const obj = repo.objects.get(oid);
      if (obj?.type === 'tag') {
        const target = peelToCommit(repo, oid);
        if (target) attrs += ` peeled:${target}`;
      }
    }
    emit(oid, r, attrs);
  }
  out.push(FLUSH);
  return Buffer.concat(out);
}
function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  if (isV2) {
    const { items } = decodePkt(body);
    const lines = items.filter((i): i is Buffer => Buffer.isBuffer(i)).map((b) => b.toString('utf8'));
    const command = (lines.find((l) => l.startsWith('command=')) ?? '').slice('command='.length).trim();
    if (command === 'ls-refs') {
      const argLines = lines.map((l) => l.trim()).filter((l) => !l.startsWith('command=') && !l.startsWith('agent=') && !l.startsWith('object-format='));
      const opts: LsRefsOpts = {
        peel: argLines.includes('peel'),
        symrefs: argLines.includes('symrefs'),
        unborn: argLines.includes('unborn'),
        prefixes: argLines.filter((l) => l.startsWith('ref-prefix ')).map((l) => l.slice('ref-prefix '.length).trim()),
      };
      return lsRefsResponse(repo, opts);
    }
    if (command === 'fetch') {
      const delimIdx = items.findIndex((i) => i === 'delim');
      const argLines = items.slice(delimIdx + 1).filter((i): i is Buffer => Buffer.isBuffer(i)).map((b) => b.toString('utf8').trim());
      const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
      let depth: number | null = null;
      for (const l of argLines) {
        if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0]!);
        else if (l.startsWith('have ')) haves.push(l.slice(5).trim());
        else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
        else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10);
      }
      const plan = computeFetch(repo, wants, haves, shallow, depth);
      const pack = writePack(plan.objects);
      const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), DELIM];
      if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(pktLine('shallow-info\n'));
        for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
        for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
        parts.push(DELIM);
      }
      parts.push(pktLine('packfile\n'), sidebandPack(pack));
      return Buffer.concat(parts);
    }
    throw new Error(`unknown v2 command ${command}`);
  }
  // v0 fetch: wants/shallow/deepen until flush, then haves until done+flush.
  const { items } = decodePkt(body);
  const lines = items.filter((i): i is Buffer => Buffer.isBuffer(i)).map((b) => b.toString('utf8'));
  const wants: string[] = []; const haves: string[] = []; const shallow: string[] = [];
  let depth: number | null = null;
  let second = false;
  for (const item of items) {
    if (item === 'flush') { second = true; continue; }
    const l = item.toString('utf8').trim();
    if (!second) {
      if (l.startsWith('want ')) wants.push(l.slice(5).split(' ')[0]!);
      else if (l.startsWith('shallow ')) shallow.push(l.slice(8).trim());
      else if (l.startsWith('deepen ')) depth = parseInt(l.slice(7).trim(), 10);
    } else {
      if (l.startsWith('have ')) haves.push(l.slice(5).trim());
    }
  }
  void lines;
  const plan = computeFetch(repo, wants, haves, shallow, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const s of plan.shallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const s of plan.unshallow) parts.push(pktLine(`unshallow ${s}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}
interface PushCommand { oldOid: string; newOid: string; ref: string }
function handleReceivePack(repo: Repo, body: Buffer): { status: number; body: Buffer; contentType: string } {
  const bad = (): { status: number; body: Buffer; contentType: string } => ({
    status: 400, body: Buffer.from(JSON.stringify({ message: 'Bad Request' })), contentType: JSON_TYPE,
  });
  let items: Array<Buffer | 'flush' | 'delim'>;
  let rest: Buffer;
  try {
    ({ items, rest } = decodePkt(body, true));
  } catch { return bad(); }
  const commands: PushCommand[] = [];
  let first = true;
  let wantSideband = false;
  for (const item of items) {
    if (item === 'flush') break;
    if (item === 'delim') continue;
    let line = item.toString('utf8');
    if (first) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        if (line.slice(nul + 1).includes('side-band-64k')) wantSideband = true;
        line = line.slice(0, nul);
      }
      first = false;
    }
    const m = line.trim().match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/);
    if (!m) return bad();
    commands.push({ oldOid: m[1]!, newOid: m[2]!, ref: m[3]! });
  }
  if (commands.length === 0) return bad();
  // Unpack.
  let entries: PackEntry[] = [];
  let unpackOk = true;
  if (rest.length > 0) {
    try {
      entries = readPack(rest, (oid) => repo.objects.get(oid));
      for (const e of entries) repo.objects.set(e.oid, { type: e.type, data: e.data });
    } catch { unpackOk = false; }
  }
  const results: Array<{ ok: boolean; ref: string; reason: string }> = [];
  if (!unpackOk) {
    for (const c of commands) results.push({ ok: false, ref: c.ref, reason: 'unpacker error' });
  } else {
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // delete
        if (!current) results.push({ ok: false, ref: c.ref, reason: 'no such ref' });
        else if (c.oldOid !== ZERO_OID && c.oldOid !== current) results.push({ ok: false, ref: c.ref, reason: 'non-fast-forward' });
        else { repo.refs.delete(c.ref); results.push({ ok: true, ref: c.ref, reason: '' }); }
        continue;
      }
      const newObj = repo.objects.get(c.newOid);
      if (!newObj || (newObj.type !== 'commit' && newObj.type !== 'tag')) {
        results.push({ ok: false, ref: c.ref, reason: 'missing object' });
        continue;
      }
      if (c.oldOid === ZERO_OID) {
        if (current) results.push({ ok: false, ref: c.ref, reason: 'already exists' });
        else { repo.refs.set(c.ref, c.newOid); results.push({ ok: true, ref: c.ref, reason: '' }); }
        continue;
      }
      if (!current) { results.push({ ok: false, ref: c.ref, reason: 'no such ref' }); continue; }
      if (current !== c.oldOid) { results.push({ ok: false, ref: c.ref, reason: 'non-fast-forward' }); continue; }
      const newCommit = peelToCommit(repo, c.newOid);
      const oldCommit = peelToCommit(repo, c.oldOid);
      if (!newCommit || !oldCommit) { results.push({ ok: false, ref: c.ref, reason: 'missing object' }); continue; }
      if (!isDescendant(repo, oldCommit, newCommit)) {
        results.push({ ok: false, ref: c.ref, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(c.ref, c.newOid);
      results.push({ ok: true, ref: c.ref, reason: '' });
    }
  }
  const textLines: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const r of results) textLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  const reportText = textLines.join('');
  if (wantSideband) {
    const banded: Buffer[] = [];
    const raw = Buffer.from(reportText, 'utf8');
    for (let off = 0; off < raw.length; off += 60000) {
      banded.push(pktLine(Buffer.concat([Buffer.from([1]), raw.subarray(off, Math.min(raw.length, off + 60000))])));
    }
    banded.push(FLUSH);
    return { status: 200, body: Buffer.concat(banded), contentType: 'application/x-git-receive-pack-result' };
  }
  return { status: 200, body: Buffer.concat([...textLines.map((l) => pktLine(l)), FLUSH]), contentType: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------- REST shapes
function repoJson(r: Repo): Record<string, unknown> {
  return {
    id: r.id, node_id: gid('R', r.id), name: r.name, full_name: `${r.owner}/${r.name}`,
    owner: { login: r.owner, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `https://github.com/${r.owner}`, url: `/api/v3/users/${r.owner}` },
    private: r.priv, html_url: `https://github.com/${r.owner}/${r.name}`,
    description: r.description, fork: false,
    url: `/api/v3/repos/${r.owner}/${r.name}`,
    created_at: r.createdAt, updated_at: r.updatedAt, pushed_at: r.updatedAt,
    git_url: `git://github.com/${r.owner}/${r.name}.git`,
    ssh_url: `git@github.com:${r.owner}/${r.name}.git`,
    clone_url: `https://github.com/${r.owner}/${r.name}.git`,
    homepage: null, size: 0, stargazers_count: 0, watchers_count: 0, language: null,
    has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
    has_discussions: false, forks_count: 0, open_issues_count: [...r.issues.values()].filter((i) => i.state === 'open').length,
    license: null, allow_forking: true, is_template: false, topics: [],
    visibility: r.priv ? 'private' : 'public', default_branch: r.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    archived: false, disabled: false, mirror_url: null, open_issues: 0,
  };
}
function labelJson(l: Label): Record<string, unknown> {
  return { id: l.id, node_id: gid('L', l.id), url: `/api/v3/labels/${encodeURIComponent(l.name)}`, name: l.name, color: l.color, default: false, description: l.description };
}
function issueJson(r: Repo, i: Issue): Record<string, unknown> {
  return {
    id: i.number * 100000 + r.id, node_id: gid('I', r.id, i.number),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}`,
    repository_url: `/api/v3/repos/${r.owner}/${r.name}`,
    labels_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/comments`,
    events_url: `/api/v3/repos/${r.owner}/${r.name}/issues/${i.number}/events`,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}`,
    number: i.number, title: i.title, body: i.body, state: i.state, locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User', avatar_url: '', html_url: `https://github.com/${VIEWER.login}` },
    labels: i.labels.map((n) => { const l = r.labels.get(n); return l ? labelJson(l) : { name: n, color: 'ededed' }; }),
    assignee: null, assignees: [], milestone: null, comments: i.comments.length,
    created_at: i.createdAt, updated_at: i.updatedAt, closed_at: i.closedAt,
    author_association: 'OWNER', active_lock_reason: null, state_reason: i.state === 'closed' ? 'completed' : null,
  };
}
function issueJsonCached(r: Repo, i: Issue): string {
  if (i.cachedJson === null) i.cachedJson = JSON.stringify(issueJson(r, i));
  return i.cachedJson;
}
function commentJson(r: Repo, i: Issue, c: Comment): Record<string, unknown> {
  return {
    id: c.id, node_id: gid('C', r.id, i.number, c.id),
    url: `/api/v3/repos/${r.owner}/${r.name}/issues/comments/${c.id}`,
    html_url: `https://github.com/${r.owner}/${r.name}/issues/${i.number}#issuecomment-${c.id}`,
    body: c.body,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    created_at: c.createdAt, updated_at: c.updatedAt,
    author_association: 'OWNER',
  };
}
function prJson(r: Repo, p: PR): Record<string, unknown> {
  return {
    id: p.number * 100000 + r.id, node_id: gid('P', r.id, p.number),
    url: `/api/v3/repos/${r.owner}/${r.name}/pulls/${p.number}`,
    html_url: `https://github.com/${r.owner}/${r.name}/pull/${p.number}`,
    number: p.number, title: p.title, body: p.body, state: p.state, locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    labels: [], assignee: null, assignees: [], milestone: null,
    comments: 0, review_comments: 0, commits: 1, additions: p.files.reduce((a, f) => a + f.additions, 0),
    deletions: p.files.reduce((a, f) => a + f.deletions, 0), changed_files: p.files.length,
    created_at: p.createdAt, updated_at: p.updatedAt, closed_at: p.closedAt, merged_at: p.mergedAt,
    merge_commit_sha: p.mergeSha, merged: p.merged, mergeable: prMergeable(r, p) === 'CONFLICTING' ? false : true,
    mergeable_state: prMergeable(r, p) === 'CONFLICTING' ? 'dirty' : 'clean',
    merged_by: p.merged ? { login: VIEWER.login, id: VIEWER.id, type: 'User' } : null,
    head: { label: `${r.owner}:${p.headRef}`, ref: p.headRef, sha: p.headSha, user: { login: r.owner, id: VIEWER.id }, repo: repoJson(r) },
    base: { label: `${r.owner}:${p.baseRef}`, ref: p.baseRef, sha: p.baseSha, user: { login: r.owner, id: VIEWER.id }, repo: repoJson(r) },
    _links: {}, author_association: 'OWNER', draft: false, auto_merge: null,
  };
}
function commitJson(r: Repo, oid: string): Record<string, unknown> | null {
  const obj = r.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const c = parseCommit(obj.data);
  const author = parseIdent(c.author);
  const committer = parseIdent(c.committer);
  return {
    sha: oid, node_id: gid('CM', r.id, oid), commit: {
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      message: c.message, tree: { sha: c.tree }, url: `/api/v3/repos/${r.owner}/${r.name}/git/commits/${oid}`,
      comment_count: 0, verification: { verified: false, reason: 'unsigned', signature: null, payload: null },
    },
    url: `/api/v3/repos/${r.owner}/${r.name}/commits/${oid}`,
    html_url: `https://github.com/${r.owner}/${r.name}/commit/${oid}`,
    comments_url: `/api/v3/repos/${r.owner}/${r.name}/commits/${oid}/comments`,
    author: { login: author.email === VIEWER.email ? VIEWER.login : null, id: VIEWER.id, type: 'User' },
    committer: { login: committer.email === VIEWER.email ? VIEWER.login : null, id: VIEWER.id, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p, url: `/api/v3/repos/${r.owner}/${r.name}/commits/${p}` })),
  };
}
function listCommitsFrom(repo: Repo, tip: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0 && out.length < limit) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    out.push(cur);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return out;
}
function countLines(data: Buffer): number {
  if (data.length === 0) return 0;
  const text = data.toString('utf8');
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}
function diffFiles(repo: Repo, baseCommit: string, headCommit: string): PR['files'] {
  const base = fileMapAt(repo, baseCommit);
  const head = fileMapAt(repo, headCommit);
  const files: PR['files'] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const b = base.get(path); const h = head.get(path);
    if (b === h) continue;
    if (b === undefined) {
      const n = countLines(repo.objects.get(h!)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (h === undefined) {
      const n = countLines(repo.objects.get(b)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'removed', additions: 0, deletions: n, changes: n });
    } else {
      const n = countLines(repo.objects.get(h)?.data ?? Buffer.alloc(0));
      const o = countLines(repo.objects.get(b)?.data ?? Buffer.alloc(0));
      files.push({ filename: path, status: 'modified', additions: n, deletions: o, changes: n + o });
    }
  }
  return files;
}
function prMergeable(repo: Repo, p: PR): 'MERGEABLE' | 'CONFLICTING' {
  const baseTip = refTipCommit(repo, `refs/heads/${p.baseRef}`);
  if (!baseTip) return 'MERGEABLE';
  const baseMap = fileMapAt(repo, p.baseSha);
  const headMap = fileMapAt(repo, p.headSha);
  const curMap = fileMapAt(repo, baseTip);
  const paths = new Set([...baseMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const b = baseMap.get(path); const h = headMap.get(path); const c = curMap.get(path);
    if (b === h) continue;
    if (c !== b && c !== h) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}
function makeServerCommit(repo: Repo, message: string, files: Map<string, string>, parents: string[]): string {
  const treeOid = buildTreeFromFiles(repo, files);
  const ts = tickTs();
  const data = buildCommit(treeOid, parents, message, ts);
  return storeObject(repo, 'commit', data);
}
function applyContentChange(repo: Repo, branch: string, path: string, content: Buffer, message: string): { commitSha: string; blobSha: string; created: boolean } {
  const ref = `refs/heads/${branch}`;
  let tip = refTipCommit(repo, ref);
  if (!tip && branch !== repo.defaultBranch) {
    // Create the branch from the default tip (or unborn).
    const defTip = refTipCommit(repo, `refs/heads/${repo.defaultBranch}`);
    if (defTip) { repo.refs.set(ref, defTip); tip = defTip; }
  }
  const files = tip ? fileMapAt(repo, tip) : new Map<string, string>();
  const created = !files.has(path);
  const blobSha = storeObject(repo, 'blob', content);
  files.set(path, blobSha);
  const commitSha = makeServerCommit(repo, message, files, tip ? [tip] : []);
  repo.refs.set(ref, commitSha);
  repo.updatedAt = tickIso();
  return { commitSha, blobSha, created };
}
function applyContentDelete(repo: Repo, branch: string, path: string, message: string): { commitSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = refTipCommit(repo, ref);
  const files = tip ? fileMapAt(repo, tip) : new Map<string, string>();
  files.delete(path);
  const commitSha = makeServerCommit(repo, message, files, tip ? [tip] : []);
  repo.refs.set(ref, commitSha);
  repo.updatedAt = tickIso();
  return { commitSha };
}
function squashMerge(repo: Repo, p: PR): { sha: string } | { conflict: true } {
  if (prMergeable(repo, p) === 'CONFLICTING') return { conflict: true };
  const baseTip = refTipCommit(repo, `refs/heads/${p.baseRef}`)!;
  const curMap = fileMapAt(repo, baseTip);
  const baseMap = fileMapAt(repo, p.baseSha);
  const headMap = fileMapAt(repo, p.headSha);
  for (const [path, h] of headMap) if (baseMap.get(path) !== h) curMap.set(path, h);
  for (const path of baseMap.keys()) if (!headMap.has(path)) curMap.delete(path);
  const message = `Merge pull request #${p.number} from ${p.headRef}\n\n${p.title}`;
  const sha = makeServerCommit(repo, message, curMap, [baseTip]);
  repo.refs.set(`refs/heads/${p.baseRef}`, sha);
  repo.updatedAt = tickIso();
  return { sha };
}

// ---------------------------------------------------------------- HTTP helpers
let globalReqId = 0;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${(++globalReqId).toString(16)}`,
    ...extra,
  });
  res.end(text);
}
function sendRawJson(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${(++globalReqId).toString(16)}`,
    ...extra,
  });
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': `req-${(++globalReqId).toString(16)}`,
    ...extra,
  });
  res.end(body);
}
function notFound(res: ServerResponse): void { sendJson(res, 404, { message: 'Not Found' }); }
function badRequest(res: ServerResponse, message = 'Bad Request'): void { sendJson(res, 400, { message }); }
function unprocessable(res: ServerResponse, message: string): void { sendJson(res, 422, { message }); }
function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  let perPage = parseInt(query.get('per_page') ?? '30', 10) || 30;
  perPage = Math.min(100, Math.max(1, perPage));
  return { page, perPage };
}
function pageSlice<T>(items: T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}
function linkHeader(req: IncomingMessage, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${new URL(req.url ?? '/', 'http://entry').pathname}`;
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `${base}?${q.toString()}`;
  };
  const last = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < last) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(last)}>; rel="last"`);
  return parts.join(', ');
}
function parseBodyJson(raw: Buffer): { ok: boolean; value: unknown } {
  if (raw.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw.toString('utf8')) }; }
  catch { return { ok: false, value: null }; }
}
function asObj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
}
function asStr(v: unknown, fallback = ''): string { return typeof v === 'string' ? v : fallback; }

function handleRest(req: IncomingMessage, res: ServerResponse, seg: string[], query: URLSearchParams, body: unknown): void {
  const method = req.method ?? 'GET';
  // API root
  if (seg.length === 0) {
    if (method === 'GET') { sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' }); return; }
    notFound(res); return;
  }
  if (seg[0] === 'meta' && method === 'GET') { sendJson(res, 200, { installed_version: '1.0.0' }); return; }
  if (seg[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: EPOCH + 3600, used: 1 } }, rate: { limit: 5000, remaining: 4999, reset: EPOCH + 3600, used: 1 } });
    return;
  }
  if (seg[0] === 'user' && seg.length === 1 && method === 'GET') {
    sendJson(res, 200, { login: VIEWER.login, id: VIEWER.id, node_id: gid('U', VIEWER.id), avatar_url: '', gravatar_id: '', url: '/api/v3/user', html_url: `https://github.com/${VIEWER.login}`, type: 'User', site_admin: false, name: VIEWER.name, company: null, blog: '', location: null, email: VIEWER.email, hireable: null, bio: null, twitter_username: null, public_repos: repos.size, public_gists: 0, followers: 0, following: 0, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });
    return;
  }
  if (seg[0] === 'users' && seg.length === 2 && method === 'GET') {
    const login = seg[1]!;
    const isViewer = login === VIEWER.login;
    sendJson(res, 200, { login, id: isViewer ? VIEWER.id : 1001, node_id: gid('U', isViewer ? VIEWER.id : 1001), avatar_url: '', url: `/api/v3/users/${login}`, html_url: `https://github.com/${login}`, type: 'User', site_admin: false, name: isViewer ? VIEWER.name : login, email: isViewer ? VIEWER.email : `${login}@example.invalid`, public_repos: 0, followers: 0, following: 0, created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' });
    return;
  }
  if (seg[0] === 'user' && seg[1] === 'repos') {
    if (method === 'POST') {
      const b = asObj(body);
      const name = asStr(b.name);
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) { unprocessable(res, 'Validation Failed: name is required'); return; }
      if (repos.has(repoKey(VIEWER.login, name))) { unprocessable(res, 'name already exists on this account'); return; }
      const repo = newRepo(name, asStr(b.description), b.private === true);
      sendJson(res, 201, repoJson(repo));
      return;
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(query);
      const all = [...repos.values()].filter((r) => r.owner === VIEWER.login).sort((a, b) => a.seq - b.seq);
      const slice = pageSlice(all, page, perPage);
      const extra: Record<string, string> = {};
      if (all.length > perPage) extra.link = linkHeader(req, query, page, perPage, all.length);
      sendJson(res, 200, slice.map((r) => repoJson(r)), extra);
      return;
    }
    notFound(res); return;
  }
  if (seg[0] !== 'repos' || seg.length < 3) { notFound(res); return; }
  const owner = seg[1]!; const repoName = seg[2]!;
  const repo = findRepo(owner, repoName);
  if (!repo) { notFound(res); return; }
  const rest = seg.slice(3);
  // /repos/{o}/{r}
  if (rest.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      const b = asObj(body);
      if (typeof b.description === 'string') repo.description = b.description;
      if (typeof b.private === 'boolean') repo.priv = b.private;
      if (typeof b.default_branch === 'string' && b.default_branch) repo.defaultBranch = b.default_branch;
      repo.updatedAt = tickIso();
      sendJson(res, 200, repoJson(repo));
      return;
    }
    if (method === 'DELETE') {
      repos.delete(repoKey(owner, repoName));
      res.writeHead(204, { 'x-github-request-id': `req-${(++globalReqId).toString(16)}` });
      res.end();
      return;
    }
    notFound(res); return;
  }
  const head = rest[0]!;
  // ---- branches
  if (head === 'branches') {
    if (method === 'GET' && rest.length === 1) {
      const list = sortedRefs(repo).filter((r) => r.startsWith('refs/heads/')).map((r) => ({
        name: r.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(r)!, url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(r)!}` },
        protected: false,
      }));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length >= 2) {
      const branch = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (!sha) { notFound(res); return; }
      sendJson(res, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
      return;
    }
    notFound(res); return;
  }
  // ---- commits
  if (head === 'commits') {
    if (method === 'GET' && rest.length === 1) {
      const { page, perPage } = pageParams(query);
      const ref = query.get('sha') ?? repo.defaultBranch;
      const tip = refTipCommit(repo, `refs/heads/${ref}`) ?? resolveRef(repo, ref);
      if (!tip) { sendJson(res, 200, []); return; }
      const all = listCommitsFrom(repo, peelToCommit(repo, tip) ?? tip, 10000);
      const slice = pageSlice(all, page, perPage);
      sendJson(res, 200, slice.map((o) => commitJson(repo, o)).filter((x) => x !== null));
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const oid = resolveRef(repo, rest[1]!);
      const c = oid ? commitJson(repo, peelToCommit(repo, oid) ?? oid) : null;
      if (!c) { notFound(res); return; }
      sendJson(res, 200, c);
      return;
    }
    notFound(res); return;
  }
  // ---- git/refs
  if (head === 'git' && rest[1] === 'refs') {
    if (method === 'POST' && rest.length === 2) {
      const b = asObj(body);
      const ref = asStr(b.ref);
      const sha = asStr(b.sha);
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha) || !repo.objects.has(sha)) { unprocessable(res, 'Validation Failed'); return; }
      if (repo.refs.has(ref)) { unprocessable(res, 'Reference already exists'); return; }
      repo.refs.set(ref, sha);
      const obj = repo.objects.get(sha)!;
      sendJson(res, 201, { ref, node_id: gid('RF', repo.id, ref), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`, object: { sha, type: obj.type, url: `/api/v3/repos/${owner}/${repoName}/git/${obj.type}s/${sha}` } });
      return;
    }
    if (method === 'GET' && rest.length === 2) {
      const list = sortedRefs(repo).map((r) => ({ ref: r, node_id: gid('RF', repo.id, r), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${r.slice(5)}`, object: { sha: repo.refs.get(r)!, type: repo.objects.get(repo.refs.get(r)!)?.type ?? 'commit', url: '' } }));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (!sha) { notFound(res); return; }
      const obj = repo.objects.get(sha);
      sendJson(res, 200, { ref, node_id: gid('RF', repo.id, ref), url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.slice(5)}`, object: { sha, type: obj?.type ?? 'commit', url: '' } });
      return;
    }
    if (method === 'DELETE' && rest.length >= 3) {
      const ref = `refs/${rest.slice(2).join('/')}`;
      if (!repo.refs.has(ref)) { notFound(res); return; }
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': `req-${(++globalReqId).toString(16)}` });
      res.end();
      return;
    }
    notFound(res); return;
  }
  // ---- contents
  if (head === 'contents') {
    const path = rest.slice(1).join('/');
    const branch = query.get('ref') ?? repo.defaultBranch;
    if (method === 'GET') {
      const tip = refTipCommit(repo, `refs/heads/${branch}`) ?? (branch === repo.defaultBranch ? null : refTipCommit(repo, branch));
      if (!tip) { notFound(res); return; }
      const files = fileMapAt(repo, tip);
      if (path === '') {
        const entries: Record<string, unknown>[] = [];
        const dirs = new Set<string>();
        for (const [p, oid] of files) {
          const first = p.split('/')[0]!;
          if (p.includes('/')) dirs.add(first);
          else entries.push({ type: 'file', encoding: 'base64', size: repo.objects.get(oid)?.data.length ?? 0, name: p, path: p, sha: oid, url: `/api/v3/repos/${owner}/${repoName}/contents/${p}`, html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${p}`, git_url: '', download_url: null, _links: {} });
        }
        for (const d of [...dirs].sort()) entries.push({ type: 'dir', size: 0, name: d, path: d, sha: '', url: `/api/v3/repos/${owner}/${repoName}/contents/${d}`, html_url: `https://github.com/${owner}/${repoName}/tree/${branch}/${d}`, git_url: '', download_url: null, _links: {} });
        sendJson(res, 200, entries.sort((a, b) => String(a.name).localeCompare(String(b.name))));
        return;
      }
      const oid = files.get(path);
      if (oid !== undefined) {
        const data = repo.objects.get(oid)?.data ?? Buffer.alloc(0);
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: data.length, name: path.split('/').pop(), path, sha: oid, content: data.toString('base64'), url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`, html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${path}`, git_url: '', download_url: null, _links: {} });
        return;
      }
      // directory?
      const prefix = `${path}/`;
      const children = new Map<string, { dir: boolean; oid: string }>();
      for (const [p, o] of files) {
        if (!p.startsWith(prefix)) continue;
        const rel = p.slice(prefix.length);
        const first = rel.split('/')[0]!;
        if (rel.includes('/')) children.set(first, { dir: true, oid: '' });
        else children.set(first, { dir: false, oid: o });
      }
      if (children.size === 0) { notFound(res); return; }
      const entries = [...children.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([name, c]) => ({
        type: c.dir ? 'dir' : 'file', encoding: c.dir ? undefined : 'base64',
        size: c.dir ? 0 : (repo.objects.get(c.oid)?.data.length ?? 0),
        name, path: `${path}/${name}`, sha: c.oid,
        url: `/api/v3/repos/${owner}/${repoName}/contents/${path}/${name}`,
        html_url: `https://github.com/${owner}/${repoName}/${c.dir ? 'tree' : 'blob'}/${branch}/${path}/${name}`,
        git_url: '', download_url: null, _links: {},
      }));
      sendJson(res, 200, entries);
      return;
    }
    if (method === 'PUT') {
      const b = asObj(body);
      const message = asStr(b.message) || `Update ${path}`;
      const targetBranch = asStr(b.branch) || branch;
      let contentBuf: Buffer;
      try { contentBuf = Buffer.from(asStr(b.content), 'base64'); } catch { badRequest(res); return; }
      if (typeof b.sha === 'string' && b.sha) {
        const tip = refTipCommit(repo, `refs/heads/${targetBranch}`);
        const existing = tip ? fileMapAt(repo, tip).get(path) : undefined;
        if (existing && existing !== b.sha) { sendJson(res, 409, { message: 'Conflict: sha does not match' }); return; }
      }
      const { commitSha, blobSha, created } = applyContentChange(repo, targetBranch, path, contentBuf, message);
      sendJson(res, created ? 201 : 200, {
        content: { name: path.split('/').pop(), path, sha: blobSha, size: contentBuf.length, url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`, html_url: '', git_url: '', download_url: null, type: 'file', encoding: 'base64', _links: {} },
        commit: { sha: commitSha, message, url: `/api/v3/repos/${owner}/${repoName}/commits/${commitSha}` },
      });
      return;
    }
    if (method === 'DELETE') {
      const b = asObj(body);
      const message = asStr(b.message) || `Delete ${path}`;
      const targetBranch = asStr(b.branch) || branch;
      const tip = refTipCommit(repo, `refs/heads/${targetBranch}`);
      if (!tip || !fileMapAt(repo, tip).has(path)) { notFound(res); return; }
      const { commitSha } = applyContentDelete(repo, targetBranch, path, message);
      sendJson(res, 200, { commit: { sha: commitSha, message, url: `/api/v3/repos/${owner}/${repoName}/commits/${commitSha}` }, content: null });
      return;
    }
    notFound(res); return;
  }
  // ---- labels
  if (head === 'labels') {
    if (method === 'POST') {
      const b = asObj(body);
      const name = asStr(b.name);
      if (!name) { unprocessable(res, 'Validation Failed: name is required'); return; }
      const existing = repo.labels.get(name);
      if (existing) { sendJson(res, 201, labelJson(existing)); return; }
      const label: Label = { id: nextLabelId++, name, color: asStr(b.color, 'ededed').replace(/^#/, ''), description: asStr(b.description) };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label));
      return;
    }
    if (method === 'GET') { sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(l))); return; }
    notFound(res); return;
  }
  // ---- issues
  if (head === 'issues') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = asObj(body);
        const title = asStr(b.title);
        if (!title) { unprocessable(res, 'Validation Failed: title is required'); return; }
        const labelNames: string[] = [];
        if (Array.isArray(b.labels)) {
          for (const l of b.labels) {
            const n = typeof l === 'string' ? l : asStr(asObj(l).name);
            if (n && !repo.labels.has(n)) { unprocessable(res, `Validation Failed: label "${n}" does not exist`); return; }
            if (n) labelNames.push(n);
          }
        }
        const number = repo.nextIssue++;
        const now = tickIso();
        const issue: Issue = { number, title, body: asStr(b.body), state: 'open', labels: labelNames, seq: ++nextGlobalSeq, createdAt: now, updatedAt: now, closedAt: null, comments: [], cachedJson: null };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(repo, issue));
        return;
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        const dir = direction === 'asc' ? 1 : -1;
        list.sort((a, b) => (sort === 'created' ? (a.seq - b.seq) * dir : (a.seq - b.seq) * dir));
        const slice = pageSlice(list, page, perPage);
        const extra: Record<string, string> = {};
        if (list.length > perPage) extra.link = linkHeader(req, query, page, perPage, list.length);
        sendJson(res, 200, slice.map((i) => issueJson(repo, i)), extra);
        return;
      }
      notFound(res); return;
    }
    const num = parseInt(rest[1] ?? '', 10);
    const issue = Number.isSafeInteger(num) ? repo.issues.get(num) : undefined;
    if (!issue) { notFound(res); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendRawJson(res, 200, issueJsonCached(repo, issue)); return; }
      if (method === 'PATCH') {
        const b = asObj(body);
        if (typeof b.title === 'string') issue.title = b.title;
        if (typeof b.body === 'string') issue.body = b.body;
        if (typeof b.state === 'string' && (b.state === 'open' || b.state === 'closed')) {
          issue.state = b.state;
          issue.closedAt = b.state === 'closed' ? tickIso() : null;
        }
        if (Array.isArray(b.labels)) {
          const names: string[] = [];
          for (const l of b.labels) {
            const n = typeof l === 'string' ? l : asStr(asObj(l).name);
            if (n && !repo.labels.has(n)) { unprocessable(res, `Validation Failed: label "${n}" does not exist`); return; }
            if (n) names.push(n);
          }
          issue.labels = names;
        }
        issue.updatedAt = tickIso();
        issue.cachedJson = null;
        sendJson(res, 200, issueJson(repo, issue));
        return;
      }
      notFound(res); return;
    }
    if (rest[2] === 'comments') {
      if (method === 'POST') {
        const b = asObj(body);
        const commentBody = asStr(b.body);
        if (!commentBody) { unprocessable(res, 'Validation Failed: body is required'); return; }
        const now = tickIso();
        const comment: Comment = { id: nextCommentId++, body: commentBody, user: VIEWER.login, createdAt: now, updatedAt: now };
        issue.comments.push(comment);
        issue.cachedJson = null;
        sendJson(res, 201, commentJson(repo, issue, comment));
        return;
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const slice = pageSlice(issue.comments, page, perPage);
        sendJson(res, 200, slice.map((c) => commentJson(repo, issue, c)));
        return;
      }
      notFound(res); return;
    }
    notFound(res); return;
  }
  // ---- pulls
  if (head === 'pulls') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const b = asObj(body);
        const title = asStr(b.title);
        const headRef = asStr(b.head).split(':').pop() ?? '';
        const baseRef = asStr(b.base);
        if (!title || !headRef || !baseRef) { unprocessable(res, 'Validation Failed'); return; }
        const headSha = refTipCommit(repo, `refs/heads/${headRef}`);
        const baseSha = refTipCommit(repo, `refs/heads/${baseRef}`);
        if (!headSha || !baseSha) { unprocessable(res, 'Validation Failed: head or base ref does not exist'); return; }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) { unprocessable(res, 'Validation Failed: a pull request already exists for these branches'); return; }
        }
        const number = repo.nextPull++;
        const now = tickIso();
        const pr: PR = {
          number, title, body: asStr(b.body), state: 'open', merged: false,
          headRef, baseRef, headSha, baseSha, mergeSha: null, mergedAt: null,
          seq: ++nextGlobalSeq, createdAt: now, updatedAt: now, closedAt: null,
          files: diffFiles(repo, baseSha, headSha),
        };
        repo.pulls.set(number, pr);
        sendJson(res, 201, prJson(repo, pr));
        return;
      }
      if (method === 'GET') {
        const { page, perPage } = pageParams(query);
        const state = query.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        sendJson(res, 200, pageSlice(list, page, perPage).map((p) => prJson(repo, p)));
        return;
      }
      notFound(res); return;
    }
    const num = parseInt(rest[1] ?? '', 10);
    const pr = Number.isSafeInteger(num) ? repo.pulls.get(num) : undefined;
    if (!pr) { notFound(res); return; }
    if (rest.length === 2) {
      if (method === 'GET') { sendJson(res, 200, prJson(repo, pr)); return; }
      if (method === 'PATCH') {
        const b = asObj(body);
        if (typeof b.title === 'string') pr.title = b.title;
        if (typeof b.body === 'string') pr.body = b.body;
        if (b.state === 'closed' && pr.state === 'open') { pr.state = 'closed'; pr.closedAt = tickIso(); }
        if (b.state === 'open' && pr.state === 'closed' && !pr.merged) { pr.state = 'open'; pr.closedAt = null; }
        pr.updatedAt = tickIso();
        sendJson(res, 200, prJson(repo, pr));
        return;
      }
      notFound(res); return;
    }
    if (rest[2] === 'files' && method === 'GET') {
      sendJson(res, 200, pr.files.map((f) => ({
        sha: '', filename: f.filename, status: f.status, additions: f.additions, deletions: f.deletions,
        changes: f.changes, blob_url: '', raw_url: '', contents_url: '',
      })));
      return;
    }
    if (rest[2] === 'merge' && method === 'PUT') {
      if (pr.state === 'closed') { sendJson(res, 405, { message: 'Pull request is already closed' }); return; }
      const result = squashMerge(repo, pr);
      if ('conflict' in result) { sendJson(res, 405, { message: 'Merge conflict' }); return; }
      pr.state = 'closed'; pr.merged = true; pr.mergeSha = result.sha; pr.mergedAt = tickIso(); pr.closedAt = pr.mergedAt; pr.updatedAt = pr.mergedAt;
      sendJson(res, 200, { sha: result.sha, merged: true, message: 'Pull request successfully merged' });
      return;
    }
    notFound(res); return;
  }
  notFound(res);
}

// ---------------------------------------------------------------- GraphQL
const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'closedAt', 'author', 'labels', 'repository', 'comments', 'assignees', 'milestone', 'locked', 'viewerDidAuthor'];
const PR_FIELDS = ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository', 'additions', 'deletions', 'changedFiles', 'commits', 'reviewDecision'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'url', 'createdAt', 'updatedAt', 'isPrivate', 'fork', 'issue', 'issues', 'pullRequest', 'pullRequests', 'homepageUrl', 'stargazers', 'watchers', 'visibility', 'licenseInfo'];
const USER_FIELDS = ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'updatedAt'];
const FIELD_SETS: Record<string, Set<string>> = {
  Query: new Set(['viewer', 'repository', 'node', 'nodes', 'search', '__type', '__schema']),
  Mutation: new Set(['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment']),
  User: new Set(USER_FIELDS),
  Repository: new Set(REPO_FIELDS),
  Ref: new Set(['id', 'name', 'target']),
  Issue: new Set(ISSUE_FIELDS),
  PullRequest: new Set(PR_FIELDS),
  IssueConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  PullRequestConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  ChangedFileConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  LabelConnection: new Set(['nodes', 'edges', 'pageInfo', 'totalCount']),
  IssueEdge: new Set(['node', 'cursor']),
  PullRequestEdge: new Set(['node', 'cursor']),
  ChangedFileEdge: new Set(['node', 'cursor']),
  LabelEdge: new Set(['node', 'cursor']),
  ChangedFile: new Set(['path', 'additions', 'deletions', 'changeType']),
  Label: new Set(['id', 'name', 'color', 'description', 'url']),
  Comment: new Set(['id', 'body', 'author', 'createdAt', 'updatedAt', 'url']),
  CommentEdge: new Set(['node', 'cursor']),
  PageInfo: new Set(['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor']),
  CreateIssuePayload: new Set(['issue', 'clientMutationId']),
  CloseIssuePayload: new Set(['issue', 'clientMutationId']),
  CreatePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  MergePullRequestPayload: new Set(['pullRequest', 'clientMutationId']),
  AddCommentPayload: new Set(['commentEdge', 'comment', 'subject', 'clientMutationId']),
  __Type: new Set(['name', 'kind', 'description', 'fields', 'enumValues', 'interfaces', 'possibleTypes', 'inputFields', 'ofType']),
  __Field: new Set(['name', 'description', 'type', 'args', 'isDeprecated', 'deprecationReason']),
  __EnumValue: new Set(['name', 'description', 'isDeprecated', 'deprecationReason']),
  __Schema: new Set(['queryType', 'mutationType', 'subscriptionType', 'types', 'directives']),
  __InputValue: new Set(['name', 'description', 'type', 'defaultValue']),
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ISSUE_FIELDS, PullRequest: PR_FIELDS, Repository: REPO_FIELDS, User: USER_FIELDS,
  Ref: ['id', 'name', 'target'], Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  ChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE', 'COMMIT', 'MILESTONE', 'WIKI', 'PACKAGE', 'MARKETPLACE', 'ORGANIZATION'];

function typed<T extends object>(obj: T, type: string): T {
  Object.defineProperty(obj, '__typename', { value: type, enumerable: false });
  return obj;
}
function typenameOf(obj: unknown): string {
  if (typeof obj === 'object' && obj !== null) return (obj as Record<string, unknown>).__typename as string ?? '';
  return '';
}

// ---- tokenizer
type Tok = { kind: string; value: string };
function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch) || ch === ',') { i += 1; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (src.startsWith('...', i)) { toks.push({ kind: '...', value: '...' }); i += 3; continue; }
    if ('{}()[]:!=$@'.includes(ch)) { toks.push({ kind: ch, value: ch }); i += 1; continue; }
    if (ch === '"') {
      if (src.startsWith('"""', i)) {
        const end = src.indexOf('"""', i + 3);
        toks.push({ kind: 'String', value: end < 0 ? src.slice(i + 3) : src.slice(i + 3, end) });
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      let j = i + 1; let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') {
          const e = src[j + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f' };
          if (e === 'u') { out += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; }
          else { out += map[e ?? ''] ?? e ?? ''; j += 2; }
        } else { out += src[j]; j += 1; }
      }
      toks.push({ kind: 'String', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.eE+-]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'Number', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < src.length && /[_A-Za-z0-9]/.test(src[j]!)) j += 1;
      toks.push({ kind: 'Name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch}`);
  }
  toks.push({ kind: 'EOF', value: '' });
  return toks;
}
interface GqlValue { kind: 'variable' | 'literal' | 'list' | 'object'; value: unknown }
interface GqlSelection {
  kind: 'field' | 'fragment' | 'spread';
  name?: string; alias?: string; args?: Map<string, GqlValue>;
  selections?: GqlSelection[]; typeCondition?: string;
}
interface GqlOperation { kind: 'query' | 'mutation'; name?: string; varDefs: Map<string, GqlValue>; selections: GqlSelection[] }
class GqlParser {
  toks: Tok[]; pos = 0;
  constructor(src: string) { this.toks = tokenize(src); }
  peek(): Tok { return this.toks[this.pos]!; }
  next(): Tok { return this.toks[this.pos++]!; }
  expect(kind: string): Tok {
    const t = this.next();
    if (t.kind !== kind) throw new Error(`expected ${kind}, got ${t.kind} ${t.value}`);
    return t;
  }
  expectName(v?: string): string {
    const t = this.next();
    if (t.kind !== 'Name' || (v !== undefined && t.value !== v)) throw new Error(`expected name ${v ?? ''}, got ${t.value}`);
    return t.value;
  }
  parseDocument(): { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> } {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, GqlSelection[]>();
    while (this.peek().kind !== 'EOF') {
      const t = this.peek();
      if (t.kind === 'Name' && t.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeName = this.expectName();
        const sels = this.parseSelectionSet();
        fragments.set(name, [{ kind: 'fragment', typeCondition: typeName, selections: sels }]);
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }
  parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const t = this.peek();
    if (t.kind === 'Name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'Name') name = this.next().value;
    } else if (t.kind === '{') {
      kind = 'query';
    } else throw new Error(`unexpected token ${t.kind} ${t.value}`);
    const varDefs = new Map<string, GqlValue>();
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        this.expect('$');
        const vname = this.expectName();
        this.expect(':');
        this.parseType();
        if (this.peek().kind === '=') { this.next(); varDefs.set(vname, this.parseValue()); }
        else varDefs.set(vname, { kind: 'literal', value: undefined });
      }
      this.next();
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }
  parseType(): void {
    if (this.peek().kind === '[') { this.next(); this.parseType(); this.expect(']'); }
    else this.expectName();
    if (this.peek().kind === '!') this.next();
  }
  parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const sels: GqlSelection[] = [];
    while (this.peek().kind !== '}') {
      sels.push(this.parseSelection());
    }
    this.next();
    return sels;
  }
  parseSelection(): GqlSelection {
    if (this.peek().kind === '...') {
      this.next();
      if (this.peek().kind === 'Name' && this.peek().value === 'on') {
        this.next();
        const typeName = this.expectName();
        return { kind: 'fragment', typeCondition: typeName, selections: this.parseSelectionSet() };
      }
      const name = this.expectName();
      return { kind: 'spread', name };
    }
    let name = this.expectName();
    let alias: string | undefined;
    if (this.peek().kind === ':') { this.next(); alias = name; name = this.expectName(); }
    const args = new Map<string, GqlValue>();
    if (this.peek().kind === '(') {
      this.next();
      while (this.peek().kind !== ')') {
        const aname = this.expectName();
        this.expect(':');
        args.set(aname, this.parseValue());
      }
      this.next();
    }
    while (this.peek().kind === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === '(') { this.next(); let depth = 1; while (depth > 0) { const k = this.next().kind; if (k === '(') depth += 1; if (k === ')') depth -= 1; } }
    }
    let selections: GqlSelection[] | undefined;
    if (this.peek().kind === '{') selections = this.parseSelectionSet();
    return { kind: 'field', name, alias, args, selections };
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t.kind === '$') return { kind: 'variable', value: this.expectName() };
    if (t.kind === 'String') return { kind: 'literal', value: t.value };
    if (t.kind === 'Number') return { kind: 'literal', value: t.value.includes('.') || /[eE]/.test(t.value) ? parseFloat(t.value) : parseInt(t.value, 10) };
    if (t.kind === 'Name') {
      if (t.value === 'true') return { kind: 'literal', value: true };
      if (t.value === 'false') return { kind: 'literal', value: false };
      if (t.value === 'null') return { kind: 'literal', value: null };
      return { kind: 'literal', value: t.value };
    }
    if (t.kind === '[') {
      const items: GqlValue[] = [];
      while (this.peek().kind !== ']') items.push(this.parseValue());
      this.next();
      return { kind: 'list', value: items };
    }
    if (t.kind === '{') {
      const fields = new Map<string, GqlValue>();
      while (this.peek().kind !== '}') {
        const fname = this.expectName();
        this.expect(':');
        fields.set(fname, this.parseValue());
      }
      this.next();
      return { kind: 'object', value: fields };
    }
    throw new Error(`unexpected value token ${t.kind}`);
  }
}
function resolveValue(v: GqlValue, variables: Record<string, unknown>): unknown {
  if (v.kind === 'variable') return variables[v.value as string];
  if (v.kind === 'list') return (v.value as GqlValue[]).map((x) => resolveValue(x, variables));
  if (v.kind === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of v.value as Map<string, GqlValue>) out[k] = resolveValue(x, variables);
    return out;
  }
  return v.value;
}
interface GqlCtx { errors: Array<{ message: string }>; fragments: Map<string, GqlSelection[]>; variables: Record<string, unknown> }
function issueCursor(seq: number): string { return Buffer.from(`c:${seq}`).toString('base64'); }
function decodeCursor(c: string): number | null {
  try {
    const text = Buffer.from(c, 'base64').toString('utf8');
    const m = text.match(/^c:(\d+)$/);
    return m ? parseInt(m[1]!, 10) : null;
  } catch { return null; }
}
function pageInfoFor<T extends { seq: number }>(items: T[], first: number | undefined, totalAfter: boolean, lastItem: T | undefined): Record<string, unknown> {
  return typed({
    hasNextPage: totalAfter,
    hasPreviousPage: false,
    startCursor: items.length > 0 ? issueCursor(items[0]!.seq) : null,
    endCursor: lastItem ? issueCursor(lastItem.seq) : null,
  }, 'PageInfo');
}
function issuesConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) list = list.filter((i) => states.includes(i.state.toUpperCase()));
  const orderBy = args.orderBy as Record<string, unknown> | undefined;
  const dir = orderBy?.direction === 'DESC' ? -1 : 1;
  list.sort((a, b) => (a.seq - b.seq) * dir);
  const after = typeof args.after === 'string' ? decodeCursor(args.after) : null;
  if (after !== null) list = list.filter((i) => i.seq > after);
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  return typed({
    nodes: page.map((i) => issueObj(repo, i)),
    edges: page.map((i) => typed({ node: issueObj(repo, i), cursor: issueCursor(i.seq) }, 'IssueEdge')),
    pageInfo: pageInfoFor(page, first, hasNext, page[page.length - 1]),
    totalCount: repo.issues.size,
  }, 'IssueConnection');
}
function pullsConnection(repo: Repo, args: Record<string, unknown>): Record<string, unknown> {
  let list = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (states && states.length > 0) list = list.filter((p) => states.includes(p.merged ? 'MERGED' : p.state.toUpperCase()));
  list.sort((a, b) => b.seq - a.seq);
  const first = typeof args.first === 'number' ? args.first : 10;
  const page = list.slice(0, first);
  const hasNext = list.length > first;
  return typed({
    nodes: page.map((p) => prObj(repo, p)),
    edges: page.map((p) => typed({ node: prObj(repo, p), cursor: issueCursor(p.seq) }, 'PullRequestEdge')),
    pageInfo: pageInfoFor(page, first, hasNext, page[page.length - 1]),
    totalCount: repo.pulls.size,
  }, 'PullRequestConnection');
}
function userObj(login: string, id: number, name?: string, email?: string): Record<string, unknown> {
  return typed({ id: gid('U', id), login, name: name ?? login, email: email ?? `${login}@example.invalid`, url: `https://github.com/${login}`, avatarUrl: '', createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }, 'User');
}
function repoObj(repo: Repo): Record<string, unknown> {
  return typed({
    id: gid('R', repo.id), databaseId: repo.id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userObj(repo.owner, VIEWER.id, VIEWER.name, VIEWER.email),
    defaultBranchRef: typed({ id: gid('RF', repo.id, 'main'), name: repo.defaultBranch, target: null }, 'Ref'),
    viewerPermission: 'ADMIN', hasIssuesEnabled: true,
    description: repo.description, url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt, updatedAt: repo.updatedAt, isPrivate: repo.priv, fork: false,
    homepageUrl: null, stargazers: 0, watchers: 0, visibility: repo.priv ? 'PRIVATE' : 'PUBLIC',
    licenseInfo: null,
    __repo: repo,
  }, 'Repository');
}
function issueObj(repo: Repo, i: Issue): Record<string, unknown> {
  return typed({
    id: gid('I', repo.id, i.number), number: i.number, title: i.title, body: i.body,
    state: i.state.toUpperCase(), url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}`,
    createdAt: i.createdAt, updatedAt: i.updatedAt, closedAt: i.closedAt,
    author: userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email),
    labels: typed({
      nodes: i.labels.map((n) => { const l = repo.labels.get(n); return typed({ id: gid('L', l?.id ?? 0), name: n, color: l?.color ?? 'ededed', description: l?.description ?? '', url: '' }, 'Label'); }),
      edges: [], pageInfo: typed({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, 'PageInfo'), totalCount: i.labels.length,
    }, 'LabelConnection'),
    repository: repoObj(repo),
    comments: typed({ nodes: [], edges: [], pageInfo: typed({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, 'PageInfo'), totalCount: i.comments.length }, 'IssueConnection'),
    assignees: typed({ nodes: [], edges: [], pageInfo: typed({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, 'PageInfo'), totalCount: 0 }, 'IssueConnection'),
    milestone: null, locked: false, viewerDidAuthor: true,
    __repo: repo, __issue: i,
  }, 'Issue');
}
function prObj(repo: Repo, p: PR): Record<string, unknown> {
  const changeType = (s: string): string => (s === 'added' ? 'ADDED' : s === 'removed' ? 'REMOVED' : 'MODIFIED');
  return typed({
    id: gid('P', repo.id, p.number), number: p.number, title: p.title, body: p.body,
    state: p.merged ? 'MERGED' : p.state.toUpperCase(), merged: p.merged,
    mergeable: prMergeable(repo, p), headRefName: p.headRef, baseRefName: p.baseRef,
    headRef: typed({ id: gid('RF', repo.id, p.headRef), name: p.headRef, target: null }, 'Ref'),
    baseRef: typed({ id: gid('RF', repo.id, p.baseRef), name: p.baseRef, target: null }, 'Ref'),
    files: typed({
      nodes: p.files.map((f) => typed({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: changeType(f.status) }, 'ChangedFile')),
      edges: [], pageInfo: typed({ hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, 'PageInfo'), totalCount: p.files.length,
    }, 'ChangedFileConnection'),
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${p.number}`,
    createdAt: p.createdAt, updatedAt: p.updatedAt, closedAt: p.closedAt, mergedAt: p.mergedAt,
    author: userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email),
    repository: repoObj(repo),
    additions: p.files.reduce((a, f) => a + f.additions, 0),
    deletions: p.files.reduce((a, f) => a + f.deletions, 0),
    changedFiles: p.files.length, commits: 1, reviewDecision: null,
    __repo: repo, __pr: p,
  }, 'PullRequest');
}
function commentObj(repo: Repo, i: Issue, c: Comment): Record<string, unknown> {
  return typed({
    id: gid('C', repo.id, i.number, c.id), body: c.body,
    author: userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email),
    createdAt: c.createdAt, updatedAt: c.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${i.number}#issuecomment-${c.id}`,
  }, 'Comment');
}
function resolveNode(id: string): Record<string, unknown> | null {
  const d = decodeGid(id);
  if (!d) return null;
  if (d.kind === 'R') { const r = repoById(Number(d.parts[0])); return r ? repoObj(r) : null; }
  if (d.kind === 'I') { const r = repoById(Number(d.parts[0])); const i = r?.issues.get(Number(d.parts[1])); return r && i ? issueObj(r, i) : null; }
  if (d.kind === 'P') { const r = repoById(Number(d.parts[0])); const p = r?.pulls.get(Number(d.parts[1])); return r && p ? prObj(r, p) : null; }
  if (d.kind === 'C') { const r = repoById(Number(d.parts[0])); const i = r?.issues.get(Number(d.parts[1])); const c = i?.comments.find((x) => x.id === Number(d.parts[2])); return r && i && c ? commentObj(r, i, c) : null; }
  if (d.kind === 'U') return userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
  return null;
}
function doCreateIssue(repo: Repo, title: string, body: string): Issue {
  const number = repo.nextIssue++;
  const now = tickIso();
  const issue: Issue = { number, title, body, state: 'open', labels: [], seq: ++nextGlobalSeq, createdAt: now, updatedAt: now, closedAt: null, comments: [], cachedJson: null };
  repo.issues.set(number, issue);
  return issue;
}
function doCreatePR(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PR {
  const headSha = refTipCommit(repo, `refs/heads/${headRef}`);
  const baseSha = refTipCommit(repo, `refs/heads/${baseRef}`);
  if (!headSha || !baseSha) throw new Error('head or base ref does not exist');
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.headRef === headRef && p.baseRef === baseRef) throw new Error('a pull request already exists for these branches');
  }
  const number = repo.nextPull++;
  const now = tickIso();
  const pr: PR = {
    number, title, body, state: 'open', merged: false, headRef, baseRef, headSha, baseSha,
    mergeSha: null, mergedAt: null, seq: ++nextGlobalSeq, createdAt: now, updatedAt: now, closedAt: null,
    files: diffFiles(repo, baseSha, headSha),
  };
  repo.pulls.set(number, pr);
  return pr;
}
function doMergePR(repo: Repo, p: PR): PR {
  if (p.state === 'closed') throw new Error('pull request is already closed');
  const result = squashMerge(repo, p);
  if ('conflict' in result) throw new Error('merge conflict');
  p.state = 'closed'; p.merged = true; p.mergeSha = result.sha; p.mergedAt = tickIso(); p.closedAt = p.mergedAt; p.updatedAt = p.mergedAt;
  return p;
}
function typeInfo(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return typed({
      name: 'SearchType', kind: 'ENUM', description: null,
      fields: null,
      enumValues: SEARCH_TYPE_VALUES.map((v) => typed({ name: v, description: null, isDeprecated: false, deprecationReason: null }, '__EnumValue')),
    }, '__Type');
  }
  const fields = TYPE_FIELDS[name];
  if (!fields) return null;
  return typed({
    name, kind: 'OBJECT', description: null,
    fields: fields.map((f) => typed({ name: f, description: null, type: typed({ name: 'String', kind: 'SCALAR' }, '__Type'), args: [], isDeprecated: false, deprecationReason: null }, '__Field')),
    enumValues: null,
  }, '__Type');
}
function resolveRootField(op: GqlOperation, sel: GqlSelection, ctx: GqlCtx): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of sel.args ?? new Map()) args[k] = resolveValue(v, ctx.variables);
  const name = sel.name!;
  if (op.kind === 'query') {
    if (name === 'viewer') return userObj(VIEWER.login, VIEWER.id, VIEWER.name, VIEWER.email);
    if (name === 'repository') {
      const r = findRepo(asStr(args.owner), asStr(args.name));
      return r ? repoObj(r) : null;
    }
    if (name === 'node') return resolveNode(asStr(args.id));
    if (name === '__type') return typeInfo(asStr(args.name));
    if (name === '__schema') {
      return typed({
        queryType: typed({ name: 'Query', kind: 'OBJECT' }, '__Type'),
        mutationType: typed({ name: 'Mutation', kind: 'OBJECT' }, '__Type'),
        subscriptionType: null,
        types: Object.keys(TYPE_FIELDS).map((n) => typed({ name: n, kind: 'OBJECT' }, '__Type')),
        directives: [],
      }, '__Schema');
    }
    if (name === 'search' || name === 'nodes') return null;
    throw new Error(`Cannot query field "${name}" on type "Query".`);
  }
  // mutations
  const input = asObj(args.input);
  if (name === 'createIssue') {
    const d = decodeGid(asStr(input.repositoryId));
    const repo = d?.kind === 'R' ? repoById(Number(d.parts[0])) : undefined;
    if (!repo) throw new Error('Could not resolve to a Repository with the id provided');
    const issue = doCreateIssue(repo, asStr(input.title), asStr(input.body));
    return typed({ issue: issueObj(repo, issue), clientMutationId: asStr(input.clientMutationId) || null }, 'CreateIssuePayload');
  }
  if (name === 'closeIssue') {
    const d = decodeGid(asStr(input.issueId));
    const repo = d?.kind === 'I' ? repoById(Number(d.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(d?.parts[1]));
    if (!repo || !issue) throw new Error('Could not resolve to an Issue with the id provided');
    issue.state = 'closed'; issue.closedAt = tickIso(); issue.updatedAt = issue.closedAt; issue.cachedJson = null;
    return typed({ issue: issueObj(repo, issue), clientMutationId: asStr(input.clientMutationId) || null }, 'CloseIssuePayload');
  }
  if (name === 'createPullRequest') {
    const d = decodeGid(asStr(input.repositoryId));
    const repo = d?.kind === 'R' ? repoById(Number(d.parts[0])) : undefined;
    if (!repo) throw new Error('Could not resolve to a Repository with the id provided');
    const pr = doCreatePR(repo, asStr(input.title), asStr(input.body), asStr(input.headRefName), asStr(input.baseRefName));
    return typed({ pullRequest: prObj(repo, pr), clientMutationId: asStr(input.clientMutationId) || null }, 'CreatePullRequestPayload');
  }
  if (name === 'mergePullRequest') {
    const d = decodeGid(asStr(input.pullRequestId));
    const repo = d?.kind === 'P' ? repoById(Number(d.parts[0])) : undefined;
    const pr = repo?.pulls.get(Number(d?.parts[1]));
    if (!repo || !pr) throw new Error('Could not resolve to a PullRequest with the id provided');
    doMergePR(repo, pr);
    return typed({ pullRequest: prObj(repo, pr), clientMutationId: asStr(input.clientMutationId) || null }, 'MergePullRequestPayload');
  }
  if (name === 'addComment') {
    const d = decodeGid(asStr(input.subjectId));
    const repo = d?.kind === 'I' ? repoById(Number(d.parts[0])) : undefined;
    const issue = repo?.issues.get(Number(d?.parts[1]));
    if (!repo || !issue) throw new Error('Could not resolve to a subject with the id provided');
    const now = tickIso();
    const comment: Comment = { id: nextCommentId++, body: asStr(input.body), user: VIEWER.login, createdAt: now, updatedAt: now };
    issue.comments.push(comment);
    issue.cachedJson = null;
    return typed({
      commentEdge: typed({ node: commentObj(repo, issue, comment), cursor: issueCursor(issue.seq) }, 'CommentEdge'),
      comment: commentObj(repo, issue, comment),
      subject: issueObj(repo, issue),
      clientMutationId: asStr(input.clientMutationId) || null,
    }, 'AddCommentPayload');
  }
  throw new Error(`Cannot query field "${name}" on type "Mutation".`);
}
function resolveSelections(obj: unknown, typeName: string, sels: GqlSelection[], ctx: GqlCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of sels) {
    if (sel.kind === 'fragment') {
      if (!sel.typeCondition || sel.typeCondition === typeName) {
        Object.assign(out, resolveSelections(obj, typeName, sel.selections ?? [], ctx));
      }
      continue;
    }
    if (sel.kind === 'spread') {
      const frag = ctx.fragments.get(sel.name!);
      if (frag) Object.assign(out, resolveSelections(obj, typeName, frag, ctx));
      continue;
    }
    const key = sel.alias ?? sel.name!;
    if (sel.name === '__typename') { out[key] = typeName; continue; }
    const fieldSet = FIELD_SETS[typeName];
    if (fieldSet && !fieldSet.has(sel.name!)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${typeName}".` });
      out[key] = null;
      continue;
    }
    try {
      const value = resolveField(obj, typeName, sel, ctx);
      out[key] = value;
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}
function resolveField(obj: unknown, typeName: string, sel: GqlSelection, ctx: GqlCtx): unknown {
  const args: Record<string, unknown> = {};
  for (const [k, v] of sel.args ?? new Map()) args[k] = resolveValue(v, ctx.variables);
  const name = sel.name!;
  const rec = obj as Record<string, unknown>;
  // Repository nested resolvers needing the repo record
  if (typeName === 'Repository') {
    const repo = rec.__repo as Repo;
    if (name === 'issue') {
      const i = repo.issues.get(Number(args.number));
      return i ? issueObj(repo, i) : null;
    }
    if (name === 'issues') return issuesConnection(repo, args);
    if (name === 'pullRequest') {
      const p = repo.pulls.get(Number(args.number));
      return p ? prObj(repo, p) : null;
    }
    if (name === 'pullRequests') return pullsConnection(repo, args);
  }
  if (typeName === 'Issue' && name === 'labels') return rec.labels;
  let value: unknown = rec[name];
  if (value === undefined) {
    if (name === '__typename') value = typeName;
    else value = null;
  }
  if (sel.selections && value !== null && value !== undefined) {
    if (Array.isArray(value)) {
      return value.map((v) => {
        const t = typenameOf(v);
        return t ? resolveSelections(v, t, sel.selections!, ctx) : v;
      });
    }
    const t = typenameOf(value);
    if (t) return resolveSelections(value, t, sel.selections, ctx);
  }
  return value;
}
function executeGraphQL(doc: unknown): Record<string, unknown> {
  const query = asStr((doc as Record<string, unknown>).query);
  const variables = asObj((doc as Record<string, unknown>).variables);
  const operationName = asStr((doc as Record<string, unknown>).operationName) || undefined;
  let parsed: { operations: GqlOperation[]; fragments: Map<string, GqlSelection[]> };
  try {
    parsed = new GqlParser(query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const op = operationName
    ? parsed.operations.find((o) => o.name === operationName) ?? parsed.operations[0]
    : parsed.operations[0];
  if (!op) return { errors: [{ message: 'No operation provided' }] };
  const ctx: GqlCtx = { errors: [], fragments: parsed.fragments, variables: { ...variables } };
  // variable defaults
  for (const [k, v] of op.varDefs) {
    if (ctx.variables[k] === undefined && v.value !== undefined) ctx.variables[k] = resolveValue(v, ctx.variables);
  }
  const rootType = op.kind === 'mutation' ? 'Mutation' : 'Query';
  const data: Record<string, unknown> = {};
  for (const sel of op.selections) {
    if (sel.kind !== 'field') continue;
    const key = sel.alias ?? sel.name!;
    const fieldSet = FIELD_SETS[rootType];
    if (fieldSet && !fieldSet.has(sel.name!)) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${rootType}".` });
      data[key] = null;
      continue;
    }
    try {
      const value = resolveRootField(op, sel, ctx);
      if (sel.selections && value !== null && value !== undefined) {
        const t = typenameOf(value);
        data[key] = t ? resolveSelections(value, t, sel.selections, ctx) : value;
      } else data[key] = value;
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      data[key] = null;
    }
  }
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
function handleGraphQL(res: ServerResponse, body: unknown): void {
  if (Array.isArray(body)) {
    sendJson(res, 200, body.map((op) => executeGraphQL(op)));
    return;
  }
  sendJson(res, 200, executeGraphQL(body));
}

// ---------------------------------------------------------------- MCP
const MCP_PROTOCOLS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MCP_SERVER_INFO = { name: 'github-forge', version: '1.0.0' };
const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo', description: 'Create a new repository for the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' } }, required: ['name'] },
  },
  {
    name: 'get_repo', description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue', description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues', description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Issue state: open, closed, or all', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] },
  },
  {
    name: 'get_issue', description: 'Get a single issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, issue_number: { type: 'integer', description: 'Issue number' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'create_pull_request', description: 'Create a pull request.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, title: { type: 'string', description: 'Pull request title' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' }, body: { type: 'string', description: 'Pull request body' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'list_pull_requests', description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, state: { type: 'string', description: 'Pull request state: open, closed, or all', enum: ['open', 'closed', 'all'] } }, required: ['owner', 'repo'] },
  },
  {
    name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner login' }, repo: { type: 'string', description: 'Repository name' }, pull_number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] },
  },
];
function mcpToolResult(payload: unknown): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}
function mcpToolError(message: string): Record<string, unknown> {
  const payload = { error: message };
  return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload, isError: true };
}
function mcpResolveRepo(args: Record<string, unknown>): Repo | null {
  let owner = asStr(args.owner);
  let repoName = asStr(args.repo);
  const full = asStr(args.full_name);
  if ((!owner || !repoName) && full.includes('/')) {
    const [o, r] = full.split('/');
    owner = owner || o || '';
    repoName = repoName || r || '';
  }
  if (!repoName && typeof args.repository === 'string') repoName = args.repository as string;
  if (!repoName && typeof args.repository_name === 'string') repoName = args.repository_name as string;
  if (!owner) owner = VIEWER.login;
  return findRepo(owner, repoName) ?? null;
}
function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = asStr(args.name);
      if (!repoName) return mcpToolError('name is required');
      if (repos.has(repoKey(VIEWER.login, repoName))) return mcpToolError('name already exists on this account');
      const repo = newRepo(repoName, asStr(args.description), args.private === true);
      return mcpToolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      return mcpToolResult(repoJson(repo));
    }
    case 'create_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const title = asStr(args.title);
      if (!title) return mcpToolError('title is required');
      const issue = doCreateIssue(repo, title, asStr(args.body));
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const state = asStr(args.state, 'open');
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      list.sort((a, b) => a.seq - b.seq);
      return mcpToolResult(list.map((i) => issueJson(repo, i)));
    }
    case 'get_issue': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return mcpToolError('Not Found');
      return mcpToolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const title = asStr(args.title);
      const head = asStr(args.head);
      const base = asStr(args.base);
      if (!title || !head || !base) return mcpToolError('title, head and base are required');
      try {
        const pr = doCreatePR(repo, title, asStr(args.body), head, base);
        return mcpToolResult(prJson(repo, pr));
      } catch (err) {
        return mcpToolError(err instanceof Error ? err.message : String(err));
      }
    }
    case 'list_pull_requests': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const state = asStr(args.state, 'open');
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.seq - a.seq);
      return mcpToolResult(list.map((p) => prJson(repo, p)));
    }
    case 'merge_pull_request': {
      const repo = mcpResolveRepo(args);
      if (!repo) return mcpToolError('Not Found');
      const pr = repo.pulls.get(Number(args.pull_number));
      if (!pr) return mcpToolError('Not Found');
      try {
        doMergePR(repo, pr);
        return mcpToolResult(prJson(repo, pr));
      } catch (err) {
        return mcpToolError(err instanceof Error ? err.message : String(err));
      }
    }
    default:
      return mcpToolError(`Unknown tool: ${name}`);
  }
}
function mcpRpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}
function handleMcpMessage(msg: unknown): Record<string, unknown> | null {
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) return mcpRpcError(null, -32600, 'Invalid Request');
  const m = msg as Record<string, unknown>;
  const id = m.id ?? null;
  const method = asStr(m.method);
  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0', id,
      result: {
        resultType: 'discover',
        supportedVersions: MCP_PROTOCOLS,
        capabilities: { tools: {}, logging: {} },
        serverInfo: MCP_SERVER_INFO,
        instructions: 'A GitHub-compatible git forge: create and read repositories, issues and pull requests.',
        _meta: { 'io.modelcontextprotocol/serverInfo': MCP_SERVER_INFO },
      },
    };
  }
  if (method === 'initialize') {
    const params = asObj(m.params);
    const requested = asStr(params.protocolVersion);
    const chosen = MCP_PROTOCOLS.includes(requested) ? requested : '2025-11-25';
    return { jsonrpc: '2.0', id, result: { protocolVersion: chosen, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO } };
  }
  if (method.startsWith('notifications/')) return null; // notification: no response
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
  }
  if (method === 'tools/call') {
    const params = asObj(m.params);
    const toolName = asStr(params.name);
    const tool = MCP_TOOLS.find((t) => t.name === toolName);
    if (!tool) return mcpRpcError(id, -32602, `Unknown tool: ${toolName}`);
    const args = asObj(params.arguments);
    const required = (tool.inputSchema as Record<string, unknown>).required as string[] | undefined ?? [];
    for (const req of required) {
      if (args[req] === undefined || args[req] === null) {
        return mcpRpcError(id, -32602, `Missing required argument: ${req}`);
      }
    }
    const result = callMcpTool(toolName, args);
    return { jsonrpc: '2.0', id, result };
  }
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [] } };
  if (method === 'prompts/list') return { jsonrpc: '2.0', id, result: { prompts: [] } };
  return mcpRpcError(id, -32601, `Method not found: ${method}`);
}
function handleMcp(req: IncomingMessage, res: ServerResponse, rawBody: Buffer): void {
  // Auth is checked by the caller before parsing; here the body must be JSON.
  const parsed = parseBodyJson(rawBody);
  if (!parsed.ok) {
    sendJson(res, 400, mcpRpcError(null, -32700, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed.value)) {
    const results = parsed.value.map((m) => handleMcpMessage(m)).filter((r) => r !== null);
    sendJson(res, 200, results);
    return;
  }
  const result = handleMcpMessage(parsed.value);
  if (result === null) {
    // Notification: answer 202 with an empty body.
    res.writeHead(202, { 'x-github-request-id': `req-${(++globalReqId).toString(16)}` });
    res.end();
    return;
  }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------- server
function isAuthed(req: IncomingMessage): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (c: Buffer) => {
      total += c.length;
      if (total > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function segmentsOf(pathname: string): string[] {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const pathname = url.pathname;
        const method = req.method ?? 'GET';
        const seg = segmentsOf(pathname);
        // Health probe: no auth.
        if (method === 'GET' && pathname === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        // MCP endpoint.
        if (pathname === '/mcp') {
          if (method === 'DELETE') { sendJson(res, 200, {}); return; }
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          if (!isAuthed(req)) { sendJson(res, 401, mcpRpcError(null, -32001, 'Unauthorized')); return; }
          const raw = await readBody(req);
          handleMcp(req, res, raw);
          return;
        }
        // GraphQL endpoint.
        if (pathname === '/api/graphql') {
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          const raw = await readBody(req);
          const parsed = parseBodyJson(raw);
          if (!parsed.ok) { badRequest(res, 'Malformed JSON body'); return; }
          handleGraphQL(res, parsed.value);
          return;
        }
        // Git smart HTTP: /{owner}/{repo}.git/info/refs and /{owner}/{repo}.git/git-*-pack
        if (seg.length === 4 && seg[1]!.endsWith('.git') && seg[2] === 'info' && seg[3] === 'refs') {
          if (method !== 'GET') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          const owner = seg[0]!;
          const repoName = seg[1]!.slice(0, -4);
          const repo = findRepo(owner, repoName);
          if (!repo) { notFound(res); return; }
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { notFound(res); return; }
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2' && service === 'git-upload-pack';
          const body = service === 'git-upload-pack' && isV2
            ? advertiseV2(repo)
            : advertiseV0(repo, service);
          sendRaw(res, 200, body, `application/x-${service}-advertisement`);
          return;
        }
        if (seg.length === 3 && seg[1]!.endsWith('.git') && (seg[2] === 'git-upload-pack' || seg[2] === 'git-receive-pack')) {
          if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
          if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          const owner = seg[0]!;
          const repoName = seg[1]!.slice(0, -4);
          const repo = findRepo(owner, repoName);
          if (!repo) { notFound(res); return; }
          const raw = await readBody(req);
          if (seg[2] === 'git-upload-pack') {
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            try {
              const out = handleUploadPack(repo, raw, isV2);
              sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
            } catch { badRequest(res); }
            return;
          }
          const result = handleReceivePack(repo, raw);
          sendRaw(res, result.status, result.body, result.contentType);
          return;
        }
        // REST v3.
        if (seg.length >= 2 && seg[0] === 'api' && seg[1] === 'v3') {
          if (!isAuthed(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
          let body: unknown = {};
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const parsed = parseBodyJson(raw);
            if (!parsed.ok) { badRequest(res, 'Malformed JSON body'); return; }
            body = parsed.value;
          }
          handleRest(req, res, seg.slice(2), url.searchParams, body);
          return;
        }
        notFound(res);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        else { try { res.end(); } catch { /* ignore */ } }
      }
    })();
  });
}
