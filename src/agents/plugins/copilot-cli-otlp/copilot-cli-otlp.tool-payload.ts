import { randomUUID } from 'node:crypto';
import { logger } from '@/utils/logger.js';
import { isSensitiveFilePath } from '@/agents/plugins/claude-code-otlp/event-fields/tool-fields.js';
import { extractPatchFiles, FILE_WRITE_TOOLS } from '@/agents/plugins/copilot-cli/copilot-cli.tool-activity.js';
import { countContentLines } from '@/utils/file-operations.js';
import type { CopilotCliHookInput } from './copilot-cli-otlp.types.js';

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
  // A patch carries file content too, so any credential file among its targets hides the payload.
  const targetPath = toolName === 'apply_patch'
    ? extractPatchFiles(toolArgs).find((f) => isSensitiveFilePath(f.path))?.path
    : argsPath(toolArgs);
  const sensitive = targetPath !== undefined && isSensitiveFilePath(targetPath);
  const event: Record<string, unknown> = {
    ...base,
    tool_name: toolName.slice(0, 300),
    tool_use_id: opts.toolUseId,
    tool_input: sensitive ? { path: targetPath } : toolArgs,
  };
  // `postToolUse` also fires for denied/rejected results, which are errors, not completions.
  if (opts.end && !opts.end.success) event.type = 'agent.tool.error';
  const filePath = extractFilePath(toolName, toolArgs);
  if (filePath !== undefined) event.file_path = filePath;
  // A failed edit/create changed nothing, so its diff must not count (matches
  // `extractCopilotToolActivity`'s same rule for the session summary).
  if (opts.end?.success) {
    const { lines_added, lines_removed } = extractLineCounts(toolName, toolArgs);
    if (lines_added !== undefined) event.lines_added = lines_added;
    if (lines_removed !== undefined) event.lines_removed = lines_removed;
    // `apply_patch` can touch several files in one call; `file_path`/`lines_added`/`lines_removed`
    // above stay the first file / the call's total for backward compatibility, and `files` gives
    // the per-file breakdown so a multi-file patch isn't attributed to a single path.
    if (toolName === 'apply_patch') {
      const files = extractPatchFiles(toolArgs);
      if (files.length > 1) {
        event.files = files.map((f) => ({
          file_path: f.path,
          type: f.type,
          lines_added: f.linesAdded ?? 0,
          lines_removed: f.linesRemoved ?? 0,
        }));
      }
    }
  }
  const skillName = extractSkillName(toolName, toolArgs);
  if (skillName !== undefined) event.skill_name = skillName;
  if (!sensitive && opts.end?.success && opts.end.resultText !== undefined) event.tool_response = opts.end.resultText;
  if (sensitive) {
    // `base` already carries the hook's own `error` text, which may quote the credential file's content.
    delete event.error_message;
    delete event.error_context;
  } else if (opts.end?.errorMessage !== undefined && event.error_message === undefined) {
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

/**
 * Target file path of a file-writing tool call, taken before the base class truncates `tool_input`.
 * For `apply_patch` it is the first file of the patch.
 */
export function extractFilePath(toolName: string, toolArgs: unknown): string | undefined {
  if (toolName === 'apply_patch') return extractPatchFiles(toolArgs)[0]?.path;
  if (!FILE_WRITE_TOOLS.has(toolName) || typeof toolArgs !== 'object' || toolArgs === null) {
    return undefined;
  }
  const path = (toolArgs as Record<string, unknown>)['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function stringArg(toolArgs: unknown, key: string): string | undefined {
  if (typeof toolArgs !== 'object' || toolArgs === null) return undefined;
  const value = (toolArgs as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** Lines of `text`, a trailing newline never starting another line; `''` has no lines at all. */
function textLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line counts of replacing `oldText` with `newText` (Copilot's `edit` / `str_replace_editor`
 * `old_str` -> `new_str`): common leading and trailing lines are unchanged, and the remaining
 * old lines are removed while the remaining new lines are added — a plain single-line edit
 * (e.g. renaming an identifier) counts as one removed, one added, matching a line-level diff.
 */
function countReplaceDiff(oldText: string, newText: string): { lines_added: number; lines_removed: number } {
  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { lines_added: newEnd - start, lines_removed: oldEnd - start };
}

/**
 * Line counts for `agent.tool.end` of a file-writing tool, or `{}` when the diff is unknown —
 * never reported as `0`, since the backend cannot tell an unknown diff apart from a real
 * zero-line change. `apply_patch` is counted from its own patch envelope (summed over every file
 * it touches, since only the first file's path is reported); `create` from the written content;
 * `edit` / `str_replace_editor` from their `old_str` -> `new_str` replacement.
 */
export function extractLineCounts(toolName: string, toolArgs: unknown): { lines_added?: number; lines_removed?: number } {
  if (toolName === 'apply_patch') {
    const files = extractPatchFiles(toolArgs);
    if (files.length === 0) return {};
    return {
      lines_added: files.reduce((sum, f) => sum + (f.linesAdded ?? 0), 0),
      lines_removed: files.reduce((sum, f) => sum + (f.linesRemoved ?? 0), 0),
    };
  }
  if (toolName === 'create') {
    const text = stringArg(toolArgs, 'file_text');
    return text !== undefined ? { lines_added: countContentLines(text), lines_removed: 0 } : {};
  }
  if (toolName === 'edit' || toolName === 'str_replace_editor') {
    const oldStr = stringArg(toolArgs, 'old_str');
    const newStr = stringArg(toolArgs, 'new_str');
    return oldStr !== undefined && newStr !== undefined ? countReplaceDiff(oldStr, newStr) : {};
  }
  return {};
}
