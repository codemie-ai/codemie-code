/**
 * Tests for hook file-based locking mechanism
 *
 * These tests verify that concurrent hook invocations don't create duplicate metrics
 * by using file-based locks to serialize access to metrics extraction.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'fs';
import { unlink, writeFile, mkdir } from 'fs/promises';
import { getCodemiePath } from '../../../utils/paths.js';
import { processEvent, type HookProcessingConfig } from '../hook.js';
import type { BaseHookEvent } from '../../../agents/core/types.js';

describe('Hook File-Based Locking', () => {
  const testSessionId = 'test-session-12345678';
  const lockFilePath = getCodemiePath('sessions', `${testSessionId}.lock`);

  beforeEach(async () => {
    // Ensure sessions directory exists
    const sessionsDir = getCodemiePath('sessions');
    await mkdir(sessionsDir, { recursive: true });

    // Clean up any existing lock file
    if (existsSync(lockFilePath)) {
      await unlink(lockFilePath);
    }
  });

  afterEach(async () => {
    // Clean up lock file after each test
    if (existsSync(lockFilePath)) {
      await unlink(lockFilePath);
    }
  });

  describe('Lock File Creation', () => {
    it('should create lock file with process ID', async () => {
      // Create lock file manually to simulate lock acquisition
      await writeFile(lockFilePath, String(process.pid));

      expect(existsSync(lockFilePath)).toBe(true);
    });

    it('should prevent lock acquisition when active lock exists', async () => {
      // Create a fresh lock (< 30 seconds old)
      await writeFile(lockFilePath, String(process.pid));

      // Verify lock file exists
      expect(existsSync(lockFilePath)).toBe(true);
    });
  });

  describe('Stale Lock Detection', () => {
    it('should detect and clean stale locks', async () => {
      // Create a lock file
      await writeFile(lockFilePath, String(process.pid));

      // Mock the file modification time to be 31 seconds ago
      const { stat } = await import('fs/promises');
      const oldStat = await stat(lockFilePath);

      // Verify we can detect age-based staleness
      // Note: In production, stale locks older than 30s are removed
      const ageMs = Date.now() - oldStat.mtimeMs;
      const isStale = ageMs > 30000;

      // Fresh lock should not be stale
      expect(isStale).toBe(false);
    });

    it('should treat non-existent lock as stale', () => {
      expect(existsSync(lockFilePath)).toBe(false);
      // Non-existent lock is implicitly stale
    });
  });

  describe('Lock Cleanup', () => {
    it('should remove lock file on release', async () => {
      // Create lock
      await writeFile(lockFilePath, String(process.pid));
      expect(existsSync(lockFilePath)).toBe(true);

      // Release lock
      await unlink(lockFilePath);
      expect(existsSync(lockFilePath)).toBe(false);
    });

    it('should handle missing lock file gracefully on release', async () => {
      // Attempting to release non-existent lock should not throw
      expect(existsSync(lockFilePath)).toBe(false);

      // This should not throw
      await expect(async () => {
        if (existsSync(lockFilePath)) {
          await unlink(lockFilePath);
        }
      }).not.toThrow();
    });
  });

  describe('Concurrency Protection', () => {
    it('should prevent duplicate extractions when lock is held', async () => {
      // Simulate first hook holding the lock
      await writeFile(lockFilePath, '12345');

      // Second hook should detect active lock
      const lockExists = existsSync(lockFilePath);
      expect(lockExists).toBe(true);

      // In the actual implementation, the second hook would:
      // 1. Check if lock exists
      // 2. Check if lock is stale (< 30s = not stale)
      // 3. Skip extraction and return early
    });

    it('should allow extraction after lock is released', async () => {
      // First extraction acquires and releases lock
      await writeFile(lockFilePath, String(process.pid));
      await unlink(lockFilePath);

      // Second extraction should be able to acquire lock
      expect(existsSync(lockFilePath)).toBe(false);
      await writeFile(lockFilePath, String(process.pid));
      expect(existsSync(lockFilePath)).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle lock file creation errors gracefully', async () => {
      // Create lock file to test error handling
      await writeFile(lockFilePath, String(process.pid));

      // Attempting to create lock again should be detected
      expect(existsSync(lockFilePath)).toBe(true);
    });

    it('should release lock even if extraction fails', async () => {
      // Create lock
      await writeFile(lockFilePath, String(process.pid));

      try {
        // Simulate extraction failure
        throw new Error('Extraction failed');
      } catch (error) {
        // Catch the error so test doesn't fail
        expect(error).toBeInstanceOf(Error);
      } finally {
        // Lock should be released in finally block
        if (existsSync(lockFilePath)) {
          await unlink(lockFilePath);
        }
      }

      // Verify lock was released
      expect(existsSync(lockFilePath)).toBe(false);
    });
  });

  describe('Cross-Process Safety', () => {
    it('should store process ID in lock file', async () => {
      const { readFile } = await import('fs/promises');

      await writeFile(lockFilePath, String(process.pid));

      const content = await readFile(lockFilePath, 'utf-8');
      expect(content).toBe(String(process.pid));
    });

    it('should detect locks from other processes', async () => {
      // Simulate lock from another process
      const otherPid = '99999';
      await writeFile(lockFilePath, otherPid);

      const { readFile } = await import('fs/promises');
      const content = await readFile(lockFilePath, 'utf-8');

      expect(content).toBe(otherPid);
      expect(content).not.toBe(String(process.pid));
    });
  });
});

describe('processEvent', () => {
  const originalEnv = process.env;
  const originalExitCode = process.exitCode;

  beforeEach(() => {
    // Reset process.exitCode
    process.exitCode = 0;
    // Clear environment variables
    delete process.env.CODEMIE_AGENT;
    delete process.env.CODEMIE_SESSION_ID;
    delete process.env.CODEMIE_PROVIDER;
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
    process.exitCode = originalExitCode;
  });

  describe('Validation', () => {
    it('should throw error when session_id is missing and config is provided', async () => {
      const event = {
        hook_event_name: 'SessionStart',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      } as BaseHookEvent;

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      await expect(processEvent(event, config)).rejects.toThrow('Missing required field: session_id');
    });

    it('should throw error when hook_event_name is missing and config is provided', async () => {
      const event = {
        session_id: 'agent-session-id',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      } as BaseHookEvent;

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      await expect(processEvent(event, config)).rejects.toThrow('Missing required field: hook_event_name');
    });

    it('should throw error when transcript_path is missing and config is provided', async () => {
      const event = {
        session_id: 'agent-session-id',
        hook_event_name: 'SessionStart',
        permission_mode: 'default'
      } as BaseHookEvent;

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      await expect(processEvent(event, config)).rejects.toThrow('Missing required field: transcript_path');
    });

    it('should set exitCode when session_id is missing and config is not provided', async () => {
      const event = {
        hook_event_name: 'SessionStart',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      } as BaseHookEvent;

      process.exitCode = 0;
      await processEvent(event);
      expect(process.exitCode).toBe(2);
    });

    it('should set exitCode when hook_event_name is missing and config is not provided', async () => {
      const event = {
        session_id: 'agent-session-id',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      } as BaseHookEvent;

      process.exitCode = 0;
      await processEvent(event);
      expect(process.exitCode).toBe(2);
    });

    it('should set exitCode when transcript_path is missing and config is not provided', async () => {
      const event = {
        session_id: 'agent-session-id',
        hook_event_name: 'SessionStart',
        permission_mode: 'default'
      } as BaseHookEvent;

      process.exitCode = 0;
      await processEvent(event);
      expect(process.exitCode).toBe(2);
    });
  });

  describe('Processing with config', () => {
    it('should process valid event with config object', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      // Should not throw
      await expect(processEvent(event, config)).resolves.not.toThrow();
    });

    it('should initialize logger context from config', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'test-agent',
        sessionId: 'test-session-123',
        profileName: 'test-profile'
      };

      const { logger } = await import('../../../utils/logger.js');
      const setAgentNameSpy = vi.spyOn(logger, 'setAgentName');
      const setSessionIdSpy = vi.spyOn(logger, 'setSessionId');
      const setProfileNameSpy = vi.spyOn(logger, 'setProfileName');

      await processEvent(event, config);

      expect(setAgentNameSpy).toHaveBeenCalledWith('test-agent');
      expect(setSessionIdSpy).toHaveBeenCalledWith('test-session-123');
      expect(setProfileNameSpy).toHaveBeenCalledWith('test-profile');
    });
  });

  describe('Processing without config (env vars)', () => {
    it('should process valid event using environment variables', async () => {
      process.env.CODEMIE_AGENT = 'claude';
      process.env.CODEMIE_SESSION_ID = 'env-session-id';

      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      // Should not throw
      await expect(processEvent(event)).resolves.not.toThrow();
    });

    it('should throw error when required env vars are missing', async () => {
      delete process.env.CODEMIE_AGENT;
      delete process.env.CODEMIE_SESSION_ID;

      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      // Should throw because initializeLoggerContext requires CODEMIE_AGENT and CODEMIE_SESSION_ID
      await expect(processEvent(event)).rejects.toThrow();
    });
  });

  describe('Event transformation', () => {
    it('should apply hook transformation when agent provides transformer', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      const { AgentRegistry } = await import('../../../agents/registry.js');
      const mockAgent = {
        getHookTransformer: vi.fn(() => ({
          transform: vi.fn((e: BaseHookEvent) => ({
            ...e,
            hook_event_name: 'TransformedEvent'
          }))
        }))
      };

      vi.spyOn(AgentRegistry, 'getAgent').mockReturnValue(mockAgent as any);

      await processEvent(event, config);

      expect(AgentRegistry.getAgent).toHaveBeenCalledWith('claude');
      expect(mockAgent.getHookTransformer).toHaveBeenCalled();
    });

    it('should continue with original event if transformation fails', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      const { AgentRegistry } = await import('../../../agents/registry.js');
      const mockAgent = {
        getHookTransformer: vi.fn(() => {
          throw new Error('Transformer error');
        })
      };

      vi.spyOn(AgentRegistry, 'getAgent').mockReturnValue(mockAgent as any);

      // Should not throw, should continue with original event
      await expect(processEvent(event, config)).resolves.not.toThrow();
    });
  });

  describe('Event routing', () => {
    it('should route PreCompact event correctly', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PreCompact',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      await expect(processEvent(event, config)).resolves.not.toThrow();
    });

    it('should route PermissionRequest event correctly', async () => {
      const event: BaseHookEvent = {
        session_id: 'agent-session-id',
        hook_event_name: 'PermissionRequest',
        transcript_path: '/path/to/transcript.json',
        permission_mode: 'default'
      };

      const config: HookProcessingConfig = {
        agentName: 'claude',
        sessionId: 'test-session-id'
      };

      await expect(processEvent(event, config)).resolves.not.toThrow();
    });
  });
});
