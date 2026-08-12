/**
 * Best-effort TypeScript shapes for Pi session JSONL entries.
 *
 * Based on the shipped Pi CLI's v3 session format
 * (packages/coding-agent/src/core/session-manager.ts), not the v4 harness format.
 * Kept local so the plugin does not depend on the upstream Pi packages.
 */

export interface PiSessionHeader {
  type: 'session';
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface PiEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface PiTextContent {
  type: 'text';
  text: string;
}

/** An image block, carried alongside text wherever Pi accepts rich content. */
export interface PiImageContent {
  type: 'image';
  data: string;
  mimeType: string;
}

export interface PiToolCall {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface PiUserMessage {
  role: 'user';
  content: string | (PiTextContent | unknown)[];
  timestamp: number;
}

export interface PiAssistantMessage {
  role: 'assistant';
  content: (PiTextContent | PiToolCall | unknown)[];
  model?: string;
  usage?: Record<string, unknown>;
  stopReason?: string;
  errorMessage?: string;
  timestamp: number;
}

export interface PiToolResultMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (PiTextContent | unknown)[] | unknown;
  details?: Record<string, unknown>;
  usage?: Record<string, unknown>;
  isError: boolean;
  timestamp: number;
}

/**
 * A `!command` shell escape the user ran directly, without the model. Pi persists the
 * command and its full output rather than a tool call/result pair.
 */
export interface PiBashExecutionMessage {
  role: 'bashExecution';
  command: string;
  output: string;
  /** Absent when the command was cancelled before it could report a status. */
  exitCode?: number;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  /** True for `!!`-prefixed commands, whose output is withheld from the model. */
  excludeFromContext?: boolean;
  timestamp: number;
}

/**
 * A message an extension injected through `sendMessage()`. `customType` is the extension's
 * own tag; the shape of `details` is whatever that extension defined.
 */
export interface PiCustomMessage {
  role: 'custom';
  customType: string;
  content: string | (PiTextContent | PiImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

/** Written when the conversation returns from a branch. `summary` is conversation content. */
export interface PiBranchSummaryMessage {
  role: 'branchSummary';
  summary: string;
  fromId: string;
  timestamp: number;
}

/** Written when Pi compacts history. `summary` is conversation content. */
export interface PiCompactionSummaryMessage {
  role: 'compactionSummary';
  summary: string;
  tokensBefore: number;
  timestamp: number;
}

/**
 * Every role Pi can persist under a `message` entry.
 *
 * Mirrors upstream's `AgentMessage` — the base LLM roles plus the four the coding agent
 * declaration-merges into `CustomAgentMessages` (`core/messages.ts`). The last three are
 * not read anywhere yet and every consumer skips them, but they must be in the union
 * anyway: the guards below are declared over it, so a union narrower than the data makes
 * any future exhaustive branch unsound — and two of these carry conversation text that
 * must be handled deliberately rather than by falling through.
 */
export type PiAgentMessage =
  | PiUserMessage
  | PiAssistantMessage
  | PiToolResultMessage
  | PiBashExecutionMessage
  | PiCustomMessage
  | PiBranchSummaryMessage
  | PiCompactionSummaryMessage;

export interface PiMessageEntry extends PiEntryBase {
  type: 'message';
  message: PiAgentMessage;
}

/** Written when the user switches models mid-session, e.g. through `/model`. */
export interface PiModelChangeEntry extends PiEntryBase {
  type: 'model_change';
  modelId: string;
  provider?: string;
}

export type PiEntry = PiMessageEntry | PiModelChangeEntry | PiEntryBase;

export function isPiMessageEntry(entry: PiEntry): entry is PiMessageEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    entry.type === 'message' &&
    'message' in entry &&
    entry.message !== null &&
    typeof entry.message === 'object'
  );
}

export function isPiUserMessage(message: PiAgentMessage): message is PiUserMessage {
  return message.role === 'user';
}

export function isPiAssistantMessage(message: PiAgentMessage): message is PiAssistantMessage {
  return message.role === 'assistant';
}

export function isPiToolResultMessage(message: PiAgentMessage): message is PiToolResultMessage {
  return message.role === 'toolResult';
}

export function isPiBashExecutionMessage(message: PiAgentMessage): message is PiBashExecutionMessage {
  return message.role === 'bashExecution';
}

export function isPiModelChangeEntry(entry: PiEntry): entry is PiModelChangeEntry {
  return (
    entry !== null &&
    typeof entry === 'object' &&
    entry.type === 'model_change' &&
    typeof (entry as PiModelChangeEntry).modelId === 'string' &&
    (entry as PiModelChangeEntry).modelId.length > 0
  );
}

/**
 * Normalize the tool calls carried by an assistant message.
 *
 * Shared by the metrics processor and the named-invocation extractor so both tolerate
 * the same two serializations: the flat `{type:'toolCall', id, name}` the Pi runtime
 * writes, and a defensive `{type:'toolCall', toolCall:{...}}` wrapper in case a Pi
 * version or provider nests it.
 */
export function extractPiToolCalls(message: PiAssistantMessage): PiToolCall[] {
  if (!Array.isArray(message.content)) {
    return [];
  }

  return message.content
    .map((part): PiToolCall | undefined => {
      if (typeof part !== 'object' || part === null) {
        return undefined;
      }

      const flat = part as PiToolCall;
      if (flat.type === 'toolCall' && typeof flat.id === 'string' && typeof flat.name === 'string') {
        return flat;
      }

      const nested = (part as { type?: string; toolCall?: PiToolCall }).toolCall;
      if (nested && typeof nested.id === 'string' && typeof nested.name === 'string') {
        return nested;
      }

      return undefined;
    })
    .filter((toolCall): toolCall is PiToolCall => toolCall !== undefined);
}

export function isPiSessionHeader(value: unknown): value is PiSessionHeader {
  if (!value || typeof value !== 'object') return false;
  const header = value as Record<string, unknown>;
  return (
    header.type === 'session' &&
    typeof header.id === 'string' &&
    header.id.length > 0 &&
    typeof header.timestamp === 'string' &&
    typeof header.cwd === 'string'
  );
}
