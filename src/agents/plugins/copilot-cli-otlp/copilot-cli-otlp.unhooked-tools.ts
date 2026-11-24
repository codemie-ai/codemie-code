import { maskAndBoundFields } from '@/agents/core/otlp-field-limits.js';
import type {
  CopilotEvent,
  CopilotToolCompleteData,
  CopilotToolStartData,
} from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { stableEventId } from './copilot-cli-otlp.request-usage.js';
import { buildToolEvent, parseArgs, type ToolEndCall } from './copilot-cli-otlp.tool-payload.js';

const TOOL_START_TYPE = 'agent.tool.start';
const TOOL_END_TYPE = 'agent.tool.end';

/** Tool call ids Copilot ran a `preToolUse` hook for; the hook forwards those itself. */
function hookedToolCallIds(events: CopilotEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type !== 'hook.start') continue;
    const data = (event.data ?? {}) as {
      hookType?: string;
      input?: { toolCalls?: Array<{ id?: unknown }>; toolCallId?: unknown };
    };
    if (data.hookType !== 'preToolUse') continue;
    for (const call of data.input?.toolCalls ?? []) {
      if (typeof call?.id === 'string') ids.add(call.id);
    }
    if (typeof data.input?.toolCallId === 'string') ids.add(data.input.toolCallId);
  }
  return ids;
}

function resultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result;
  const content = typeof result === 'object' && result !== null ? (result as { content?: unknown }).content : undefined;
  return typeof content === 'string' ? content : undefined;
}

function errorMessage(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return JSON.stringify(error);
}

function toolEnd(toolName: string, toolArgs: unknown, complete: CopilotToolCompleteData): ToolEndCall {
  const failed = complete.success === false || complete.error !== undefined;
  return {
    toolName,
    toolArgs,
    success: !failed,
    resultText: resultText(complete.result),
    errorMessage: failed ? errorMessage(complete.error) : undefined,
  };
}

/**
 * Tool events for the calls Copilot executed without running a `preToolUse` hook: the ones its runtime
 * issues itself (`read_agent`, `read_powershell` after a background agent or shell finishes). The session
 * summary counts them from the transcript, so without these events Session Detail falls short of it.
 *
 * Built from the whole transcript with stable event ids, so a repeated pass dedups. Nothing is built for a
 * session whose transcript shows no tool hook at all, or for a tail-only transcript, where a missing hook
 * cannot be told from a cut one.
 */
export function buildUnhookedToolEvents(sessionId: string, events: CopilotEvent[]): Record<string, unknown>[] {
  const hooked = hookedToolCallIds(events);
  if (hooked.size === 0) return [];

  const completions = new Map<string, CopilotEvent>();
  for (const event of events) {
    if (event.type !== 'tool.execution_complete') continue;
    const id = (event.data as CopilotToolCompleteData | undefined)?.toolCallId;
    if (id) completions.set(id, event);
  }

  const out: Record<string, unknown>[] = [];
  for (const event of events) {
    if (event.type !== 'tool.execution_start') continue;
    const data = (event.data ?? {}) as CopilotToolStartData;
    const toolUseId = data.toolCallId;
    const toolName = data.toolName;
    if (!toolUseId || !toolName || hooked.has(toolUseId)) continue;

    const toolArgs = parseArgs(data.arguments);
    const base = (type: string, timestamp: string | undefined): Record<string, unknown> => ({
      session_id: sessionId,
      type,
      ...(timestamp ? { timestamp } : {}),
      ...(event.agentId ? { agent_id: event.agentId } : {}),
    });

    out.push(maskAndBoundFields({
      ...buildToolEvent(base(TOOL_START_TYPE, event.timestamp), toolName, toolArgs, { toolUseId }),
      event_id: stableEventId(TOOL_START_TYPE, sessionId, toolUseId),
    }));

    const complete = completions.get(toolUseId);
    if (!complete) continue;
    const end = toolEnd(toolName, toolArgs, (complete.data ?? {}) as CopilotToolCompleteData);
    const endEvent = buildToolEvent(base(TOOL_END_TYPE, complete.timestamp), toolName, toolArgs, { toolUseId, end });
    out.push(maskAndBoundFields({
      ...endEvent,
      event_id: stableEventId(String(endEvent['type']), sessionId, toolUseId),
    }));
  }
  return out;
}
