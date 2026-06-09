/**
 * Shared Claude file-operation extraction.
 *
 * Single source of truth for turning a Claude tool call (tool name + input + the user
 * message's `toolUseResult`) into a file-operation record with line counts. Used by both
 * the live {@link MetricsProcessor} and the session adapter's parse path, so re-parsed
 * (native, untracked) sessions report the same `linesAdded`/`linesRemoved` as live-tracked ones.
 */

import { extractFormat, detectLanguage } from '../../../../utils/file-operations.js';

export interface ClaudeFileOperation {
  type: string;
  path?: string;
  format?: string;
  language?: string;
  pattern?: string;
  linesAdded?: number;
  linesRemoved?: number;
}

/** Tool names that map to a file operation, and their operation type. */
const TOOL_TYPE_MAP: Record<string, string> = {
  Read: 'read',
  Write: 'write',
  Edit: 'edit',
  Grep: 'grep',
  Glob: 'glob',
};

/**
 * Build a file-operation record for a Claude tool call, or `undefined` if the tool is not a
 * file/search tool. Line counts come from the Write content or the Edit `structuredPatch`.
 */
export function extractClaudeFileOperation(
  toolName: string,
  input?: { file_path?: string; path?: string; content?: string; pattern?: string } | unknown,
  toolUseResult?:
    | {
        filePath?: string;
        file?: { filePath?: string; content?: string };
        content?: string;
        structuredPatch?: Array<{ lines?: unknown[] }>;
      }
    | unknown
): ClaudeFileOperation | undefined {
  const type = TOOL_TYPE_MAP[toolName];
  if (!type) {
    return undefined;
  }

  const inp = (input ?? {}) as { file_path?: string; path?: string; content?: string; pattern?: string };
  const res = (toolUseResult ?? {}) as {
    filePath?: string;
    file?: { filePath?: string; content?: string };
    content?: string;
    structuredPatch?: Array<{ lines?: unknown[] }>;
  };

  const fileOp: ClaudeFileOperation = { type };

  const filePath = res.filePath || res.file?.filePath || inp.file_path || inp.path;
  if (filePath) {
    fileOp.path = filePath;
    fileOp.format = extractFormat(filePath);
    fileOp.language = detectLanguage(filePath);
  } else if (inp.pattern) {
    fileOp.pattern = inp.pattern;
  }

  if (toolName === 'Write') {
    const content = res.content || res.file?.content || inp.content;
    if (content) {
      fileOp.linesAdded = content.split('\n').length;
    }
  } else if (toolName === 'Edit' && Array.isArray(res.structuredPatch)) {
    let added = 0;
    let removed = 0;
    for (const patch of res.structuredPatch) {
      if (Array.isArray(patch.lines)) {
        for (const line of patch.lines) {
          if (typeof line === 'string') {
            if (line.startsWith('+')) added++;
            else if (line.startsWith('-')) removed++;
          }
        }
      }
    }
    if (added > 0) fileOp.linesAdded = added;
    if (removed > 0) fileOp.linesRemoved = removed;
  }

  return fileOp;
}
