/**
 * Integration Test: Incremental Conversation Processing
 *
 * This test validates the complete realtime conversation processing flow:
 * 1. Parse Claude session files incrementally (turn by turn)
 * 2. Transform messages to conversation history format
 * 3. Write payloads to JSONL with status 'pending'
 * 4. Handle turn continuations and system messages correctly
 * 5. Process subagent files and aggregate token usage
 *
 * Test Fixtures:
 * - incremental-simple: Simple 2-turn session (3fb74381)
 * - incremental-subagents: Complex session with subagent calls (e9fb405b)
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

const FIXTURES_DIR = join(__dirname, 'fixtures', 'claude');
const SIMPLE_FIXTURES_DIR = join(FIXTURES_DIR, 'incremental-simple');
const SUBAGENTS_FIXTURES_DIR = join(FIXTURES_DIR, 'incremental-subagents');

/**
 * Process session via Claude adapter (simulates stopHook)
 */
async function processSessionViaAdapter(
  agentSessionFile: string,
  sessionId: string
): Promise<any> {
  const agent = AgentRegistry.getAgent('claude');
  if (!agent) {
    throw new Error('Claude agent not found in registry');
  }

  const sessionAdapter = (agent as any).getSessionAdapter?.();
  if (!sessionAdapter) {
    throw new Error('No session adapter available for Claude agent');
  }

  const processingContext = {
    sessionId,
    agentSessionId: 'test-agent-session',
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

describe('Incremental Conversation Processing - Simple Session', () => {
  const TEST_SESSION_ID = 'test-incremental-simple';
  const sessionStore = new SessionStore();
  
  const turn1File = join(SIMPLE_FIXTURES_DIR, 'turn-1.jsonl');
  const turn2File = join(SIMPLE_FIXTURES_DIR, 'turn-2.jsonl');
  const expectedFile = join(SIMPLE_FIXTURES_DIR, 'expected-conversation.jsonl');

  const conversationPath = getSessionConversationPath(TEST_SESSION_ID);
  const sessionFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}.json`);
  const metricsFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}_metrics.jsonl`);

  beforeAll(async () => {
    // Verify fixtures exist
    if (!existsSync(turn1File)) {
      throw new Error(`Turn 1 fixture not found: ${turn1File}`);
    }
    if (!existsSync(turn2File)) {
      throw new Error(`Turn 2 fixture not found: ${turn2File}`);
    }
    if (!existsSync(expectedFile)) {
      throw new Error(`Expected conversation file not found: ${expectedFile}`);
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
      agentName: 'claude',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'test',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: 'test-agent-session',
        agentSessionFile: turn1File,
        retryCount: 0
      }
    });

    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session).toBeDefined();
    expect(session?.agentName).toBe('claude');
  });

  it('should process turn 1 and create first conversation record', async () => {
    const result = await processSessionViaAdapter(turn1File, TEST_SESSION_ID);
    
    expect(result.success).toBe(true);
    expect(existsSync(conversationPath)).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    expect(record.payload.history).toHaveLength(2);
    expect(record.payload.history[0].role).toBe('User');
    expect(record.payload.history[1].role).toBe('Assistant');
  });

  it('should update sync state after turn 1', async () => {
    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session?.sync?.conversations).toBeDefined();
    expect(session?.sync?.conversations?.lastSyncedMessageUuid).toBeDefined();
    expect(session?.sync?.conversations?.lastSyncedHistoryIndex).toBe(0);
  });

  it('should process turn 2 and create second conversation record', async () => {
    const result = await processSessionViaAdapter(turn2File, TEST_SESSION_ID);
    
    expect(result.success).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(2);

    const record = records[1];
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    expect(record.payload.history).toHaveLength(2);
  });

  it('should match expected conversation structure', () => {
    const generatedRecords = readConversationFile(TEST_SESSION_ID);
    const expectedContent = readFileSync(expectedFile, 'utf-8');
    const expectedRecords = expectedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(generatedRecords).toHaveLength(expectedRecords.length);

    for (let i = 0; i < expectedRecords.length; i++) {
      const generated = generatedRecords[i];
      const expected = expectedRecords[i];

      expect(generated.status).toBe(expected.status);
      expect(generated.isTurnContinuation).toBe(expected.isTurnContinuation);
      expect(generated.messageCount).toBe(expected.messageCount);
      expect(generated.payload.history.length).toBe(expected.payload.history.length);

      // Compare assistant message
      const genAssistant = generated.payload.history.find((h: any) => h.role === 'Assistant');
      const expAssistant = expected.payload.history.find((h: any) => h.role === 'Assistant');

      expect(genAssistant.message).toBe(expAssistant.message);
      expect(genAssistant.input_tokens).toBe(expAssistant.input_tokens);
      expect(genAssistant.output_tokens).toBe(expAssistant.output_tokens);
    }
  });

  it('should have correct thought structure for each record', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      expect(assistant.thoughts).toBeDefined();
      expect(Array.isArray(assistant.thoughts)).toBe(true);

      if (assistant.thoughts.length > 0) {
        const thought = assistant.thoughts[0];
        expect(thought).toHaveProperty('id');
        expect(thought).toHaveProperty('author_type');
        expect(thought).toHaveProperty('message');
      }
    }
  });

  it('should preserve all required fields in each record', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      expect(record).toHaveProperty('timestamp');
      expect(record).toHaveProperty('isTurnContinuation');
      expect(record).toHaveProperty('historyIndices');
      expect(record).toHaveProperty('messageCount');
      expect(record).toHaveProperty('payload');
      expect(record).toHaveProperty('status');
      expect(record.status).toBe('pending');

      expect(record.payload).toHaveProperty('conversationId');
      expect(record.payload).toHaveProperty('history');
      expect(Array.isArray(record.payload.history)).toBe(true);
    }
  });
});

describe('Incremental Conversation Processing - Session with Subagents', () => {
  const TEST_SESSION_ID = 'test-incremental-subagents';
  const sessionStore = new SessionStore();
  
  const turn1File = join(SUBAGENTS_FIXTURES_DIR, 'turn-1.jsonl');
  const turn2File = join(SUBAGENTS_FIXTURES_DIR, 'turn-2.jsonl');
  const expectedFile = join(SUBAGENTS_FIXTURES_DIR, 'expected-conversation.jsonl');

  const conversationPath = getSessionConversationPath(TEST_SESSION_ID);
  const sessionFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}.json`);
  const metricsFilePath = join(dirname(conversationPath), `${TEST_SESSION_ID}_metrics.jsonl`);

  beforeAll(async () => {
    // Verify fixtures exist
    if (!existsSync(turn1File)) {
      throw new Error(`Turn 1 fixture not found: ${turn1File}`);
    }
    if (!existsSync(turn2File)) {
      throw new Error(`Turn 2 fixture not found: ${turn2File}`);
    }
    if (!existsSync(expectedFile)) {
      throw new Error(`Expected conversation file not found: ${expectedFile}`);
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
      agentName: 'claude',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/test',
      gitBranch: 'test',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: 'e9fb405b-169f-40eb-9396-7e75076f045d',
        agentSessionFile: turn1File,
        retryCount: 0
      }
    });

    const session = await sessionStore.loadSession(TEST_SESSION_ID);
    expect(session).toBeDefined();
  });

  it('should process turn 1 with partial subagent data', async () => {
    const result = await processSessionViaAdapter(turn1File, TEST_SESSION_ID);
    
    expect(result.success).toBe(true);
    expect(existsSync(conversationPath)).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
  });

  it('should process turn 2 and create turn continuation record', async () => {
    const result = await processSessionViaAdapter(turn2File, TEST_SESSION_ID);
    
    expect(result.success).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(2);

    // Second record should be turn continuation
    const record2 = records[1];
    expect(record2.status).toBe('pending');
    expect(record2.isTurnContinuation).toBe(true);
    expect(record2.messageCount).toBe(1); // Only Assistant
    expect(record2.payload.history).toHaveLength(1);
    expect(record2.payload.history[0].role).toBe('Assistant');
  });

  it('should discover and parse subagent files', async () => {
    const records = readConversationFile(TEST_SESSION_ID);
    
    // Check for agent thoughts in records
    let foundAgentThoughts = false;
    for (const record of records) {
      const assistant = record.payload.history.find((h: any) => h.role === 'Assistant');
      if (assistant && assistant.thoughts) {
        const agentThoughts = assistant.thoughts.filter((t: any) => t.author_type === 'Agent');
        if (agentThoughts.length > 0) {
          foundAgentThoughts = true;
          
          // Validate agent thought structure
          const agentThought = agentThoughts.find((t: any) => 
            t.metadata?.agent_id || t.author_name === 'solution-architect'
          );
          
          if (agentThought) {
            expect(agentThought).toHaveProperty('id');
            expect(agentThought).toHaveProperty('metadata');
            expect(agentThought).toHaveProperty('message');
            expect(agentThought).toHaveProperty('children');
            expect(Array.isArray(agentThought.children)).toBe(true);
          }
        }
      }
    }
    
    expect(foundAgentThoughts).toBe(true);
  });

  it('should aggregate tokens from main session and subagents', async () => {
    const records = readConversationFile(TEST_SESSION_ID);
    const record2 = records[1]; // Turn continuation with complete data
    
    const assistant = record2.payload.history[0];
    
    // Should have tokens from both main and subagent
    expect(assistant.input_tokens).toBeGreaterThan(0);
    expect(assistant.output_tokens).toBeGreaterThan(0);
    
    // Check if subagent tokens are included
    const agentThoughts = assistant.thoughts?.filter((t: any) => 
      t.author_type === 'Agent' && t.metadata?.token_usage
    );
    
    if (agentThoughts && agentThoughts.length > 0) {
      const agentThought = agentThoughts[0];
      expect(agentThought.metadata.token_usage).toHaveProperty('input');
      expect(agentThought.metadata.token_usage).toHaveProperty('output');
    }
  });

  it('should match expected conversation structure with subagents', () => {
    const generatedRecords = readConversationFile(TEST_SESSION_ID);
    const expectedContent = readFileSync(expectedFile, 'utf-8');
    const expectedRecords = expectedContent.trim().split('\n').map(line => JSON.parse(line));

    expect(generatedRecords).toHaveLength(expectedRecords.length);

    // Compare second record (turn continuation with subagent data)
    const generated = generatedRecords[1];
    const expected = expectedRecords[1];

    expect(generated.status).toBe(expected.status);
    expect(generated.isTurnContinuation).toBe(expected.isTurnContinuation);
    expect(generated.messageCount).toBe(expected.messageCount);

    const genAssistant = generated.payload.history[0];
    const expAssistant = expected.payload.history[0];

    expect(genAssistant.message).toBe(expAssistant.message);
    expect(genAssistant.input_tokens).toBe(expAssistant.input_tokens);
    expect(genAssistant.output_tokens).toBe(expAssistant.output_tokens);
    expect(genAssistant.thoughts.length).toBe(expAssistant.thoughts.length);
  });

  it('should handle system messages correctly (stop hooks)', async () => {
    // System messages (stop hooks) should not create separate conversation records
    // They should mark turn boundaries
    const records = readConversationFile(TEST_SESSION_ID);
    
    // All records should have valid User or Assistant messages, no system messages
    for (const record of records) {
      for (const historyItem of record.payload.history) {
        expect(['User', 'Assistant']).toContain(historyItem.role);
      }
    }
  });

  it('should preserve subagent metadata in thoughts', async () => {
    const records = readConversationFile(TEST_SESSION_ID);
    const record2 = records[1];
    const assistant = record2.payload.history[0];
    
    const agentThoughts = assistant.thoughts?.filter((t: any) => t.author_type === 'Agent');
    expect(agentThoughts).toBeDefined();
    expect(agentThoughts.length).toBeGreaterThan(0);
    
    // Find solution-architect subagent thought
    const subagentThought = agentThoughts.find((t: any) => 
      t.author_name === 'solution-architect' || t.metadata?.subagent_type === 'solution-architect'
    );
    
    if (subagentThought) {
      expect(subagentThought.metadata).toBeDefined();
      expect(subagentThought.metadata).toHaveProperty('agent_id');
      expect(subagentThought.message).toBeTruthy();
      expect(subagentThought.children).toBeDefined();
      expect(Array.isArray(subagentThought.children)).toBe(true);
    }
  });
});
