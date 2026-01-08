/**
 * Conversation Sync Transformation Tests
 *
 * Tests Claude session → Codemie conversation transformation with both
 * small and medium session fixtures.
 *
 * Golden Dataset Pattern: Parse once in beforeAll, validate many times
 * - Small sessions: < 5 KB, edge cases (errors, filtering, empty)
 * - Medium sessions: 100-500 KB, real usage (tool calls, multi-turn)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { transformMessages } from '../../../src/agents/plugins/claude/claude.conversations-transformer.js';
import type { ClaudeMessage } from '../../../src/agents/plugins/claude/claude.conversations-types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Constants
const ASSISTANT_ID = '5a430368-9e91-4564-be20-989803bf4da2';
const FOLDER = 'Claude Imports';
const AGENT_NAME = 'Claude Code';

// Paths
const fixturesDir = join(__dirname, 'fixtures');
const sessionsDir = join(fixturesDir, 'sessions');
const expectedDir = join(fixturesDir, 'expected');

// Types
interface TransformedConversation {
  history: HistoryEntry[];
  assistantId: string;
  folder: string;
}

interface HistoryEntry {
  role: 'User' | 'Assistant';
  message: string;
  message_raw: string;
  history_index: number;
  date: string;
  file_names?: string[];
  thoughts?: Thought[];
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  response_time?: number;
  assistant_id?: string;
}

interface Thought {
  id: string;
  parent_id?: string;
  metadata: Record<string, unknown>;
  in_progress: boolean;
  input_text: string;
  message: string;
  author_type: 'Agent' | 'Tool';
  author_name: string;
  output_format: string;
  error: boolean;
  children: unknown[];
}

// Helpers
async function loadSession(filename: string): Promise<ClaudeMessage[]> {
  const content = await readFile(join(sessionsDir, filename), 'utf-8');
  return content.trim().split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}

async function loadExpected(filename: string): Promise<TransformedConversation> {
  const content = await readFile(join(expectedDir, filename), 'utf-8');
  return JSON.parse(content);
}

function transformSession(messages: ClaudeMessage[]): TransformedConversation {
  const history = transformMessages(messages, ASSISTANT_ID, AGENT_NAME);
  return { history, assistantId: ASSISTANT_ID, folder: FOLDER };
}

function getMessages(history: HistoryEntry[], role: 'User' | 'Assistant'): HistoryEntry[] {
  return history.filter(h => h.role === role);
}

function countThoughts(messages: HistoryEntry[]): { agent: number; tool: number } {
  let agent = 0;
  let tool = 0;
  for (const msg of messages) {
    if (msg.role === 'Assistant' && msg.thoughts) {
      for (const thought of msg.thoughts) {
        if (thought.author_type === 'Agent') agent++;
        if (thought.author_type === 'Tool') tool++;
      }
    }
  }
  return { agent, tool };
}

// ============================================
// SMALL SESSIONS - Edge Cases & Filtering
// ============================================

describe('Conversation Sync - Small Sessions', () => {
  describe('[S1] Single user message - No response, API errors', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('single-user-message.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('single-user-message.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have 2 history entries (user + assistant error)', () => {
      expect(actual.history).toHaveLength(2);
      expect(actual.history[0].role).toBe('User');
      expect(actual.history[1].role).toBe('Assistant');
    });

    it('should have API error thoughts in assistant message', () => {
      const assistantMsg = actual.history.find(h => h.role === 'Assistant');
      expect(assistantMsg?.thoughts).toBeDefined();
      expect(assistantMsg?.thoughts?.length).toBe(8); // 8 API errors
      expect(assistantMsg?.thoughts?.[0].error).toBe(true);
    });

    it('should populate required user message fields', () => {
      const userMsg = actual.history[0];
      expect(userMsg.message).toBe('show tools');
      expect(userMsg.message_raw).toBe('show tools');
      expect(userMsg.history_index).toBe(0);
      expect(userMsg.date).toBeDefined();
      expect(userMsg.file_names).toEqual([]);
    });
  });

  describe('[S2] Simple Q&A session - Show tools with response', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('simple-qa.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('simple-qa.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have correct message structure', () => {
      expect(actual.history).toHaveLength(2); // User + Assistant

      const userMsg = actual.history[0];
      expect(userMsg.role).toBe('User');
      expect(userMsg.message).toBe('show tools');
      expect(userMsg.message_raw).toBe('show tools');

      const assistantMsg = actual.history[1];
      expect(assistantMsg.role).toBe('Assistant');
      expect(assistantMsg.assistant_id).toBe(ASSISTANT_ID);
    });

    it('should have token metrics', () => {
      const assistantMsg = actual.history[1];
      expect(assistantMsg.input_tokens).toBeGreaterThan(0);
      expect(assistantMsg.output_tokens).toBeGreaterThan(0);
      expect(assistantMsg.response_time).toBeGreaterThan(0);
    });

    it('should preserve intermediate response as thought', () => {
      const assistantMsg = actual.history[1];
      expect(assistantMsg.thoughts).toBeDefined();
      expect(assistantMsg.thoughts?.length).toBeGreaterThan(0);

      const thought = assistantMsg.thoughts?.[0];
      expect(thought?.author_type).toBe('Agent');
      expect(thought?.author_name).toBe(AGENT_NAME);
      expect(thought?.metadata.type).toBe('intermediate_response');
    });
  });

  describe('[S3] UnknownOperationException error', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('unknown-operation-error.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('unknown-operation-error.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have error thought with correct structure', () => {
      const assistantMsg = actual.history.find(h => h.role === 'Assistant');
      expect(assistantMsg?.thoughts).toBeDefined();
      expect(assistantMsg?.thoughts?.length).toBeGreaterThan(0);

      const errorThought = assistantMsg?.thoughts?.[0];
      expect(errorThought?.error).toBe(true);
      expect(errorThought?.output_format).toBe('error');
      expect(errorThought?.author_type).toBe('Agent');
      expect(errorThought?.message).toContain('Error:');
    });

    it('should include error in assistant message', () => {
      const assistantMsg = actual.history.find(h => h.role === 'Assistant');
      expect(assistantMsg?.message).toContain('Error:');
      expect(assistantMsg?.message).toContain('UnknownOperationException');
    });
  });

  describe('[S4] System messages only - Filtered out', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('system-messages-only.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('system-messages-only.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have empty history (all messages filtered)', () => {
      expect(actual.history).toHaveLength(0);
    });

    it('should maintain correct metadata', () => {
      expect(actual.assistantId).toBe(ASSISTANT_ID);
      expect(actual.folder).toBe(FOLDER);
    });
  });
});

// ============================================
// MEDIUM SESSIONS - Real Usage Scenarios
// ============================================

describe('Conversation Sync - Medium Sessions', () => {
  describe('[M1] c3a574c5 - Extensive tool usage (476 KB)', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('c3a574c5.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('c3a574c5-expected.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have correct message structure', () => {
      expect(actual.history).toHaveLength(2); // User + Assistant

      const userMsg = actual.history[0];
      expect(userMsg.role).toBe('User');
      expect(userMsg.message).toBe('/memory-refresh');
      expect(userMsg.message_raw).toBe('/memory-refresh');

      const assistantMsg = actual.history[1];
      expect(assistantMsg.role).toBe('Assistant');
      expect(assistantMsg.assistant_id).toBe(ASSISTANT_ID);
    });

    it('should preserve all thoughts', () => {
      const assistantMsgs = getMessages(actual.history, 'Assistant');
      const thoughtCount = countThoughts(assistantMsgs);

      expect(assistantMsgs[0].thoughts?.length).toBe(99); // 35 agent + 64 tool
      expect(thoughtCount.agent).toBe(35);
      expect(thoughtCount.tool).toBe(64);
    });

    it('should have token metrics', () => {
      const assistantMsg = getMessages(actual.history, 'Assistant')[0];
      expect(assistantMsg.input_tokens).toBe(9748);
      expect(assistantMsg.output_tokens).toBe(12798);
      expect(assistantMsg.cache_creation_input_tokens).toBeGreaterThan(0);
      expect(assistantMsg.cache_read_input_tokens).toBeGreaterThan(0);
    });

    it('should have response time', () => {
      const assistantMsg = getMessages(actual.history, 'Assistant')[0];
      expect(assistantMsg.response_time).toBeGreaterThan(0);
    });
  });

  describe('[M2] a1f75e0f - Multiple interactions (348 KB)', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('a1f75e0f.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('a1f75e0f-expected.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have correct message counts', () => {
      expect(actual.history).toHaveLength(6); // 3 user + 3 assistant

      const userMsgs = getMessages(actual.history, 'User');
      const assistantMsgs = getMessages(actual.history, 'Assistant');

      expect(userMsgs.length).toBe(3);
      expect(assistantMsgs.length).toBe(3);
    });

    it('should filter system messages correctly', () => {
      // "[Request interrupted by user]" should be filtered out
      const userMsgs = getMessages(actual.history, 'User');
      const hasInterruptionMsg = userMsgs.some(m =>
        m.message.includes('[Request interrupted by user]')
      );
      expect(hasInterruptionMsg).toBe(false);
    });

    it('should preserve all thoughts', () => {
      const assistantMsgs = getMessages(actual.history, 'Assistant');
      const thoughtCount = countThoughts(assistantMsgs);

      expect(thoughtCount.agent).toBe(36);
      expect(thoughtCount.tool).toBe(26);
    });

    it('should have token metrics for all assistant messages', () => {
      const assistantMsgs = getMessages(actual.history, 'Assistant');

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const assistantMsg of assistantMsgs) {
        expect(assistantMsg.input_tokens).toBeGreaterThan(0);
        expect(assistantMsg.output_tokens).toBeGreaterThan(0);
        totalInputTokens += assistantMsg.input_tokens || 0;
        totalOutputTokens += assistantMsg.output_tokens || 0;
      }

      expect(totalInputTokens).toBe(767);
      expect(totalOutputTokens).toBe(7539);
    });
  });

  describe('[M3] b68cb16e - Session starting with /clear (319 KB)', () => {
    let actual: TransformedConversation;
    let expected: TransformedConversation;

    beforeAll(async () => {
      const messages = await loadSession('b68cb16e.jsonl');
      actual = transformSession(messages);
      expected = await loadExpected('b68cb16e-expected.json');
    });

    it('should match expected transformation', () => {
      expect(actual).toEqual(expected);
    });

    it('should have correct message counts', () => {
      expect(actual.history).toHaveLength(6); // 3 user + 3 assistant

      const userMsgs = getMessages(actual.history, 'User');
      const assistantMsgs = getMessages(actual.history, 'Assistant');

      expect(userMsgs.length).toBe(3);
      expect(assistantMsgs.length).toBe(3);
    });

    it('should filter /clear command correctly', () => {
      // /clear at line 3 should be filtered out
      const userMsgs = getMessages(actual.history, 'User');
      const hasClearCmd = userMsgs.some(m =>
        m.message.includes('/clear') || m.message_raw.includes('/clear')
      );
      expect(hasClearCmd).toBe(false);
    });

    it('should preserve all thoughts', () => {
      const assistantMsgs = getMessages(actual.history, 'Assistant');
      const thoughtCount = countThoughts(assistantMsgs);

      expect(thoughtCount.agent).toBe(20);
      expect(thoughtCount.tool).toBe(20);
    });

    it('should have token metrics for all assistant messages', () => {
      const assistantMsgs = getMessages(actual.history, 'Assistant');

      let totalInputTokens = 0;
      let totalOutputTokens = 0;

      for (const assistantMsg of assistantMsgs) {
        expect(assistantMsg.input_tokens).toBeGreaterThan(0);
        expect(assistantMsg.output_tokens).toBeGreaterThan(0);
        totalInputTokens += assistantMsg.input_tokens || 0;
        totalOutputTokens += assistantMsg.output_tokens || 0;
      }

      expect(totalInputTokens).toBe(525);
      expect(totalOutputTokens).toBe(6420);
    });
  });
});
