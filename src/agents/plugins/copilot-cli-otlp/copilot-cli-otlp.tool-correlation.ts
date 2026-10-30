import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { getCopilotSessionStateRoot } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import type { CopilotEvent, CopilotToolCompleteData, CopilotToolStartData } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { logger } from '@/utils/logger.js';
import { parseArgs, type ToolStartCall } from './copilot-cli-otlp.tool-payload.js';
import { readState, TOOL_STATE_BUDGET_MS, toolsStatePath, withStateLock, writeStateAtomic } from './copilot-cli-otlp.state.js';

const MAX_OPEN_STARTS = 500;
const OPEN_START_MAX_AGE_MS = 30 * 60 * 1000;
const TAIL_BYTES = 256 * 1024;

interface OpenStart {
  id: string;
  name: string;
  argsKey: string;
  startedAt: number;
}

interface ToolsState {
  openStarts: OpenStart[];
  orphanCount: number;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function argsKeyOf(args: unknown): string {
  return createHash('sha256').update(canonicalJson(parseArgs(args))).digest('hex');
}

/** Records the open starts of a successfully authorised batch. Budget exhaustion only skips recording. */
export async function recordOpenStarts(sessionId: string, calls: ToolStartCall[], now: number = Date.now()): Promise<void> {
  if (calls.length === 0) return;
  const path = toolsStatePath(sessionId);
  await withStateLock(path, () => {
    const state = readState<ToolsState>(path, { openStarts: [], orphanCount: 0 });
    const added = calls.map((c) => ({ id: c.toolUseId, name: c.toolName, argsKey: argsKeyOf(c.toolArgs), startedAt: now }));
    state.openStarts = [...state.openStarts, ...added].slice(-MAX_OPEN_STARTS);
    writeStateAtomic(path, state);
  }, TOOL_STATE_BUDGET_MS);
}

/** Newest `tool.execution_start` with this name and args whose call has not completed, from the file tail. */
function lookupFromTranscript(sessionId: string, name: string, argsKey: string, stateRoot: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(join(stateRoot, sessionId, 'events.jsonl'), 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf-8').split('\n');
    if (size > length) lines.shift(); // first line is cut
    const completed = new Set<string>();
    const starts: Array<{ id: string }> = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let event: CopilotEvent;
      try {
        event = JSON.parse(line) as CopilotEvent;
      } catch {
        continue;
      }
      if (event.type === 'tool.execution_complete') {
        const id = (event.data as CopilotToolCompleteData | undefined)?.toolCallId;
        if (id) completed.add(id);
      } else if (event.type === 'tool.execution_start') {
        const data = (event.data ?? {}) as CopilotToolStartData;
        if (data.toolCallId && data.toolName === name && argsKeyOf(data.arguments) === argsKey) {
          starts.push({ id: data.toolCallId });
        }
      }
    }
    return starts.reverse().find((s) => !completed.has(s.id))?.id;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Pairs a post-tool hook with its open start: oldest open start with the same name and args,
 * then the oldest with the same name. A start's ID is never changed. Without an open start the
 * transcript tail is consulted, and finally an orphan ID is generated; the end is always sent.
 */
export async function resolveEndToolUseId(
  sessionId: string,
  name: string,
  toolArgs: unknown,
  now: number = Date.now(),
  stateRoot: string = getCopilotSessionStateRoot()
): Promise<string> {
  const argsKey = argsKeyOf(toolArgs);
  const path = toolsStatePath(sessionId);
  let orphanOrdinal = 0;
  const matched = await withStateLock(path, () => {
    const state = readState<ToolsState>(path, { openStarts: [], orphanCount: 0 });
    state.openStarts = state.openStarts.filter((s) => now - s.startedAt <= OPEN_START_MAX_AGE_MS);
    let index = state.openStarts.findIndex((s) => s.name === name && s.argsKey === argsKey);
    if (index < 0) index = state.openStarts.findIndex((s) => s.name === name);
    let id: string | undefined;
    if (index >= 0) {
      id = state.openStarts[index].id;
      state.openStarts.splice(index, 1);
    } else {
      state.orphanCount += 1;
      orphanOrdinal = state.orphanCount;
    }
    writeStateAtomic(path, state);
    return id;
  }, TOOL_STATE_BUDGET_MS);
  if (matched) return matched;

  const fromTranscript = lookupFromTranscript(sessionId, name, argsKey, stateRoot);
  if (fromTranscript) return fromTranscript;
  logger.debug('[copilot-cli-otlp] tool end without open start, using orphan id');
  return `${sessionId}:${argsKey.slice(0, 16)}:orphan:${orphanOrdinal || Date.now()}`;
}
