/**
 * Best-effort TypeScript shapes for Pi session JSONL entries.
 *
 * Based on Pi's public message/session types, but kept local so the plugin
 * does not depend on the upstream Pi packages.
 */

export interface PiEntryBase {
  type: string;
  id: string;
  seq: number;
  parentId: string | null;
  timestamp: number;
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
  isError?: boolean;
  timestamp: number;
}

export type PiAgentMessage = PiUserMessage | PiAssistantMessage | PiToolResultMessage;

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
  return entry.type === 'message' && 'message' in entry && entry.message !== undefined;
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
