import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger.js';
import { isSensitiveFilePath } from '@/agents/plugins/claude-code-otlp/event-fields/tool-fields.js';
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
  const resultType = input.toolResult?.resultType;
  const failed = input.codemieEventName === 'postToolUseFailure' || (resultType !== undefined && resultType !== 'success');
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
  const targetPath = argsPath(toolArgs);
  const sensitive = targetPath !== undefined && isSensitiveFilePath(targetPath);
  const event: Record<string, unknown> = {
    ...base,
    tool_name: toolName.slice(0, 300),
    tool_use_id: opts.toolUseId,
    tool_input: sensitive ? { path: targetPath } : toolArgs,
  };
  const filePath = extractFilePath(toolName, toolArgs);
  if (filePath !== undefined) event.file_path = filePath;
  const skillName = extractSkillName(toolName, toolArgs);
  if (skillName !== undefined) event.skill_name = skillName;
  if (!sensitive && opts.end?.success && opts.end.resultText !== undefined) event.tool_response = opts.end.resultText;
  if (!sensitive && opts.end?.errorMessage !== undefined && event.error_message === undefined) {
    event.error_message = opts.end.errorMessage.slice(0, 300);
  }
  return event;
}

/** `args.path` of any tool, used to detect credential files before content is forwarded. */
function argsPath(toolArgs: unknown): string | undefined {
  if (typeof toolArgs !== 'object' || toolArgs === null) return undefined;
  const path = (toolArgs as Record<string, unknown>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

/** Skill invoked by Copilot's `skill` tool (`args.skill`), taken before the base class truncates `tool_input`. */
export function extractSkillName(toolName: string, toolArgs: unknown): string | undefined {
  if (toolName !== 'skill' || typeof toolArgs !== 'object' || toolArgs === null) {
    return undefined;
  }
  const skill = (toolArgs as Record<string, unknown>)['skill'];
  const name = typeof skill === 'string' ? skill.trim() : '';
  return name.length > 0 ? name.slice(0, 300) : undefined;
}

/** Target file path of a file-writing tool call, taken before the base class truncates `tool_input`. */
export function extractFilePath(toolName: string, toolArgs: unknown): string | undefined {
  if (!FILE_PATH_TOOLS.has(toolName) || typeof toolArgs !== 'object' || toolArgs === null) {
    return undefined;
  }
  const path = (toolArgs as Record<string, unknown>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}
