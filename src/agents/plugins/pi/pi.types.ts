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

export interface PiBashExecutionMessage {
  role: 'bashExecution';
  content: unknown;
  timestamp: number;
}

export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage | PiBashExecutionMessage;

export interface PiMessageEntry extends PiEntryBase {
  type: 'message';
  message: PiAgentMessage;
}

export interface PiModelChangeEntry extends PiEntryBase {
  type: 'model_change';
  modelId: string;
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
