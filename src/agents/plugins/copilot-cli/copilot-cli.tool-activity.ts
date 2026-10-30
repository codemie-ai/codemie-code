import type {
  CopilotEvent,
  CopilotToolCompleteData,
  CopilotToolStartData,
} from './copilot-cli-event-types.js';

/**
 * Copilot tools that write to disk. `view` also carries a `path` but is a read, and the
 * aggregator excludes reads from the changed-files metrics.
 */
const FILE_WRITE_TOOLS = new Set(['create', 'edit']);

export interface CopilotFileOperation {
  type: 'write' | 'edit';
  path: string;
  linesAdded?: number;
  linesRemoved?: number;
}

export interface CopilotToolActivity {
  tools: Record<string, number>;
  toolStatus: Record<string, { success: number; failure: number }>;
  fileOperations: CopilotFileOperation[];
}

/**
 * Pairs `tool.execution_start` (the only event carrying the tool name and arguments) with
 * `tool.execution_complete` (toolCallId plus a boolean success) by id.
 */
export function extractCopilotToolActivity(events: CopilotEvent[]): CopilotToolActivity {
  const tools: Record<string, number> = {};
  const toolStatus: Record<string, { success: number; failure: number }> = {};
  const fileOperations: CopilotFileOperation[] = [];
  const toolCallById = new Map<string, { name: string; path?: string }>();

  for (const event of events) {
    if (event.type === 'tool.execution_start') {
      const data = (event.data ?? {}) as CopilotToolStartData;
      if (data.toolCallId && data.toolName) {
        toolCallById.set(data.toolCallId, { name: data.toolName, path: data.arguments?.path });
      }
    } else if (event.type === 'tool.execution_complete') {
      const data = (event.data ?? {}) as CopilotToolCompleteData;
      const call = data.toolCallId ? toolCallById.get(data.toolCallId) : undefined;
      if (!call) {
        continue; // orphaned completion (truncated transcript)
      }
      tools[call.name] = (tools[call.name] ?? 0) + 1;
      const bucket = toolStatus[call.name] ?? { success: 0, failure: 0 };
      const failed = data.success === false || data.error !== undefined;
      bucket[failed ? 'failure' : 'success'] += 1;
      toolStatus[call.name] = bucket;

      // A failed edit/create must not count as a changed file.
      if (!failed && call.path && FILE_WRITE_TOOLS.has(call.name)) {
        fileOperations.push({ type: call.name === 'create' ? 'write' : 'edit', path: call.path });
      }
    }
  }

  return { tools, toolStatus, fileOperations };
}
