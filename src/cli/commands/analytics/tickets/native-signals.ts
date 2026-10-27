/**
 * Every user prompt and every branch recorded in a parsed native log. The delta path only carries
 * a native session's opening prompt and one modal branch (native-loader.ts); reading the log here
 * gives native sessions the same coverage as CodeMie-tracked ones.
 *
 * Output stays inside the ticket pass: callers derive ids from it and discard the text.
 */

import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { isCodexInjectedUserText } from '@/agents/plugins/codex/session/codex-user-prompt.js';
import { isCodexFamilyAgent } from '../cost/codex-agent.js';

export interface NativePrompt {
  /** Row id when the log has one (Claude `uuid`), used to drop prompts replayed into a later session. */
  key: string | null;
  text: string;
  ts: number | null;
}

export interface NativeSignals {
  prompts: NativePrompt[];
  branches: string[];
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

function claudeSignals(parsed: ParsedSession): NativeSignals {
  const prompts: NativePrompt[] = [];
  const branches = new Set<string>();
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as ClaudeRow[]) {
    if (!row || typeof row !== 'object') continue;
    if (typeof row.gitBranch === 'string' && row.gitBranch) branches.add(row.gitBranch);
    const text = claudeUserText(row);
    if (text.trim()) prompts.push({ key: typeof row.uuid === 'string' && row.uuid ? row.uuid : null, text, ts: toMs(row.timestamp) });
  }
  return { prompts, branches: [...branches] };
}

function codexSignals(parsed: ParsedSession): NativeSignals {
  const prompts: NativePrompt[] = [];
  for (const row of (Array.isArray(parsed.messages) ? parsed.messages : []) as CodexRow[]) {
    if (row?.type !== 'event_msg' || row.payload?.type !== 'user_message') continue;
    const text = row.payload.message?.trim();
    if (text && !isCodexInjectedUserText(text)) prompts.push({ key: null, text, ts: toMs(row.timestamp) });
  }
  return { prompts, branches: [] };
}

export function readNativeSignals(agentName: string, parsed: ParsedSession): NativeSignals {
  const metadataBranches = [parsed.metadata?.gitBranch, parsed.metadata?.branch].filter((b): b is string => typeof b === 'string' && !!b);
  let signals: NativeSignals;
  switch (agentName.toLowerCase()) {
    case 'claude':
    case 'claude-acp':
    case 'claude-desktop':
      signals = claudeSignals(parsed);
      break;
    default:
      signals = isCodexFamilyAgent(agentName) ? codexSignals(parsed) : { prompts: [], branches: [] };
  }
  return { prompts: signals.prompts, branches: [...new Set([...signals.branches, ...metadataBranches])] };
}
