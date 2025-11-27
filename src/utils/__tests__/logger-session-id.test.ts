import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { logger } from '../logger.js';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

describe('Logger Session ID', () => {
  let originalDebugEnv: string | undefined;

  beforeEach(() => {
    originalDebugEnv = process.env.CODEMIE_DEBUG;
  });

  afterEach(async () => {
    // Restore original env
    if (originalDebugEnv) {
      process.env.CODEMIE_DEBUG = originalDebugEnv;
    } else {
      delete process.env.CODEMIE_DEBUG;
    }

    // Clean up test session directories
    const debugDir = join(homedir(), '.codemie', 'debug');
    try {
      const entries = await fs.readdir(debugDir);
      for (const entry of entries) {
        if (entry.startsWith('session-')) {
          const sessionPath = join(debugDir, entry);
          const stat = await fs.stat(sessionPath);
          if (stat.isDirectory()) {
            await fs.rm(sessionPath, { recursive: true, force: true });
          }
        }
      }
    } catch {
      // Directory might not exist
    }
  });

  it('should always return a session ID regardless of debug mode', () => {
    delete process.env.CODEMIE_DEBUG;
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

  it('should maintain same session ID throughout the session', async () => {
    const sessionId1 = logger.getSessionId();
    const sessionId2 = logger.getSessionId();

    expect(sessionId1).toBe(sessionId2);
  });

  it('should include session ID in debug directory name when debug is enabled', async () => {
    process.env.CODEMIE_DEBUG = '1';
    const sessionId = logger.getSessionId();
    const sessionDir = await logger.enableDebugMode();

    expect(sessionDir).toContain(sessionId);
    expect(sessionDir).toMatch(/session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f-]{36}/i);
  });
});
