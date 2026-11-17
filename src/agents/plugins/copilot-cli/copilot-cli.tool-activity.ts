import type {
  CopilotEvent,
  CopilotToolCompleteData,
  CopilotToolStartData,
} from './copilot-cli-event-types.js';

/**
 * Copilot tools that write to disk. `view` also carries a `path` but is a read, and the
 * aggregator excludes reads from the changed-files metrics.
 */
export const FILE_WRITE_TOOLS: ReadonlySet<string> = new Set(['create', 'edit', 'str_replace_editor', 'apply_patch']);

const PATCH_FILE_HEADER_RE = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
// Renames a file already opened by `*** Update File:`; it does not start a new file block.
const PATCH_MOVE_TO_RE = /^\*\*\* Move to: (.+)$/;

/**
 * Files written by an `apply_patch` call, from the `*** Add|Update|Delete File:` headers of its
 * patch envelope, each with its own `+`/`-` line counts (lines between its header and the next
 * header or `*** End Patch`). A `*** Move to:` line renames the file an `*** Update File:` block
 * already opened, so the operation is reported under its new path. The patch is the raw argument
 * string or a string field of the arguments object. Mirrors Codex's `fileOpsFromPatch`
 * (`codex-metrics-extractor.ts`), the same `apply_patch` envelope format.
 */
export function extractPatchFiles(toolArgs: unknown): CopilotFileOperation[] {
  const texts = typeof toolArgs === 'string'
    ? [toolArgs]
    : typeof toolArgs === 'object' && toolArgs !== null
      ? Object.values(toolArgs).filter((v): v is string => typeof v === 'string')
      : [];
  const files: CopilotFileOperation[] = [];
  for (const text of texts) {
    let current: CopilotFileOperation | null = null;
    let added = 0;
    let removed = 0;
    const flush = (): void => {
      if (current) {
        current.linesAdded = added;
        current.linesRemoved = removed;
        files.push(current);
      }
      current = null;
      added = 0;
      removed = 0;
    };
    for (const line of text.split('\n')) {
      const header = PATCH_FILE_HEADER_RE.exec(line.trim());
      if (header) {
        flush();
        current = { type: header[1] === 'Add' ? 'write' : header[1] === 'Delete' ? 'delete' : 'edit', path: header[2].trim() };
        continue;
      }
      const moveTo = PATCH_MOVE_TO_RE.exec(line.trim());
      if (moveTo && current) {
        current.path = moveTo[1].trim();
        continue;
      }
      if (!current) continue;
      // Unlike a unified diff, the apply_patch envelope has no `+++`/`---` file headers, so every
      // `+`/`-` body line counts, including a removed `---` delimiter or an added `++` token.
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
    flush();
  }
  return files;
}

/** Files a write tool call targets: `args.path`, or the patch headers for `apply_patch`. */
function writeTargets(toolName: string, toolArgs: unknown): CopilotFileOperation[] {
  if (toolName === 'apply_patch') return extractPatchFiles(toolArgs);
  const path = typeof toolArgs === 'object' && toolArgs !== null ? (toolArgs as { path?: unknown }).path : undefined;
  if (typeof path !== 'string' || path.length === 0) return [];
  return [{ type: toolName === 'create' ? 'write' : 'edit', path }];
}

export interface OpenToolCall {
  name: string;
  /** Files the call writes; empty for reads and non-file tools. */
  files?: CopilotFileOperation[];
}

export interface CopilotFileOperation {
  type: 'write' | 'edit' | 'delete';
  path: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CopilotToolActivity {
  tools: Record<string, number>;
  toolStatus: Record<string, { success: number; failure: number }>;
  fileOperations: CopilotFileOperation[];
  /** Calls started but not completed in `events`; seed the next incremental slice with them. */
  openCalls: Record<string, OpenToolCall>;
}

/**
 * Pairs `tool.execution_start` (the only event carrying the tool name and arguments) with
 * `tool.execution_complete` (toolCallId plus a boolean success) by id.
 */
export function extractCopilotToolActivity(
  events: CopilotEvent[],
  seedOpenCalls: Record<string, OpenToolCall> = {}
): CopilotToolActivity {
  const tools: Record<string, number> = {};
  const toolStatus: Record<string, { success: number; failure: number }> = {};
  const fileOperations: CopilotFileOperation[] = [];
  const toolCallById = new Map<string, OpenToolCall>(Object.entries(seedOpenCalls));

  for (const event of events) {
    if (event.type === 'tool.execution_start') {
      const data = (event.data ?? {}) as CopilotToolStartData;
      if (data.toolCallId && data.toolName) {
        const files = FILE_WRITE_TOOLS.has(data.toolName) ? writeTargets(data.toolName, data.arguments) : [];
        toolCallById.set(data.toolCallId, { name: data.toolName, ...(files.length > 0 && { files }) });
      }
    } else if (event.type === 'tool.execution_complete') {
      const data = (event.data ?? {}) as CopilotToolCompleteData;
      const call = data.toolCallId ? toolCallById.get(data.toolCallId) : undefined;
      if (!call) {
        continue; // orphaned completion (truncated transcript)
      }
      toolCallById.delete(data.toolCallId as string);
      tools[call.name] = (tools[call.name] ?? 0) + 1;
      const bucket = toolStatus[call.name] ?? { success: 0, failure: 0 };
      const failed = data.success === false || data.error !== undefined;
      bucket[failed ? 'failure' : 'success'] += 1;
      toolStatus[call.name] = bucket;

      // A failed edit/create must not count as a changed file.
      if (!failed && call.files) fileOperations.push(...call.files);
    }
  }

  return { tools, toolStatus, fileOperations, openCalls: Object.fromEntries(toolCallById) };
}
