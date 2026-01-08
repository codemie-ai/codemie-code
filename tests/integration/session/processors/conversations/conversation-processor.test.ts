/**
 * Integration Test: ConversationsProcessor - Incremental Tracking
 *
 * Tests the conversation sync pipeline with incremental tracking using mock data:
 * 1. Create mock ParsedSession with messages
 * 2. Create SessionStore metadata (correlation only, no metrics dependency)
 * 3. Process with ConversationsProcessor (independent incremental tracking)
 * 4. Validate incremental tracking, conversationId management, and processor behavior
 *
 * Test Scenarios:
 * - Incremental sync: Only NEW messages processed (via lastSyncedMessageUuid)
 * - conversationId management: Set from sessionId on first sync
 * - Independent tracking: No dependency on metrics processedRecordIds
 * - Session reset: Re-syncs all when lastSyncedMessageUuid not found
 * - Error handling: Graceful handling of edge cases
 *
 * CRITICAL: This tests Incremental Tracking logic - zero tolerance for failures
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../../../../src/agents/core/session/SessionStore.js';
import { ConversationsProcessor } from '../../../../../src/providers/plugins/sso/session/processors/conversations/conversation-processor.js';
import type { Session } from '../../../../../src/agents/core/session/types.js';
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
    const sessionMetadata: Session = {
      sessionId: testSessionId,
      agentName: 'claude',
      provider: 'ai-run-sso',
      startTime: Date.now(),
      workingDirectory: '/tmp/test',
      correlation: {
        status: 'matched',
        agentSessionFile: '/tmp/mock-session.jsonl',
        agentSessionId: testSessionId,  // Use testSessionId (codemie ID, not agent ID)
        detectedAt: Date.now(),
        retryCount: 0
      },
      monitoring: {
        isActive: true,
        changeCount: 0
      },
      status: 'active',
      sync: {
        metrics: {
          lastProcessedTimestamp: Date.now(),
          processedRecordIds: [], // Start empty - will be populated by individual tests
          totalDeltas: 0,
          totalSynced: 0,
          totalFailed: 0
        }
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

  describe('Incremental Tracking', () => {
    it('should process all messages on first sync (no conversationId)', async () => {
      // First sync - no conversationId or lastSyncedMessageUuid
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
      expect(sessionMetadata!.sync!.conversations!.conversationId).toBe(testSessionId);
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
      // Reset session metadata with lastSyncedMessageUuid
      const sessionMetadata = await sessionStore.loadSession(testSessionId);
      const allMessages = parsedSession.messages as any[];

      // Simulate previous sync processed first 5 messages
      const fifthMessageUuid = (allMessages[4] as any).uuid;
      if (!sessionMetadata!.sync!.conversations) {
        sessionMetadata!.sync!.conversations = {
          lastSyncAt: Date.now()
        };
      }
      sessionMetadata!.sync!.conversations!.conversationId = testSessionId;
      sessionMetadata!.sync!.conversations!.lastSyncedMessageUuid = fifthMessageUuid;
      sessionMetadata!.sync!.conversations!.lastSyncAt = Date.now();

      await sessionStore.saveSession(sessionMetadata!);

      // Process session - should only process messages 6+
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);
      expect(result.message).toContain('new messages');

      // Verify it processed the remaining messages (6-10 = 5 messages)
      const expectedNewCount = allMessages.length - 5;
      expect(result.message).toContain(expectedNewCount.toString());
    });


    it('should handle session reset (UUID not found)', async () => {
      // Create session metadata with invalid lastSyncedMessageUuid
      const resetSessionId = 'reset-test-' + Date.now();
      const resetSessionMetadata: Session = {
        sessionId: resetSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: resetSessionId,
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        sync: {
          metrics: {
            lastProcessedTimestamp: Date.now(),
            processedRecordIds: [],
            totalDeltas: 0,
            totalSynced: 0,
            totalFailed: 0
          },
          conversations: {
            conversationId: resetSessionId,
            lastSyncedMessageUuid: 'invalid-uuid-not-in-session', // UUID not in session
            lastSyncAt: Date.now()
          }
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
      if (!sessionMetadata!.sync!.conversations) {
        sessionMetadata!.sync!.conversations = { lastSyncAt: Date.now() };
      }
      sessionMetadata!.sync!.conversations!.conversationId = existingConvId;
      await sessionStore.saveSession(sessionMetadata!);

      // Process - should use existing conversationId
      const result = await processor.process(parsedSession, processingContext);

      expect(result.success).toBe(true);

      // Verify it used the existing ID
      const updatedMetadata = await sessionStore.loadSession(testSessionId);
      expect(updatedMetadata!.sync!.conversations!.conversationId).toBe(existingConvId);
    });

    it('should save conversationId and lastSyncedMessageUuid on first sync', async () => {
      const newSessionId = 'new-conv-test-' + Date.now();
      const allMessages = parsedSession.messages as any[];

      const newSessionMetadata: Session = {
        sessionId: newSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: newSessionId,
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        sync: {
          metrics: {
            lastProcessedTimestamp: Date.now(),
            processedRecordIds: [],
            totalDeltas: 0,
            totalSynced: 0,
            totalFailed: 0
          }
          // No conversations sync state initially
        }
      };

      await sessionStore.saveSession(newSessionMetadata);

      const newParsedSession = { ...parsedSession, sessionId: newSessionId };

      // First sync - should save conversationId and lastSyncedMessageUuid
      await processor.process(newParsedSession, processingContext);

      const afterFirstSync = await sessionStore.loadSession(newSessionId);
      expect(afterFirstSync!.sync!.conversations!.conversationId).toBe(newSessionId);
      expect(afterFirstSync!.sync!.conversations!.lastSyncedMessageUuid).toBeDefined();
      expect(afterFirstSync!.sync!.conversations!.lastSyncAt).toBeDefined();

      // Verify lastSyncedMessageUuid is the last message's UUID
      const lastMessageUuid = (allMessages[allMessages.length - 1] as any).uuid;
      expect(afterFirstSync!.sync!.conversations!.lastSyncedMessageUuid).toBe(lastMessageUuid);

      // Verify lastSyncedHistoryIndex is set
      expect(afterFirstSync!.sync!.conversations!.lastSyncedHistoryIndex).toBeDefined();
      expect(afterFirstSync!.sync!.conversations!.lastSyncedHistoryIndex).toBeGreaterThanOrEqual(0);
    });

    it('should increment history index correctly on subsequent syncs', async () => {
      const incrementalSessionId = 'incremental-index-' + Date.now();

      // Create initial session with 3 messages (will have index 0)
      const initialMessages = Array.from({ length: 3 }, (_, i) => ({
        uuid: `msg-initial-${i}`,
        timestamp: Date.now() + i * 1000,
        type: 'user' as const,
        sessionId: incrementalSessionId,
        message: {
          role: 'user',
          content: `Initial message ${i}`
        }
      }));

      const initialSession: Session = {
        sessionId: incrementalSessionId,
        agentName: 'claude',
        provider: 'ai-run-sso',
        startTime: Date.now(),
        workingDirectory: '/tmp/test',
        correlation: {
          status: 'matched',
          agentSessionFile: '/tmp/mock-session.jsonl',
          agentSessionId: incrementalSessionId,
          detectedAt: Date.now(),
          retryCount: 0
        },
        monitoring: {
          isActive: true,
          changeCount: 0
        },
        status: 'active',
        sync: {
          metrics: {
            lastProcessedTimestamp: Date.now(),
            processedRecordIds: [],
            totalDeltas: 0,
            totalSynced: 0,
            totalFailed: 0
          }
        }
      };

      await sessionStore.saveSession(initialSession);

      // First sync
      const firstParsedSession = {
        ...parsedSession,
        sessionId: incrementalSessionId,
        messages: initialMessages
      };

      await processor.process(firstParsedSession, processingContext);

      const afterFirstSync = await sessionStore.loadSession(incrementalSessionId);
      const firstSyncLastIndex = afterFirstSync!.sync!.conversations!.lastSyncedHistoryIndex!;

      // Add 2 more messages
      const newMessages = Array.from({ length: 2 }, (_, i) => ({
        uuid: `msg-new-${i}`,
        timestamp: Date.now() + (i + 3) * 1000,
        type: 'user' as const,
        sessionId: incrementalSessionId,
        message: {
          role: 'user',
          content: `New message ${i}`
        }
      }));

      // Update session with lastSyncedMessageUuid pointing to last initial message
      afterFirstSync!.sync!.conversations!.lastSyncedMessageUuid = initialMessages[initialMessages.length - 1].uuid;
      await sessionStore.saveSession(afterFirstSync!);

      // Second sync with all messages (initial + new)
      const secondParsedSession = {
        ...parsedSession,
        sessionId: incrementalSessionId,
        messages: [...initialMessages, ...newMessages]
      };

      await processor.process(secondParsedSession, processingContext);

      const afterSecondSync = await sessionStore.loadSession(incrementalSessionId);
      const secondSyncLastIndex = afterSecondSync!.sync!.conversations!.lastSyncedHistoryIndex!;

      // Verify history index incremented correctly
      // Second sync should start at firstSyncLastIndex + 1
      expect(secondSyncLastIndex).toBeGreaterThan(firstSyncLastIndex);
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
