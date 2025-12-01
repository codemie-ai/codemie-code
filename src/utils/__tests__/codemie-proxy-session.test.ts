import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../logger.js';

describe('CodeMie Proxy Session ID Integration', () => {
  it('should have a valid UUID session ID', () => {
    const sessionId = logger.getSessionId();

    // Verify it's a valid UUID v4
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should return the same session ID across multiple calls', () => {
    const sessionId1 = logger.getSessionId();
    const sessionId2 = logger.getSessionId();
    const sessionId3 = logger.getSessionId();

    expect(sessionId1).toBe(sessionId2);
    expect(sessionId2).toBe(sessionId3);
  });
});
