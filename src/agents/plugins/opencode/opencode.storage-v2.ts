/**
 * OpenCode v2 storage → the v1 in-memory shapes the session processors consume.
 *
 * OpenCode v2 keeps a whole message in one `session_message` row: an assistant row carries its
 * text, reasoning and tool calls in `data.content`. OpenCode v1 (still what the built-in
 * codemie-code agent writes) split the same information across `message` and `part` rows.
 * Converting at the reader boundary keeps one set of processors for both.
 */

import type {
  OpenCodeAssistantMessage,
  OpenCodeMessage,
  OpenCodePart,
  OpenCodeToolPart,
} from './opencode-message-types.js';

/** A `session_message` row. Rows of other types (`idle`, switches, …) carry no conversation content. */
export interface V2MessageRow {
  id: string;
  session_id: string;
  type: string;
  data: string; // JSON blob
}

/** The `session_message.type` values that are conversation turns. */
export const V2_CONVERSATION_TYPES = ['user', 'assistant'] as const;

interface V2Time {
  created?: number;
  completed?: number;
}

interface V2TextContent {
  type: 'text' | 'reasoning';
  text?: string;
}

interface V2ToolContent {
  type: 'tool';
  id: string;
  name: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    content?: Array<{ type: string; text?: string }>;
    error?: { message?: string };
    metadata?: Record<string, unknown>;
  };
  time?: { created?: number; ran?: number; completed?: number };
}

type V2Content = V2TextContent | V2ToolContent;

interface V2MessageData {
  time?: V2Time;
  /** User prompt text. */
  text?: string;
  agent?: string;
  model?: { id?: string; providerID?: string };
  content?: V2Content[];
  error?: { type?: string; message?: string };
}

/** v2 adds `streaming` (arguments still arriving); v1 called every not-yet-run tool `pending`. */
const V1_TOOL_STATUS: Record<string, OpenCodeToolPart['state']['status']> = {
  streaming: 'pending',
  running: 'running',
  completed: 'completed',
  error: 'error',
};

function parseData(row: V2MessageRow): V2MessageData {
  return JSON.parse(row.data) as V2MessageData;
}

/** The message of a `user` or `assistant` row. Throws on a malformed JSON blob. */
export function messageFromV2Row(row: V2MessageRow): OpenCodeMessage {
  const data = parseData(row);
  const base = {
    id: row.id,
    sessionID: row.session_id,
    time: {
      created: data.time?.created ?? 0,
      ...(typeof data.time?.completed === 'number' && { completed: data.time.completed }),
    },
  };

  if (row.type !== 'assistant') {
    return { ...base, role: 'user' };
  }

  const assistant: OpenCodeAssistantMessage = {
    ...base,
    role: 'assistant',
    providerID: data.model?.providerID,
    modelID: data.model?.id,
    agent: data.agent,
    ...(data.error && {
      error: { name: data.error.type ?? 'error', data: { message: data.error.message } },
    }),
  };
  return assistant;
}

function toolPart(content: V2ToolContent, ids: { id: string; messageID: string; sessionID: string }): OpenCodeToolPart {
  const { state, time } = content;
  const output = (state.content ?? [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');

  return {
    ...ids,
    type: 'tool',
    callID: content.id,
    tool: content.name,
    state: {
      status: V1_TOOL_STATUS[state.status] ?? 'pending',
      input: state.input,
      ...(output && { output }),
      ...(state.error?.message && { error: state.error.message }),
      ...(state.metadata && { metadata: state.metadata }),
      time: { start: time?.ran ?? time?.created, end: time?.completed },
    },
  };
}

/** The parts of a `user` or `assistant` row, in content order. Throws on a malformed JSON blob. */
export function partsFromV2Row(row: V2MessageRow): OpenCodePart[] {
  const data = parseData(row);
  const idsAt = (index: number) => ({ id: `${row.id}:${index}`, messageID: row.id, sessionID: row.session_id });

  if (row.type !== 'assistant') {
    return data.text ? [{ ...idsAt(0), type: 'text', text: data.text }] : [];
  }

  return (data.content ?? []).flatMap((content, index): OpenCodePart[] => {
    if (content.type === 'tool') {
      return [toolPart(content, idsAt(index))];
    }
    if (content.type === 'text' || content.type === 'reasoning') {
      return [{ ...idsAt(index), type: content.type, text: content.text ?? '' }];
    }
    return [];
  });
}
