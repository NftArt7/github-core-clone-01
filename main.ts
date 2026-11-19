// forge — a standalone GitHub-compatible git forge in one process.
//
// Serves git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API,
// GraphQL v4 and MCP from a single in-memory store. Node 22 standard library
// only: no git binary, no outside service, no dependencies.
//
// Wiring (the make.fun trial contract): bind an ephemeral port, POST
// {"port": N} to $MAKEFUN_ENV_URL/register, then long-poll
// GET $MAKEFUN_ENV_URL/done until {"done": true} and exit 0. Without
// MAKEFUN_ENV_URL (local practice) it just listens on $PORT and stays up.
//
// The viewer login is the token owner's login: MAKEFUN_FORGE_LOGIN when set,
// else the kit scenario's seeded viewer ("adaiversen"). Every repository
// created through this forge belongs to that login.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

export const VIEWER_LOGIN = process.env.MAKEFUN_FORGE_LOGIN || 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FORGE_AGENT = 'forge/1.0';
export const SERVER_NAME = 'forge-mcp';
export const SERVER_VERSION = '1.0.0';
export const ZERO_OID = '0'.repeat(40);

const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN || '';
const FIXED_TS = 1700000000; // deterministic base timestamp for server-made commits

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([header, data]));
}

function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function b64encode(data: Buffer | string): string {
  return Buffer.from(data).toString('base64');
}

function b64decode(value: string): Buffer {
  return Buffer.from(value.replace(/\s+/g, ''), 'base64');
}

function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function stableId(prefix: string, key: string): string {
  return b64encode(`${prefix}:${key}`).replace(/=+$/, '');
}

function decodeStableId(id: string): { prefix: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { prefix: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// git objects: commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
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
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const head = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenText = buffer.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(lenText, 16);
    if (Number.isNaN(length)) throw new Error(`bad pkt-line length ${JSON.stringify(lenText)}`);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function pktLinesText(buffer: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buffer)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------
// packfiles: read (with deltas) and write (plain entries, no deltas)
// ---------------------------------------------------------------------------

export interface GitObject {
  type: string;
  data: Buffer;
}

const PACK_TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
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

function readDeltaSize(delta: Buffer, offset: { value: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (offset.value >= delta.length) throw new Error('delta size varint is truncated');
    const byte = delta[offset.value];
    offset.value += 1;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return value;
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const offset = { value: 0 };
  const sourceSize = readDeltaSize(delta, offset);
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readDeltaSize(delta, offset);
  const parts: Buffer[] = [];
  let produced = 0;
  while (offset.value < delta.length) {
    const op = delta[offset.value];
    offset.value += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset.value >= delta.length) throw new Error('delta copy is truncated');
          copyOffset |= delta[offset.value] << (8 * bit);
          offset.value += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          if (offset.value >= delta.length) throw new Error('delta copy is truncated');
          copySize |= delta[offset.value] << (8 * bit);
          offset.value += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy runs past the base');
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset.value + op > delta.length) throw new Error('delta insert is truncated');
      parts.push(delta.subarray(offset.value, offset.value + op));
      offset.value += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (produced !== targetSize) throw new Error('delta result size mismatch');
  return Buffer.concat(parts);
}

function readPackEntrySize(buffer: Buffer, start: number): { typeCode: number; size: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset];
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { typeCode, size, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset];
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

/** Parse a packfile into objects keyed by oid. Bases may come from the pack itself or `lookup`. */
export function readPack(
  pack: Buffer,
  lookup?: (oid: string) => GitObject | undefined,
): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const byOffset = new Map<number, GitObject>();
  const objects = new Map<string, GitObject>();
  const pending: Array<{ offset: number; type: string; data: Buffer }> = [];
  let offset = 12;
  const end = pack.length - 20;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { typeCode, size, next } = readPackEntrySize(pack, offset);
    offset = next;
    if (typeCode === 6) {
      const { baseOffset, next: afterBase } = readOfsBase(pack, offset);
      const inflated = inflateAt(pack, afterBase);
      const base = byOffset.get(entryOffset - baseOffset);
      if (!base) throw new Error('ofs-delta base is not in this pack');
      const data = applyDelta(base.data, inflated.data);
      if (data.length !== size) throw new Error('ofs-delta size mismatch');
      const object: GitObject = { type: base.type, data };
      byOffset.set(entryOffset, object);
      objects.set(hashObject(object.type, object.data), object);
      offset = inflated.next;
    } else if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      const base = byOffset.get(0) ?? objects.get(baseOid) ?? lookup?.(baseOid);
      const resolved = base ?? ((): GitObject | undefined => {
        for (const candidate of byOffset.values()) {
          if (hashObject(candidate.type, candidate.data) === baseOid) return candidate;
        }
        return undefined;
      })();
      if (!resolved) throw new Error('ref-delta base is missing');
      const data = applyDelta(resolved.data, inflated.data);
      if (data.length !== size) throw new Error('ref-delta size mismatch');
      const object: GitObject = { type: resolved.type, data };
      byOffset.set(entryOffset, object);
      objects.set(hashObject(object.type, object.data), object);
      offset = inflated.next;
    } else {
      const type = PACK_TYPE_NAMES[typeCode];
      if (!type) throw new Error(`unknown pack type ${typeCode}`);
      const inflated = inflateAt(pack, offset);
      if (inflated.data.length !== size) throw new Error('pack object size mismatch');
      const object: GitObject = { type, data: inflated.data };
      byOffset.set(entryOffset, object);
      objects.set(hashObject(type, inflated.data), object);
      offset = inflated.next;
    }
    if (offset > end) throw new Error('pack entries run past the trailer');
  }
  const trailer = pack.subarray(pack.length - 20).toString('hex');
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  if (trailer !== expected) throw new Error('pack trailer checksum mismatch');
  void pending;
  return objects;
}

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = PACK_TYPE_CODES[type];
  if (code === undefined) throw new Error(`cannot pack type ${type}`);
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------------------
// the store: repositories, issues, pull requests, labels, comments
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  comments: Comment[];
  seq: number;
}

export interface Comment {
  id: number;
  body: string;
}

export interface PullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  files: PullFile[];
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, Label>;
  nextNumber: number;
  seq: number;
}

export const repos = new Map<string, Repo>();
let nextObjectId = 1000;
let nextCommitSeq = 0;
let nextItemSeq = 0;

function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return repos.get(repoKey(owner, name));
}

export function createRepoRecord(name: string, isPrivate: boolean, description: string): Repo {
  const repo: Repo = {
    id: nextObjectId,
    name,
    owner: VIEWER_LOGIN,
    description,
    isPrivate,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextNumber: 1,
    seq: nextItemSeq,
  };
  nextObjectId += 1;
  nextItemSeq += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

export function viewerUser(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: viewerUser(),
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })),
    user: viewerUser(),
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: viewerUser() },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: viewerUser() },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pullMergeable(repo, pull),
    user: viewerUser(),
    created_at: '2026-11-14T06:30:00Z',
    updated_at: '2026-11-14T06:30:00Z',
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function createIssueRecord(repo: Repo, title: string, body: string, labels: Label[]): Issue {
  const issue: Issue = {
    id: nextObjectId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    labels,
    comments: [],
    seq: nextItemSeq,
  };
  nextObjectId += 1;
  nextItemSeq += 1;
  repo.nextNumber += 1;
  repo.issues.push(issue);
  return issue;
}

// ---------------------------------------------------------------------------
// git graph helpers over a repository's object store
// ---------------------------------------------------------------------------

export function lookupObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

export function putObject(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function collectReachable(
  repo: Repo,
  roots: Iterable<string>,
  options: { allowMissing?: boolean; stopAt?: ReadonlySet<string> } = {},
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isOid(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) {
      if (options.allowMissing) continue;
      throw new Error(`object ${oid} is missing from the store`);
    }
    seen.add(oid);
    if (options.stopAt?.has(oid)) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancestorsOfB = new Set<string>();
  const queueB = [b];
  while (queueB.length > 0) {
    const oid = queueB.pop() as string;
    if (ancestorsOfB.has(oid)) continue;
    ancestorsOfB.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueB.push(parent);
  }
  const queueA = [a];
  const seenA = new Set<string>();
  while (queueA.length > 0) {
    const oid = queueA.pop() as string;
    if (seenA.has(oid)) continue;
    seenA.add(oid);
    if (ancestorsOfB.has(oid)) return oid;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queueA.push(parent);
  }
  return null;
}

export function flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, path: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, childPath);
      else out.set(childPath, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, prefix);
  return out;
}

export function buildTreeFromMap(entries: Map<string, { oid: string; mode: string }>, repo: Repo): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, value] of entries) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name) as Node;
    }
    node.files.set(segments[segments.length - 1], value);
  }
  const build = (node: Node): string => {
    const treeEntries: TreeEntry[] = [];
    for (const [name, value] of node.files) treeEntries.push({ mode: value.mode, name, oid: value.oid });
    for (const [name, child] of node.dirs) treeEntries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(treeEntries));
  };
  return build(root);
}

export function treeDiff(
  repo: Repo,
  fromTree: string | null,
  toTree: string | null,
): Map<string, { status: 'added' | 'modified' | 'removed'; fromOid: string | null; toOid: string | null }> {
  const from = fromTree ? flattenTree(repo, fromTree) : new Map();
  const to = toTree ? flattenTree(repo, toTree) : new Map();
  const diff = new Map<string, { status: 'added' | 'modified' | 'removed'; fromOid: string | null; toOid: string | null }>();
  for (const [path, value] of to) {
    const old = from.get(path);
    if (!old) diff.set(path, { status: 'added', fromOid: null, toOid: value.oid });
    else if (old.oid !== value.oid) diff.set(path, { status: 'modified', fromOid: old.oid, toOid: value.oid });
  }
  for (const [path, value] of from) {
    if (!to.has(path)) diff.set(path, { status: 'removed', fromOid: value.oid, toOid: null });
  }
  return diff;
}

function countLines(data: Buffer | null): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

export function pullFilesFor(repo: Repo, baseTree: string | null, headTree: string | null): PullFile[] {
  const diff = treeDiff(repo, baseTree, headTree);
  const files: PullFile[] = [];
  for (const [path, change] of [...diff.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const fromData = change.fromOid ? repo.objects.get(change.fromOid)?.data ?? null : null;
    const toData = change.toOid ? repo.objects.get(change.toOid)?.data ?? null : null;
    const additions = countLines(toData) - (change.status === 'modified' ? countLines(fromData) : 0);
    const deletions = change.status === 'modified' ? countLines(fromData) : change.status === 'removed' ? countLines(fromData) : 0;
    const adds = Math.max(0, change.status === 'added' ? countLines(toData) : additions);
    files.push({
      filename: path,
      status: change.status,
      additions: adds,
      deletions: Math.max(0, deletions),
      changes: Math.max(0, adds) + Math.max(0, deletions),
    });
  }
  return files;
}

/** The three-way merge of a pull request: null when it applies, 'conflict' when it does not. */
export function tryMergeTree(repo: Repo, pull: Pull): { tree: string } | { conflict: true } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return { conflict: true };
  const baseCommit = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0));
  const headCommit = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0));
  const mergeBaseOid = mergeBase(repo, headTip, baseTip);
  const mergeBaseTree = mergeBaseOid ? parseCommit(repo.objects.get(mergeBaseOid)?.data ?? Buffer.alloc(0)).tree : null;
  const headDiff = treeDiff(repo, mergeBaseTree, headCommit.tree);
  const baseDiff = treeDiff(repo, mergeBaseTree, baseCommit.tree);
  const result = flattenTree(repo, baseCommit.tree);
  for (const [path, change] of headDiff) {
    const baseChange = baseDiff.get(path);
    if (baseChange && baseChange.toOid !== change.toOid) return { conflict: true };
    if (change.status === 'removed') result.delete(path);
    else if (change.toOid) result.set(path, { oid: change.toOid, mode: '100644' });
  }
  return { tree: buildTreeFromMap(result, repo) };
}

export function pullMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const merged = tryMergeTree(repo, pull);
  return 'conflict' in merged ? 'CONFLICTING' : 'MERGEABLE';
}

export function createPullRecord(
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull | { error: string } {
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (!headSha || !baseSha) return { error: 'head or base branch does not exist' };
  const base = mergeBase(repo, headSha, baseSha);
  const baseTree = base ? parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree : null;
  const headTree = parseCommit(repo.objects.get(headSha)?.data ?? Buffer.alloc(0)).tree;
  const pull: Pull = {
    id: nextObjectId,
    number: repo.nextNumber,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    mergeBaseSha: base ?? '',
    files: pullFilesFor(repo, baseTree, headTree),
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    seq: nextItemSeq,
  };
  nextObjectId += 1;
  nextItemSeq += 1;
  repo.nextNumber += 1;
  repo.pulls.push(pull);
  return pull;
}

/** Squash-merge an open pull request onto its base branch. */
export function mergePullRecord(repo: Repo, pull: Pull): { sha: string } | { error: string; status: number } {
  if (pull.state !== 'open') return { error: 'pull request is not open', status: 405 };
  const merged = tryMergeTree(repo, pull);
  if ('conflict' in merged) return { error: 'merge conflict', status: 405 };
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) as string;
  nextCommitSeq += 1;
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commitData = buildCommit({
    tree: merged.tree,
    parents: [baseTip],
    message,
    author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    timestamp: FIXED_TS + nextCommitSeq,
  });
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = '2026-11-14T06:30:00Z';
  pull.mergeCommitSha = sha;
  return { sha };
}

// ---------------------------------------------------------------------------
// fetch computation: what a clone/fetch sends, honouring haves and depth
// ---------------------------------------------------------------------------

export interface FetchPlan {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

export function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | null,
  clientShallow: readonly string[],
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  // Objects the client already holds: the closure of its haves, stopping at
  // its shallow boundaries (their parents are not held).
  const held = collectReachable(repo, haves, { allowMissing: true, stopAt: shallowSet });
  // Walk from the wants, limited to `depth` commit generations.
  const walkSeen = new Set<string>();
  const commitGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'tag') {
      walkSeen.add(want);
      const target = parseTag(object.data).object;
      queue.push({ oid: target, gen: 0 });
    } else if (object.type === 'commit') {
      queue.push({ oid: want, gen: 0 });
    }
  }
  const boundary = new Set<string>();
  while (queue.length > 0) {
    const { oid, gen } = queue.pop() as { oid: string; gen: number };
    if (walkSeen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    walkSeen.add(oid);
    commitGen.set(oid, gen);
    const commit = parseCommit(object.data);
    if (depth !== null && gen + 1 >= depth) {
      if (commit.parents.length > 0) boundary.add(oid);
      continue;
    }
    for (const parent of commit.parents) queue.push({ oid: parent, gen: gen + 1 });
  }
  const wanted = new Set<string>();
  for (const oid of walkSeen) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    wanted.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const reachable of collectReachable(repo, [commit.tree], { allowMissing: true })) wanted.add(reachable);
    }
  }
  const toSend: GitObject[] = [];
  for (const oid of wanted) {
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object) toSend.push(object);
  }
  // Tag objects themselves are sent when wanted and not held.
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag' && !held.has(want)) toSend.push(object);
  }
  const seenOids = new Set<string>();
  const unique = toSend.filter((object) => {
    const oid = hashObject(object.type, object.data);
    if (seenOids.has(oid)) return false;
    seenOids.add(oid);
    return true;
  });
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== null) {
    for (const oid of boundary) shallow.push(oid);
    for (const oid of clientShallow) {
      if (!walkSeen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => walkSeen.has(parent) && !held.has(parent))) unshallow.push(oid);
    }
  }
  return { objects: unique, shallow, unshallow };
}

/** One server-made commit on a branch (contents writes, merges use this shape). */
export function commitOnBranch(
  repo: Repo,
  branch: string,
  tree: string,
  message: string,
): { sha: string } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  nextCommitSeq += 1;
  const commitData = buildCommit({
    tree,
    parents: tip ? [tip] : [],
    message,
    author: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    committer: `${VIEWER_NAME} <${VIEWER_EMAIL}>`,
    timestamp: FIXED_TS + nextCommitSeq,
  });
  const sha = putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${branch}`, sha);
  return { sha };
}

/** The tree of a branch tip with one path set to a blob (creating parents). */
export function setPathInTree(repo: Repo, baseTree: string | null, path: string, blobOid: string): string {
  const flat = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  flat.set(path, { oid: blobOid, mode: '100644' });
  return buildTreeFromMap(flat, repo);
}

/** The tree of a branch tip with one path removed. */
export function removePathFromTree(repo: Repo, baseTree: string | null, path: string): string {
  const flat = baseTree ? flattenTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  flat.delete(path);
  return buildTreeFromMap(flat, repo);
}

export function branchTipTree(repo: Repo, branch: string): string | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) return null;
  const object = repo.objects.get(tip);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

let requestCounter = 0;

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  requestCounter += 1;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-request-id': `req-${requestCounter}`,
    'x-oauth-scopes': 'repo, read:user',
    ...extraHeaders,
  };
  if (status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  const body = jsonBody(value);
  headers['content-length'] = String(body.length);
  res.writeHead(status, headers);
  res.end(body);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function parseJsonBody(buffer: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buffer.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buffer.toString('utf8')) as unknown };
  } catch {
    return { ok: false };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) return null;
  return header.slice('Bearer '.length);
}

function authorized(req: IncomingMessage): boolean {
  if (EXPECTED_TOKEN === '') return true;
  return bearerToken(req) === EXPECTED_TOKEN;
}

function queryParams(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of url.searchParams) out[key] = value;
  return out;
}

function pageOf(query: Record<string, string>): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.per_page ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.page ?? '1', 10) || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], query: Record<string, string>, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } {
  const { perPage, page } = pageOf(query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(`http://${host}${basePath}`);
    url.searchParams.set('per_page', String(perPage));
    url.searchParams.set('page', String(page + 1));
    link = `<${url.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function restRoot(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {});
}

function restMeta(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
}

function restUser(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, viewerUser());
}

function restListUserRepos(req: IncomingMessage, res: ServerResponse, query: Record<string, string>): void {
  const all = [...repos.values()].sort((a, b) => a.seq - b.seq).map((repo) => repoJson(repo));
  const { page, link } = paginate(all, query, req, '/api/v3/user/repos');
  sendJson(res, 200, page, link ? { link } : {});
}

function restCreateUserRepo(_req: IncomingMessage, res: ServerResponse, body: unknown): void {
  if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
    sendError(res, 422, 'name is required');
    return;
  }
  if (repos.has(repoKey(VIEWER_LOGIN, body.name))) {
    sendError(res, 422, 'Repository already exists');
    return;
  }
  const repo = createRepoRecord(body.name, body.private === true, asString(body.description));
  sendJson(res, 201, repoJson(repo));
}

function restGetRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, repoJson(repo));
}

function restPatchRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (isRecord(body) && typeof body.description === 'string') repo.description = body.description;
  sendJson(res, 200, repoJson(repo));
}

function restDeleteRepo(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  repos.delete(repoKey(owner, name));
  sendJson(res, 204, null);
}

function restListBranches(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const branches = [...repo.refs.keys()]
    .filter((ref) => ref.startsWith('refs/heads/'))
    .map((ref) => ref.slice('refs/heads/'.length))
    .sort()
    .map((branch) => ({ name: branch, commit: { sha: repo.refs.get(`refs/heads/${branch}`) }, protected: false }));
  sendJson(res, 200, branches);
}

function restGetBranch(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = getRepo(owner, name);
  const sha = repo?.refs.get(`refs/heads/${branch}`);
  if (!repo || !sha) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, { name: branch, commit: { sha }, protected: false });
}

function restListCommits(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: Record<string, string>): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const ref = query.sha ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined);
  if (!tip) {
    sendJson(res, 200, []);
    return;
  }
  const commits: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let current: string | undefined = tip;
  while (current && !seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'commit') break;
    const commit = parseCommit(object.data);
    commits.push({
      sha: current,
      commit: {
        message: commit.message.replace(/\n$/, ''),
        author: { name: VIEWER_NAME, email: VIEWER_EMAIL },
        committer: { name: VIEWER_NAME, email: VIEWER_EMAIL },
      },
      author: viewerUser(),
      committer: viewerUser(),
    });
    current = commit.parents[0];
  }
  sendJson(res, 200, commits);
}

function restCreateRef(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
    sendError(res, 422, 'ref and sha are required');
    return;
  }
  if (!repo.objects.has(body.sha)) {
    sendError(res, 422, 'object does not exist');
    return;
  }
  repo.refs.set(body.ref, body.sha);
  sendJson(res, 201, { ref: body.ref, object: { sha: body.sha, type: 'commit' } });
}

function restGetRef(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, refPath: string): void {
  const repo = getRepo(owner, name);
  const sha = repo?.refs.get(`refs/${refPath}`);
  if (!repo || !sha) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, { ref: `refs/${refPath}`, object: { sha, type: 'commit' } });
}

function resolveRefTip(repo: Repo, ref: string | undefined): string | null {
  if (!ref) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const direct = repo.refs.get(`refs/heads/${ref}`);
  if (direct) return direct;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function restGetContents(req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, query: Record<string, string>): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tip = resolveRefTip(repo, query.ref);
  if (!tip) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = flattenTree(repo, tree);
  const decodedPath = decodeURIComponent(path);
  const file = flat.get(decodedPath);
  if (file) {
    const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      content: b64encode(data),
      sha: file.oid,
      size: data.length,
      name: decodedPath.split('/').pop(),
      path: decodedPath,
    });
    return;
  }
  const prefix = decodedPath === '' ? '' : `${decodedPath}/`;
  const entries: Record<string, unknown>[] = [];
  const seenDirs = new Set<string>();
  for (const [entryPath, value] of flat) {
    if (!entryPath.startsWith(prefix)) continue;
    const rest = entryPath.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      entries.push({ type: 'file', name: rest, path: entryPath, sha: value.oid });
    } else {
      const dir = rest.slice(0, slash);
      if (!seenDirs.has(dir)) {
        seenDirs.add(dir);
        entries.push({ type: 'dir', name: dir, path: `${prefix}${dir}`, sha: value.oid });
      }
    }
  }
  if (entries.length === 0) {
    sendError(res, 404, 'Not Found');
    return;
  }
  entries.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  sendJson(res, 200, entries);
}

function restPutContents(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.content !== 'string' || typeof body.message !== 'string') {
    sendError(res, 422, 'content and message are required');
    return;
  }
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const decodedPath = decodeURIComponent(path);
  let tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip && branch !== repo.defaultBranch) {
    // Creating a branch from the default tip, then committing on it.
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip) repo.refs.set(`refs/heads/${branch}`, defaultTip);
    tip = defaultTip;
  }
  const tree = tip ? parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree : null;
  const flat = tree ? flattenTree(repo, tree) : new Map();
  const existing = flat.get(decodedPath);
  const content = b64decode(body.content);
  const blobOid = putObject(repo, 'blob', content);
  if (existing) {
    if (typeof body.sha !== 'string' || body.sha !== existing.oid) {
      sendError(res, 409, 'sha does not match the current file');
      return;
    }
  }
  const newTree = setPathInTree(repo, tree, decodedPath, blobOid);
  const { sha } = commitOnBranch(repo, branch, newTree, body.message);
  sendJson(res, existing ? 200 : 201, {
    content: { name: decodedPath.split('/').pop(), path: decodedPath, sha: blobOid, size: content.length, encoding: 'base64' },
    commit: { sha, message: body.message },
  });
}

function restDeleteContents(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, path: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const branch = isRecord(body) && typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const decodedPath = decodeURIComponent(path);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (!tip) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const tree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = flattenTree(repo, tree);
  if (!flat.has(decodedPath)) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const message = isRecord(body) && typeof body.message === 'string' ? body.message : 'delete file';
  const newTree = removePathFromTree(repo, tree, decodedPath);
  const { sha } = commitOnBranch(repo, branch, newTree, message);
  sendJson(res, 200, { commit: { sha } });
}

function restCreateLabel(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
    sendError(res, 422, 'name is required');
    return;
  }
  let label = repo.labels.get(body.name);
  if (!label) {
    label = { id: nextObjectId, name: body.name, color: asString(body.color, 'ededed'), description: asString(body.description) };
    nextObjectId += 1;
    repo.labels.set(body.name, label);
  }
  sendJson(res, 201, label);
}

function restListLabels(_req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, [...repo.labels.values()]);
}

function restCreateIssue(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
    sendError(res, 422, 'title is required');
    return;
  }
  const labelNames = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
  const labels: Label[] = [];
  for (const labelName of labelNames) {
    const label = repo.labels.get(labelName);
    if (!label) {
      sendError(res, 422, `label ${labelName} does not exist`);
      return;
    }
    labels.push(label);
  }
  const issue = createIssueRecord(repo, body.title, asString(body.body), labels);
  sendJson(res, 201, issueJson(repo, issue));
}

function filterIssues(repo: Repo, query: Record<string, string>): Issue[] {
  let issues = [...repo.issues];
  const state = query.state ?? 'open';
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const direction = query.direction ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  return issues;
}

function restListIssues(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: Record<string, string>): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const issues = filterIssues(repo, query);
  const { page, link } = paginate(issues.map((issue) => issueJson(repo, issue)), query, req, `/api/v3/repos/${owner}/${name}/issues`);
  sendJson(res, 200, page, link ? { link } : {});
}

function restGetIssue(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.find((entry) => entry.number === number);
  if (!repo || !issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function restPatchIssue(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number, body: unknown): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.find((entry) => entry.number === number);
  if (!repo || !issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (isRecord(body)) {
    if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
    if (typeof body.title === 'string') issue.title = body.title;
    if (typeof body.body === 'string') issue.body = body.body;
  }
  sendJson(res, 200, issueJson(repo, issue));
}

function restCreateComment(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number, body: unknown): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.find((entry) => entry.number === number);
  if (!repo || !issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.body !== 'string') {
    sendError(res, 422, 'body is required');
    return;
  }
  const comment: Comment = { id: nextObjectId, body: body.body };
  nextObjectId += 1;
  issue.comments.push(comment);
  sendJson(res, 201, { id: comment.id, body: comment.body, user: viewerUser() });
}

function restListComments(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const issue = repo?.issues.find((entry) => entry.number === number);
  if (!repo || !issue) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: viewerUser() })));
}

function restCreatePull(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: unknown): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
    sendError(res, 422, 'title, head and base are required');
    return;
  }
  const pull = createPullRecord(repo, body.title, asString(body.body), body.head, body.base);
  if ('error' in pull) {
    sendError(res, 422, pull.error);
    return;
  }
  sendJson(res, 201, pullJson(repo, pull));
}

function restListPulls(req: IncomingMessage, res: ServerResponse, owner: string, name: string, query: Record<string, string>): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    sendError(res, 404, 'Not Found');
    return;
  }
  let pulls = [...repo.pulls];
  const state = query.state ?? 'open';
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => b.seq - a.seq);
  const { page, link } = paginate(pulls.map((pull) => pullJson(repo, pull)), query, req, `/api/v3/repos/${owner}/${name}/pulls`);
  sendJson(res, 200, page, link ? { link } : {});
}

function restGetPull(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.find((entry) => entry.number === number);
  if (!repo || !pull) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, pullJson(repo, pull));
}

function restListPullFiles(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.find((entry) => entry.number === number);
  if (!repo || !pull) {
    sendError(res, 404, 'Not Found');
    return;
  }
  sendJson(res, 200, pull.files);
}

function restMergePull(_req: IncomingMessage, res: ServerResponse, owner: string, name: string, number: number): void {
  const repo = getRepo(owner, name);
  const pull = repo?.pulls.find((entry) => entry.number === number);
  if (!repo || !pull) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const result = mergePullRecord(repo, pull);
  if ('error' in result) {
    sendError(res, result.status, result.error);
    return;
  }
  sendJson(res, 200, { sha: result.sha, merged: true, message: `Pull request #${number} merged` });
}

// ---------------------------------------------------------------------------
// GraphQL v4: a small parser and executor for the documents gh sends
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlSelection[];
}

type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; type: string; children: GqlSelection[] };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: string[];
  selections: GqlSelection[];
}

function gqlTokenize(source: string): string[] {
  const tokens: string[] = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char) || char === ',') {
      index += 1;
      continue;
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '"') {
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== '"') {
        if (source[end] === '\\' && end + 1 < source.length) {
          const escaped = source[end + 1];
          value += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped;
          end += 2;
        } else {
          value += source[end];
          end += 1;
        }
      }
      tokens.push(JSON.stringify(value));
      index = end + 1;
      continue;
    }
    if (char === '.' && source.slice(index, index + 3) === '...') {
      tokens.push('...');
      index += 3;
      continue;
    }
    if ('{}():[]!=$'.includes(char)) {
      tokens.push(char);
      index += 1;
      continue;
    }
    const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index)) ?? /^-?\d+/.exec(source.slice(index));
    if (match) {
      tokens.push(match[0]);
      index += match[0].length;
      continue;
    }
    throw new Error(`unexpected GraphQL character ${JSON.stringify(char)}`);
  }
  return tokens;
}

class GqlParser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = gqlTokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === 'query' || token === 'mutation') {
        this.next();
        let name: string | null = null;
        if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
        const variables: string[] = [];
        if (this.peek() === '(') {
          this.next();
          while (this.peek() !== ')') {
            const dollar = this.next();
            if (dollar !== '$') throw new Error('expected $ in variable definition');
            variables.push(this.next());
            this.expect(':');
            this.next(); // type name
            if (this.peek() === '!') this.next();
            if (this.peek() === '=') {
              this.next();
              this.parseValue();
            }
          }
          this.expect(')');
        }
        operations.push({ type: token as 'query' | 'mutation', name, variables, selections: this.parseSelectionSet() });
      } else if (token === '{') {
        operations.push({ type: 'query', name: null, variables: [], selections: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected GraphQL token ${JSON.stringify(token)}`);
      }
    }
    return operations;
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const type = this.next();
          selections.push({ kind: 'fragment', type, children: this.parseSelectionSet() });
        } else {
          this.next(); // fragment name; unsupported, skip its selection set if any
          if (this.peek() === '{') this.parseSelectionSet();
        }
        continue;
      }
      let alias: string | null = null;
      let name = this.next();
      if (this.peek() === ':') {
        this.next();
        alias = name;
        name = this.next();
      }
      const args: Record<string, GqlValue> = {};
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args[argName] = this.parseValue();
        }
        this.expect(')');
      }
      const children = this.peek() === '{' ? this.parseSelectionSet() : [];
      selections.push({ kind: 'field', field: { alias, name, args, children } });
    }
    this.expect('}');
    return selections;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token === '[') {
      const items: GqlValue[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    return { kind: 'enum', value: token };
  }
}

function resolveGqlValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
      return value.value;
    case 'int':
      return value.value;
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.items.map((item) => resolveGqlValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value.fields)) out[key] = resolveGqlValue(child, variables);
      return out;
    }
  }
}

function resolveGqlArgs(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveGqlValue(value, variables);
  return out;
}

// The schema the introspection probes describe.
const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'closedAt', 'author', 'labels'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'headRef', 'baseRef', 'mergeCommit', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url'],
  SearchType: [],
  Viewer: ['login', 'id', 'name'],
  User: ['login', 'id'],
  BranchRef: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFilesConnection: ['nodes', 'pageInfo'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  Comment: ['id', 'body'],
};

const GQL_ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'COMMIT', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

interface GqlContext {
  errors: Array<{ message: string }>;
}

function gqlIssueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function gqlPullState(pull: Pull): string {
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function repoGlobalId(repo: Repo): string {
  return stableId('repo', `${repo.owner}/${repo.name}`);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return stableId('issue', `${repo.owner}/${repo.name}#${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return stableId('pr', `${repo.owner}/${repo.name}#${pull.number}`);
}

function commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
  return stableId('comment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
}

function findByGlobalId(id: string): { kind: 'repo' | 'issue' | 'pr'; repo: Repo; issue?: Issue; pull?: Pull } | null {
  const decoded = decodeStableId(id);
  if (!decoded) return null;
  if (decoded.prefix === 'repo') {
    const [owner, name] = decoded.key.split('/', 2);
    const repo = getRepo(owner, name);
    return repo ? { kind: 'repo', repo } : null;
  }
  if (decoded.prefix === 'issue' || decoded.prefix === 'pr') {
    const hash = decoded.key.indexOf('#');
    if (hash < 0) return null;
    const [owner, name] = decoded.key.slice(0, hash).split('/', 2);
    const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
    const repo = getRepo(owner, name);
    if (!repo) return null;
    if (decoded.prefix === 'issue') {
      const issue = repo.issues.find((entry) => entry.number === number);
      return issue ? { kind: 'issue', repo, issue } : null;
    }
    const pull = repo.pulls.find((entry) => entry.number === number);
    return pull ? { kind: 'pr', repo, pull } : null;
  }
  return null;
}

function executeSelections(
  ctx: GqlContext,
  typeName: string,
  source: unknown,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const allowed = GQL_TYPE_FIELDS[typeName] ?? [];
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type === typeName) {
        Object.assign(out, executeSelections(ctx, typeName, source, selection.children, variables));
      }
      continue;
    }
    const { field } = selection;
    const responseKey = field.alias ?? field.name;
    if (!allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    out[responseKey] = resolveGqlField(ctx, typeName, source, field, variables);
  }
  return out;
}

function resolveGqlField(
  ctx: GqlContext,
  typeName: string,
  source: unknown,
  field: GqlField,
  variables: Record<string, unknown>,
): unknown {
  const args = resolveGqlArgs(field, variables);
  if (typeName === 'Query') return resolveQueryField(ctx, field, args, variables);
  if (typeName === 'Mutation') return resolveMutationField(ctx, field, args, variables);
  if (typeName === 'Viewer') {
    if (field.name === 'login') return VIEWER_LOGIN;
    if (field.name === 'id') return String(VIEWER_ID);
    if (field.name === 'name') return VIEWER_NAME;
  }
  if (typeName === 'User') {
    const user = source as Record<string, unknown>;
    if (field.name === 'login') return user.login ?? VIEWER_LOGIN;
    if (field.name === 'id') return String(user.id ?? VIEWER_ID);
  }
  if (typeName === 'BranchRef') {
    return (source as { name: string }).name;
  }
  if (typeName === 'Repository') {
    const repo = source as Repo;
    switch (field.name) {
      case 'id':
        return repoGlobalId(repo);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner':
        return executeSelections(ctx, 'User', viewerUser(), field.children, variables);
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (!tip) return null;
        return executeSelections(ctx, 'BranchRef', { name: repo.defaultBranch }, field.children, variables);
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'issue': {
        const number = args.number as number;
        const issue = repo.issues.find((entry) => entry.number === number);
        if (!issue) return null;
        return executeSelections(ctx, 'Issue', { repo, issue }, field.children, variables);
      }
      case 'issues': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const after = typeof args.after === 'string' ? args.after : null;
        const states = Array.isArray(args.states) ? (args.states as string[]) : null;
        const orderBy = isRecord(args.orderBy) ? (args.orderBy as Record<string, unknown>) : null;
        let issues = [...repo.issues];
        if (states) issues = issues.filter((issue) => states.includes(gqlIssueState(issue)));
        const direction = orderBy?.direction === 'ASC' ? 1 : -1;
        issues.sort((a, b) => (a.seq - b.seq) * direction || (a.number - b.number) * direction);
        let start = 0;
        if (after) {
          const decoded = Buffer.from(after, 'base64').toString('utf8');
          const afterNumber = Number.parseInt(decoded, 10);
          const index = issues.findIndex((issue) => issue.number === afterNumber);
          if (index >= 0) start = index + 1;
        }
        const page = issues.slice(start, start + first);
        const nodes = page.map((issue) => executeSelections(ctx, 'Issue', { repo, issue }, field.children.find((child) => child.kind === 'field' && child.field.name === 'nodes')?.field.children ?? [], variables));
        const endCursor = page.length > 0 ? b64encode(String(page[page.length - 1].number)) : null;
        return executeConnection(ctx, field.children, nodes, start + first < issues.length, endCursor, variables);
      }
      case 'pullRequests': {
        const first = typeof args.first === 'number' ? args.first : 100;
        const pulls = repo.pulls.filter((pull) => pull.state === 'open').slice(0, first);
        const nodes = pulls.map((pull) => executeSelections(ctx, 'PullRequest', { repo, pull }, field.children.find((child) => child.kind === 'field' && child.field.name === 'nodes')?.field.children ?? [], variables));
        return executeConnection(ctx, field.children, nodes, false, null, variables);
      }
      case 'pullRequest': {
        const number = args.number as number;
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (!pull) return null;
        return executeSelections(ctx, 'PullRequest', { repo, pull }, field.children, variables);
      }
    }
  }
  if (typeName === 'Issue') {
    const { repo, issue } = source as { repo: Repo; issue: Issue };
    switch (field.name) {
      case 'id':
        return issueGlobalId(repo, issue);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'state':
        return gqlIssueState(issue);
      case 'body':
        return issue.body;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'author':
        return executeSelections(ctx, 'User', viewerUser(), field.children, variables);
      case 'labels':
        return issue.labels.map((label) => label.name);
      default:
        return null;
    }
  }
  if (typeName === 'PullRequest') {
    const { repo, pull } = source as { repo: Repo; pull: Pull };
    switch (field.name) {
      case 'id':
        return pullGlobalId(repo, pull);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'mergeable':
        return pullMergeable(repo, pull);
      case 'state':
        return gqlPullState(pull);
      case 'merged':
        return pull.merged;
      case 'author':
        return executeSelections(ctx, 'User', viewerUser(), field.children, variables);
      case 'files': {
        const nodes = pull.files.map((file) => ({ path: file.filename }));
        const fileChildren = field.children.find((child) => child.kind === 'field' && child.field.name === 'nodes')?.field.children ?? [];
        const mapped = nodes.map((node) => {
          const out: Record<string, unknown> = {};
          for (const child of fileChildren) {
            if (child.kind === 'field' && child.field.name === 'path') out[child.field.alias ?? 'path'] = node.path;
          }
          return out;
        });
        return executeConnection(ctx, field.children, mapped, false, null, variables);
      }
      default:
        return null;
    }
  }
  return null;
}

function executeConnection(
  ctx: GqlContext,
  children: GqlSelection[],
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const child of children) {
    if (child.kind !== 'field') continue;
    const key = child.field.alias ?? child.field.name;
    if (child.field.name === 'nodes') out[key] = nodes;
    else if (child.field.name === 'totalCount') out[key] = nodes.length;
    else if (child.field.name === 'pageInfo') {
      const pageInfo: Record<string, unknown> = {};
      for (const grand of child.field.children) {
        if (grand.kind !== 'field') continue;
        const gkey = grand.field.alias ?? grand.field.name;
        if (grand.field.name === 'hasNextPage') pageInfo[gkey] = hasNextPage;
        else if (grand.field.name === 'hasPreviousPage') pageInfo[gkey] = false;
        else if (grand.field.name === 'endCursor') pageInfo[gkey] = endCursor;
        else if (grand.field.name === 'startCursor') pageInfo[gkey] = endCursor;
      }
      out[key] = pageInfo;
    }
  }
  void ctx;
  void variables;
  return out;
}

function resolveQueryField(
  ctx: GqlContext,
  field: GqlField,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
): unknown {
  if (field.name === 'viewer') {
    return executeSelections(ctx, 'Viewer', {}, field.children, variables);
  }
  if (field.name === 'repository') {
    const owner = args.owner as string;
    const name = args.name as string;
    const repo = getRepo(owner, name);
    if (!repo) return null;
    return executeSelections(ctx, 'Repository', repo, field.children, variables);
  }
  if (field.name === 'node') {
    const found = findByGlobalId(args.id as string);
    if (!found) return null;
    if (found.kind === 'repo') return executeSelections(ctx, 'Repository', found.repo, field.children, variables);
    if (found.kind === 'issue') return executeSelections(ctx, 'Issue', { repo: found.repo, issue: found.issue }, field.children, variables);
    if (found.kind === 'pr') return executeSelections(ctx, 'PullRequest', { repo: found.repo, pull: found.pull }, field.children, variables);
    return null;
  }
  if (field.name === '__type') {
    const typeName = args.name as string;
    const fields = GQL_TYPE_FIELDS[typeName];
    const enums = GQL_ENUM_VALUES[typeName];
    if (fields === undefined && enums === undefined) return null;
    const out: Record<string, unknown> = { name: typeName };
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'fields') {
        out[key] = (fields ?? []).map((name) => {
          const entry: Record<string, unknown> = {};
          for (const grand of child.field.children) {
            if (grand.kind === 'field' && grand.field.name === 'name') entry[grand.field.alias ?? 'name'] = name;
          }
          return entry;
        });
      } else if (child.field.name === 'enumValues') {
        out[key] = (enums ?? []).map((name) => {
          const entry: Record<string, unknown> = {};
          for (const grand of child.field.children) {
            if (grand.kind === 'field' && grand.field.name === 'name') entry[grand.field.alias ?? 'name'] = name;
          }
          return entry;
        });
      } else if (child.field.name === 'name') {
        out[key] = typeName;
      }
    }
    return out;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Query".` });
  return null;
}

function resolveMutationField(
  ctx: GqlContext,
  field: GqlField,
  args: Record<string, unknown>,
  variables: Record<string, unknown>,
): unknown {
  const input = isRecord(args.input) ? args.input : {};
  const pick = (selections: GqlSelection[], build: (children: GqlSelection[]) => unknown): unknown => {
    for (const child of selections) {
      if (child.kind === 'field' && child.field.name === field.name) return build(child.field.children);
    }
    return build(selections);
  };
  void pick;
  if (field.name === 'createIssue') {
    const repoId = input.repositoryId as string;
    const found = findByGlobalId(repoId);
    if (!found || found.kind !== 'repo') {
      ctx.errors.push({ message: 'createIssue: repository not found' });
      return null;
    }
    const issue = createIssueRecord(found.repo, asString(input.title), asString(input.body), []);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'issue') out[key] = executeSelections(ctx, 'Issue', { repo: found.repo, issue }, child.field.children, variables);
    }
    return out;
  }
  if (field.name === 'closeIssue') {
    const found = findByGlobalId(input.issueId as string);
    if (!found || found.kind !== 'issue' || !found.issue) {
      ctx.errors.push({ message: 'closeIssue: issue not found' });
      return null;
    }
    found.issue.state = 'closed';
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'issue') out[key] = executeSelections(ctx, 'Issue', { repo: found.repo, issue: found.issue }, child.field.children, variables);
    }
    return out;
  }
  if (field.name === 'createPullRequest') {
    const found = findByGlobalId(input.repositoryId as string);
    if (!found || found.kind !== 'repo') {
      ctx.errors.push({ message: 'createPullRequest: repository not found' });
      return null;
    }
    const pull = createPullRecord(found.repo, asString(input.title), asString(input.body), asString(input.headRefName), asString(input.baseRefName));
    if ('error' in pull) {
      ctx.errors.push({ message: `createPullRequest: ${pull.error}` });
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'pullRequest') out[key] = executeSelections(ctx, 'PullRequest', { repo: found.repo, pull }, child.field.children, variables);
    }
    return out;
  }
  if (field.name === 'mergePullRequest') {
    const found = findByGlobalId(input.pullRequestId as string);
    if (!found || found.kind !== 'pr' || !found.pull) {
      ctx.errors.push({ message: 'mergePullRequest: pull request not found' });
      return null;
    }
    const result = mergePullRecord(found.repo, found.pull);
    if ('error' in result) {
      ctx.errors.push({ message: `mergePullRequest: ${result.error}` });
      return null;
    }
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'pullRequest') out[key] = executeSelections(ctx, 'PullRequest', { repo: found.repo, pull: found.pull }, child.field.children, variables);
    }
    return out;
  }
  if (field.name === 'addComment') {
    const found = findByGlobalId(input.subjectId as string);
    if (!found || found.kind !== 'issue' || !found.issue) {
      ctx.errors.push({ message: 'addComment: issue not found' });
      return null;
    }
    const comment: Comment = { id: nextObjectId, body: asString(input.body) };
    nextObjectId += 1;
    found.issue.comments.push(comment);
    const out: Record<string, unknown> = {};
    for (const child of field.children) {
      if (child.kind !== 'field') continue;
      const key = child.field.alias ?? child.field.name;
      if (child.field.name === 'commentEdge') {
        const edge: Record<string, unknown> = {};
        for (const grand of child.field.children) {
          if (grand.kind !== 'field') continue;
          const gkey = grand.field.alias ?? grand.field.name;
          if (grand.field.name === 'node') {
            const node: Record<string, unknown> = {};
            for (const great of grand.field.children) {
              if (great.kind !== 'field') continue;
              const nkey = great.field.alias ?? great.field.name;
              if (great.field.name === 'id') node[nkey] = commentGlobalId(found.repo, found.issue, comment);
              else if (great.field.name === 'body') node[nkey] = comment.body;
            }
            edge[gkey] = node;
          }
        }
        out[key] = edge;
      }
    }
    return out;
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

export function executeGraphQL(query: string, variables: Record<string, unknown>): { data: Record<string, unknown> | null; errors: Array<{ message: string }> } {
  const ctx: GqlContext = { errors: [] };
  let operations: GqlOperation[];
  try {
    operations = new GqlParser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: (err as Error).message }] };
  }
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'empty document' }] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const allowedRoot = rootType === 'Query' ? ['viewer', 'repository', 'node', '__type'] : ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'];
  const data: Record<string, unknown> = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const key = selection.field.alias ?? selection.field.name;
    if (!allowedRoot.includes(selection.field.name)) {
      ctx.errors.push({ message: `Cannot query field "${selection.field.name}" on type "${rootType}".` });
      continue;
    }
    data[key] = resolveGqlField(ctx, rootType, null, selection.field, variables);
  }
  return { data, errors: ctx.errors };
}

// ---------------------------------------------------------------------------
// MCP (JSON-RPC 2.0 Streamable HTTP)
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
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
    description: 'Get a repository by owner and name.',
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
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
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
    description: 'Merge a pull request by number using a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
  {
    name: 'close_issue',
    description: 'Close an issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'integer', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
];

function mcpResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function mcpError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function mcpToolResult(id: unknown, obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return mcpResult(id, { content: [{ type: 'text', text }], structuredContent: obj });
}

function mcpToolError(id: unknown, message: string): Record<string, unknown> {
  return mcpResult(id, { content: [{ type: 'text', text: message }], isError: true });
}

function mcpPickArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (args[name] !== undefined) return args[name];
  }
  return undefined;
}

function mcpCallTool(id: unknown, params: Record<string, unknown>): Record<string, unknown> {
  const name = asString(params.name);
  const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (!tool) return mcpError(id, -32602, `unknown tool ${name}`);
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined) return mcpToolError(id, `missing required argument ${required}`);
  }
  const owner = asString(mcpPickArg(args, 'owner', 'owner_login', 'org'));
  const repoName = asString(mcpPickArg(args, 'repo', 'repository'));
  if (name === 'create_repo') {
    const repo = createRepoRecord(asString(args.name), args.private === true, asString(args.description));
    return mcpToolResult(id, repoJson(repo));
  }
  if (name === 'list_repos') {
    const all = [...repos.values()].map((repo) => repoJson(repo));
    return mcpToolResult(id, all);
  }
  const repo = getRepo(owner, repoName);
  if (!repo) return mcpToolError(id, 'Not Found');
  if (name === 'get_repo') return mcpToolResult(id, repoJson(repo));
  if (name === 'create_issue') {
    const issue = createIssueRecord(repo, asString(mcpPickArg(args, 'title', 'issue_title')), asString(mcpPickArg(args, 'body', 'description')), []);
    return mcpToolResult(id, issueJson(repo, issue));
  }
  if (name === 'list_issues') {
    const state = asString(mcpPickArg(args, 'state'), 'open');
    const issues = filterIssues(repo, { state });
    return mcpToolResult(id, issues.map((issue) => issueJson(repo, issue)));
  }
  if (name === 'close_issue') {
    const number = Number(mcpPickArg(args, 'issue_number', 'number'));
    const issue = repo.issues.find((entry) => entry.number === number);
    if (!issue) return mcpToolError(id, 'Not Found');
    issue.state = 'closed';
    return mcpToolResult(id, issueJson(repo, issue));
  }
  if (name === 'create_pull_request') {
    const pull = createPullRecord(repo, asString(mcpPickArg(args, 'title')), asString(mcpPickArg(args, 'body', 'description')), asString(mcpPickArg(args, 'head', 'head_branch')), asString(mcpPickArg(args, 'base', 'base_branch')));
    if ('error' in pull) return mcpToolError(id, pull.error);
    return mcpToolResult(id, pullJson(repo, pull));
  }
  if (name === 'merge_pull_request') {
    const number = Number(mcpPickArg(args, 'pull_number', 'number'));
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (!pull) return mcpToolError(id, 'Not Found');
    const result = mergePullRecord(repo, pull);
    if ('error' in result) return mcpToolError(id, result.error);
    return mcpToolResult(id, { sha: result.sha, merged: true, message: `Pull request #${number} merged` });
  }
  return mcpError(id, -32602, `unknown tool ${name}`);
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authorized(req)) {
    sendJson(res, 401, mcpError(null, -32000, 'unauthorized'));
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    sendJson(res, 400, mcpError(null, -32700, 'Parse error'));
    return;
  }
  if (!isRecord(payload) || typeof payload.method !== 'string') {
    sendJson(res, 400, mcpError(null, -32600, 'Invalid Request'));
    return;
  }
  const id = payload.id ?? null;
  const method = payload.method;
  const params = isRecord(payload.params) ? (payload.params as Record<string, unknown>) : {};
  if (method === 'server/discover') {
    sendJson(res, 200, mcpResult(id, {
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18'],
      serverInfo: { name: 'forge', version: '1.0.0' },
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'forge', version: '1.0.0' } },
    }));
    return;
  }
  if (method === 'initialize') {
    sendJson(res, 200, mcpResult(id, {
      protocolVersion: asString(params.protocolVersion, '2025-11-25'),
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    }));
    return;
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    sendJson(res, 202, null);
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, mcpResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    sendJson(res, 200, mcpResult(id, { tools: MCP_TOOLS }));
    return;
  }
  if (method === 'tools/call') {
    sendJson(res, 200, mcpCallTool(id, params));
    return;
  }
  sendJson(res, 200, mcpError(id, -32601, `method not found: ${method}`));
}

// ---------------------------------------------------------------------------
// Git smart HTTP
// ---------------------------------------------------------------------------

function pktEncodeLine(data: Buffer): Buffer {
  const length = data.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), data]);
}

function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

function pktEncode(lines: Buffer[]): Buffer {
  return Buffer.concat([...lines.map((line) => pktEncodeLine(line)), pktFlush()]);
}

interface PktFrame {
  line: Buffer | null; // null = flush
  consumed: number;
}

function pktReadFrame(buffer: Buffer, offset: number): PktFrame | null {
  if (offset + 4 > buffer.length) return null;
  const length = Number.parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
  if (Number.isNaN(length)) return null;
  // length 0 is a flush packet, length 1 is a delim packet; both carry no
  // payload and both act as a section boundary.
  if (length === 0 || length === 1) return { line: null, consumed: 4 };
  if (offset + length > buffer.length) return null;
  return { line: buffer.subarray(offset + 4, offset + length), consumed: length };
}

function gitAdvertise(repo: Repo | null, service: 'upload-pack' | 'receive-pack'): Buffer {
  const chunks: Buffer[] = [];
  if (service === 'upload-pack') {
    chunks.push(pktEncodeLine(Buffer.from('version 2\n', 'utf8')));
    chunks.push(pktEncodeLine(Buffer.from('ls-refs=unborn\n', 'utf8')));
    chunks.push(pktEncodeLine(Buffer.from('fetch=shallow filter\n', 'utf8')));
    chunks.push(pktEncodeLine(Buffer.from('object-format=sha1\n', 'utf8')));
    chunks.push(pktEncodeLine(Buffer.from('agent=forge/1.0\n', 'utf8')));
    chunks.push(pktFlush());
    return Buffer.concat(chunks);
  }
  const serviceLine = Buffer.from(`# service=git-${service}\n`, 'utf8');
  chunks.push(pktEncodeLine(serviceLine));
  chunks.push(pktFlush());
  if (!repo) return Buffer.concat(chunks);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const capabilities = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=forge/1.0';
  if (!tip) {
    chunks.push(pktEncodeLine(Buffer.concat([Buffer.from(ZERO_OID, 'ascii'), Buffer.from(` capabilities^{}\0${capabilities}\n`, 'utf8')])));
    return Buffer.concat(chunks);
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  let first = true;
  for (const [refName, sha] of refs) {
    if (first) {
      chunks.push(pktEncodeLine(Buffer.concat([Buffer.from(sha, 'ascii'), Buffer.from(` ${refName}\0${capabilities}\n`, 'utf8')])));
      first = false;
    } else {
      chunks.push(pktEncodeLine(Buffer.from(`${sha} ${refName}\n`, 'utf8')));
    }
  }
  if (first) {
    chunks.push(pktEncodeLine(Buffer.concat([Buffer.from(tip, 'ascii'), Buffer.from(` HEAD\0${capabilities}\n`, 'utf8')])));
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function gitAdvertiseV0(repo: Repo | null, service: 'upload-pack' | 'receive-pack'): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(pktEncodeLine(Buffer.from(`# service=git-${service}\n`, 'utf8')));
  chunks.push(pktFlush());
  if (!repo) return Buffer.concat(chunks);
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const capabilities = service === 'upload-pack'
    ? 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack shallow agent=forge/1.0'
    : 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';
  if (!tip) {
    chunks.push(pktEncodeLine(Buffer.from(`${ZERO_OID} capabilities^{}\0${capabilities}\n`, 'utf8')));
    chunks.push(pktFlush());
    return Buffer.concat(chunks);
  }
  const refs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
  let first = true;
  for (const [refName, sha] of refs) {
    if (first) {
      chunks.push(pktEncodeLine(Buffer.from(`${sha} ${refName}\0${capabilities}\n`, 'utf8')));
      first = false;
    } else {
      chunks.push(pktEncodeLine(Buffer.from(`${sha} ${refName}\n`, 'utf8')));
    }
  }
  chunks.push(pktFlush());
  return Buffer.concat(chunks);
}

function sendGitService(res: ServerResponse, service: 'upload-pack' | 'receive-pack', body: Buffer): void {
  res.writeHead(200, {
    'content-type': `application/x-git-${service}-advertisement`,
    'cache-control': 'no-cache',
  });
  res.end(body);
}

function sidebandPacket(band: number, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from([band]), data]);
  return pktEncodeLine(payload);
}

function handleGitInfoRefs(req: IncomingMessage, res: ServerResponse, owner: string, name: string): void {
  const repo = getRepo(owner, name);
  const service = req.url?.includes('git-upload-pack') ? 'upload-pack' : 'receive-pack';
  const wantsV2 = req.headers['git-protocol'] === 'version=2' && service === 'upload-pack';
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  if (wantsV2) {
    sendGitService(res, service, gitAdvertise(repo, service));
    return;
  }
  sendGitService(res, service, gitAdvertiseV0(repo, service));
}

interface LsRefsOptions {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleGitUploadPack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  const repo = getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  const isV2 = req.headers['git-protocol'] === 'version=2';
  if (!isV2) {
    handleUploadPackV0(res, repo, body);
    return;
  }
  // Split the v2 request into sections separated by delim pkt-lines. Section
  // 0 holds the command line; later sections hold the command's arguments.
  const sections: Buffer[][] = [[]];
  let offset = 0;
  while (offset < body.length) {
    const frame = pktReadFrame(body, offset);
    if (!frame) break;
    offset += frame.consumed;
    if (frame.line === null) sections.push([]);
    else sections[sections.length - 1].push(frame.line);
  }
  const lines = sections[0];
  const args = sections.slice(1).flat();
  let command: string | null = null;
  for (const line of lines) {
    const text = line.toString('utf8').trim();
    if (text.startsWith('command=')) command = text.slice('command='.length);
  }
  if (command === 'ls-refs') {
    const options: LsRefsOptions = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of args) {
      const text = line.toString('utf8').trim();
      if (text === 'peel') options.peel = true;
      else if (text === 'symrefs') options.symrefs = true;
      else if (text === 'unborn') options.unborn = true;
      else if (text.startsWith('ref-prefix ')) options.prefixes.push(text.slice('ref-prefix '.length));
    }
    const out: Buffer[] = [];
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const refs = [...repo.refs.entries()].sort(([a], [b]) => a.localeCompare(b));
    const matches = (ref: string): boolean => options.prefixes.length === 0 || options.prefixes.some((prefix) => ref.startsWith(prefix));
    for (const [refName, sha] of refs) {
      if (!matches(refName)) continue;
      const parts = [sha, refName];
      if (options.peel) {
        const object = repo.objects.get(sha);
        if (object?.type === 'tag') {
          const tag = parseTag(object.data);
          parts.push(`peeled:${tag.object}`);
        }
      }
      out.push(pktEncodeLine(Buffer.from(`${parts.join(' ')}\n`, 'utf8')));
    }
    if (!defaultTip && options.unborn) {
      const headMatches = matches('HEAD');
      if (headMatches || options.prefixes.length === 0) {
        out.push(pktEncodeLine(Buffer.from(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`, 'utf8')));
      }
    } else if (defaultTip && matches('HEAD')) {
      const parts = [defaultTip, 'HEAD'];
      if (options.symrefs) parts.push(`symref-target:refs/heads/${repo.defaultBranch}`);
      out.push(pktEncodeLine(Buffer.from(`${parts.join(' ')}\n`, 'utf8')));
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat([...out, pktFlush()]));
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallows: string[] = [];
    let depth: number | null = null;
    let thinPack = false;
    let ofsDelta = false;
    for (const line of args) {
      const text = line.toString('utf8').trim();
      if (text.startsWith('want ')) wants.push(text.slice(5));
      else if (text.startsWith('have ')) haves.push(text.slice(5));
      else if (text.startsWith('shallow ')) shallows.push(text.slice(8));
      else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
      else if (text === 'thin-pack') thinPack = true;
      else if (text === 'ofs-delta') ofsDelta = true;
    }
    void thinPack;
    void ofsDelta;
    const result = computeFetch(repo, wants, haves, depth, shallows);
    const chunks: Buffer[] = [];
    chunks.push(pktEncodeLine(Buffer.from('acknowledgments\n', 'utf8')));
    chunks.push(pktEncodeLine(Buffer.from('NAK\n', 'utf8')));
    chunks.push(pktFlush());
    if (depth !== null && (result.shallow.length > 0 || result.unshallow.length > 0)) {
      chunks.push(pktEncodeLine(Buffer.from('shallow-info\n', 'utf8')));
      for (const oid of result.shallow) chunks.push(pktEncodeLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
      for (const oid of result.unshallow) chunks.push(pktEncodeLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
      chunks.push(pktFlush());
    }
    if (result.objects.length > 0) {
      chunks.push(pktEncodeLine(Buffer.from('packfile\n', 'utf8')));
      const pack = writePack(result.objects);
      let packOffset = 0;
      while (packOffset < pack.length) {
        const slice = pack.subarray(packOffset, Math.min(pack.length, packOffset + 65515));
        chunks.push(sidebandPacket(1, slice));
        packOffset += slice.length;
      }
    }
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
    res.end(Buffer.concat(chunks));
    return;
  }
  res.writeHead(400, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ message: 'unknown command' }));
}

function handleUploadPackV0(res: ServerResponse, repo: Repo, body: Buffer): void {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallows: string[] = [];
  let depth: number | null = null;
  let offset = 0;
  let seenFlush = false;
  while (offset < body.length) {
    const frame = pktReadFrame(body, offset);
    if (!frame) break;
    offset += frame.consumed;
    if (frame.line === null) {
      seenFlush = true;
      continue;
    }
    const text = frame.line.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const first = text.slice(5).split(' ')[0];
      wants.push(first);
    } else if (text.startsWith('have ')) haves.push(text.slice(5));
    else if (text.startsWith('shallow ')) shallows.push(text.slice(8));
    else if (text.startsWith('deepen ')) depth = Number.parseInt(text.slice(7), 10);
  }
  void seenFlush;
  const result = computeFetch(repo, wants, haves, depth, shallows);
  const chunks: Buffer[] = [];
  chunks.push(pktEncodeLine(Buffer.from('NAK\n', 'utf8')));
  for (const oid of result.shallow) chunks.push(pktEncodeLine(Buffer.from(`shallow ${oid}\n`, 'utf8')));
  for (const oid of result.unshallow) chunks.push(pktEncodeLine(Buffer.from(`unshallow ${oid}\n`, 'utf8')));
  if (result.objects.length > 0) {
    const pack = writePack(result.objects);
    let packOffset = 0;
    while (packOffset < pack.length) {
      const slice = pack.subarray(packOffset, Math.min(pack.length, packOffset + 65515));
      chunks.push(sidebandPacket(1, slice));
      packOffset += slice.length;
    }
  }
  chunks.push(pktFlush());
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result' });
  res.end(Buffer.concat(chunks));
}

function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, owner: string, name: string, body: Buffer): void {
  void req;
  const repo = getRepo(owner, name);
  if (!repo) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: 'Not Found' }));
    return;
  }
  // Parse command lines up to the first flush, then the pack.
  interface Command { old: string; new: string; ref: string }
  const commands: Command[] = [];
  let offset = 0;
  while (offset < body.length) {
    const frame = pktReadFrame(body, offset);
    if (!frame) break;
    offset += frame.consumed;
    if (frame.line === null) break;
    const raw = frame.line.toString('utf8');
    const nul = raw.indexOf('\0');
    const text = (nul >= 0 ? raw.slice(0, nul) : raw).trim();
    const parts = text.split(' ');
    if (parts.length >= 3) commands.push({ old: parts[0], new: parts[1], ref: parts[2] });
  }
  const packData = body.subarray(offset);
  let unpackOk = true;
  if (packData.length > 0) {
    try {
      const stored = readPack(packData, (oid) => repo.objects.get(oid));
      for (const [oid, object] of stored) repo.objects.set(oid, object);
    } catch {
      unpackOk = false;
    }
  }
  const report: Buffer[] = [];
  report.push(pktEncodeLine(Buffer.from(unpackOk ? 'unpack ok\n' : 'unpack failed\n', 'utf8')));
  for (const command of commands) {
    const ref = command.ref;
    if (!unpackOk) {
      report.push(pktEncodeLine(Buffer.from(`ng ${ref} unpack failed\n`, 'utf8')));
      continue;
    }
    if (command.new === ZERO_OID) {
      repo.refs.delete(ref);
      report.push(pktEncodeLine(Buffer.from(`ok ${ref}\n`, 'utf8')));
      continue;
    }
    const current = repo.refs.get(ref);
    const isNew = !current;
    let fastForward = true;
    if (current && current !== ZERO_OID) {
      fastForward = isAncestor(repo, current, command.new);
    }
    if (!fastForward) {
      report.push(pktEncodeLine(Buffer.from(`ng ${ref} non-fast-forward\n`, 'utf8')));
      continue;
    }
    repo.refs.set(ref, command.new);
    if (isNew && ref === `refs/heads/${repo.defaultBranch}`) {
      // default branch created by the first push
    }
    report.push(pktEncodeLine(Buffer.from(`ok ${ref}\n`, 'utf8')));
  }
  report.push(pktFlush());
  const inner = Buffer.concat(report);
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result' });
  res.end(Buffer.concat([sidebandPacket(1, inner), pktFlush()]));
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function restNotFound(res: ServerResponse): void {
  sendError(res, 404, 'Not Found');
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
  const path = url.pathname;
  const method = (req.method ?? 'GET').toUpperCase();
  const query = queryParams(url);

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // Git smart HTTP: /{owner}/{repo}.git/...
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
  if (gitMatch) {
    const [, owner, repoName, action] = gitMatch;
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    if (method === 'GET' && action === 'info/refs') {
      handleGitInfoRefs(req, res, owner, repoName);
      return;
    }
    const body = await readRequestBody(req);
    if (method === 'POST' && action === 'git-upload-pack') {
      handleGitUploadPack(req, res, owner, repoName, body);
      return;
    }
    if (method === 'POST' && action === 'git-receive-pack') {
      handleGitReceivePack(req, res, owner, repoName, body);
      return;
    }
    restNotFound(res);
    return;
  }

  if (path === '/mcp') {
    if (method !== 'POST') {
      restNotFound(res);
      return;
    }
    const body = await readRequestBody(req);
    handleMcp(req, res, body);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') {
      restNotFound(res);
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { data: null, errors: [{ message: 'Requires authentication' }] });
      return;
    }
    const body = await readRequestBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendJson(res, 400, { data: null, errors: [{ message: 'malformed JSON' }] });
      return;
    }
    const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
    const results = requests.map((request) => {
      if (!isRecord(request) || typeof request.query !== 'string') {
        return { data: null, errors: [{ message: 'query is required' }] };
      }
      const variables = isRecord(request.variables) ? (request.variables as Record<string, unknown>) : {};
      return executeGraphQL(request.query, variables);
    });
    sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
    return;
  }

  // REST v3 — everything under /api/v3.
  if (!path.startsWith('/api/v3')) {
    restNotFound(res);
    return;
  }
  const restPath = path.slice('/api/v3'.length) || '/';
  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }
  const body = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE' ? await readRequestBody(req) : Buffer.alloc(0);
  let parsedBody: unknown = {};
  if (body.length > 0) {
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'Problems parsing JSON');
      return;
    }
    parsedBody = parsed.value;
  }

  if (restPath === '/' && method === 'GET') {
    restRoot(req, res);
    return;
  }
  if (restPath === '/meta' && method === 'GET') {
    restMeta(req, res);
    return;
  }
  if (restPath === '/user' && method === 'GET') {
    restUser(req, res);
    return;
  }
  if (restPath === '/user/repos') {
    if (method === 'GET') {
      restListUserRepos(req, res, query);
      return;
    }
    if (method === 'POST') {
      restCreateUserRepo(req, res, parsedBody);
      return;
    }
    restNotFound(res);
    return;
  }

  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(restPath);
  if (repoMatch) {
    const [, owner, repoName, rest] = repoMatch;
    if (!rest) {
      if (method === 'GET') {
        restGetRepo(req, res, owner, repoName);
        return;
      }
      if (method === 'PATCH') {
        restPatchRepo(req, res, owner, repoName, parsedBody);
        return;
      }
      if (method === 'DELETE') {
        restDeleteRepo(req, res, owner, repoName);
        return;
      }
      restNotFound(res);
      return;
    }
    if (rest === 'branches' && method === 'GET') {
      restListBranches(req, res, owner, repoName);
      return;
    }
    const branchMatch = /^branches\/(.+)$/.exec(rest);
    if (branchMatch && method === 'GET') {
      restGetBranch(req, res, owner, repoName, decodeURIComponent(branchMatch[1]));
      return;
    }
    if (rest === 'commits' && method === 'GET') {
      restListCommits(req, res, owner, repoName, query);
      return;
    }
    if (rest === 'git/refs' && method === 'POST') {
      restCreateRef(req, res, owner, repoName, parsedBody);
      return;
    }
    const refMatch = /^git\/refs\/(.+)$/.exec(rest);
    if (refMatch && method === 'GET') {
      restGetRef(req, res, owner, repoName, refMatch[1]);
      return;
    }
    const contentsMatch = /^contents\/(.+)$/.exec(rest);
    if (contentsMatch) {
      if (method === 'GET') {
        restGetContents(req, res, owner, repoName, contentsMatch[1], query);
        return;
      }
      if (method === 'PUT') {
        restPutContents(req, res, owner, repoName, contentsMatch[1], parsedBody);
        return;
      }
      if (method === 'DELETE') {
        restDeleteContents(req, res, owner, repoName, contentsMatch[1], parsedBody);
        return;
      }
      restNotFound(res);
      return;
    }
    if (rest === 'labels') {
      if (method === 'POST') {
        restCreateLabel(req, res, owner, repoName, parsedBody);
        return;
      }
      if (method === 'GET') {
        restListLabels(req, res, owner, repoName);
        return;
      }
      restNotFound(res);
      return;
    }
    if (rest === 'issues') {
      if (method === 'POST') {
        restCreateIssue(req, res, owner, repoName, parsedBody);
        return;
      }
      if (method === 'GET') {
        restListIssues(req, res, owner, repoName, query);
        return;
      }
      restNotFound(res);
      return;
    }
    const issueMatch = /^issues\/(\d+)$/.exec(rest);
    if (issueMatch) {
      const number = Number.parseInt(issueMatch[1], 10);
      if (method === 'GET') {
        restGetIssue(req, res, owner, repoName, number);
        return;
      }
      if (method === 'PATCH') {
        restPatchIssue(req, res, owner, repoName, number, parsedBody);
        return;
      }
      restNotFound(res);
      return;
    }
    const commentMatch = /^issues\/(\d+)\/comments$/.exec(rest);
    if (commentMatch) {
      const number = Number.parseInt(commentMatch[1], 10);
      if (method === 'POST') {
        restCreateComment(req, res, owner, repoName, number, parsedBody);
        return;
      }
      if (method === 'GET') {
        restListComments(req, res, owner, repoName, number);
        return;
      }
      restNotFound(res);
      return;
    }
    if (rest === 'pulls') {
      if (method === 'POST') {
        restCreatePull(req, res, owner, repoName, parsedBody);
        return;
      }
      if (method === 'GET') {
        restListPulls(req, res, owner, repoName, query);
        return;
      }
      restNotFound(res);
      return;
    }
    const pullMatch = /^pulls\/(\d+)$/.exec(rest);
    if (pullMatch) {
      const number = Number.parseInt(pullMatch[1], 10);
      if (method === 'GET') {
        restGetPull(req, res, owner, repoName, number);
        return;
      }
      restNotFound(res);
      return;
    }
    const pullFilesMatch = /^pulls\/(\d+)\/files$/.exec(rest);
    if (pullFilesMatch && method === 'GET') {
      restListPullFiles(req, res, owner, repoName, Number.parseInt(pullFilesMatch[1], 10));
      return;
    }
    const pullMergeMatch = /^pulls\/(\d+)\/merge$/.exec(rest);
    if (pullMergeMatch && method === 'PUT') {
      restMergePull(req, res, owner, repoName, Number.parseInt(pullMergeMatch[1], 10));
      return;
    }
    restNotFound(res);
    return;
  }

  restNotFound(res);
}

// ---------------------------------------------------------------------------
// Lifecycle: register with the harness env, wait for "done", then exit.
// ---------------------------------------------------------------------------

async function postJson(url: string, value: unknown): Promise<unknown> {
  const body = jsonBody(value);
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body,
  });
  const text = await response.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function waitForDone(envUrl: string): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${envUrl}/done`);
      const data = (await response.json()) as { done?: boolean };
      if (data.done) return;
    } catch {
      // The harness may not be ready yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // eslint-disable-next-line no-console
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'Internal Server Error');
      else res.end();
    });
  });
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (envUrl) {
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    await postJson(`${envUrl}/register`, { port });
    await waitForDone(envUrl);
    server.close();
    process.exit(0);
  }
  const port = Number.parseInt(process.env.PORT ?? '8787', 10);
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });
  // eslint-disable-next-line no-console
  console.log(`forge listening on http://127.0.0.1:${port} as ${VIEWER_LOGIN}`);
}

void main();
