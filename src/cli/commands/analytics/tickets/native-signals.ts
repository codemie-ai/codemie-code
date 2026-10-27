/**
 * User prompts and branches recorded in a parsed native log, row by row. The delta path only
 * carries a native session's opening prompt and one modal branch (native-loader.ts); reading the
 * log here gives native sessions the same coverage as CodeMie-tracked ones.
 *
 * Rows are returned with a replay key so the collector can apply the earliest-session rule to
 * them: resumed and forked logs copy earlier rows — prompts and their `gitBranch` — verbatim.
 *
 * Output stays inside the ticket pass: callers derive ids from it and discard the text.
 */

import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { isCodexInjectedUserText } from '@/agents/plugins/codex/session/codex-user-prompt.js';
import { isCodexFamilyAgent } from '../cost/codex-agent.js';

export interface NativeRow {
  /**
   * Identifies the row across logs, so a copy replayed into a later session is recognised:
   * Claude's `uuid`; for Codex, which has no row id, the original timestamp plus the text.
   * Null when neither is available.
   */
  key: string | null;
  ts: number | null;
  /** User-authored prompt text on this row, if any. */
  prompt?: string;
  /** Branch recorded on this row, if any. */
  branch?: string;
}

export interface NativeSignals {
  rows: NativeRow[];
  /** Session-level branch from the log's metadata; not tied to a row, so never a replay. */
  metadataBranches: string[];
}

interface ClaudeRow {
  type?: string;
  uuid?: string;
  timestamp?: string;
  gitBranch?: string;
  message?: { role?: string; content?: unknown };
}

interface CodexRow {
  type?: string;
  timestamp?: string;
  payload?: { type?: string; message?: string };
}

function toMs(timestamp: string | undefined): number | null {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** User-authored text of a Claude row: string content or text blocks; tool results are not prompts. */
function claudeUserText(row: ClaudeRow): string {
  if ((row.message?.role ?? row.type) !== 'user') return '';
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block): block is { type: string; text: string } => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function claudeRows(parsed: ParsedSession): NativeRow[] {
  const rows: NativeRow[] = [];
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as ClaudeRow[]) {
    if (!row || typeof row !== 'object') continue;
    const prompt = claudeUserText(row);
    const branch = typeof row.gitBranch === 'string' && row.gitBranch ? row.gitBranch : undefined;
    if (!prompt.trim() && !branch) continue;
    rows.push({
      key: typeof row.uuid === 'string' && row.uuid ? `claude:${row.uuid}` : null,
      ts: toMs(row.timestamp),
      ...(prompt.trim() && { prompt }),
      ...(branch && { branch }),
    });
  }
  return rows;
}

function codexRows(parsed: ParsedSession): NativeRow[] {
  const rows: NativeRow[] = [];
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as CodexRow[]) {
    if (row?.type !== 'event_msg' || row.payload?.type !== 'user_message') continue;
    const prompt = row.payload.message?.trim();
    if (!prompt || isCodexInjectedUserText(prompt)) continue;
    const ts = toMs(row.timestamp);
    rows.push({ key: ts === null ? null : `codex:${ts}:${prompt}`, ts, prompt });
  }
  return rows;
}

export function readNativeSignals(agentName: string, parsed: ParsedSession): NativeSignals {
  const metadataBranches = [...new Set([parsed.metadata?.gitBranch, parsed.metadata?.branch].filter((b): b is string => typeof b === 'string' && !!b))];
  switch (agentName.toLowerCase()) {
    case 'claude':
    case 'claude-acp':
    case 'claude-desktop':
      return { rows: claudeRows(parsed), metadataBranches };
    default:
      return { rows: isCodexFamilyAgent(agentName) ? codexRows(parsed) : [], metadataBranches };
  }
}
