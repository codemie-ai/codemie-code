/**
 * Persistent, advisory index of the skill-fork evidence found in subagent transcripts
 * (EPMCDME-16391): for each source file, the `Agent`/`Task`/`Skill` tool calls (id, name, prompt,
 * skill) and their results (named agent, error) found in its complete lines up to `offset`.
 *
 * `fork-skill.ts` correlates a subagent with its starting call by reading every subagent transcript
 * (a parent may hold the call of a child), on every hook. Hooks are separate processes, so this index
 * lets an unchanged source file be validated with ~1 KiB of reads and a changed one be read only from
 * its last complete-line boundary.
 *
 * Acceptance contract (append-only, stated, not proven by hashes): an entry is used only when
 *  - the file is the same file: device, inode and creation time are those recorded (an atomic
 *    replacement by rename, or delete + create, is a different file);
 *  - it did not shrink: size >= the size recorded when the entry was built, and when the size is
 *    exactly that size the modification time is unchanged too (an in-place rewrite without growth);
 *  - it was built from the same starting prompt, and the hashes of the first 1 KiB and of the 256
 *    bytes before the indexed offset still match (a tripwire for rewrites, NOT proof that the middle of a
 *    grown file is unchanged: a same-inode in-place rewrite of old bytes followed by growth cannot be
 *    detected without reading the whole file, and transcripts are append-only);
 *  - its shape is valid (types, bounds).
 * Anything else (replaced, truncated, missing, unreadable, different start prompt, malformed or oversized
 * cache) is a plain full read. A file that changed while it was being read is not indexed. The index
 * never carries "absence": it holds only evidence that was seen, and absence is always derived from the
 * whole set. The file is a cache, never state the analytics depend on: written atomically without a
 * lock (each entry validates itself, so a lost update only costs a re-read).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

const FORMAT = 1;
const HEAD_HASH_BYTES = 1024;
const TAIL_HASH_BYTES = 256;

/** Most keys (calls + results + other tool ids) one file's entry may hold; beyond it the file is read in full. */
export const MAX_INDEXED_KEYS = 50_000;

export interface FileEvidence {
  /** `dev:ino:birthtime` of the file the entry was built from. */
  id: string;
  /** Size of the file when the entry was last extended, and its modification time then. */
  size0: number;
  mtimeNs: string;
  /** Byte offset just after the last complete line that was indexed. */
  offset: number;
  headLen: number;
  headHash: string;
  tailHash: string;
  /** The prompt the scan started from (the file's own first `promptId`). */
  start: string;
  /** The prompt in force at `offset` (carried across appends). */
  prompt: string;
  calls: Record<string, { n: string; p: string; s?: string }>;
  /** Observed results by tool id (any id whose call is not known to be another tool's in this file). */
  results: Record<string, { a: string; e?: 1 }>;
  /** Ids of calls of every other tool: a `.meta.json` tool id is "seen" if any tool_use has it. */
  others: string[];
}

export interface Identity {
  id: string;
  size: number;
  mtimeNs: string;
}

export function identityOf(st: BigIntStats): Identity {
  return { id: `${st.dev}:${st.ino}:${st.birthtimeNs}`, size: Number(st.size), mtimeNs: String(st.mtimeNs) };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Shape and bounds of an entry read from disk; anything doubtful is treated as absent. */
export function isValidEntry(e: unknown): e is FileEvidence {
  if (!e || typeof e !== 'object') return false;
  const v = e as Record<string, unknown>;
  if (!isStr(v.id) || !isCount(v.size0) || !isStr(v.mtimeNs) || !isCount(v.offset) || v.offset > v.size0) return false;
  if (!isCount(v.headLen) || v.headLen > HEAD_HASH_BYTES || !isStr(v.headHash) || !isStr(v.tailHash)) return false;
  if (!isStr(v.start) || !isStr(v.prompt)) return false;
  const { calls, results, others } = v;
  if (!calls || typeof calls !== 'object' || Array.isArray(calls)) return false;
  if (!results || typeof results !== 'object' || Array.isArray(results)) return false;
  if (!Array.isArray(others) || !others.every(isStr)) return false;
  const callKeys = Object.keys(calls);
  const resultKeys = Object.keys(results);
  if (callKeys.length + resultKeys.length + others.length > MAX_INDEXED_KEYS) return false;
  if (callKeys.includes('__proto__') || resultKeys.includes('__proto__')) return false;
  for (const c of Object.values(calls)) {
    const call = c as Record<string, unknown> | null;
    if (!call || !isStr(call.n) || !isStr(call.p) || (call.s !== undefined && !isStr(call.s))) return false;
  }
  for (const r of Object.values(results)) {
    const res = r as Record<string, unknown> | null;
    if (!res || !isStr(res.a) || (res.e !== undefined && res.e !== 1)) return false;
  }
  return true;
}

export class EvidenceCache {
  private files: Record<string, FileEvidence> = {};
  private loaded = false;
  private dirty = false;

  constructor(private readonly path: string) {}

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf-8')) as { v?: number; files?: Record<string, FileEvidence> };
      if (parsed.v === FORMAT && parsed.files && typeof parsed.files === 'object') this.files = parsed.files;
    } catch {
      // absent or malformed: start empty
    }
  }

  async get(filePath: string): Promise<FileEvidence | undefined> {
    await this.ensureLoaded();
    return Object.hasOwn(this.files, filePath) ? this.files[filePath] : undefined;
  }

  set(filePath: string, evidence: FileEvidence): void {
    this.files[filePath] = evidence;
    this.dirty = true;
  }

  drop(filePath: string): void {
    if (Object.hasOwn(this.files, filePath)) {
      delete this.files[filePath];
      this.dirty = true;
    }
  }

  /** Best effort; never throws. */
  async save(): Promise<void> {
    if (!this.dirty) return;
    try {
      await mkdir(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify({ v: FORMAT, files: this.files }), 'utf-8');
      await rename(tmp, this.path);
      this.dirty = false;
    } catch {
      // a cache that cannot be written is only slower
    }
  }
}

/** The index of a main transcript's session (same session-id convention as subagent discovery). */
export function evidenceCacheFor(mainTranscriptPath: string): EvidenceCache {
  const sessionId = basename(mainTranscriptPath).replace(/\.jsonl$/, '');
  return new EvidenceCache(getCodemiePath('analytics', 'state', `${sessionId}.evidence.json`));
}

const sha = (bytes: Buffer): string => createHash('sha1').update(bytes).digest('hex');

export async function readRange(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

export function emptyEvidence(start: string): FileEvidence {
  return { id: '', size0: 0, mtimeNs: '', offset: 0, headLen: 0, headHash: '', tailHash: '', start, prompt: start, calls: {}, results: {}, others: [] };
}

/** Whether `evidence` may be extended for the open file whose current identity is `now` (contract above). */
export async function evidenceStillValid(handle: FileHandle, evidence: FileEvidence, now: Identity): Promise<boolean> {
  if (evidence.offset === 0) return true;
  if (evidence.id !== now.id || now.size < evidence.size0) return false;
  if (now.size === evidence.size0 && now.mtimeNs !== evidence.mtimeNs) return false;
  const head = await readRange(handle, 0, evidence.headLen);
  if (head.length !== evidence.headLen || sha(head) !== evidence.headHash) return false;
  const tailLen = Math.min(TAIL_HASH_BYTES, evidence.offset);
  const tail = await readRange(handle, evidence.offset - tailLen, tailLen);
  return tail.length === tailLen && sha(tail) === evidence.tailHash;
}

/** Record the hashes for `evidence.offset` (already advanced); `fresh` holds the bytes read from the old offset. */
export async function sealEvidence(
  handle: FileHandle,
  evidence: FileEvidence,
  fresh: Buffer,
  previousOffset: number
): Promise<void> {
  if (evidence.headLen === 0 && evidence.offset > 0) {
    const headLen = Math.min(HEAD_HASH_BYTES, evidence.offset);
    const head = previousOffset === 0 ? fresh.subarray(0, headLen) : await readRange(handle, 0, headLen);
    evidence.headLen = head.length;
    evidence.headHash = sha(head);
  }
  const tailLen = Math.min(TAIL_HASH_BYTES, evidence.offset);
  const tail = fresh.length >= tailLen ? fresh.subarray(fresh.length - tailLen) : await readRange(handle, evidence.offset - tailLen, tailLen);
  evidence.tailHash = sha(tail);
}
