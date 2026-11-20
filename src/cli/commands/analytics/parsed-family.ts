/**
 * One report run's parsed view of a native session, kept small.
 *
 * Native transcripts (Claude with its sub-agents, long Codex rollouts, Pi fork families) reach
 * gigabytes, so a report cannot hold every parsed family from discovery to cost enrichment.
 * Instead it keeps a recipe: each transcript's path and the byte lengths it was parsed from.
 * Replaying the recipe re-reads exactly that input, so a live transcript that grows during the
 * run still gives aggregation, cost series and dispatch details the same data (#559, AC 9).
 */

import { basename } from 'node:path';
import type { ParsedSession } from '../../../agents/core/session/BaseSessionAdapter.js';
import {
  recordJSONLSnapshot,
  replayJSONLSnapshot,
  type JSONLSnapshot,
} from '../../../agents/core/session/utils/jsonl-reader.js';
import { PI_FORKED_CONTINUATION } from '../../../agents/plugins/pi/pi.session.js';

/** Parses one native transcript; the loader's and the cost enricher's adapters both fit it. */
export type TranscriptParse = (agentName: string, filePath: string, sessionId: string) => Promise<ParsedSession | null>;

/** One transcript of a family and the input it was parsed from. */
export interface TranscriptPart {
  /** The agent name the transcript was parsed with (selects the adapter). */
  agentName: string;
  /** The path it was read under; the snapshot is keyed by the paths read beneath it. */
  filePath: string;
  sessionId: string;
  snapshot: JSONLSnapshot;
}

/** A Pi `/fork` continuation folded into its root, with the symlink-free path that names it. */
export interface PiForkPart extends TranscriptPart {
  realPath: string;
}

/** How to rebuild a session's parsed family: its own transcript, then the Pi forks folded into it. */
export interface FamilyRecipe {
  root: TranscriptPart;
  piForks?: PiForkPart[];
}

/** A parse and, when every transcript it read can be replayed, the input it read. */
export interface RecordedParse {
  parsed: ParsedSession | null;
  snapshot?: JSONLSnapshot;
}

/**
 * Parse a transcript, recording what it read. A parse that read nothing through the snapshot
 * readers (a whole-file JSON chat, a SQLite store) has no snapshot: its result must be kept.
 */
export async function recordParse(
  parse: TranscriptParse,
  agentName: string,
  filePath: string,
  sessionId: string
): Promise<RecordedParse> {
  const { result, snapshot } = await recordJSONLSnapshot(() => parse(agentName, filePath, sessionId));
  return snapshot.size > 0 ? { parsed: result, snapshot } : { parsed: result };
}

/** Parse `part` again from exactly the input it was recorded with; incomplete when that input is gone. */
export function replayPart(parse: TranscriptParse, part: TranscriptPart): Promise<{ result: ParsedSession | null; complete: boolean }> {
  return replayJSONLSnapshot(part.snapshot, () => parse(part.agentName, part.filePath, part.sessionId));
}

/**
 * Fold a Pi `/fork` continuation into the transcript it grew out of, as a sub-agent of that
 * root, so its spend is counted once, inside the session it continues.
 */
export function appendPiForkedContinuation(root: ParsedSession, realPath: string, fork: ParsedSession): void {
  root.subagents = [
    ...(root.subagents ?? []),
    {
      agentId: basename(realPath, '.jsonl'),
      filePath: realPath,
      agentType: PI_FORKED_CONTINUATION,
      messages: fork.messages ?? [],
    },
  ];
}

/**
 * Rebuild a session's parsed family from its recipe. Null when it cannot be rebuilt as
 * discovered: its own transcript no longer parses, or any file of the family was removed or
 * truncated since. Pricing what is left would understate the session.
 */
export async function replayFamily(parse: TranscriptParse, recipe: FamilyRecipe): Promise<ParsedSession | null> {
  const root = await replayPart(parse, recipe.root);
  if (!root.complete || !root.result) return null;
  for (const fork of recipe.piForks ?? []) {
    const parsed = await replayPart(parse, fork);
    if (!parsed.complete) return null;
    if (parsed.result) appendPiForkedContinuation(root.result, fork.realPath, parsed.result);
  }
  return root.result;
}
