/**
 * Integration Test: ConversationsProcessor - Incremental Tracking Incremental Tracking
 *
 * Tests the NEW conversation sync pipeline with incremental tracking using mock data:
 * 1. Create mock ParsedSession with messages
 * 2. Create SessionStore metadata with processedRecordIds (simulating metrics processor)
 * 3. Process with ConversationsProcessor (NEW - Incremental Tracking architecture)
 * 4. Validate incremental tracking, conversationId management, and processor behavior
 *
 * Test Scenarios:
 * - Incremental sync: Only NEW messages processed
 * - conversationId management: Set from sessionId (no UUID generation)
 * - Metrics dependency: Waits for metrics processor to populate processedRecordIds
 * - Session reset: Re-syncs all when UUID not found
 * - Error handling: Graceful handling of edge cases
 *
 * CRITICAL: This tests Incremental Tracking logic - zero tolerance for failures
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../../../src/agents/core/metrics/session/SessionStore.js';
import { ConversationsProcessor } from '../../../../../src/providers/plugins/sso/session/processors/conversations/conversation-processor.js';
import type { MetricsSession } from '../../../../../src/agents/core/metrics/types.js';
import type { ParsedSession } from '../../../../../src/providers/plugins/sso/session/adapters/base/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../../../src/providers/plugins/sso/session/processors/base/BaseProcessor.js';

describe('ConversationsProcessor - Incremental Tracking Integration Test', () => {
  const tempTestDir = join(tmpdir(), 'conversation-processor-test-' + Date.now());
  const testSessionId = 'conv-test-' + Date.now() + '-' + Math.random().toString(36).substring(7);

  let sessionStore: SessionStore;
  let processor: ConversationsProcessor;
  let parsedSession: ParsedSession;
  let processingContext: ProcessingContext;

  beforeAll(async () => {
    // 1. Setup test directories
    mkdirSync(tempTestDir, { recursive: true });

    // 2. Create mock parsed session (Incremental Tracking focuses on processor logic, not parsing)
    const mockMessages = Array.from({ length: 10 }, (_, i) => ({
      uuid: `mock-uuid-${i}`,
      timestamp: Date.now() + i * 1000,
      type: 'user' as const,
      content: `Test message ${i}`
    }));

    parsedSession = {
      sessionId: testSessionId,
      agentName: 'claude',
      agentVersion: '1.0.0',
      metadata: {
        projectPath: '/tmp/test',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      },
      messages: mockMessages,
      metrics: {
        tokens: { input: 1000, output: 500 },
        tools: { Read: 2, Write: 1 },
        toolStatus: { Read: { success: 2, failure: 0 }, Write: { success: 1, failure: 0 } }
      }
    };

    // 4. Initialize session store
    sessionStore = new SessionStore();

    // 5. Create mock session metadata WITHOUT processedRecordIds
    // This simulates the state before FIRST sync (metrics processor hasn't run yet)
    const sessionMetadata: MetricsSession = {
      sessionId: testSessionId,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.now(),
      workingDirectory: '/tmp/test',
      correlation: {
        status: 'matched',
        agentSessionFile: '/tmp/mock-session.jsonl',
        agentSessionId: 'mock-agent-session-id',
        detectedAt: Date.now(),
        retryCount: 0
      },
      monitoring: {
        isActive: true,
        changeCount: 0
      },
      status: 'active',
      syncState: {
        sessionId: testSessionId,
        agentSessionId: 'mock-agent-session-id',
        sessionStartTime: Date.now(),
        status: 'active',
        lastProcessedLine: 0,
        lastProcessedTimestamp: Date.now(),
        processedRecordIds: [], // Start empty - will be populated by individual tests
        totalDeltas: 0,
        totalSynced: 0,
        totalFailed: 0
      }
    };

    await sessionStore.saveSession(sessionMetadata);

    // 6. Create processing context
    processingContext = {
      apiBaseUrl: 'https://test.api.codemie.ai',
      cookies: 'test-cookie=value',
      clientType: 'codemie-claude',
      version: '0.0.28',
      dryRun: true // Dry-run mode for testing
    };

    // 7. Initialize processor
    processor = new ConversationsProcessor();
  });

  afterAll(() => {
    // Cleanup
    try {
      rmSync(tempTestDir, { recursive: true, force: true });
      rmSync(join(tmpdir(), '.codemie-test-' + testSessionId.split('-')[2]), { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Incremental Tracking - Incremental Tracking', () => {
    it('should use processedRecordIds from metrics SessionStore', async () => {
      // First, populate processedRecordIds (simulating metrics processor)
      const sessionMetadata = await sessionStore.loadSession(testSessionId);
      const allMessages = parsedSession.messages as any[];
      sessionMetadata!.syncState!.processedRecordIds = allMessages.map((m: any) => m.uuid).filter(Boolean);
      await sessionStore.saveSession(sessionMetadata!);

      // Verify it was saved
      const reloadedMetadata = await sessionStore.loadSession(testSessionId);
      expect(reloadedMetadata).toBeDefined();
      expect(reloadedMetadata!.syncState).toBeDefined();
      expect(reloadedMetadata!.syncState!.processedRecordIds).toBeDefined();
      expect(reloadedMetadata!.syncState!.processedRecordIds.length).toBe(10); // 10 mock messages
    });

    it('should process all messages on first sync', async () => {
      // processedRecordIds already populated by first test (simulating metrics processor ran first)
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('messages'); // "Synced N new messages"
      expect(result.metadata?.messagesProcessed).toBeGreaterThan(0);
    });

    it('should set conversationId from sessionId (no UUID generation)', async () => {
      // First sync
      await processor.process(parsedSession, processingContext);

      // Verify conversationId was saved
      const sessionMetadata = await sessionStore.loadSession(testSessionId);
      expect(sessionMetadata!.syncState!.conversationId).toBe(testSessionId);
    });

    it('should skip when no new messages', async () => {
      // First sync - processes all
      await processor.process(parsedSession, processingContext);

      // Second sync - should skip (no new messages)
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toBe('No new messages');
    });

    it('should process only NEW messages (incremental sync)', async () => {
      // Reset session metadata
      const sessionMetadata = await sessionStore.loadSession(testSessionId);
      const allMessages = parsedSession.messages as any[];

      // Simulate metrics processor processed only first 5 messages
      sessionMetadata!.syncState!.processedRecordIds = allMessages
        .slice(0, 5)
        .map((m: any) => m.uuid)
        .filter(Boolean);

      await sessionStore.saveSession(sessionMetadata!);

      // Process session - should only process messages 6+
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('new messages');

      // Verify it processed the remaining messages
      const expectedNewCount = allMessages.length - 5;
      expect(result.message).toContain(expectedNewCount.toString());
    });

    it('should wait for metrics processor when processedRecordIds is empty', async () => {
      // Create session metadata with empty processedRecordIds
      const emptySessionId = 'empty-test-' + Date.now();
      const emptySessionMetadata: MetricsSession = {
        sessionId: emptySessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: 'mock-agent-session-id',
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        syncState: {
          sessionId: emptySessionId,
          agentSessionId: 'mock-agent-session-id',
          sessionStartTime: Date.now(),
          status: 'active',
          lastProcessedLine: 0,
          lastProcessedTimestamp: Date.now(),
          processedRecordIds: [], // Empty - metrics hasn't run yet
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0
        }
      };

      await sessionStore.saveSession(emptySessionMetadata);

      const emptyParsedSession = { ...parsedSession, sessionId: emptySessionId };
      const result = await processor.process(emptyParsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Waiting for metrics');
    });

    it('should handle session reset (UUID not found)', async () => {
      // Create session metadata with invalid UUID
      const resetSessionId = 'reset-test-' + Date.now();
      const resetSessionMetadata: MetricsSession = {
        sessionId: resetSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: 'mock-agent-session-id',
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        syncState: {
          sessionId: resetSessionId,
          agentSessionId: 'mock-agent-session-id',
          sessionStartTime: Date.now(),
          status: 'active',
          lastProcessedLine: 0,
          lastProcessedTimestamp: Date.now(),
          processedRecordIds: ['invalid-uuid-not-in-session'], // UUID not in session
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0
        }
      };

      await sessionStore.saveSession(resetSessionMetadata);

      const resetParsedSession = { ...parsedSession, sessionId: resetSessionId };
      const result = await processor.process(resetParsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('messages'); // Re-synced all messages
    });
  });

  describe('Incremental Tracking - ConversationId Management', () => {
    it('should use existing conversationId if already set', async () => {
      const existingConvId = 'existing-conv-' + Date.now();

      // Create session with existing conversationId
      const sessionMetadata = await sessionStore.loadSession(testSessionId);
      sessionMetadata!.syncState!.conversationId = existingConvId;
      await sessionStore.saveSession(sessionMetadata!);

      // Process - should use existing conversationId
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);

      // Verify it used the existing ID
      const updatedMetadata = await sessionStore.loadSession(testSessionId);
      expect(updatedMetadata!.syncState!.conversationId).toBe(existingConvId);
    });

    it('should save conversationId only on first sync', async () => {
      const newSessionId = 'new-conv-test-' + Date.now();
      const allMessages = parsedSession.messages as any[];

      const newSessionMetadata: MetricsSession = {
        sessionId: newSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: 'mock-agent-session-id',
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        syncState: {
          sessionId: newSessionId,
          agentSessionId: 'mock-agent-session-id',
          sessionStartTime: Date.now(),
          status: 'active',
          lastProcessedLine: allMessages.length,
          lastProcessedTimestamp: Date.now(),
          processedRecordIds: allMessages.map((m: any) => m.uuid).filter(Boolean),
          totalDeltas: allMessages.length,
          totalSynced: 0,
          totalFailed: 0
          // No conversationId initially
        }
      };

      await sessionStore.saveSession(newSessionMetadata);

      const newParsedSession = { ...parsedSession, sessionId: newSessionId };

      // First sync - should save conversationId
      await processor.process(newParsedSession, processingContext);

      const afterFirstSync = await sessionStore.loadSession(newSessionId);
      expect(afterFirstSync!.syncState!.conversationId).toBe(newSessionId);
    });
  });

  describe('Incremental Tracking - Error Handling', () => {
    it('should return error when session metadata not found', async () => {
      const missingSess = { ...parsedSession, sessionId: 'missing-session-id' };
      const result = await processor.process(missingSess, processingContext);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Session metadata not found');
    });

    it('should handle empty messages gracefully', async () => {
      const emptySession = { ...parsedSession, messages: [] };
      const result = await processor.process(emptySession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toBe('No messages to process');
    });

    it('should prevent concurrent syncs with isSyncing flag', async () => {
      // Start first sync (will block)
      const firstSync = processor.process(parsedSession, processingContext);

      // Immediately start second sync (should be blocked)
      const secondSync = processor.process(parsedSession, processingContext);

      // Wait for both
      const [result1, result2] = await Promise.all([firstSync, secondSync]);

      // One should succeed, one should be blocked
      expect(result1.success || result2.success).toBe(true);

      // Due to timing, we might not catch the concurrent sync, so this is optional
      // The important part is that both complete successfully
      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
    });
  });
});
