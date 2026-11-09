/**
 * Map Pi / oh-my-pi (omp) tool calls/results to CodeMie file-operation records.
 */

import { isAbsolute, resolve, sep } from 'path';
import type { FileOperation, FileOperationType } from '../../../core/metrics/types.js';
import { extractFormat, detectLanguage, countContentLines } from '../../../../utils/file-operations.js';
import { logger } from '../../../../utils/logger.js';

// Pi's closed tool registry is read | bash | edit | write | grep | find | ls
// (packages/coding-agent/src/core/tools/index.ts). `find` is Pi's glob-by-filename
// tool; omp names the same tool `glob`. `bash` is intentionally absent: it mutates
// files arbitrarily (`sed -i`, `>`, `mv`, `git apply`, etc.) and no reliable
// file-effect signal is persisted. `write` creates OR overwrites; the result does not
// record which occurred.
//
// Tool names are matched case-sensitively: extension tools may register arbitrary
// names, and lowercasing would misclassify an extension named `Write` as the
// built-in write tool.
//
// omp specifics:
// - `edit` takes a hashline patch with no path; the path only appears in the result
//   `details`. A multi-file edit carries `details.perFileResults[]`, whose items replace
//   the (duplicating) top-level diff.
// - `edit` with `op: 'delete'` maps to `delete`; Pi itself has no delete tool.
// - Paths may be internal URIs (`xd://`, `agent://`, `local://`, ...), carry line
//   selectors (`file.ts:39-121`), or hold several `;`-separated paths. URIs and files
//   inside the transcript's own session directory are not workspace files and are dropped.
const TOOL_TYPE_MAP: Record<string, FileOperationType> = {
  read: 'read',
  edit: 'edit',
  write: 'write',
  grep: 'grep',
  ls: 'read',
  find: 'glob',
  glob: 'glob',
};

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const SELECTOR_SUFFIX = /(?::(?:raw|img|conflicts|-?\d[\d,+-]*))+$/;
const GLOB_CHARS = /[*?[{]/;

export interface PiFileOperationContext {
  /** Session working directory; relative tool paths resolve against it. */
  cwd?: string;
  /** Directory that holds this transcript family; files inside it are session-local artifacts (omp `local://`), not workspace files. */
  sessionDir?: string;
}

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

function normalizePath(raw: string, ctx: PiFileOperationContext): string | undefined {
  let p = raw.trim();
  if (!p) return undefined;

  if (p.startsWith('file://')) {
    p = p.slice('file://'.length);
  } else if (URI_SCHEME.test(p)) {
    return undefined;
  }

  p = p.replace(SELECTOR_SUFFIX, '');
  if (!p) return undefined;

  if (!isAbsolute(p) && ctx.cwd) {
    p = resolve(ctx.cwd, p);
  }

  if (ctx.sessionDir && (p === ctx.sessionDir || p.startsWith(ctx.sessionDir + sep))) {
    return undefined;
  }

  return p;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((v): v is string => typeof v === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function withPath(op: FileOperation, path: string): FileOperation {
  op.path = path;
  op.format = extractFormat(path);
  op.language = detectLanguage(path);
  return op;
}

function splitPaths(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return raw
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

function extractEditOperations(
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  ctx: PiFileOperationContext
): FileOperation[] {
  const perFile = details?.perFileResults;
  const items: Array<{ path?: string; diff: unknown; op: unknown }> = [];

  if (Array.isArray(perFile) && perFile.length > 0) {
    for (const item of perFile) {
      const rec = asRecord(item);
      if (!rec) continue;
      items.push({
        path: firstString(rec.path, rec.filePath, rec.file_path),
        diff: rec.diff ?? rec.patch,
        op: rec.op,
      });
    }
  } else {
    items.push({
      path: firstString(
        args?.path,
        args?.filePath,
        args?.file_path,
        details?.path,
        details?.filePath,
        details?.file_path
      ),
      diff: details?.diff ?? details?.patch,
      op: details?.op,
    });
  }

  const operations: FileOperation[] = [];
  for (const item of items) {
    const path = item.path === undefined ? undefined : normalizePath(item.path, ctx);
    if (!path) continue;

    const operation = withPath({ type: item.op === 'delete' ? 'delete' : 'edit' }, path);
    const { linesAdded, linesRemoved } = countPiDiffLines(item.diff);
    if (linesAdded > 0) operation.linesAdded = linesAdded;
    if (linesRemoved > 0) operation.linesRemoved = linesRemoved;
    operations.push(operation);
  }
  return operations;
}

function extractWriteOperations(
  args: Record<string, unknown> | undefined,
  details: Record<string, unknown> | undefined,
  ctx: PiFileOperationContext
): FileOperation[] {
  const argPath = args?.path;
  if (typeof argPath === 'string' && URI_SCHEME.test(argPath) && !argPath.startsWith('file://')) {
    return [];
  }

  const raw = firstString(
    details?.resolvedPath,
    args?.path,
    args?.filePath,
    args?.file_path,
    details?.path
  );
  const path = raw === undefined ? undefined : normalizePath(raw, ctx);
  if (!path) return [];

  const operation = withPath({ type: 'write' }, path);
  const content = args?.content;
  if (typeof content === 'string' && content.length > 0) {
    operation.linesAdded = countContentLines(content);
  }
  return [operation];
}

/**
 * Build file-operation records for a Pi / omp tool call. Returns [] when the tool is not a
 * tracked file/search tool or no workspace path survives normalization.
 */
export function extractPiFileOperations(
  toolName: string,
  toolArguments?: Record<string, unknown>,
  toolResultDetails?: Record<string, unknown>,
  context: PiFileOperationContext = {}
): FileOperation[] {
  const type = TOOL_TYPE_MAP[toolName];
  if (!type) {
    logger.debug(`[pi-file-ops] No file-operation mapping for tool: ${toolName}`);
    return [];
  }

  if (toolName === 'edit') return extractEditOperations(toolArguments, toolResultDetails, context);
  if (toolName === 'write') return extractWriteOperations(toolArguments, toolResultDetails, context);

  const parts = splitPaths(toolArguments?.path ?? toolResultDetails?.path);
  const pattern = typeof toolArguments?.pattern === 'string' ? toolArguments.pattern : undefined;

  if (type === 'read') {
    const operations: FileOperation[] = [];
    for (const part of parts) {
      if (GLOB_CHARS.test(part)) continue;
      const path = normalizePath(part, context);
      if (path) operations.push(withPath({ type }, path));
    }
    return operations;
  }

  // grep | glob | find
  if (parts.length === 0) {
    return [pattern === undefined ? { type } : { type, pattern }];
  }

  const operations: FileOperation[] = [];
  for (const part of parts) {
    if (GLOB_CHARS.test(part)) {
      operations.push({ type, pattern: pattern ?? part });
      continue;
    }
    const path = normalizePath(part, context);
    if (!path) continue;
    const operation = withPath({ type }, path);
    if (pattern !== undefined) operation.pattern = pattern;
    operations.push(operation);
  }
  return operations;
}
