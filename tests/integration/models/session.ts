import { z } from 'zod';

const CorrelationSchema = z.object({
  status: z.string(),
  agentSessionId: z.string(),
  agentSessionFile: z.string(),
  retryCount: z.number().int(),
}).passthrough();

const SyncMetricsSchema = z.object({
  lastProcessedTimestamp: z.number().int(),
  processedRecordIds: z.array(z.string()),
  totalDeltas: z.number().int(),
  totalSynced: z.number().int(),
  totalFailed: z.number().int(),
}).passthrough();

const SyncConversationsSchema = z.object({
  lastSyncedMessageUuid: z.string(),
  lastSyncedHistoryIndex: z.number().int(),
  totalMessagesSynced: z.number().int(),
  totalSyncAttempts: z.number().int(),
  conversationId: z.string().optional(), // absent when SSO sync has not run (e.g. JWT mode)
  lastSyncAt: z.number().int().optional(), // absent when SSO sync has not run (e.g. JWT mode)
}).passthrough();

const SyncSchema = z.object({
  metrics: SyncMetricsSchema,
  conversations: SyncConversationsSchema,
}).passthrough();

export const SessionDataSchema = z.object({
  sessionId: z.string(),
  agentName: z.string(),
  provider: z.string(),
  startTime: z.number().int(),
  workingDirectory: z.string(),
  status: z.string(),
  activeDurationMs: z.number().int(),
  correlation: CorrelationSchema,
  sync: SyncSchema,
}).passthrough();

export type SessionData = z.infer<typeof SessionDataSchema>;
