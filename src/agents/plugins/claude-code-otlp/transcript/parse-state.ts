/**
 * Transcript parse-state persistence.
 *
 * Transcript parsing is incremental: each parse pass picks up where the previous one
 * left off (byte offsets into the main transcript and per-subagent transcripts),
 * tracks usage requests opened but not yet closed by their matching response, the
 * currently active skill, and per-branch request counts. This module persists that
 * state to disk between parse passes, keyed by session id.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getCodemiePath } from '@/utils/paths.js';

export interface OpenUsageRequest {
  requestId: string;
  model: string;
  modelRaw: string;
  timestamp: string;
  speed: string;
  inferenceGeo: string;
  serviceTier: string;
  inputTokens: number;
  cacheCreation5mTokens: number;
  cacheCreation1hTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  webSearchRequests: number;
  webFetchRequests: number;
  scopeKind: 'main' | 'skill' | 'agent';
  scopeName: string;
  agentId: string;
  stopReason: string;
  isApiError: boolean;
  gitBranch: string;
}

export interface TranscriptParseState {
  mainOffset: number;
  subagentOffsets: Record<string, number>;
  openRequests: Record<string, OpenUsageRequest>; // key: `${requestId}::${model}`
  activeSkill: string;
  branchCounts: Record<string, number>;
}

/**
 * Build a fresh, empty parse state.
 */
export function createParseState(): TranscriptParseState {
  return {
    mainOffset: 0,
    subagentOffsets: {},
    openRequests: {},
    activeSkill: '',
    branchCounts: {},
  };
}

function getParseStatePath(sessionId: string): string {
  return getCodemiePath('analytics', 'state', `${sessionId}.json`);
}

/**
 * Load the persisted parse state for a session.
 *
 * Never throws: a missing file, malformed JSON, or any other I/O failure all fall
 * back to a fresh state via {@link createParseState}, since transcript parsing must
 * keep going (as if starting fresh) rather than fail the whole run over stale/corrupt
 * state on disk.
 */
export async function loadParseState(sessionId: string): Promise<TranscriptParseState> {
  try {
    const raw = await readFile(getParseStatePath(sessionId), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<TranscriptParseState>;

    return {
      mainOffset: parsed.mainOffset ?? 0,
      subagentOffsets: parsed.subagentOffsets ?? {},
      openRequests: parsed.openRequests ?? {},
      activeSkill: parsed.activeSkill ?? '',
      branchCounts: parsed.branchCounts ?? {},
    };
  } catch {
    return createParseState();
  }
}

/**
 * Persist parse state for a session, creating the parent directory if needed.
 *
 * Unlike {@link loadParseState}, this does not swallow errors — a genuine write
 * failure (disk full, permissions) propagates to the caller rather than silently
 * discarding progress.
 */
export async function saveParseState(sessionId: string, state: TranscriptParseState): Promise<void> {
  const filePath = getParseStatePath(sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(state, null, 2), 'utf-8');
}
