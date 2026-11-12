import { MAX_TOOL_FIELD_CHARS } from '@/agents/core/OtlpAgentAdapter.js';
import { countContentLines } from '@/utils/file-operations.js';

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
 * The agent a `Skill` or `Agent` call started, as `{ fork_agent_id }` for its `agent.tool.end`, or
 * `{}` for any other tool or a result without a non-empty string `agentId` (an inline skill's result
 * has none; neither has a failed or denied Agent call). The backend pairs a call with its agent by
 * this id; it is read here from the uncut result because the base class cuts `tool_response` to
 * {@link MAX_TOOL_FIELD_CHARS}, and a long skill name or an echoed Agent prompt pushes `agentId` past
 * that cut. The hook's typed `agent_id` names the caller, never the started agent.
 *
 * A `Skill` result may arrive as an object or as JSON text. An `Agent` result is an object whose
 * `agentId` is a top-level key (captured from a real foreground run), so JSON text is not read for it.
 */
export function resolveForkAgentFields(toolName: string, toolResponse: unknown): { fork_agent_id?: string } {
  let agentId = '';
  if (toolName === 'Skill') {
    agentId = readString(parseJsonObject(toolResponse), 'agentId');
  } else if (AGENT_RESULT_ID_TOOLS.has(toolName)) {
    agentId = readString(toolResponse, 'agentId');
  }
  return agentId ? { fork_agent_id: agentId.slice(0, MAX_TOOL_FIELD_CHARS) } : {};
}

/** Directories whose whole contents are credential material. */
const SENSITIVE_DIRECTORIES = new Set(['.aws', '.ssh', '.gnupg', '.kube', '.docker']);

/** Exact (lower-cased) file names that hold credentials. */
const SENSITIVE_FILE_NAMES = new Set(['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.pgpass', '.htpasswd']);

/** Lower-cased file-name prefixes that mark credential files (`.env.local`, `id_rsa.pub`, `credentials.json`). */
const SENSITIVE_FILE_PREFIXES = [
  '.env', 'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', 'credentials', 'secrets.',
];

/** Lower-cased file extensions that mark key material. */
const SENSITIVE_FILE_EXTENSIONS = ['.pem', '.key', '.p12', '.pfx', '.ppk', '.jks', '.keystore', '.tfvars'];

/**
 * True for a path that very likely holds credentials, so a Read of it must not forward its
 * content. Case-insensitive; accepts `\` and `/` separators.
 */
export function isSensitiveFilePath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]+/).filter((segment) => segment.length > 0);
  const name = segments.pop() ?? '';
  return (
    segments.some((directory) => SENSITIVE_DIRECTORIES.has(directory)) ||
    SENSITIVE_FILE_NAMES.has(name) ||
    SENSITIVE_FILE_PREFIXES.some((prefix) => name.startsWith(prefix)) ||
    SENSITIVE_FILE_EXTENSIONS.some((extension) => name.endsWith(extension))
  );
}

/** `tool_name` -> which `tool_input` key holds the file path. */
const FILE_PATH_KEY_BY_TOOL: Record<string, string> = {
  Edit: 'file_path',
  Write: 'file_path',
  MultiEdit: 'file_path',
  NotebookEdit: 'notebook_path',
};

/** Every tool that reads or writes file content -> the `tool_input` key holding its path. */
const FILE_CONTENT_TOOL_PATH_KEYS: ReadonlyMap<string, string> = new Map([
  ['Read', 'file_path'],
  ...Object.entries(FILE_PATH_KEY_BY_TOOL),
]);

/**
 * The tool hook payload as it may be forwarded. A call that reads or writes a credentials file
 * (Read, Edit, MultiEdit, Write, NotebookEdit) keeps `tool_name` and the path, and loses everything
 * that can hold the file's content: `tool_input` shrinks to the path, `tool_response` is dropped,
 * and so is a failure's `error`, which can echo the text being edited. Any other call is unchanged.
 */
export function withoutSensitiveFileContent(hookInput: { tool_name: string; tool_input?: unknown }): Record<string, unknown> {
  const forwarded: Record<string, unknown> = { ...hookInput };
  const pathKey = FILE_CONTENT_TOOL_PATH_KEYS.get(hookInput.tool_name);
  const path = pathKey ? readString(hookInput.tool_input, pathKey) : '';
  if (pathKey && path && isSensitiveFilePath(path)) {
    forwarded['tool_input'] = { [pathKey]: path };
    delete forwarded['tool_response'];
    delete forwarded['error'];
  }
  return forwarded;
}

/** This CLI's own name for the subagent-dispatch tool is `Agent`; standard Claude Code uses `Task`. */
const AGENT_DISPATCH_TOOLS = new Set(['Agent', 'Task']);

/**
 * Dispatch tools whose result carries the started agent's id, so `agent.tool.end` is stamped with it.
 * `Task` is deliberately left out (decision A2): its results are not stamped or read, and its rows keep
 * the backend's parent-window estimate.
 */
const AGENT_RESULT_ID_TOOLS: ReadonlySet<string> = new Set(['Agent']);

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
