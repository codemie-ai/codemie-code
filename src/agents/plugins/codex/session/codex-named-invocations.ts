/**
 * Shared Codex named-invocation extraction.
 *
 * Pulls skill, agent, and command names from Codex rollout JSONL records. Used by
 * parse-time `extractMetrics` and analytics re-parse so native (untracked) sessions
 * match live-tracked invocation charts.
 *
 * - Skills: `exec_command` whose args reference `.../skills/{name}/SKILL.md`
 * - Agents: `spawn_agent` function_call → `agent_type` in JSON arguments
 * - Commands: Codex `$skill-name` user messages (optional slash-style `/name` in short prompts)
 */

import type { NamedInvocationCounts } from '../../claude/session/claude-named-invocations.js';

export type { NamedInvocationCounts };

interface CodexRecord {
  type?: string;
  payload?: {
    type?: string;
    name?: string;
    arguments?: string;
    message?: string;
    call_id?: string;
    new_agent_role?: string;
  };
}

const SKILL_PATH = /\/skills\/([^/]+)\/SKILL\.md/i;
// Command invocations: `$name` or `/name` at the very start of a SHORT user prompt, with the token
// terminated by whitespace or end-of-string. Lowercase-initial only, so shell variables ($HOME,
// $PATH) and absolute paths (/usr/local/bin/...) are not mistaken for commands.
const DOLLAR_SKILL = /^\$([a-z][\w-]*)(?:\s|$)/;
const SLASH_CMD = /^\/([a-z][\w-]*)(?:\s|$)/;

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] || 0) + 1;
}

export function skillFromExecArgs(argsJson: string | undefined): string | undefined {
  if (!argsJson) {
    return undefined;
  }
  try {
    const args = JSON.parse(argsJson) as { cmd?: string };
    const cmd = typeof args.cmd === 'string' ? args.cmd : '';
    const match = SKILL_PATH.exec(cmd);
    return match?.[1]?.trim() || undefined;
  } catch {
    const match = SKILL_PATH.exec(argsJson);
    return match?.[1]?.trim() || undefined;
  }
}

function agentFromSpawnArgs(argsJson: string | undefined): string | undefined {
  if (!argsJson) {
    return undefined;
  }
  try {
    const args = JSON.parse(argsJson) as { agent_type?: string };
    const agentType = args.agent_type?.trim();
    return agentType || undefined;
  } catch {
    return undefined;
  }
}

function scanUserMessage(text: string, commandInvocations: Record<string, number>): void {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length >= 120) {
    return; // command invocations are short prompts; longer text is prose, not a command
  }
  const dollar = DOLLAR_SKILL.exec(trimmed);
  if (dollar?.[1]) {
    bump(commandInvocations, dollar[1]);
    return;
  }
  const slash = SLASH_CMD.exec(trimmed);
  if (slash?.[1]) {
    bump(commandInvocations, slash[1]);
  }
}

/** Extract skill / agent / command name counts from Codex rollout records. */
export function extractCodexNamedInvocations(records: readonly unknown[]): NamedInvocationCounts {
  const skillInvocations: Record<string, number> = {};
  const agentInvocations: Record<string, number> = {};
  const commandInvocations: Record<string, number> = {};
  const countedSpawnCallIds = new Set<string>();

  for (const raw of records) {
    const rec = raw as CodexRecord;

    if (rec.type === 'response_item') {
      const p = rec.payload;
      if (p?.type === 'function_call' && p.name === 'spawn_agent') {
        const agent = agentFromSpawnArgs(p.arguments) ?? p.new_agent_role?.trim();
        if (agent) {
          bump(agentInvocations, agent);
          if (p.call_id) {
            countedSpawnCallIds.add(p.call_id);
          }
        }
      } else if (p?.type === 'function_call' && p.name === 'exec_command') {
        const skill = skillFromExecArgs(p.arguments);
        if (skill) {
          bump(skillInvocations, skill);
        }
      }
    } else if (rec.type === 'event_msg' && rec.payload?.type === 'user_message') {
      const msg = rec.payload.message;
      if (typeof msg === 'string') {
        scanUserMessage(msg, commandInvocations);
      }
    } else if (rec.type === 'event_msg' && rec.payload?.type === 'collab_agent_spawn_end') {
      // Count the role here only when the matching spawn_agent did not already contribute a name
      // (older rollouts, or spawn_agent args without agent_type). Tracking counted call_ids avoids
      // both the missed count and an O(n^2) rescan of every record per spawn-end.
      const role = rec.payload.new_agent_role?.trim();
      const callId = rec.payload.call_id;
      if (role && (!callId || !countedSpawnCallIds.has(callId))) {
        bump(agentInvocations, role);
        if (callId) {
          countedSpawnCallIds.add(callId);
        }
      }
    }
  }

  return { skillInvocations, agentInvocations, commandInvocations };
}
