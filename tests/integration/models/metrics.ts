import { z } from 'zod';

const FileOperationSchema = z.object({
  format: z.string(),
  language: z.string(),
  path: z.string(),
  type: z.string(),
  linesAdded: z.number().int().gt(0),
}).passthrough();

const UserPromptSchema = z.object({
  count: z.number().int().gt(0),
  text: z.string(),
}).passthrough();

export const MetricsRecordSchema = z.object({
  agentSessionId: z.string(),
  fileOperations: z.array(FileOperationSchema).min(1),
  gitBranch: z.string(),
  models: z.array(z.string()).min(1),
  recordId: z.string(),
  sessionId: z.string(),
  syncAttempts: z.number().int().gt(0),
  syncStatus: z.literal('synced'),
  syncedAt: z.number().int().gt(0),
  timestamp: z.string(),
  toolStatus: z.record(z.string(), z.unknown()),
  tools: z.record(z.string(), z.unknown()),
  userPrompts: z.array(UserPromptSchema).min(1),
}).passthrough();

export type MetricsRecord = z.infer<typeof MetricsRecordSchema>;
