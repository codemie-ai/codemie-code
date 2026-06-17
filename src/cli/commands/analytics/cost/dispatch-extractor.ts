/**
 * Per-session dispatch-timeline extraction.
 *
 * Walks a parsed native session and pairs each TOP-LEVEL agent/skill `tool_use` with its
 * matching `tool_result` (by `tool_use_id`) to recover when each invocation ran and how long
 * it took. Slash commands are point events (no duration). Sub-agent (sidechain) dispatches are
 * skipped so a parent's bar never visually contains its children.
 *
 * Note: this recovers *timing*, not per-agent cost — in the CodeMie CLI sub-agents run as
 * separate sessions (their tokens are not in the parent log), so cost-by-agent is a separate
 * cross-session correlation concern.
 */

import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from './types.js';
import { MAX_DISPATCHES } from './types.js';

interface RawBlock {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: {
    skill?: unknown;
    subagent_type?: unknown;
    name?: unknown;
    description?: unknown;
  };
  text?: unknown;
}
interface RawMsg {
  isSidechain?: boolean;
  timestamp?: string;
  message?: { role?: string; content?: unknown };
}

const COMMAND_TAG = /<command-name>([^<]+)<\/command-name>/g;

/** Extract timed top-level dispatches (agents/skills) + command point events, sorted by start. */
export function extractDispatchEvents(parsed: ParsedSession): DispatchEventRaw[] {
  const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
  const pending = new Map<string, { kind: 'agent' | 'skill'; name: string; start: number; toolUseId?: string }>();
  const events: DispatchEventRaw[] = [];

  const scanCommands = (text: string, at: number): void => {
    if (!text.includes('<command-message>')) {
      return;
    }
    COMMAND_TAG.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = COMMAND_TAG.exec(text)) !== null) {
      const cmd = m[1].replace(/^\//, '').trim();
      if (cmd) {
        events.push({ kind: 'command', name: cmd, start: at, durationMs: 0 });
      }
    }
  };

  for (const raw of messages as RawMsg[]) {
    if (raw?.isSidechain === true) {
      continue; // only top-level dispatches — skip nested sub-agent invocations
    }
    const parsedTs = raw?.timestamp ? Date.parse(raw.timestamp) : NaN;
    const ts = Number.isFinite(parsedTs) ? parsedTs : null;
    const content = raw?.message?.content;
    const isUser = raw?.message?.role === 'user';

    if (typeof content === 'string') {
      if (isUser && ts != null) {
        scanCommands(content, ts);
      }
      continue;
    }
    if (!Array.isArray(content)) {
      continue;
    }

    for (const b of content as RawBlock[]) {
      if (b?.type === 'tool_use' && ts != null && b.id) {
        if (b.name === 'Agent' || b.name === 'Task') {
          const agentName = [b.input?.subagent_type, b.input?.name]
            .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
          pending.set(b.id, { kind: 'agent', name: agentName?.trim() ?? 'agent', start: ts, toolUseId: b.id });
        } else if (b.name === 'Skill' && typeof b.input?.skill === 'string') {
          pending.set(b.id, { kind: 'skill', name: b.input.skill.trim() || 'skill', start: ts });
        }
      } else if (b?.type === 'tool_result' && b.tool_use_id && pending.has(b.tool_use_id)) {
        const p = pending.get(b.tool_use_id)!;
        pending.delete(b.tool_use_id);
        events.push({ kind: p.kind, name: p.name, start: p.start, durationMs: ts != null ? Math.max(0, ts - p.start) : 0, _toolUseId: p.kind === 'agent' ? p.toolUseId : undefined });
      } else if (isUser && b?.type === 'text' && typeof b.text === 'string' && ts != null) {
        scanCommands(b.text, ts);
      }
    }
  }

  // Dispatches whose tool_result never appeared (truncated/streaming log) → 0-duration markers.
  for (const p of pending.values()) {
    events.push({ kind: p.kind, name: p.name, start: p.start, durationMs: 0, _toolUseId: p.kind === 'agent' ? p.toolUseId : undefined });
  }

  events.sort((a, b) => a.start - b.start);
  return events.slice(0, MAX_DISPATCHES);
}
