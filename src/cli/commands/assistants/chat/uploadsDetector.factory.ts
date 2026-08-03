import { logger } from '@/utils/logger.js';
import { SessionStore } from '@/agents/core/session/SessionStore.js';
import { ClaudeUploadsDetector } from './claudeUploadsDetector.js';
import { GeminiUploadsDetector } from './geminiUploadsDetector.js';
import type { UploadsDetector } from './types.js';

export async function createUploadsDetector(
  conversationId?: string
): Promise<UploadsDetector> {
  if (!conversationId) {
    return new ClaudeUploadsDetector();
  }

  try {
    const store = new SessionStore();
    const session = await store.loadSession(conversationId);
    if (session?.agentName === 'gemini') {
      logger.debug('[uploadsDetector.factory] Selecting GeminiUploadsDetector', { conversationId });
      return new GeminiUploadsDetector();
    }
  } catch {
    logger.debug('[uploadsDetector.factory] Session load failed, falling back to ClaudeUploadsDetector', { conversationId });
  }

  return new ClaudeUploadsDetector();
}
