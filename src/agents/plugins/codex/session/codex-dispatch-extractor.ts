/**
 * Codex dispatch-timeline extraction.
 *
 * Agent bars: spawn_agent paired with wait_agent completion (function_call_output or
 * collab_waiting_end). Skill reads: exec_command paired with function_call_output or
 * exec_command_end by call_id.
 */

import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { DispatchEventRaw } from '../../../../cli/commands/analytics/cost/types.js';
import { MAX_DISPATCHES } from '../../../../cli/commands/analytics/cost/types.js';
import { extractCodexSpawnLinks } from './codex-collab-links.js';
import { skillFromExecArgs } from './codex-named-invocations.js';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
  };
}

function parseTs(raw: CodexLine): number | null {
  const n = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Extract timed agent dispatches + skill/command events from a Codex rollout. */
export function extractCodexDispatchEvents(parsed: ParsedSession): DispatchEventRaw[] {
  const messages = Array.isArray(parsed.messages) ? (parsed.messages as CodexLine[]) : [];
  const events: DispatchEventRaw[] = [];

  for (const link of extractCodexSpawnLinks(messages)) {
    events.push({
      kind: 'agent',
      name: link.agentType,
      start: link.spawnStart,
      durationMs: link.waitEnd != null ? Math.max(0, link.waitEnd - link.spawnStart) : 0,
      _toolUseId: link.spawnCallId,
    });
  }

  const pendingSkills = new Map<string, { name: string; start: number }>();

  for (const raw of messages) {
    const ts = parseTs(raw);
    if (raw.type !== 'response_item') {
      if (raw.type === 'event_msg' && raw.payload?.type === 'exec_command_end' && raw.payload.call_id) {
        const tsEnd = parseTs(raw);
        const skill = pendingSkills.get(raw.payload.call_id);
        if (skill && tsEnd != null) {
          pendingSkills.delete(raw.payload.call_id);
          events.push({
            kind: 'skill',
            name: skill.name,
            start: skill.start,
            durationMs: Math.max(0, tsEnd - skill.start),
          });
        }
      }
      continue;
    }

    const p = raw.payload;
    if (p?.type === 'function_call' && p.name === 'exec_command' && p.call_id && ts != null) {
      const skill = skillFromExecArgs(p.arguments);
      if (skill) {
        pendingSkills.set(p.call_id, { name: skill, start: ts });
      }
    } else if (p?.type === 'function_call_output' && p.call_id && ts != null) {
      const skill = pendingSkills.get(p.call_id);
      if (skill) {
        pendingSkills.delete(p.call_id);
        events.push({
          kind: 'skill',
          name: skill.name,
          start: skill.start,
          durationMs: Math.max(0, ts - skill.start),
        });
      }
    }
  }

  for (const skill of pendingSkills.values()) {
    events.push({ kind: 'skill', name: skill.name, start: skill.start, durationMs: 0 });
  }

  events.sort((a, b) => a.start - b.start);
  return events.slice(0, MAX_DISPATCHES);
}
