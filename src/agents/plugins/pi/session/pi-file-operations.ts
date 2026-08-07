/**
 * Map Pi tool calls/results to CodeMie file-operation records.
 */

import type { FileOperation, FileOperationType } from '../../../core/metrics/types.js';
import { extractFormat, detectLanguage } from '../../../../utils/file-operations.js';

const TOOL_TYPE_MAP: Record<string, FileOperationType> = {
  write: 'write',
  edit: 'edit',
  read: 'read',
  grep: 'grep',
  glob: 'glob',
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
 * is not a file/search tool.
 */
export function extractPiFileOperation(
  toolName: string,
  toolArguments?: Record<string, unknown>,
  toolResultDetails?: Record<string, unknown>
): FileOperation | undefined {
  const type = TOOL_TYPE_MAP[toolName.toLowerCase()];
  if (!type) {
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

  const lowerToolName = toolName.toLowerCase();

  if (lowerToolName === 'write') {
    const content = toolArguments?.content;
    if (typeof content === 'string' && content.length > 0) {
      operation.linesAdded = content.split('\n').length;
    }
  }

  if (lowerToolName === 'edit') {
    const patch = toolResultDetails?.diff ?? toolResultDetails?.patch;
    const { linesAdded, linesRemoved } = countPiDiffLines(patch);
    if (linesAdded > 0) operation.linesAdded = linesAdded;
    if (linesRemoved > 0) operation.linesRemoved = linesRemoved;
  }

  return operation;
}
