/**
 * Integration Test: Gemini Conversation Processing
 *
 * This test validates the complete Gemini conversation processing flow:
 * 1. Parse Gemini session file with turn-based architecture
 * 2. Detect turn boundaries (user → gemini → next user)
 * 3. Aggregate tokens across multiple gemini messages in a turn
 * 4. Extract tool calls from nested structure
 * 5. Transform to conversation history format
 * 6. Write payloads to JSONL with status 'pending'
 *
 * Test Fixture:
 * - session-2025-12-01T21-45-5b959dae.json: Real Gemini session with tool calls
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { AgentRegistry } from '../../../src/agents/registry.js';
import { SessionStore } from '../../../src/agents/core/session/SessionStore.js';
import { getSessionConversationPath } from '../../../src/agents/core/session/session-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, '..', 'metrics', 'fixtures', 'gemini');
const SESSION_FILE = join(FIXTURES_DIR, 'session-2025-12-01T21-45-5b959dae.json');

/**
 * Process session via Gemini adapter
 */
async function processSessionViaAdapter(
  agentSessionFile: string,
  sessionId: string
): Promise<any> {
  const agent = AgentRegistry.getAgent('gemini');
  if (!agent) {
    throw new Error('Gemini agent not found in registry');
  }

  const sessionAdapter = (agent as any).getSessionAdapter?.();
  if (!sessionAdapter) {
    throw new Error('No session adapter available for Gemini agent');
  }

  const processingContext = {
    sessionId,
    agentSessionId: '5b959dae-8655-4cd1-b10f-720b8c336ea2',
    agentSessionFile,
    provider: 'test-provider',
    apiBaseUrl: 'http://localhost:3000',
    cookies: {},
    version: '1.0.0',
    clientType: 'test-client',
    dryRun: true
  };

  return await sessionAdapter.processSession(agentSessionFile, sessionId, processingContext);
}

/**
 * Read and parse conversation file
 */
function readConversationFile(sessionId: string): any[] {
  const conversationPath = getSessionConversationPath(sessionId);
  if (!existsSync(conversationPath)) {
    throw new Error(`Conversation file not found: ${conversationPath}`);
  }

  const content = readFileSync(conversationPath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.length > 0);
  return lines.map(line => JSON.parse(line));
}

describe('Gemini Conversation Processing', () => {
  const TEST_SESSION_ID = 'test-gemini-conversation';
  const sessionStore = new SessionStore();

  const conversationPath = getSessionConversationPath(TEST_SESSION_ID);
  const sessionFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}.json`);
  const metricsFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}_metrics.jsonl`);

  beforeAll(async () => {
    // Verify fixture exists
    if (!existsSync(SESSION_FILE)) {
      throw new Error(`Session fixture not found: ${SESSION_FILE}`);
    }
  });

  afterAll(() => {
    // Cleanup test files
    [conversationPath, sessionFilePath, metricsFilePath].forEach(file => {
      if (existsSync(file)) {
        try {
          unlinkSync(file);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  it('should create initial session metadata', async () => {
    await sessionStore.saveSession({
      sessionId: TEST_SESSION_ID,
      agentName: 'gemini',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'test',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: '5b959dae-8655-4cd1-b10f-720b8c336ea2',
        agentSessionFile: SESSION_FILE,
        retryCount: 0
      }
    });

    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.agentName).toBe('gemini');
  });

  it('should process Gemini session and create conversation records', async () => {
    const result = await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    expect(result.success).toBe(true);
    expect(existsSync(conversationPath)).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records.length).toBeGreaterThan(0);
  });

  it('should create proper turn-based conversation records', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      // Verify record structure
      expect(record).toHaveProperty('timestamp');
      expect(record).toHaveProperty('isTurnContinuation');
      expect(record).toHaveProperty('historyIndices');
      expect(record).toHaveProperty('messageCount');
      expect(record).toHaveProperty('payload');
      expect(record).toHaveProperty('status');
      expect(record.status).toBe('pending');

      // Verify payload structure
      expect(record.payload).toHaveProperty('conversationId');
      expect(record.payload.conversationId).toBe('5b959dae-8655-4cd1-b10f-720b8c336ea2');
      expect(record.payload).toHaveProperty('history');
      expect(Array.isArray(record.payload.history)).toBe(true);

      // Each turn should have User + Assistant (messageCount = 2)
      if (!record.isTurnContinuation) {
        expect(record.messageCount).toBe(2);
        expect(record.payload.history).toHaveLength(2);
        expect(record.payload.history[0].role).toBe('User');
        expect(record.payload.history[1].role).toBe('Assistant');
      }
    }
  });

  it('should have correct token aggregation', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      if (assistant) {
        // Should have token fields
        expect(assistant).toHaveProperty('input_tokens');
        expect(assistant).toHaveProperty('output_tokens');
        expect(assistant).toHaveProperty('cache_read_input_tokens');
        expect(assistant).toHaveProperty('cache_creation_input_tokens');

        // Tokens should be numbers
        expect(typeof assistant.input_tokens).toBe('number');
        expect(typeof assistant.output_tokens).toBe('number');
        expect(typeof assistant.cache_read_input_tokens).toBe('number');
        expect(typeof assistant.cache_creation_input_tokens).toBe('number');

        // Cache creation should always be 0 for Gemini
        expect(assistant.cache_creation_input_tokens).toBe(0);
      }
    }
  });

  it('should extract tool thoughts from tool calls', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    // Find records with tool calls
    let foundToolCalls = false;
    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      if (assistant && assistant.thoughts) {
        const toolThoughts = assistant.thoughts.filter((t: any) => t.author_type === 'Tool');

        if (toolThoughts.length > 0) {
          foundToolCalls = true;

          for (const thought of toolThoughts) {
            // Validate tool thought structure
            expect(thought).toHaveProperty('id');
            expect(thought).toHaveProperty('metadata');
            expect(thought).toHaveProperty('author_type');
            expect(thought).toHaveProperty('author_name');
            expect(thought).toHaveProperty('message');
            expect(thought).toHaveProperty('input_text');
            expect(thought).toHaveProperty('error');
            expect(thought).toHaveProperty('children');

            expect(thought.author_type).toBe('Tool');
            expect(thought.in_progress).toBe(false);
            expect(thought.output_format).toBe('text');
            expect(Array.isArray(thought.children)).toBe(true);

            // metadata should have timestamp
            expect(thought.metadata).toHaveProperty('timestamp');
          }
        }
      }
    }

    // This session has tool calls, so we should find at least one
    expect(foundToolCalls).toBe(true);
  });

  it('should have correct history indices', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (let i = 0; i < records.length; i++) {
      const record = records[i];

      // historyIndices should match history_index in records
      const userRecord = record.payload.history.find((h: any) => h.role === 'User');
      const assistantRecord = record.payload.history.find((h: any) => h.role === 'Assistant');

      if (userRecord && assistantRecord) {
        // Both should have same history_index (same turn)
        expect(userRecord.history_index).toBe(assistantRecord.history_index);

        // historyIndices should be [index, index]
        expect(record.historyIndices).toEqual([userRecord.history_index, userRecord.history_index]);
      }
    }
  });

  it('should update sync state after processing', async () => {
    const session = await sessionStore.loadSession(TEST_SESSION_ID);

    expect(session?.sync?.conversations).toBeDefined();
    expect(session?.sync?.conversations?.lastSyncedMessageUuid).toBeDefined();
    expect(session?.sync?.conversations?.lastSyncedHistoryIndex).toBeGreaterThanOrEqual(0);

    // Verify the last synced message UUID is from the session
    const sessionData = JSON.parse(readFileSync(SESSION_FILE, 'utf-8'));
    const lastMessage = sessionData.messages[sessionData.messages.length - 1];

    expect(session?.sync?.conversations?.lastSyncedMessageUuid).toBe(lastMessage.id);
  });

  it('should have response time calculated', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      if (assistant) {
        expect(assistant).toHaveProperty('response_time');
        expect(typeof assistant.response_time).toBe('number');
        expect(assistant.response_time).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('should have assistant_id field', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      if (assistant) {
        expect(assistant).toHaveProperty('assistant_id');
        expect(assistant.assistant_id).toBe('5a430368-9e91-4564-be20-989803bf4da2');
      }
    }
  });

  it('should handle incremental processing correctly', async () => {
    // Get initial record count
    const initialRecords = readConversationFile(TEST_SESSION_ID);
    const initialRecordCount = initialRecords.length;

    // Process the same session again (simulating second hook call)
    const result = await processSessionViaAdapter(SESSION_FILE, TEST_SESSION_ID);

    expect(result.success).toBe(true);

    // Should not create duplicate records
    const records = readConversationFile(TEST_SESSION_ID);
    expect(records.length).toBe(initialRecordCount); // Same count

    // If there were no new messages, verify the message
    if (result.metadata?.turnsProcessed === 0 || result.metadata?.messagesProcessed === 0) {
      expect(result.message).toBe('No new messages');
    }
  });

  it('should have incrementing history indices across all turns', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    // Extract all unique history indices
    const historyIndices = new Set<number>();
    for (const record of records) {
      for (const historyItem of record.payload.history) {
        historyIndices.add(historyItem.history_index);
      }
    }

    // Convert to sorted array
    const sortedIndices = Array.from(historyIndices).sort((a, b) => a - b);

    // Should start at 0 and increment by 1
    for (let i = 0; i < sortedIndices.length; i++) {
      expect(sortedIndices[i]).toBe(i);
    }

    // Verify historyIndices array matches the history_index values
    for (const record of records) {
      const indices = record.payload.history.map((h: any) => h.history_index);
      expect(record.historyIndices).toEqual(indices);
    }
  });
});
