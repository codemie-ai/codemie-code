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
 * Acceptance: an entry is used only when the file still has at least `offset` bytes, the hash of its
 * first bytes and of the bytes just before `offset` are unchanged, and it was built from the same
 * starting prompt. Anything else (truncated, replaced, missing, unreadable, different start prompt,
 * malformed cache) is a plain full read; the index never carries "absence": it holds only evidence
 * that was seen, and absence is always derived from the whole set. The file is a cache, never state
 * the analytics depend on: written atomically without a lock (each entry validates itself, so a lost
 * update only costs a re-read).
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

const FORMAT = 1;
const HEAD_HASH_BYTES = 1024;
const TAIL_HASH_BYTES = 256;

export interface FileEvidence {
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
  results: Record<string, { a: string; e?: 1 }>;
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
  return { offset: 0, headLen: 0, headHash: '', tailHash: '', start, prompt: start, calls: {}, results: {} };
}

/** Whether `evidence` still describes the first `evidence.offset` bytes of the open file. */
export async function evidenceStillValid(handle: FileHandle, evidence: FileEvidence, size: number): Promise<boolean> {
  if (evidence.offset === 0) return true;
  if (size < evidence.offset) return false;
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
