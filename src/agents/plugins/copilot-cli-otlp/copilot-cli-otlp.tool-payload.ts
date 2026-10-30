import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger.js';
import type { CopilotCliHookInput } from './copilot-cli-otlp.types.js';

/** Tools whose `args.path` is the file they write; independent of the managed adapter's set. */
const FILE_PATH_TOOLS: ReadonlySet<string> = new Set(['create', 'edit', 'str_replace_editor', 'apply_patch']);

export interface ToolStartCall {
  toolUseId: string;
  toolName: string;
  toolArgs: unknown;
}

export interface ToolEndCall {
  toolName: string;
  toolArgs: unknown;
  success: boolean;
  resultText?: string;
  errorMessage?: string;
}

/** Parses a JSON string when valid, otherwise keeps the value untouched. */
export function parseArgs(args: unknown): unknown {
  if (typeof args !== 'string') {
    return args;
  }
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

export function extractStartCalls(input: CopilotCliHookInput): ToolStartCall[] {
  const calls: ToolStartCall[] = [];
  if (!Array.isArray(input.toolCalls) && typeof input.toolName === 'string' && input.toolName.length > 0) {
    const toolUseId = typeof input.toolCallId === 'string' && input.toolCallId.length > 0
      ? input.toolCallId
      : `${input.sessionId}:pre:${randomUUID()}`;
    return [{ toolUseId, toolName: input.toolName, toolArgs: parseArgs(input.toolArgs) }];
  }
  for (const call of input.toolCalls ?? []) {
    if (typeof call?.id !== 'string' || call.id.length === 0 || typeof call.name !== 'string' || call.name.length === 0) {
      logger.debug('[copilot-cli-otlp] dropped preToolUse tool call without id or name');
      continue;
    }
    calls.push({ toolUseId: call.id, toolName: call.name, toolArgs: parseArgs(call.args) });
  }
  return calls;
}

function errorText(error: unknown): string | undefined {
  if (error === undefined || error === null) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && 'message' in error) return String((error as { message: unknown }).message);
  return JSON.stringify(error);
}

export function extractEndCall(input: CopilotCliHookInput): ToolEndCall {
  const failed = input.codemieEventName === 'postToolUseFailure' || input.toolResult?.resultType === 'failure';
  return {
    toolName: typeof input.toolName === 'string' ? input.toolName : '',
    toolArgs: parseArgs(input.toolArgs),
    success: !failed,
    resultText: input.toolResult?.textResultForLlm,
    errorMessage: failed ? errorText(input.error) : undefined,
  };
}

/** Tool fields of one `agent.tool.*` event; `file_path` is taken before the base class truncates `tool_input`. */
export function buildToolEvent(
  base: Record<string, unknown>,
  toolName: string,
  toolArgs: unknown,
  opts: { toolUseId: string; end?: ToolEndCall }
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    ...base,
    tool_name: toolName.slice(0, 300),
    tool_use_id: opts.toolUseId,
    tool_input: toolArgs,
  };
  const filePath = extractFilePath(toolName, toolArgs);
  if (filePath !== undefined) event.file_path = filePath;
  if (opts.end?.success && opts.end.resultText !== undefined) event.tool_response = opts.end.resultText;
  if (opts.end?.errorMessage !== undefined && event.error_message === undefined) {
    event.error_message = opts.end.errorMessage.slice(0, 300);
  }
  return event;
}

/** Target file path of a file-writing tool call, taken before the base class truncates `tool_input`. */
export function extractFilePath(toolName: string, toolArgs: unknown): string | undefined {
  if (!FILE_PATH_TOOLS.has(toolName) || typeof toolArgs !== 'object' || toolArgs === null) {
    return undefined;
  }
  const path = (toolArgs as Record<string, unknown>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
