/**
 * Incremental Sync Integration Test
 *
 * Simulates real-world scenario where Claude session messages arrive incrementally
 * and sync happens after each new message.
 *
 * Scenario:
 * - Sync 1: 1 line from Claude session (file-history-snapshot)
 * - Sync 2: 2 lines (snapshot + first user message)
 * - Sync 3: 3 lines (+ summary)
 * - ... continue until all lines processed
 *
 * Output:
 * - Writes conversation JSONL file matching production format
 * - Each line = ConversationPayloadRecord with timestamp, payload, status
 * - Same format as ~/.codemie/conversations/sessions/{sessionId}_conversation.jsonl
 *
 * Validates:
 * - Turn continuation detection
 * - State persistence across syncs
 * - Tool result handling
 * - System message filtering
 * - Turn boundary detection with partial data
 */

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, unlinkSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { transformMessages } from '../../../src/agents/plugins/claude/claude.conversations-transformer.js';

// ESM equivalent of __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Conversation payload record (matches ConversationPayloadWriter format)
 */
interface ConversationPayloadRecord {
  timestamp: number;
  isTurnContinuation: boolean;
  historyIndices: number[];
  messageCount: number;
  payload: {
    conversationId: string;
    history: any[];
  };
  status: 'pending' | 'success' | 'failed';
  error?: string;
}

// Test session configurations
const testSessions = [
  {
    name: 'Session 9eda1058 (3 turns)',
    fixtureFile: 'session-9eda1058.jsonl',
    sessionId: '9eda1058-9706-484a-b992-d03f9cfa2546',
    expectedTotalLines: 40,
    expectedUserPrompts: 3,
    expectedToolCalls: 3,
    expectedTurns: 3
  },
  {
    name: 'Session 3fe1b6bc (10 turns)',
    fixtureFile: 'session-3fe1b6bc.jsonl',
    sessionId: '3fe1b6bc-dbd0-4320-b980-4f147befa187',
    expectedTotalLines: 275,
    expectedUserPrompts: 10,
    expectedToolCalls: 76,
    expectedTurns: 10
  },
  {
    name: 'Session 196820da (13 turns)',
    fixtureFile: 'session-196820da.jsonl',
    sessionId: '196820da-1026-4b6f-a513-a6aae42da1a6',
    expectedTotalLines: 233,
    expectedUserPrompts: 13,
    expectedToolCalls: 65,
    expectedTurns: 13
  },
  {
    name: 'Session 624a4a58 (15 turns)',
    fixtureFile: 'session-624a4a58.jsonl',
    sessionId: '624a4a58-b34c-462d-a70d-13421c8125a8',
    expectedTotalLines: 222,
    expectedUserPrompts: 15,
    expectedToolCalls: 48,
    expectedTurns: 15
  }
];

testSessions.forEach(sessionConfig => {
describe(`Incremental Sync - ${sessionConfig.name}`, () => {
  // Use fixture file from tests/integration/session/fixtures
  const FIXTURE_PATH = join(__dirname, 'fixtures', sessionConfig.fixtureFile);

  // Use temp directory for test output (cleaned up after tests)
  const TEST_OUTPUT_DIR = join(tmpdir(), `session-test-${sessionConfig.sessionId.split('-')[0]}-` + Date.now());
  const CONVERSATION_FILE = join(TEST_OUTPUT_DIR, `${sessionConfig.sessionId.split('-')[0]}_conversation.jsonl`);

  const SESSION_ID = sessionConfig.sessionId;
  const ASSISTANT_ID = '5a430368-9e91-4564-be20-989803bf4da2';
  const AGENT_NAME = 'Claude Code';

  // Expected values (golden dataset)
  const EXPECTED_TOTAL_LINES = sessionConfig.expectedTotalLines;
  const EXPECTED_TOOL_CALLS = sessionConfig.expectedToolCalls;
  const EXPECTED_TURNS = sessionConfig.expectedTurns;

  let allLines: string[];
  let allMessages: any[];
  let finalSyncState: {
    lastSyncedMessageUuid?: string;
    lastSyncedHistoryIndex: number;
  };
  let totalSyncsWithHistory: number;
  let totalTurnContinuations: number;

  beforeAll(() => {
    // 1. Load fixture
    const sessionContent = readFileSync(FIXTURE_PATH, 'utf-8');
    allLines = sessionContent.trim().split('\n');
    allMessages = allLines.map(line => JSON.parse(line));

    // 2. Create temp output directory
    mkdirSync(TEST_OUTPUT_DIR, { recursive: true });

    // 3. Run incremental sync simulation (parse once, validate many times)
    let syncState = {
      lastSyncedMessageUuid: undefined as string | undefined,
      lastSyncedHistoryIndex: -1
    };

    totalSyncsWithHistory = 0;
    totalTurnContinuations = 0;

    // Clear conversation file
    writeFileSync(CONVERSATION_FILE, '');

    // Simulate incremental sync - process one line at a time
    for (let i = 1; i <= allLines.length; i++) {
      const currentMessages = allMessages.slice(0, i);

      const result = transformMessages(
        currentMessages,
        syncState,
        ASSISTANT_ID,
        AGENT_NAME
      );

      // Write conversation payload if history was generated
      if (result.history.length > 0) {
        const historyIndices = result.history.map(h => h.history_index);

        const record: ConversationPayloadRecord = {
          timestamp: Date.now(),
          isTurnContinuation: result.isTurnContinuation,
          historyIndices,
          messageCount: result.history.length,
          payload: {
            conversationId: SESSION_ID,
            history: result.history
          },
          status: 'success'
        };

        appendFileSync(CONVERSATION_FILE, JSON.stringify(record) + '\n');

        syncState.lastSyncedMessageUuid = result.lastProcessedMessageUuid;
        syncState.lastSyncedHistoryIndex = result.currentHistoryIndex;

        totalSyncsWithHistory++;
        if (result.isTurnContinuation) {
          totalTurnContinuations++;
        }
      } else {
        // Even if no history, update UUID if transformer advanced
        if (result.lastProcessedMessageUuid !== syncState.lastSyncedMessageUuid) {
          syncState.lastSyncedMessageUuid = result.lastProcessedMessageUuid;
        }
      }
    }

    // Store final sync state for tests
    finalSyncState = syncState;
  });

  afterAll(() => {
    // Cleanup test output
    try {
      if (existsSync(CONVERSATION_FILE)) {
        unlinkSync(CONVERSATION_FILE);
      }
      if (existsSync(TEST_OUTPUT_DIR)) {
        rmSync(TEST_OUTPUT_DIR, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors - tmpdir cleanup happens on reboot
    }
  });

  describe('Incremental Message Arrival', () => {
    it('should process all lines from fixture', () => {
      expect(allLines.length).toBe(EXPECTED_TOTAL_LINES);
    });

    it('should produce correct final sync state', () => {
      expect(finalSyncState.lastSyncedHistoryIndex).toBe(EXPECTED_TURNS - 1); // 0, 1, 2
      expect(finalSyncState.lastSyncedMessageUuid).toBeTruthy();
      expect(finalSyncState.lastSyncedMessageUuid).not.toBe('');
      expect(finalSyncState.lastSyncedMessageUuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    });

    it('should generate conversation records with correct turn structure', () => {
      // Read conversation file
      const conversationContent = readFileSync(CONVERSATION_FILE, 'utf-8');
      const records = conversationContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as ConversationPayloadRecord);

      // Verify record count
      expect(records.length).toBe(totalSyncsWithHistory);
      expect(records.length).toBeGreaterThan(0);

      // Verify turn structure
      const newTurns = records.filter(r => !r.isTurnContinuation);
      expect(newTurns.length).toBe(EXPECTED_TURNS);

      // Verify all records have required fields
      records.forEach(record => {
        expect(record.timestamp).toBeGreaterThan(0);
        expect(record.payload.conversationId).toBe(SESSION_ID);
        expect(record.payload.history).toBeInstanceOf(Array);
        expect(record.payload.history.length).toBe(record.messageCount);
        expect(record.historyIndices).toBeInstanceOf(Array);
        expect(record.status).toBe('success');
      });

      // Verify turn continuation logic
      const continuations = records.filter(r => r.isTurnContinuation);
      expect(continuations.length).toBe(totalTurnContinuations);

      // Turn continuations should only have Assistant entries
      continuations.forEach(record => {
        const roles = record.payload.history.map((h: any) => h.role);
        expect(roles.every(r => r === 'Assistant')).toBe(true);
      });

      // New turns should start with User
      const allNewTurns = records.filter(r => !r.isTurnContinuation);
      allNewTurns.forEach(record => {
        expect(record.payload.history[0].role).toBe('User');
      });
    });
  });

  describe('Conversation Payload Validation', () => {
    it('should have valid history entry structure', () => {
      // Read conversation file
      const conversationContent = readFileSync(CONVERSATION_FILE, 'utf-8');
      const records = conversationContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as ConversationPayloadRecord);

      // Verify each record has valid history entries
      records.forEach((record) => {
        record.payload.history.forEach((entry: any) => {
          expect(entry).toHaveProperty('role');
          expect(entry).toHaveProperty('history_index');
          expect(entry).toHaveProperty('message');
          expect(entry).toHaveProperty('date');
          expect(['User', 'Assistant']).toContain(entry.role);
          expect(entry.history_index).toBeGreaterThanOrEqual(0);
        });

        // Verify history indices match
        const historyIndices = record.payload.history.map((h: any) => h.history_index);
        expect(historyIndices).toEqual(record.historyIndices);
      });

      expect(records.length).toBeGreaterThan(0);
    });
  });

  describe('System Message Filtering', () => {
    it('should filter system messages from conversation output', () => {
      // Find system message in original messages
      const systemMessageIndex = allMessages.findIndex((msg: any) =>
        msg.message?.content?.[0]?.text?.startsWith('[Request interrupted by user')
      );

      // Read conversation file
      const conversationContent = readFileSync(CONVERSATION_FILE, 'utf-8');
      const records = conversationContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as ConversationPayloadRecord);

      // System message should not appear in any User entries
      const allHistory = records.flatMap(r => r.payload.history);
      const userEntries = allHistory.filter((h: any) => h.role === 'User');
      const hasSystemMessage = userEntries.some((h: any) =>
        h.message?.includes('[Request interrupted by user')
      );

      // If session has system messages, verify they were filtered
      if (systemMessageIndex >= 0) {
        expect(hasSystemMessage).toBe(false);
      } else {
        // If session doesn't have system messages, verify none appear anyway
        expect(hasSystemMessage).toBe(false);
      }
    });
  });

  describe('Tool Call and Thinking Block Extraction', () => {
    it('should extract all tool calls and thinking blocks', () => {
      // Count tool calls in original session
      const originalToolCalls = allMessages
        .filter((msg: any) => msg.type === 'assistant')
        .flatMap((msg: any) => msg.message?.content || [])
        .filter((item: any) => item.type === 'tool_use')
        .map((item: any) => item.id);

      // Read conversation file
      const conversationContent = readFileSync(CONVERSATION_FILE, 'utf-8');
      const records = conversationContent
        .trim()
        .split('\n')
        .filter(line => line.length > 0)
        .map(line => JSON.parse(line) as ConversationPayloadRecord);

      // Extract all thoughts from synced conversation
      const allThoughts = records
        .flatMap(r => r.payload.history)
        .filter((h: any) => h.role === 'Assistant')
        .flatMap((h: any) => h.thoughts || []);

      const uniqueThoughtIds = [...new Set(allThoughts.map((t: any) => t.id))];

      // Separate tool calls (toolu_ prefix) from thinking blocks (UUID format)
      const toolCallIds = uniqueThoughtIds.filter(id => id.startsWith('toolu_'));
      const thinkingBlockIds = uniqueThoughtIds.filter(id => !id.startsWith('toolu_'));

      // Verify counts match expected values
      expect(originalToolCalls.length).toBe(EXPECTED_TOOL_CALLS);
      expect(toolCallIds.length).toBe(EXPECTED_TOOL_CALLS);
      expect(uniqueThoughtIds.length).toBeGreaterThanOrEqual(EXPECTED_TOOL_CALLS);

      // Verify all original tool call IDs are in synced data
      originalToolCalls.forEach(id => {
        expect(toolCallIds).toContain(id);
      });

      // Verify thinking blocks exist
      expect(thinkingBlockIds.length).toBeGreaterThan(0);
    });
  });
});
});
