export { SessionDataSchema, type SessionData } from './session.js';
export { MetricsRecordSchema } from './metrics.js';
export { ConversationRecordSchema, UserMessageSchema, AssistantMessageSchema } from './conversation.js';

import { z } from 'zod';

/**
 * Parse and validate data against a Zod schema.
 * Throws a descriptive error listing all validation failures if the data
 * does not conform, making test assertion failures easy to diagnose.
 */
export function validateSchema<T>(schema: z.ZodType<T>, data: unknown, label: string): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map(e => `  [${e.path.join('.')}] ${e.message}`)
      .join('\n');
    throw new Error(`${label} failed schema validation:\n${errors}`);
  }
  return result.data;
}
