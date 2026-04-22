import { z } from 'zod';

export const UserMessageSchema = z.object({
  date: z.string(),
  file_names: z.array(z.string()),
  history_index: z.number().int(),
  message: z.string(),
  message_raw: z.string(),
  role: z.literal('User'),
}).passthrough();

export const AssistantMessageSchema = z.object({
  assistant_id: z.string(),
  date: z.string(),
  history_index: z.number().int(),
  message: z.string(),
  message_raw: z.string(),
  response_time: z.number().gt(0),
  role: z.literal('Assistant'),
}).passthrough();

const ConversationPayloadSchema = z.object({
  conversationId: z.string(),
  history: z.array(z.record(z.string(), z.unknown())).min(2),
}).passthrough();

export const ConversationRecordSchema = z.object({
  historyIndices: z.array(z.number().int()),
  isTurnContinuation: z.boolean(),
  messageCount: z.number().int().gt(0),
  payload: ConversationPayloadSchema,
  status: z.string(),
  timestamp: z.number().int(),
}).passthrough();

export type UserMessage        = z.infer<typeof UserMessageSchema>;
export type AssistantMessage   = z.infer<typeof AssistantMessageSchema>;
export type ConversationRecord = z.infer<typeof ConversationRecordSchema>;
