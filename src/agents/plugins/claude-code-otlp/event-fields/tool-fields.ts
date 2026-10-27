import { MAX_TOOL_FIELD_CHARS } from '@/agents/core/OtlpAgentAdapter.js';
import { countContentLines } from '../content-lines.js';

export interface ToolContextFields {
  file_path: string;
  subagent_type: string;
  description: string;
  skill_name: string;
}

export interface ToolDiffFields {
  /** Omitted (not `0`) when this tool's diff is unknown — see {@link resolveToolDiffFields}. */
  lines_added?: number;
  lines_removed?: number;
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
 * Line counts for `agent.tool.end`, or no keys at all when the tool's diff is unknown: an unknown
 * value is never reported as `0` (contract rule 4), since the backend cannot tell it apart from a
 * real zero-line change. Only `Edit`/`MultiEdit`/`Write` produce a diff; every other tool omits
 * `lines_added`/`lines_removed`.
 *
 * A Write with a non-empty `structuredPatch` is counted by its patch. An overwrite (`type: 'update'`)
 * with an empty patch changed nothing and counts as `0`. Otherwise — a brand-new file, whose patch is
 * empty because there is nothing to diff against — it counts the written content's lines, matching
 * `claude-file-operation.ts`.
 */
export function resolveToolDiffFields(toolName: string, toolInput: unknown, toolResponse: unknown): ToolDiffFields {
  if (toolName === 'Edit' || toolName === 'MultiEdit') {
    const counts = countStructuredPatch(readField(toolResponse, 'structuredPatch'));
    return counts ? { lines_added: counts.added, lines_removed: counts.removed } : {};
  }
  if (toolName === 'Write') {
    const patch = readField(toolResponse, 'structuredPatch');
    const counts = Array.isArray(patch) && patch.length > 0 ? countStructuredPatch(patch) : null;
    if (counts) {
      return { lines_added: counts.added, lines_removed: counts.removed };
    }
    if (readField(toolResponse, 'type') === 'update' && Array.isArray(patch)) {
      return { lines_added: 0, lines_removed: 0 };
    }
    const content = readField(toolInput, 'content');
    // A Write never removes lines; its added count comes from the content it wrote. No content
    // string means the count is unknown, so omit it rather than report zero.
    return typeof content === 'string' ? { lines_added: countContentLines(content), lines_removed: 0 } : {};
  }
  return {};
}

/**
 * The fork a `Skill` call started, as `{ fork_agent_id }` for its `agent.tool.end`, or `{}` for any
 * other tool or a result without a non-empty string `agentId` (an inline skill's result has none).
 * The backend pairs a Skill call with its fork by this id; it is read here from the uncut result
 * because the base class cuts `tool_response` to {@link MAX_TOOL_FIELD_CHARS}, and a long skill name
 * pushes `agentId` past that cut. The hook's typed `agent_id` names the caller, never the fork.
 */
export function resolveSkillForkFields(toolName: string, toolResponse: unknown): { fork_agent_id?: string } {
  if (toolName !== 'Skill') {
    return {};
  }
  const agentId = readString(parseJsonObject(toolResponse), 'agentId');
  return agentId ? { fork_agent_id: agentId.slice(0, MAX_TOOL_FIELD_CHARS) } : {};
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

/** `value` itself, or the value its JSON text parses to; `undefined` for text that is not JSON. */
function parseJsonObject(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
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
