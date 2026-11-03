/**
 * Per-agent tool-call readers for ticket extraction. Each reader returns the tool calls found in
 * a parsed native log — the main transcript AND every linked transcript in `parsed.subagents`, so
 * a call a subagent made counts for the session that dispatched it.
 *
 * Mirrors the agent switch in `readUsageByModel` (cost/usage-readers.ts): adding an agent is one
 * new case here. Agents without a reader yield no calls, so the `tool` source is simply empty.
 */

import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import { isCodexFamilyAgent } from '../cost/codex-agent.js';

export interface ToolCall {
  /** Stable call id (Claude `tool_use.id`, Codex `call_id`); null when the log has none. */
  id: string | null;
  name: string;
  /**
   * Names the tool patterns are matched against: the logged name, plus for Codex the
   * `mcp__`-prefixed form of a `server__tool` name, so the default `mcp__*` patterns cover MCP
   * tools whichever form a Codex version logs.
   */
  matchNames: string[];
  /** Parsed call arguments; for Codex, the JSON-decoded `arguments` string (undefined if not JSON). */
  input: unknown;
  /** Epoch ms of the row carrying the call; null when untimed. */
  ts: number | null;
}

interface ClaudeRow {
  timestamp?: string;
  message?: { content?: unknown };
}

interface CodexRow {
  timestamp?: string;
  type?: string;
  payload?: { type?: string; name?: string; arguments?: unknown; call_id?: string };
}

function toMs(timestamp: string | undefined): number | null {
  const ms = timestamp ? Date.parse(timestamp) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** The session's message arrays: main transcript first, then every linked transcript. */
function transcripts(parsed: ParsedSession): unknown[][] {
  const out: unknown[][] = [Array.isArray(parsed.messages) ? parsed.messages : []];
  for (const sub of parsed.subagents ?? []) {
    if (Array.isArray(sub.messages)) out.push(sub.messages);
  }
  return out;
}

function readClaudeToolCalls(parsed: ParsedSession): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const messages of transcripts(parsed)) {
    for (const row of messages as ClaudeRow[]) {
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      const ts = toMs(row.timestamp);
      for (const block of content as Array<{ type?: string; id?: string; name?: string; input?: unknown }>) {
        if (block?.type !== 'tool_use' || typeof block.name !== 'string' || !block.name) continue;
        calls.push({ id: typeof block.id === 'string' && block.id ? block.id : null, name: block.name, matchNames: [block.name], input: block.input, ts });
      }
    }
  }
  return calls;
}

function decodeArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function codexMatchNames(name: string): string[] {
  return name.includes('__') && !name.toLowerCase().startsWith('mcp__') ? [name, `mcp__${name}`] : [name];
}

function readCodexToolCalls(parsed: ParsedSession): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const messages of transcripts(parsed)) {
    for (const row of messages as CodexRow[]) {
      const payload = row?.payload;
      if (row?.type !== 'response_item' || payload?.type !== 'function_call') continue;
      if (typeof payload.name !== 'string' || !payload.name) continue;
      calls.push({
        id: typeof payload.call_id === 'string' && payload.call_id ? payload.call_id : null,
        name: payload.name,
        matchNames: codexMatchNames(payload.name),
        input: decodeArguments(payload.arguments),
        ts: toMs(row.timestamp),
      });
    }
  }
  return calls;
}

export function readToolCalls(agentName: string, parsed: ParsedSession): ToolCall[] {
  switch (agentName.toLowerCase()) {
    case 'claude':
    case 'claude-acp':
    case 'claude-desktop':
      return readClaudeToolCalls(parsed);
    default:
      return isCodexFamilyAgent(agentName) ? readCodexToolCalls(parsed) : [];
  }
}
