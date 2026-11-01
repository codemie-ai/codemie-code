/**
 * Copilot file operations: the files a run's tool calls and shutdown summary say it changed.
 */

import { isAbsolute, join } from 'path';
import type { ParsedSession } from '../../core/session/BaseSessionAdapter.js';
import type { CopilotToolCompleteData } from './copilot-cli-event-types.js';
import type { ShutdownShare } from './copilot-cli.usage.js';

/**
 * Copilot tools that write to disk. `view` also carries a `path` but is a read, and the
 * aggregator excludes reads from the changed-files metrics.
 */
const FILE_WRITE_TOOLS = new Set(['create', 'edit', 'apply_patch']);

const PATCH_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
const PATCH_OPERATION = { Add: 'write', Update: 'edit', Delete: 'delete' } as const;

type FileOperation = NonNullable<NonNullable<ParsedSession['metrics']>['fileOperations']>[number];

/** A file-writing tool call as its start event names it. */
export interface ToolCall {
  name: string;
  path?: string;
  /** The patch text of an `apply_patch` call. */
  patch?: string;
}

/** A JSON-encoded list of paths from copilot's tool telemetry; anything else is no paths. */
function pathList(value: string | undefined): string[] {
  try {
    const list: unknown = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter((path): path is string => typeof path === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The file operations of one successful file-writing call, never merged into another call's: its
 * telemetry paths (an added path is a write, a deleted one a delete), else an `apply_patch`'s patch
 * headers (a relative path joined to the session's `cwd`, as the telemetry and the shutdown name it),
 * else the tool's `path` argument; a `create` call is always a write; the call's lines go on its first file.
 *
 * ponytail: copilot gives no per-file lines, so a multi-file apply_patch puts all its lines on its first file
 * ponytail: `*** Move to:` is not read, the operation stays on the file its header names
 */
export function callFileOperations(call: ToolCall, data: CopilotToolCompleteData, cwd: string | undefined): FileOperation[] {
  if (!FILE_WRITE_TOOLS.has(call.name)) return [];
  const paths = data.toolTelemetry?.restrictedProperties;
  const added = new Set(pathList(paths?.addedPaths));
  const deleted = new Set(pathList(paths?.deletedPaths));
  const telemetryPaths = pathList(paths?.filePaths);
  let ops: FileOperation[];
  if (telemetryPaths.length > 0) {
    ops = telemetryPaths.map((path) => ({
      type: deleted.has(path) ? 'delete' : added.has(path) || call.name === 'create' ? 'write' : 'edit',
      path,
    }));
  } else if (call.patch !== undefined) {
    ops = [...call.patch.matchAll(PATCH_HEADER)].map(([, kind, header]) => {
      const path = header.trim();
      return { type: PATCH_OPERATION[kind as keyof typeof PATCH_OPERATION], path: cwd && !isAbsolute(path) ? join(cwd, path) : path };
    });
  } else {
    ops = call.path ? [{ type: call.name === 'create' ? 'write' : 'edit', path: call.path }] : [];
  }
  const lines = data.toolTelemetry?.metrics;
  if (ops[0] && (lines?.linesAdded !== undefined || lines?.linesRemoved !== undefined)) {
    ops[0].linesAdded = lines.linesAdded ?? 0;
    ops[0].linesRemoved = lines.linesRemoved ?? 0;
  }
  return ops;
}

/**
 * Files only the run's shutdown share lists join as edits. Its line totals (no per-file split) count
 * only when no call carried its own lines (an older copilot build), on a file it lists as modified —
 * the first tool-derived entry may be a file opened but never changed — else on the first entry.
 */
export function applyShutdownShare(ops: FileOperation[], share: ShutdownShare | undefined): void {
  if (!share) return;
  const callLines = ops.some((op) => op.linesAdded !== undefined || op.linesRemoved !== undefined);
  for (const path of share.filesModified) {
    if (!ops.some((op) => op.path === path)) ops.push({ type: 'edit', path });
  }
  if (callLines || (share.linesAdded === undefined && share.linesRemoved === undefined)) return;
  const modified = new Set(share.filesModified);
  const target = ops.find((op) => op.path !== undefined && modified.has(op.path)) ?? ops[0];
  if (target) {
    target.linesAdded = share.linesAdded ?? 0;
    target.linesRemoved = share.linesRemoved ?? 0;
  }
}
