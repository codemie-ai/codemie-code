/**
 * Map Pi tool calls/results to CodeMie file-operation records.
 */

import type { FileOperation, FileOperationType } from '../../../core/metrics/types.js';
import { extractFormat, detectLanguage } from '../../../../utils/file-operations.js';
import { logger } from '../../../../utils/logger.js';

// Pi's closed tool registry is read | bash | edit | write | grep | find | ls
// (packages/coding-agent/src/core/tools/index.ts). `find` is Pi's glob-by-filename
// tool. `bash` is intentionally absent: it mutates files arbitrarily (`sed -i`,
// `>`, `mv`, `git apply`, etc.) and no reliable file-effect signal is persisted.
// `write` creates OR overwrites; the result does not record which occurred.
//
// Tool names are matched case-sensitively: extension tools may register arbitrary
// names, and lowercasing would misclassify an extension named `Write` as the
// built-in write tool.
//
// There is deliberately no 'delete' mapping, so `files_deleted` stays at 0. That is
// parity, not a gap: Pi ships no delete tool, and Claude's own TOOL_TYPE_MAP
// (claude/session/claude-file-operation.ts) has no delete entry either. Inferring
// deletions from `rm` inside a bash command would report a number Claude never reports
// and would be wrong whenever the command fails, is conditional, or is a dry run.
const TOOL_TYPE_MAP: Record<string, FileOperationType> = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  grep: 'grep',
  ls: 'read',
  find: 'glob',
};

/**
 * Count added/removed lines in a unified diff string.
 */
export function countPiDiffLines(patch: unknown): { linesAdded: number; linesRemoved: number } {
  if (typeof patch !== 'string' || patch.length === 0) {
    return { linesAdded: 0, linesRemoved: 0 };
  }

  let linesAdded = 0;
  let linesRemoved = 0;

  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) continue;
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;
    if (line.startsWith('+')) linesAdded++;
    else if (line.startsWith('-')) linesRemoved++;
  }

  return { linesAdded, linesRemoved };
}

function extractPath(args?: Record<string, unknown>, details?: Record<string, unknown>): string | undefined {
  const fromArgs = args?.path ?? args?.filePath ?? args?.file_path;
  if (typeof fromArgs === 'string') return fromArgs;

  const fromDetails = details?.path ?? details?.filePath ?? details?.file_path;
  if (typeof fromDetails === 'string') return fromDetails;

  return undefined;
}

/**
 * Build a file-operation record for a Pi tool call, or undefined if the tool
 * is not a tracked file/search tool.
 */
export function extractPiFileOperation(
  toolName: string,
  toolArguments?: Record<string, unknown>,
  toolResultDetails?: Record<string, unknown>
): FileOperation | undefined {
  const type = TOOL_TYPE_MAP[toolName];
  if (!type) {
    logger.debug(`[pi-file-ops] No file-operation mapping for tool: ${toolName}`);
    return undefined;
  }

  const operation: FileOperation = { type };

  const filePath = extractPath(toolArguments, toolResultDetails);
  if (filePath) {
    operation.path = filePath;
    operation.format = extractFormat(filePath);
    operation.language = detectLanguage(filePath);
  }

  if (typeof toolArguments?.pattern === 'string') {
    operation.pattern = toolArguments.pattern;
  }

  if (toolName === 'write') {
    const content = toolArguments?.content;
    if (typeof content === 'string' && content.length > 0) {
      // Strip a single trailing newline so newline-terminated source files are
      // not over-counted by one.
      const normalized = content.endsWith('\n') ? content.slice(0, -1) : content;
      operation.linesAdded = normalized.split('\n').length;
    }
  }

  if (toolName === 'edit') {
    const patch = toolResultDetails?.diff ?? toolResultDetails?.patch;
    const { linesAdded, linesRemoved } = countPiDiffLines(patch);
    if (linesAdded > 0) operation.linesAdded = linesAdded;
    if (linesRemoved > 0) operation.linesRemoved = linesRemoved;
  }

  return operation;
}
