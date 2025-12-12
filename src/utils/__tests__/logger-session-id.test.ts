import { describe, it, expect, beforeEach } from 'vitest';
import { logger } from '../logger.js';
import { randomUUID } from 'crypto';

describe('Logger Session ID', () => {
  beforeEach(() => {
    // Set a test session ID before each test
    logger.setSessionId(randomUUID());
  });

  it('should return the session ID that was set', () => {
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
