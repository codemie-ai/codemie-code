import { z } from 'zod';

const FileOperationSchema = z.object({
  format: z.string(),
  language: z.string(),
  path: z.string(),
  type: z.string(),
  linesAdded: z.number().int(),
}).passthrough();

const UserPromptSchema = z.object({
  count: z.number().int(),
  text: z.string(),
}).passthrough();

export const MetricsRecordSchema = z.object({
  agentSessionId: z.string(),
  fileOperations: z.array(FileOperationSchema),
  gitBranch: z.string(),
  models: z.array(z.string()),
  recordId: z.string(),
  sessionId: z.string(),
  syncAttempts: z.number().int(),
  syncStatus: z.string(),
  syncedAt: z.number().int().optional(), // absent when SSO sync has not run (e.g. JWT mode)
  timestamp: z.string(),
  toolStatus: z.record(z.string(), z.unknown()),
  tools: z.record(z.string(), z.unknown()),
  userPrompts: z.array(UserPromptSchema),
}).passthrough();

export type MetricsRecord = z.infer<typeof MetricsRecordSchema>;
