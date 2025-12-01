import { describe, it, expect } from 'vitest';
import { logger } from '../logger.js';

describe('Logger Session ID', () => {
  it('should always return a session ID', () => {
    const sessionId = logger.getSessionId();

    expect(sessionId).toBeDefined();
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should return UUID format session ID', () => {
    const sessionId = logger.getSessionId();

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    // where y is 8, 9, a, or b
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('should maintain same session ID throughout the session', () => {
    const sessionId1 = logger.getSessionId();
    const sessionId2 = logger.getSessionId();

    expect(sessionId1).toBe(sessionId2);
  });
});
