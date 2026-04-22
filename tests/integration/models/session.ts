import { z } from 'zod';

const CorrelationSchema = z.object({
  status: z.string(),
  agentSessionId: z.string(),
  agentSessionFile: z.string(),
  retryCount: z.number().int().gte(0),
}).passthrough();

const SyncMetricsSchema = z.object({
  lastProcessedTimestamp: z.number().int(),
  processedRecordIds: z.array(z.string()),
  totalDeltas: z.number().int(),
  totalSynced: z.number().int().gte(0),
  totalFailed: z.literal(0),
}).passthrough();

const SyncConversationsSchema = z.object({
  lastSyncedMessageUuid: z.string(),
  lastSyncedHistoryIndex: z.number().int(),
  totalMessagesSynced: z.number().int().gt(0),
  totalSyncAttempts: z.number().int(),
  conversationId: z.string(),
  lastSyncAt: z.number().int(),
}).passthrough();

const SyncSchema = z.object({
  metrics: SyncMetricsSchema,
  conversations: SyncConversationsSchema,
}).passthrough();

export const SessionDataSchema = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  provider: z.string(),
  startTime: z.number().int().gt(0),
  workingDirectory: z.string(),
  status: z.literal('completed'),
  activeDurationMs: z.number().int().gt(0),
  correlation: CorrelationSchema,
  sync: SyncSchema,
  reason: z.string(),
  endTime: z.number().int().gt(0),
}).passthrough();

export type SessionData = z.infer<typeof SessionDataSchema>;
