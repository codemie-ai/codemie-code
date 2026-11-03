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
  /** User-authored prompt text on this row, if any: every text block, so no id is missed. */
  prompt?: string;
  /**
   * The same prompt as CodeMie records it — its first text block only (claude.metrics-processor.ts)
   * — so a prompt seen in both CodeMie's deltas and the native log is recognised as one.
   */
  promptKey?: string;
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
  isMeta?: boolean;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
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

/**
 * Wrappers Claude Code puts around text the user did not type: slash-command plumbing, local
 * command output and injected reminders. `<command-args>` is kept — it is what the user typed
 * after the command.
 */
const INJECTED_BLOCKS = /<(command-name|command-message|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder)>[\s\S]*?<\/\1>/gi;

/**
 * Prompt text with injected wrappers removed and whitespace collapsed. Applied to native rows and
 * to CodeMie-recorded prompts alike, so the same prompt seen in both is recognised as one.
 */
export function normalizePromptText(text: string): string {
  return text.replace(INJECTED_BLOCKS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Text the user actually typed on a Claude row. Same notion of a genuine user turn as
 * `countTurns` (claude-code-otlp/transcript/session-signals.ts): meta rows (injected skills,
 * attachments), sidechain rows and compaction summaries are not prompts, and neither are rows
 * holding only tool results.
 */
function claudeUserText(row: ClaudeRow): { text: string; key: string } {
  if ((row.message?.role ?? row.type) !== 'user' || row.isMeta || row.isSidechain || row.isCompactSummary) return { text: '', key: '' };
  const content = row.message?.content;
  if (typeof content === 'string') {
    const text = normalizePromptText(content);
    return { text, key: text };
  }
  if (!Array.isArray(content)) return { text: '', key: '' };
  const blocks = content
    .filter((block): block is { type: string; text: string } => block?.type === 'text' && typeof block.text === 'string' && !!block.text)
    .map((block) => block.text);
  return { text: normalizePromptText(blocks.join('\n')), key: normalizePromptText(blocks[0] ?? '') };
}

function claudeRows(parsed: ParsedSession): NativeRow[] {
  const rows: NativeRow[] = [];
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as ClaudeRow[]) {
    if (!row || typeof row !== 'object') continue;
    const { text: prompt, key: promptKey } = claudeUserText(row);
    const branch = typeof row.gitBranch === 'string' && row.gitBranch ? row.gitBranch : undefined;
    if (!prompt && !branch) continue;
    rows.push({
      key: typeof row.uuid === 'string' && row.uuid ? `claude:${row.uuid}` : null,
      ts: toMs(row.timestamp),
      ...(prompt && { prompt, promptKey: promptKey || prompt }),
      ...(branch && { branch }),
    });
  }
  return rows;
}

function codexRows(parsed: ParsedSession): NativeRow[] {
  const rows: NativeRow[] = [];
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as CodexRow[]) {
    if (row?.type !== 'event_msg' || row.payload?.type !== 'user_message') continue;
    const raw = row.payload.message?.trim();
    if (!raw || isCodexInjectedUserText(raw)) continue;
    const prompt = normalizePromptText(raw);
    if (!prompt) continue;
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
