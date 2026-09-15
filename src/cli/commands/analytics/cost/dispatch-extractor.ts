import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import { extractCodexDispatchEvents } from '../../../../agents/plugins/codex/session/codex-dispatch-extractor.js';
import { isCodexFamilyAgent } from './codex-agent.js';
import { buildClaudeTraceIndex, normalizeClaudeTrace } from './claude-trace.js';
import type { DispatchEventRaw } from './types.js';

interface RawBlock {
  type?: string;
  name?: string;
  id?: string;
  tool_use_id?: string;
  input?: { skill?: unknown; subagent_type?: unknown; name?: unknown };
  text?: unknown;
}

interface RawRow {
  timestamp?: string;
  toolUseResult?: { isAsync?: boolean; status?: string; agentId?: string; taskId?: string };
  message?: { role?: string; content?: unknown };
}

interface Pending {
  event: DispatchEventRaw;
  ownerAgentId: string;
}

const COMMAND_TAG = /<command-name>([^<]+)<\/command-name>/g;

const rowTimestamp = (row: RawRow): number | undefined => {
  const parsed = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
};

const blocks = (row: RawRow): RawBlock[] => Array.isArray(row.message?.content)
  ? row.message.content as RawBlock[]
  : [];

/** Extract every native invocation while retaining stable ownership and lifecycle evidence. */
export function extractDispatchEvents(parsed: ParsedSession, agentName?: string): DispatchEventRaw[] {
  const agent = (agentName ?? parsed.agentName ?? '').toLowerCase();
  if (isCodexFamilyAgent(agent)) return extractCodexDispatchEvents(parsed);

  const index = buildClaudeTraceIndex(parsed);
  const pending = new Map<string, Pending>();
  const events: DispatchEventRaw[] = [];
  const emittedTools = new Set<string>();

  const scanCommands = (text: string, start: number, ownerAgentId: string): void => {
    if (!text.includes('<command-message>')) return;
    COMMAND_TAG.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMAND_TAG.exec(text)) !== null) {
      const name = match[1].replace(/^\//, '').trim();
      if (!name) continue;
      events.push({
        kind: 'command', name, start, durationMs: 0,
        id: `${ownerAgentId}:command:${start}:${name}`, ownerAgentId,
        relationshipStatus: ownerAgentId === index.rootOwnerId ? 'root' : 'resolved', status: 'completed', elapsedMs: 0,
      });
    }
  };

  for (const owner of index.owners.values()) {
    for (const row of owner.messages as RawRow[]) {
      const start = rowTimestamp(row);
      const content = row.message?.content;
      if (typeof content === 'string') {
        if (row.message?.role === 'user' && start !== undefined) scanCommands(content, start, owner.id);
        continue;
      }
      for (const block of blocks(row)) {
        if (block.type === 'tool_use' && start !== undefined && block.id && !emittedTools.has(block.id)) {
          if (index.toolOwners.get(block.id) !== owner.id) continue;
          let kind: 'agent' | 'skill' | undefined;
          let name: string | undefined;
          if (block.name === 'Agent' || block.name === 'Task') {
            kind = 'agent';
            name = [block.input?.subagent_type, block.input?.name].find((value): value is string => typeof value === 'string' && value.trim().length > 0)?.trim() ?? 'agent';
          } else if (block.name === 'Skill' && typeof block.input?.skill === 'string') {
            kind = 'skill';
            name = block.input.skill.trim() || 'skill';
          }
          if (kind && name) {
            emittedTools.add(block.id);
            pending.set(block.id, { ownerAgentId: owner.id, event: {
              kind, name, start, durationMs: 0, id: block.id, _toolUseId: kind === 'agent' ? block.id : undefined,
              ownerAgentId: owner.id, relationshipStatus: owner.id === index.rootOwnerId ? 'root' : 'resolved',
            } });
          }
        } else if (block.type === 'tool_result' && block.tool_use_id) {
          const item = pending.get(block.tool_use_id);
          if (!item) continue;
          pending.delete(block.tool_use_id);
          const acknowledgedAt = start;
          const isAsync = row.toolUseResult?.isAsync === true || row.toolUseResult?.status === 'async_launched';
          events.push({
            ...item.event,
            durationMs: acknowledgedAt === undefined ? 0 : Math.max(0, acknowledgedAt - item.event.start),
            ...(acknowledgedAt !== undefined && { acknowledgedAt }),
            ...(typeof row.toolUseResult?.agentId === 'string' && { agentId: row.toolUseResult.agentId }),
            status: item.event.kind === 'agent' && isAsync ? 'incomplete' : 'completed',
          });
        } else if (row.message?.role === 'user' && block.type === 'text' && typeof block.text === 'string' && start !== undefined) {
          scanCommands(block.text, start, owner.id);
        }
      }
    }
  }

  for (const item of pending.values()) events.push({ ...item.event, status: item.event.kind === 'agent' ? 'unknown' : 'incomplete' });
  events.sort((left, right) => left.start - right.start || (left.id ?? '').localeCompare(right.id ?? ''));
  return normalizeClaudeTrace(events, parsed, index);
}
