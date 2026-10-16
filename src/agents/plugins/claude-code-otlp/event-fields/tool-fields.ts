export interface ToolContextFields {
  file_path: string;
  subagent_type: string;
  description: string;
  skill_name: string;
}

export interface ToolDiffFields {
  lines_added: number;
  lines_removed: number;
}

export function resolveToolContextFields(toolName: string, toolInput: unknown): ToolContextFields {
  const filePathKey = FILE_PATH_KEY_BY_TOOL[toolName];
  const isAgentDispatch = AGENT_DISPATCH_TOOLS.has(toolName);
  return {
    file_path: filePathKey ? readString(toolInput, filePathKey) : '',
    subagent_type: isAgentDispatch ? readString(toolInput, 'subagent_type') : '',
    description: isAgentDispatch ? readString(toolInput, 'description') : '',
    skill_name: toolName === 'Skill' ? readString(toolInput, 'skill') : '',
  };
}

/**
 * Write's `structuredPatch` is empty for a brand-new file (nothing to diff against), so it falls
 * back to counting the written content's lines instead, matching `claude-file-operation.ts`.
 */
export function resolveToolDiffFields(toolName: string, toolInput: unknown, toolResponse: unknown): ToolDiffFields {
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const counts = countStructuredPatch(readField(toolResponse, 'structuredPatch'));
    return { lines_added: counts?.added ?? 0, lines_removed: counts?.removed ?? 0 };
  }
  if (toolName === 'Write') {
    const patch = readField(toolResponse, 'structuredPatch');
    const counts = Array.isArray(patch) && patch.length > 0 ? countStructuredPatch(patch) : null;
    if (counts) {
      return { lines_added: counts.added, lines_removed: counts.removed };
    }
    const content = readString(toolInput, 'content');
    return { lines_added: content ? content.split('\n').length : 0, lines_removed: 0 };
  }
  return { lines_added: 0, lines_removed: 0 };
}

/** `tool_name` -> which `tool_input` key holds the file path. */
const FILE_PATH_KEY_BY_TOOL: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** This CLI's own name for the subagent-dispatch tool is `Agent`; standard Claude Code uses `Task`. */
const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

function readField(record: unknown, key: string): unknown {
  return record && typeof record === 'object' ? (record as Record<string, unknown>)[key] : undefined;
}

function readString(record: unknown, key: string): string {
  const value = readField(record, key);
  return typeof value === 'string' ? value : '';
}

interface StructuredPatchHunk {
  lines?: unknown[];
}

/** `null` when `patch` carries no structuredPatch array at all, as opposed to a verified-empty one. */
function countStructuredPatch(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) {
    return null;
  }
  let added = 0;
  let removed = 0;
  for (const hunk of patch as StructuredPatchHunk[]) {
    for (const line of hunk?.lines ?? []) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  return { added, removed };
}
