/**
 * Shared types for Kimi Code `wire.jsonl` session events.
 */

export interface KimiUsage {
  inputOther?: number;
  output?: number;
  inputCacheRead?: number;
  inputCacheCreation?: number;
}

export type KimiDisplayOperation = 'read' | 'write' | 'edit';

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
  // context.append_loop_event
  event?: KimiLoopEvent;
  display?: KimiWireEventDisplay;
}
