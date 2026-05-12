/**
 * Integration Test: Codex Conversation Processing
 *
 * Validates the complete Codex rollout → conversation payload pipeline:
 * 1. Parse Codex rollout JSONL (session_meta, event_msg, response_item records)
 * 2. Extract user messages and assistant responses
 * 3. Write PENDING payloads to _conversation.jsonl
 * 4. Deduplicate via queued-checkpoint so re-processing the same rollout is a no-op
 * 5. Process an extended rollout (turn-2) and produce a second payload record
 *
 * Fixture layout:
 *   fixtures/codex/turn-1.jsonl  — rollout with 1 user + 1 assistant message
 *   fixtures/codex/turn-2.jsonl  — same rollout extended with a second user + assistant pair
 *   fixtures/codex/expected-conversation.jsonl — golden records (stable fields only)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { CodexSessionAdapter } from '../../../src/agents/plugins/codex/codex.session.js';
import { CodexPluginMetadata } from '../../../src/agents/plugins/codex/codex.plugin.js';
import { SessionStore } from '../../../src/agents/core/session/SessionStore.js';
import { getSessionConversationPath } from '../../../src/agents/core/session/session-config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURES_DIR = join(__dirname, 'fixtures', 'codex');
const TURN_1_FILE = join(FIXTURES_DIR, 'turn-1.jsonl');
const TURN_2_FILE = join(FIXTURES_DIR, 'turn-2.jsonl');
const EXPECTED_FILE = join(FIXTURES_DIR, 'expected-conversation.jsonl');

const CODEX_SESSION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
const TEST_SESSION_ID = 'test-codex-conversation';

function readConversationFile(sessionId: string): any[] {
  const conversationPath = getSessionConversationPath(sessionId);
  if (!existsSync(conversationPath)) {
    throw new Error(`Conversation file not found: ${conversationPath}`);
  }
  const content = readFileSync(conversationPath, 'utf-8');
  return content.trim().split('\n').filter(l => l.length > 0).map(l => JSON.parse(l));
}

describe('Codex Conversation Processing', () => {
  let tempDir: string;
  const sessionStore = new SessionStore();
  const adapter = new CodexSessionAdapter(CodexPluginMetadata);

  const processingContext = {
    sessionId: TEST_SESSION_ID,
    agentSessionId: CODEX_SESSION_ID,
    apiBaseUrl: 'http://localhost:3000',
    cookies: '',
    version: '1.0.0',
    clientType: 'codemie-codex',
    dryRun: true,
  };

  beforeAll(async () => {
    if (!existsSync(TURN_1_FILE)) throw new Error(`Fixture missing: ${TURN_1_FILE}`);
    if (!existsSync(TURN_2_FILE)) throw new Error(`Fixture missing: ${TURN_2_FILE}`);
    if (!existsSync(EXPECTED_FILE)) throw new Error(`Fixture missing: ${EXPECTED_FILE}`);

    tempDir = await mkdtemp(join(tmpdir(), 'codemie-codex-test-'));
    process.env.CODEMIE_HOME = tempDir;

    await sessionStore.saveSession({
      sessionId: TEST_SESSION_ID,
      agentName: 'codex',
      provider: 'test-provider',
      project: 'test-project',
      startTime: Date.now(),
      workingDirectory: '/home/user/project',
      gitBranch: 'main',
      status: 'active',
      correlation: {
        status: 'matched',
        agentSessionId: CODEX_SESSION_ID,
        agentSessionFile: TURN_1_FILE,
        retryCount: 0,
      },
    });
  });

  afterAll(async () => {
    delete process.env.CODEMIE_HOME;
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it('processes turn-1 and writes one PENDING conversation record', async () => {
    const result = await adapter.processSession(TURN_1_FILE, TEST_SESSION_ID, processingContext);

    expect(result.success).toBe(true);

    const conversationPath = getSessionConversationPath(TEST_SESSION_ID);
    expect(existsSync(conversationPath)).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(1);

    const record = records[0];
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    expect(record.payload.history).toHaveLength(2);
    expect(record.payload.history[0].role).toBe('User');
    expect(record.payload.history[0].message).toBe('Hello, Codex! Please explain what you do.');
    expect(record.payload.history[1].role).toBe('Assistant');
    expect(record.payload.history[1].message).toBe('I am Codex, an AI coding assistant by OpenAI.');
  });

  it('re-processing turn-1 is idempotent (no duplicate records)', async () => {
    const result = await adapter.processSession(TURN_1_FILE, TEST_SESSION_ID, processingContext);

    expect(result.success).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(1);
  });

  it('processes turn-2 and appends a second conversation record', async () => {
    const result = await adapter.processSession(TURN_2_FILE, TEST_SESSION_ID, processingContext);

    expect(result.success).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(2);

    const record = records[1];
    expect(record.status).toBe('pending');
    expect(record.isTurnContinuation).toBe(false);
    expect(record.messageCount).toBe(2);
    expect(record.payload.history).toHaveLength(2);
    expect(record.payload.history[0].role).toBe('User');
    expect(record.payload.history[0].message).toBe('What languages can you work with?');
    expect(record.payload.history[1].role).toBe('Assistant');
    expect(record.payload.history[1].message).toBe(
      'I can work with many programming languages including Python, JavaScript, TypeScript, Go, and Rust.'
    );
  });

  it('re-processing turn-2 is idempotent (no duplicate records)', async () => {
    const result = await adapter.processSession(TURN_2_FILE, TEST_SESSION_ID, processingContext);

    expect(result.success).toBe(true);

    const records = readConversationFile(TEST_SESSION_ID);
    expect(records).toHaveLength(2);
  });

  it('records have required structural fields', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      expect(record).toHaveProperty('timestamp');
      expect(record).toHaveProperty('isTurnContinuation');
      expect(record).toHaveProperty('historyIndices');
      expect(record).toHaveProperty('messageCount');
      expect(record).toHaveProperty('lastProcessedMessageUuid');
      expect(record).toHaveProperty('payload');
      expect(record).toHaveProperty('status');
      expect(record.status).toBe('pending');

      expect(record.payload).toHaveProperty('conversationId');
      expect(record.payload.conversationId).toBe(CODEX_SESSION_ID);
      expect(record.payload).toHaveProperty('history');
      expect(Array.isArray(record.payload.history)).toBe(true);

      for (const entry of record.payload.history) {
        expect(['User', 'Assistant']).toContain(entry.role);
        expect(typeof entry.message).toBe('string');
        expect(entry.message.length).toBeGreaterThan(0);
      }
    }
  });

  it('sentinel encodes codexSessionId and source index', () => {
    const records = readConversationFile(TEST_SESSION_ID);

    for (const record of records) {
      expect(record.lastProcessedMessageUuid).toMatch(
        new RegExp(`^${CODEX_SESSION_ID}@\\d+$`)
      );
    }
  });

  it('history indices increment across turns', () => {
    const records = readConversationFile(TEST_SESSION_ID);
    const allIndices = records.flatMap((r: any) =>
      r.payload.history.map((h: any) => h.history_index)
    );
    const unique = [...new Set(allIndices)].sort((a: number, b: number) => a - b);
    expect(unique).toEqual([0, 1]);
  });

  it('matches expected-conversation.jsonl golden records', () => {
    const generated = readConversationFile(TEST_SESSION_ID);
    const expected = readFileSync(EXPECTED_FILE, 'utf-8')
      .trim()
      .split('\n')
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l));

    expect(generated).toHaveLength(expected.length);

    for (let i = 0; i < expected.length; i++) {
      const gen = generated[i];
      const exp = expected[i];

      expect(gen.status).toBe(exp.status);
      expect(gen.isTurnContinuation).toBe(exp.isTurnContinuation);
      expect(gen.messageCount).toBe(exp.messageCount);
      expect(gen.payload.history).toHaveLength(exp.payload.history.length);

      const genUser = gen.payload.history.find((h: any) => h.role === 'User');
      const expUser = exp.payload.history.find((h: any) => h.role === 'User');
      expect(genUser.message).toBe(expUser.message);

      const genAssistant = gen.payload.history.find((h: any) => h.role === 'Assistant');
      const expAssistant = exp.payload.history.find((h: any) => h.role === 'Assistant');
      expect(genAssistant.message).toBe(expAssistant.message);
    }
  });
});
