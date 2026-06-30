/**
 * Codex sub-agent collaboration link extraction.
 *
 * Newer rollouts pair spawns with `wait_agent` + `function_call_output` instead of
 * `collab_agent_spawn_end` / `collab_waiting_end`. Shared by dispatch timing and
 * child-rollout loading for analytics.
 */

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    name?: string;
    arguments?: string;
    call_id?: string;
    new_thread_id?: string;
    new_agent_role?: string;
  };
}

export interface CodexSpawnLink {
  spawnCallId: string;
  threadId: string;
  agentType: string;
  spawnStart: number;
  waitEnd?: number;
}

function parseTs(raw: CodexLine): number | null {
  const n = raw.timestamp ? Date.parse(raw.timestamp) : NaN;
  return Number.isFinite(n) ? n : null;
}

function agentFromSpawnArgs(argsJson: string | undefined): string {
  if (!argsJson) {
    return 'agent';
  }
  try {
    const args = JSON.parse(argsJson) as { agent_type?: string };
    return args.agent_type?.trim() || 'agent';
  } catch {
    return 'agent';
  }
}

/** Collect child thread UUIDs referenced by spawn/wait collaboration events. */
export function collectCodexChildThreadIds(records: readonly unknown[]): Set<string> {
  const out = new Set<string>();
  for (const raw of records) {
    const rec = raw as CodexLine;
    if (rec.type === 'event_msg' && rec.payload?.type === 'collab_agent_spawn_end' && rec.payload.new_thread_id) {
      out.add(rec.payload.new_thread_id);
    }
    if (rec.type === 'response_item' && rec.payload?.type === 'function_call' && rec.payload.name === 'wait_agent') {
      try {
        const args = JSON.parse(rec.payload.arguments ?? '{}') as { targets?: string[] };
        for (const target of args.targets ?? []) {
          if (typeof target === 'string' && target) {
            out.add(target);
          }
        }
      } catch {
        // ignore malformed wait_agent args
      }
    }
  }
  return out;
}

/**
 * Resolve spawn call_id → child thread id for loading sub-agent rollouts and
 * attaching per-dispatch cost/tokens (_toolUseId = spawn call_id).
 */
export function extractCodexSpawnLinks(records: readonly unknown[]): CodexSpawnLink[] {
  const messages = Array.isArray(records) ? (records as CodexLine[]) : [];
  const spawns = new Map<string, { name: string; start: number; threadId?: string }>();
  const waitCalls = new Map<string, { targets: string[]; start: number }>();
  const links: CodexSpawnLink[] = [];
  const linkedSpawns = new Set<string>();
  const linkedThreads = new Set<string>();

  for (const raw of messages) {
    const ts = parseTs(raw);
    if (raw.type === 'response_item') {
      const p = raw.payload;
      if (p?.type === 'function_call' && p.name === 'spawn_agent' && p.call_id && ts != null) {
        spawns.set(p.call_id, { name: agentFromSpawnArgs(p.arguments), start: ts });
      } else if (p?.type === 'function_call' && p.name === 'wait_agent' && p.call_id && ts != null) {
        try {
          const args = JSON.parse(p.arguments ?? '{}') as { targets?: string[] };
          if (Array.isArray(args.targets) && args.targets.length) {
            waitCalls.set(p.call_id, { targets: args.targets, start: ts });
          }
        } catch {
          // ignore
        }
      } else if (p?.type === 'function_call_output' && p.call_id && ts != null) {
        const wait = waitCalls.get(p.call_id);
        if (!wait) {
          continue;
        }
        for (const threadId of wait.targets) {
          if (linkedThreads.has(threadId)) {
            continue;
          }
          let spawnCallId: string | undefined;
          for (const [callId, spawn] of spawns) {
            if (spawn.threadId === threadId) {
              spawnCallId = callId;
              break;
            }
          }
          if (!spawnCallId) {
            let best: { callId: string; start: number } | undefined;
            for (const [callId, spawn] of spawns) {
              if (linkedSpawns.has(callId) || spawn.start > wait.start) {
                continue;
              }
              if (!best || spawn.start > best.start) {
                best = { callId, start: spawn.start };
              }
            }
            spawnCallId = best?.callId;
          }
          if (!spawnCallId) {
            continue;
          }
          const spawn = spawns.get(spawnCallId);
          if (!spawn) {
            continue;
          }
          linkedSpawns.add(spawnCallId);
          linkedThreads.add(threadId);
          links.push({
            spawnCallId,
            threadId,
            agentType: spawn.name,
            spawnStart: spawn.start,
            waitEnd: ts,
          });
        }
      }
    } else if (raw.type === 'event_msg' && raw.payload?.type === 'collab_agent_spawn_end' && raw.payload.call_id) {
      const spawn = spawns.get(raw.payload.call_id);
      if (spawn && raw.payload.new_thread_id) {
        spawn.threadId = raw.payload.new_thread_id;
        if (raw.payload.new_agent_role?.trim()) {
          spawn.name = raw.payload.new_agent_role.trim();
        }
      }
    } else if (raw.type === 'event_msg' && raw.payload?.type === 'collab_waiting_end' && ts != null) {
      const waitCallId = raw.payload.call_id;
      const wait = waitCallId ? waitCalls.get(waitCallId) : undefined;
      if (!wait) {
        continue;
      }
      for (const threadId of wait.targets) {
        if (linkedThreads.has(threadId)) {
          continue;
        }
        for (const [spawnCallId, spawn] of spawns) {
          if (spawn.threadId !== threadId || linkedSpawns.has(spawnCallId)) {
            continue;
          }
          linkedSpawns.add(spawnCallId);
          linkedThreads.add(threadId);
          links.push({
            spawnCallId,
            threadId,
            agentType: spawn.name,
            spawnStart: spawn.start,
            waitEnd: ts,
          });
        }
      }
    }
  }

  return links;
}
