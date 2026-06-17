/**
 * Shared types for Kimi Code `wire.jsonl` session events.
 */

export interface KimiUsage {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

export type KimiDisplayOperation = 'read' | 'write' | 'edit' | 'delete';

export interface KimiWireEventDisplay {
  kind?: string;
  operation?: KimiDisplayOperation;
  path?: string;
  content?: string;
  before?: string;
  after?: string;
}

export interface KimiLoopEvent {
  type?: string;
  uuid?: string;
  turnId?: string;
  step?: number;
  stepUuid?: string;
  toolCallId?: string;
  parentUuid?: string;
  name?: string;
  args?: Record<string, unknown>;
  description?: string;
  result?: {
    output?: string;
    isError?: boolean;
  };
  usage?: KimiUsage;
  finishReason?: string;
  /**
   * Display metadata for loop events (e.g. file_io for tool calls).
   * In real wire.jsonl output this is nested inside the event object,
   * not at the top-level wire event.
   */
  display?: KimiWireEventDisplay;
}

export interface KimiWireEvent {
  type: string;
  time?: number;
  // metadata
  protocol_version?: string;
  created_at?: number;
  app_version?: string;
  // config.update
  profileName?: string;
  systemPrompt?: string;
  modelAlias?: string;
  thinkingLevel?: string;
  // usage.record
  model?: string;
  usage?: KimiUsage;
  usageScope?: string;
  // turn.prompt
  input?: Array<{ type?: string; text?: string }>;
  origin?: { kind?: string };
  // context.append_message
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
    toolCalls?: unknown[];
    origin?: { kind?: string };
  };
  // context.append_loop_event
  event?: KimiLoopEvent;
  /**
   * @deprecated Real Kimi wire.jsonl puts display inside `event.display`.
   * Keep for backward compatibility with old fixtures/tests only.
   */
  display?: KimiWireEventDisplay;
}
