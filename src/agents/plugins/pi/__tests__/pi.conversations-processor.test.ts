/**
 * Tests for the Pi conversations processor.
 *
 * The payloads this writes are uploaded verbatim to CodeMie, so the cases that matter
 * most are the ones about what must *not* be in them: a `!!` bash execution's output,
 * a skill wrapper Pi prepends to the user's words, or a turn that a previous run
 * already queued.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ParsedSession } from '@/agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '@/agents/core/session/BaseProcessor.js';

// The file logger appends into CODEMIE_HOME asynchronously, which races the temp-dir
// cleanup below.
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { upsertConversation } = vi.hoisted(() => ({ upsertConversation: vi.fn() }));
vi.mock('@/providers/plugins/sso/session/processors/conversations/apiClient.js', () => ({
  createApiClient: () => ({ upsertConversation }),
}));

const SESSION_ID = 'cm-session-1';
const PI_SESSION_ID = 'pi-session-a';

let codemieHome: string;
let originalCodemieHome: string | undefined;

beforeEach(() => {
  codemieHome = mkdtempSync(join(tmpdir(), 'pi-conversations-'));
  originalCodemieHome = process.env.CODEMIE_HOME;
  process.env.CODEMIE_HOME = codemieHome;
  mkdirSync(join(codemieHome, 'sessions'), { recursive: true });
  lastEntryId = null;
  upsertConversation.mockReset();
  upsertConversation.mockResolvedValue({ success: true, message: 'ok', new_messages: 1, total_messages: 1 });
});

afterEach(() => {
  rmSync(codemieHome, { recursive: true, force: true });
  if (originalCodemieHome === undefined) {
    delete process.env.CODEMIE_HOME;
  } else {
    process.env.CODEMIE_HOME = originalCodemieHome;
  }
});

function conversationsPath(): string {
  return join(codemieHome, 'sessions', `${SESSION_ID}_conversation.jsonl`);
}

function readPayloads(): any[] {
  if (!existsSync(conversationsPath())) return [];
  return readFileSync(conversationsPath(), 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

let entryCounter = 0;
let lastEntryId: string | null = null;

/**
 * Append an entry the way Pi does: as a child of the entry written before it. Fixtures
 * that left every `parentId` null would describe a forest of roots, which is not a shape
 * Pi can produce, and would never exercise the branch reconstruction.
 */
function treeEntry(fields: Record<string, unknown>): Record<string, unknown> {
  entryCounter += 1;
  const id = `entry-${entryCounter}`;
  const parentId = lastEntryId;
  lastEntryId = id;
  return { id, parentId, ...fields };
}

/** Re-parent an entry, as `/rewind` does: the next entry still chains onto this one. */
function withParent(built: Record<string, unknown>, parentId: string | null): Record<string, unknown> {
  return { ...built, parentId };
}

function entry(timestamp: string, message: unknown): Record<string, unknown> {
  return treeEntry({ type: 'message', timestamp, message });
}

function compactionEntry(summary: string, timestamp = '2026-08-01T10:00:02.000Z'): Record<string, unknown> {
  return treeEntry({ type: 'compaction', timestamp, summary, firstKeptEntryId: 'entry-1', tokensBefore: 1200 });
}

function branchSummaryEntry(summary: string, timestamp = '2026-08-01T10:00:03.000Z'): Record<string, unknown> {
  return treeEntry({ type: 'branch_summary', timestamp, summary, fromId: 'entry-1' });
}

function userEntry(text: string, timestamp = '2026-08-01T10:00:00.000Z'): Record<string, unknown> {
  return entry(timestamp, { role: 'user', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp) });
}

/** A user message whose content Pi assembled from more than a single text block. */
function userEntryWithContent(content: unknown[], timestamp = '2026-08-01T10:00:00.000Z'): Record<string, unknown> {
  return entry(timestamp, { role: 'user', content, timestamp: Date.parse(timestamp) });
}

/** The skill body must never leave the machine, so every fixture uses the same marker. */
const SKILL_BODY = 'SECRET SKILL BODY — MUST NOT BE UPLOADED';

/**
 * The literal block Pi prepends when a `/skill:<name>` command expands, byte-for-byte as
 * upstream `_expandSkillCommand` builds it. With no arguments this *is* the whole message.
 */
function skillWrapper(name: string, body = SKILL_BODY): string {
  const location = `/home/dev/.pi/skills/${name}/SKILL.md`;
  const baseDir = `/home/dev/.pi/skills/${name}`;
  return `<skill name="${name}" location="${location}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

function assistantEntry(
  content: unknown[],
  timestamp = '2026-08-01T10:00:05.000Z',
  model = 'anthropic/claude-sonnet'
): Record<string, unknown> {
  return entry(timestamp, { role: 'assistant', content, model, timestamp: Date.parse(timestamp) });
}

function toolResultEntry(
  toolCallId: string,
  toolName: string,
  text: string,
  isError = false,
  timestamp = '2026-08-01T10:00:06.000Z'
): Record<string, unknown> {
  return entry(timestamp, {
    role: 'toolResult',
    toolCallId,
    toolName,
    content: [{ type: 'text', text }],
    isError,
    timestamp: Date.parse(timestamp),
  });
}

function buildSession(entries: unknown[], agentSessionId = PI_SESSION_ID): ParsedSession {
  return {
    sessionId: SESSION_ID,
    agentName: 'Pi',
    metadata: {
      projectPath: '/tmp/work',
      createdAt: '2026-08-01T09:59:00.000Z',
      agentSessionId,
    },
    messages: entries,
  } as unknown as ParsedSession;
}

/** A transcript whose header was malformed, so the adapter recorded no Pi session id. */
function buildSessionWithoutHeaderId(entries: unknown[]): ParsedSession {
  const session = buildSession(entries) as unknown as { metadata: Record<string, unknown> };
  delete session.metadata.agentSessionId;
  return session as unknown as ParsedSession;
}

function buildContext(): ProcessingContext {
  return { agentSessionId: PI_SESSION_ID } as unknown as ProcessingContext;
}

async function createProcessor() {
  const { PiConversationsProcessor } = await import('../session/processors/pi.conversations-processor.js');
  return new PiConversationsProcessor();
}

function writeSessionRecord(sync?: Record<string, unknown>): void {
  writeFileSync(
    join(codemieHome, 'sessions', `${SESSION_ID}.json`),
    JSON.stringify({
      sessionId: SESSION_ID,
      agentName: 'pi',
      provider: 'ai-run-sso',
      startTime: Date.parse('2026-08-01T09:59:00.000Z'),
      workingDirectory: '/tmp/work',
      status: 'active',
      activeDurationMs: 0,
      correlation: { status: 'matched', agentSessionId: PI_SESSION_ID, retryCount: 0 },
      ...(sync && { sync }),
    })
  );
}

describe('PiConversationsProcessor', () => {
  it('still reads the conversation when a transcript ends with an ownership marker', async () => {
    // Transcripts recorded before `appendTranscriptMarker` stopped writing this line for pi
    // still end with a `codemie_session_start`, and foreign tooling may append one. The marker
    // is not a tree node — no `id`, no `parentId` — so treating "last line written" as the leaf
    // ended the parent walk immediately and every such pi session normalised to zero events.
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('add a health endpoint'),
      assistantEntry([{ type: 'text', text: 'Added GET /health.' }], '2026-08-01T10:00:10.000Z'),
      {
        type: 'codemie_session_start',
        uuid: 'b3d1c7f0-0000-4000-8000-000000000000',
        codemie_session_id: 'codemie-session',
        codemie_agent: 'pi',
        timestamp: '2026-08-01T10:00:11.000Z',
      } as never,
    ]);

    const result = await processor.process(session, buildContext());

    expect(result.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history.map((h) => h.role)).toEqual(['User', 'Assistant']);
    expect(payloads[0].payload.history[0].message).toBe('add a health endpoint');
  });

  it('turns a complete turn into a User + Assistant payload filed under the pi folder', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('add a health endpoint'),
      assistantEntry([
        { type: 'thinking', thinking: 'the router lives in app.ts' },
        { type: 'text', text: 'Looking at the router first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'app.ts' } },
      ]),
      toolResultEntry('call-1', 'read', 'export const app = ...'),
      assistantEntry([{ type: 'text', text: 'Added GET /health.' }], '2026-08-01T10:00:10.000Z'),
    ]);

    const result = await processor.process(session, buildContext());

    expect(result.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.folder).toBe('pi');
    expect(payloads[0].payload.conversationId).toBe(PI_SESSION_ID);
    expect(payloads[0].payload.llmModel).toBe('anthropic/claude-sonnet');
    expect(payloads[0].isTurnContinuation).toBe(false);

    const [user, assistant] = payloads[0].payload.history;
    expect(user).toMatchObject({
      role: 'User',
      message: 'add a health endpoint',
      message_raw: 'add a health endpoint',
      history_index: 0,
      date: '2026-08-01T10:00:00.000Z',
      file_names: [],
    });
    expect(assistant).toMatchObject({
      role: 'Assistant',
      message: 'Added GET /health.',
      history_index: 0,
      date: '2026-08-01T10:00:10.000Z',
      response_time: 10,
    });
    expect(assistant.assistant_id).toBeTruthy();
  });

  it('records thinking as reasoning, intermediate text as commentary, and pairs tool calls with their results', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('add a health endpoint'),
      assistantEntry([
        { type: 'thinking', thinking: 'the router lives in app.ts' },
        { type: 'text', text: 'Looking at the router first.' },
        { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'app.ts' } },
      ]),
      toolResultEntry('call-1', 'read', 'export const app = ...'),
      assistantEntry([{ type: 'text', text: 'Added GET /health.' }], '2026-08-01T10:00:10.000Z'),
    ]);

    await processor.process(session, buildContext());

    const thoughts = readPayloads()[0].payload.history[1].thoughts;
    expect(thoughts.map((thought: any) => thought.author_name)).toEqual([
      'Pi Reasoning',
      'Pi',
      'read',
    ]);
    expect(thoughts[0].message).toBe('the router lives in app.ts');
    expect(thoughts[1].message).toBe('Looking at the router first.');
    expect(thoughts[2]).toMatchObject({
      id: 'call-1',
      author_type: 'Tool',
      input_text: JSON.stringify({ path: 'app.ts' }),
      message: 'export const app = ...',
      error: false,
    });
  });

  it('marks a failed tool result as an error on its thought', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('read the missing file'),
      assistantEntry([{ type: 'toolCall', id: 'call-9', name: 'read', arguments: { path: 'nope.ts' } }]),
      toolResultEntry('call-9', 'read', 'ENOENT: no such file', true),
      assistantEntry([{ type: 'text', text: 'That file does not exist.' }], '2026-08-01T10:00:09.000Z'),
    ]);

    await processor.process(session, buildContext());

    const thoughts = readPayloads()[0].payload.history[1].thoughts;
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({ author_name: 'read', error: true, message: 'ENOENT: no such file' });
  });

  it('strips the skill wrapper from the user prompt', async () => {
    const processor = await createProcessor();
    const wrapped = [
      '<skill name="brainstorming" location="/home/dev/.pi/skills/brainstorming">',
      'You MUST use this before any creative work.',
      '</skill>',
      '',
      'lets design the cache layer',
    ].join('\n');

    const session = buildSession([
      userEntry(wrapped),
      assistantEntry([{ type: 'text', text: 'Sure.' }]),
    ]);

    await processor.process(session, buildContext());

    const user = readPayloads()[0].payload.history[0];
    expect(user.message).toBe('lets design the cache layer');
    expect(user.message_raw).toBe('lets design the cache layer');
  });

  it('gives an argument-less /skill: invocation its own turn instead of the previous question', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('explain the cache layer'),
      assistantEntry([{ type: 'text', text: 'The cache layer is an LRU.' }]),
      userEntry(skillWrapper('brainstorming'), '2026-08-01T10:01:00.000Z'),
      assistantEntry([{ type: 'text', text: 'Here is the brainstorm.' }], '2026-08-01T10:01:05.000Z'),
    ]);

    await processor.process(session, buildContext());

    // The brainstorm used to be published as the answer to "explain the cache layer", with
    // the real answer demoted to a thought, because a wordless prompt emitted no event.
    const payloads = readPayloads();
    expect(payloads.map((payload) => payload.payload.history.map((message: any) => message.message))).toEqual([
      ['explain the cache layer', 'The cache layer is an LRU.'],
      ['/skill:brainstorming', 'Here is the brainstorm.'],
    ]);
    expect(payloads.map((payload) => payload.historyIndices)).toEqual([[0, 0], [1, 1]]);
    expect(readFileSync(conversationsPath(), 'utf-8')).not.toContain(SKILL_BODY);
  });

  it('keeps an exchange that opens with an argument-less /skill: invocation', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry(skillWrapper('brainstorming')),
      assistantEntry([{ type: 'text', text: 'Here is the brainstorm.' }]),
    ]);

    await processor.process(session, buildContext());

    // A transcript that started with the skill invocation used to be dropped whole.
    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history.map((message: any) => message.message)).toEqual([
      '/skill:brainstorming',
      'Here is the brainstorm.',
    ]);
    expect(readFileSync(conversationsPath(), 'utf-8')).not.toContain(SKILL_BODY);
  });

  it('names an unparsable skill wrapper as a skill without uploading its body', async () => {
    const processor = await createProcessor();
    // The wrapper opens the way Pi writes it but never closes, so the shared parser fails
    // closed: no name, no text. The invocation still has to open a turn.
    const malformed = `<skill name="brainstorming" location="/home/dev/.pi/skills/brainstorming/SKILL.md">\n${SKILL_BODY}\n`;
    const session = buildSession([
      userEntry(malformed),
      assistantEntry([{ type: 'text', text: 'Here is the brainstorm.' }]),
    ]);

    await processor.process(session, buildContext());

    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history.map((message: any) => message.message)).toEqual([
      '/skill',
      'Here is the brainstorm.',
    ]);
    expect(readFileSync(conversationsPath(), 'utf-8')).not.toContain(SKILL_BODY);
  });

  it('gives an image-only message its own turn', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('what does this config do?'),
      assistantEntry([{ type: 'text', text: 'It configures the router.' }]),
      // Pi always writes the text block, empty when the user only attached a picture.
      userEntryWithContent(
        [
          { type: 'text', text: '' },
          { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
        ],
        '2026-08-01T10:01:00.000Z'
      ),
      assistantEntry([{ type: 'text', text: 'That is the login screen.' }], '2026-08-01T10:01:05.000Z'),
    ]);

    await processor.process(session, buildContext());

    expect(readPayloads().map((payload) => payload.payload.history.map((message: any) => message.message))).toEqual([
      ['what does this config do?', 'It configures the router.'],
      ['[1 image attachment]', 'That is the login screen.'],
    ]);
  });

  it('opens a turn for a user message with no publishable content, without an empty User bubble', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('what does this config do?'),
      assistantEntry([{ type: 'text', text: 'It configures the router.' }]),
      userEntryWithContent([], '2026-08-01T10:01:00.000Z'),
      assistantEntry([{ type: 'text', text: 'Second answer.' }], '2026-08-01T10:01:05.000Z'),
    ]);

    await processor.process(session, buildContext());

    const payloads = readPayloads();
    expect(payloads.map((payload) => payload.payload.history.map((message: any) => message.message))).toEqual([
      ['what does this config do?', 'It configures the router.'],
      ['Second answer.'],
    ]);
    expect(payloads[1].payload.history[0].role).toBe('Assistant');
    expect(payloads[1].historyIndices).toEqual([1]);
  });

  it('reads the skill wrapper per text block, so a multi-block prompt keeps the user words', async () => {
    const processor = await createProcessor();
    // Blocks join with a single "\n" while the wrapper's tail is anchored to "\n\n", so
    // parsing the joined content emptied the prompt and dropped the exchange.
    const session = buildSession([
      userEntryWithContent([
        { type: 'text', text: skillWrapper('brainstorming') },
        { type: 'text', text: 'and use redis for the backend' },
      ]),
      assistantEntry([{ type: 'text', text: 'Redis it is.' }]),
    ]);

    await processor.process(session, buildContext());

    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history.map((message: any) => message.message)).toEqual([
      'and use redis for the backend',
      'Redis it is.',
    ]);
    expect(readFileSync(conversationsPath(), 'utf-8')).not.toContain(SKILL_BODY);
  });

  it('never uploads a bash execution the user marked private', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('check the secrets'),
      entry('2026-08-01T10:00:03.000Z', {
        role: 'bashExecution',
        command: 'cat .env',
        output: 'OPENAI_API_KEY=sk-super-secret',
        exitCode: 0,
        cancelled: false,
        excludeFromContext: true,
        timestamp: Date.parse('2026-08-01T10:00:03.000Z'),
      }),
      assistantEntry([{ type: 'text', text: 'Done.' }]),
    ]);

    await processor.process(session, buildContext());

    const serialized = readFileSync(conversationsPath(), 'utf-8');
    expect(serialized).not.toContain('sk-super-secret');
    expect(serialized).not.toContain('cat .env');
    expect(readPayloads()[0].payload.history[1].thoughts).toBeUndefined();
  });

  it('records a shared bash execution as a bash tool thought', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('run the tests'),
      entry('2026-08-01T10:00:03.000Z', {
        role: 'bashExecution',
        command: 'npm test',
        output: '2 failing',
        exitCode: 1,
        cancelled: false,
        timestamp: Date.parse('2026-08-01T10:00:03.000Z'),
      }),
      assistantEntry([{ type: 'text', text: 'Two tests fail.' }]),
    ]);

    await processor.process(session, buildContext());

    const thoughts = readPayloads()[0].payload.history[1].thoughts;
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({
      author_type: 'Tool',
      author_name: 'bash',
      input_text: 'npm test',
      message: '2 failing',
      error: true,
    });
    expect(thoughts[0].metadata.exit_code).toBe(1);
  });

  it('records compaction and branch summaries as summary thoughts', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('carry on'),
      compactionEntry('earlier turns discussed the cache layer'),
      branchSummaryEntry('the branch explored a redis backend'),
      assistantEntry([{ type: 'text', text: 'Continuing.' }]),
    ]);

    await processor.process(session, buildContext());

    const thoughts = readPayloads()[0].payload.history[1].thoughts;
    expect(thoughts).toHaveLength(2);
    expect(thoughts[0]).toMatchObject({
      author_type: 'Agent',
      author_name: 'Compaction Summary',
      output_format: 'summary',
      message: 'earlier turns discussed the cache layer',
    });
    expect(thoughts[1]).toMatchObject({
      author_name: 'Branch Summary',
      output_format: 'summary',
      message: 'the branch explored a redis backend',
    });
  });

  it('queues every complete turn in one pass, since Pi only reports at session end', async () => {
    const processor = await createProcessor();
    const session = buildSession([
      userEntry('first question', '2026-08-01T10:00:00.000Z'),
      assistantEntry([{ type: 'text', text: 'first answer' }], '2026-08-01T10:00:05.000Z'),
      userEntry('second question', '2026-08-01T10:01:00.000Z'),
      assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z'),
      userEntry('third question', '2026-08-01T10:02:00.000Z'),
      assistantEntry([{ type: 'text', text: 'third answer' }], '2026-08-01T10:02:05.000Z'),
    ]);

    const result = await processor.process(session, buildContext());

    expect(result.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(3);
    expect(payloads.map((payload) => payload.historyIndices)).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(payloads.map((payload) => payload.payload.history[0].message)).toEqual([
      'first question',
      'second question',
      'third question',
    ]);
    expect(result.metadata?.syncUpdates?.conversations?.lastSyncedHistoryIndex).toBe(2);
  });

  it('is idempotent: re-processing the same transcript queues nothing new', async () => {
    const processor = await createProcessor();
    const entries = [
      userEntry('first question'),
      assistantEntry([{ type: 'text', text: 'first answer' }]),
    ];

    await processor.process(buildSession(entries), buildContext());
    const second = await processor.process(buildSession(entries), buildContext());

    expect(second.success).toBe(true);
    expect(second.metadata?.recordsProcessed).toBe(0);
    expect(readPayloads()).toHaveLength(1);
  });

  it('emits only the new turn when the transcript grows', async () => {
    const processor = await createProcessor();
    const entries = [
      userEntry('first question'),
      assistantEntry([{ type: 'text', text: 'first answer' }]),
    ];

    await processor.process(buildSession(entries), buildContext());

    const grown = [
      ...entries,
      userEntry('second question', '2026-08-01T10:01:00.000Z'),
      assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z'),
    ];
    const second = await processor.process(buildSession(grown), buildContext());

    expect(second.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].payload.history.map((message: any) => message.message)).toEqual([
      'second question',
      'second answer',
    ]);
    expect(payloads[1].historyIndices).toEqual([1, 1]);
  });

  it('completes a turn whose answer arrived after the prompt was already queued', async () => {
    const processor = await createProcessor();
    const prompt = userEntry('will you answer?');

    const first = await processor.process(buildSession([prompt]), buildContext());
    expect(first.success).toBe(true);
    expect(readPayloads()[0].payload.history).toHaveLength(1);

    const second = await processor.process(
      buildSession([prompt, assistantEntry([{ type: 'text', text: 'yes' }])]),
      buildContext()
    );

    expect(second.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].isTurnContinuation).toBe(true);
    expect(payloads[1].payload.history).toHaveLength(1);
    expect(payloads[1].payload.history[0]).toMatchObject({
      role: 'Assistant',
      message: 'yes',
      history_index: 0,
    });
  });

  it('honours a checkpoint persisted by a previous CodeMie run', async () => {
    const processor = await createProcessor();
    const entries = [
      userEntry('first question'),
      assistantEntry([{ type: 'text', text: 'first answer' }]),
      userEntry('second question', '2026-08-01T10:01:00.000Z'),
      assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z'),
    ];
    writeSessionRecord({
      conversations: { lastSyncedMessageUuid: `${PI_SESSION_ID}@1`, lastSyncedHistoryIndex: 0 },
    });

    await processor.process(buildSession(entries), buildContext());

    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history[0].message).toBe('second question');
    expect(payloads[0].historyIndices).toEqual([1, 1]);
  });

  it('keeps a second transcript of the same run in its own conversation', async () => {
    const processor = await createProcessor();
    const firstTranscript = [
      userEntry('first question'),
      assistantEntry([{ type: 'text', text: 'first answer' }]),
    ];
    await processor.process(buildSession(firstTranscript), buildContext());

    // `/new` starts a fresh transcript inside the same CodeMie session; its indices
    // must not inherit the previous transcript's checkpoint.
    const forkedTranscript = [
      userEntry('fresh start', '2026-08-01T11:00:00.000Z'),
      assistantEntry([{ type: 'text', text: 'clean slate' }], '2026-08-01T11:00:05.000Z'),
    ];
    await processor.process(buildSession(forkedTranscript, 'pi-session-b'), buildContext());

    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].payload.conversationId).toBe('pi-session-b');
    expect(payloads[1].historyIndices).toEqual([0, 0]);
    expect(payloads[1].payload.history[0].message).toBe('fresh start');
  });

  it('truncates oversized tool output instead of uploading it whole', async () => {
    const processor = await createProcessor();
    const hugeOutput = 'x'.repeat(20_000);
    const session = buildSession([
      userEntry('dump the file'),
      assistantEntry([{ type: 'toolCall', id: 'call-big', name: 'read', arguments: { path: 'big.txt' } }]),
      toolResultEntry('call-big', 'read', hugeOutput),
      assistantEntry([{ type: 'text', text: 'That is a big file.' }], '2026-08-01T10:00:09.000Z'),
    ]);

    await processor.process(session, buildContext());

    const thought = readPayloads()[0].payload.history[1].thoughts[0];
    expect(thought.message.length).toBeLessThan(hugeOutput.length);
    expect(thought.message).toContain('[truncated');
  });

  it('keeps queueing later turns when a resumed turn adds no new assistant text', async () => {
    const processor = await createProcessor();
    const question = userEntry('first question');
    const answer = assistantEntry([{ type: 'text', text: 'first answer' }]);
    await processor.process(buildSession([question, answer]), buildContext());

    // The run was interrupted after a model turn that only called tools — the common
    // shape — and the user then asked something new.
    const toolOnlyTail = assistantEntry(
      [{ type: 'toolCall', id: 'call-tail', name: 'read', arguments: { path: 'app.ts' } }],
      '2026-08-01T10:00:30.000Z'
    );
    const secondQuestion = userEntry('second question', '2026-08-01T10:01:00.000Z');
    const secondAnswer = assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z');
    const grown = [question, answer, toolOnlyTail, secondQuestion, secondAnswer];

    const second = await processor.process(buildSession(grown), buildContext());

    expect(second.success).toBe(true);
    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].payload.history.map((message: any) => message.message)).toEqual([
      'second question',
      'second answer',
    ]);
    expect(payloads[1].historyIndices).toEqual([1, 1]);

    // The stall used to be permanent, because the cursor was recomputed from the same
    // sentinel on every later call.
    const third = await processor.process(buildSession(grown), buildContext());
    expect(third.metadata?.recordsProcessed).toBe(0);
    expect(readPayloads()).toHaveLength(2);
  });

  it('declines a transcript whose header carries no Pi session id', async () => {
    const processor = await createProcessor();
    const { logger } = await import('@/utils/logger.js');
    vi.mocked(logger.warn).mockClear();

    const result = await processor.process(
      buildSessionWithoutHeaderId([userEntry('hi'), assistantEntry([{ type: 'text', text: 'hello' }])]),
      buildContext()
    );

    expect(result.success).toBe(true);
    expect(result.metadata?.recordsProcessed).toBe(0);
    expect(readPayloads()).toEqual([]);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never merges two header-less transcripts into one conversation', async () => {
    const processor = await createProcessor();

    await processor.process(
      buildSessionWithoutHeaderId([userEntry('first question'), assistantEntry([{ type: 'text', text: 'first answer' }])]),
      buildContext()
    );
    await processor.process(
      buildSessionWithoutHeaderId([
        userEntry('unrelated question', '2026-08-01T11:00:00.000Z'),
        assistantEntry([{ type: 'text', text: 'unrelated answer' }], '2026-08-01T11:00:05.000Z'),
      ]),
      buildContext()
    );

    // Falling back to the run id used to file both under one conversation, so the second
    // transcript's turns vanished into the first one's indices.
    expect(readPayloads()).toEqual([]);
  });

  it('numbers turns from the transcript, not from a session-wide history index', async () => {
    const processor = await createProcessor();
    // The sync processor takes lastSyncedHistoryIndex as a maximum over every conversation
    // in the session, so it can be far ahead of this transcript's own turn count.
    writeSessionRecord({
      conversations: { lastSyncedMessageUuid: `${PI_SESSION_ID}@1`, lastSyncedHistoryIndex: 9 },
    });

    await processor.process(
      buildSession([
        userEntry('first question'),
        assistantEntry([{ type: 'text', text: 'first answer' }]),
        userEntry('second question', '2026-08-01T10:01:00.000Z'),
        assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z'),
      ]),
      buildContext()
    );

    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history[0].message).toBe('second question');
    expect(payloads[0].historyIndices).toEqual([1, 1]);
  });

  it('uploads only the active branch, never an exchange the user rewound away', async () => {
    const processor = await createProcessor();
    const question = userEntry('first question');
    const answer = assistantEntry([{ type: 'text', text: 'first answer' }]);
    const rewoundQuestion = userEntry('rewound question', '2026-08-01T10:01:00.000Z');
    const rewoundAnswer = assistantEntry(
      [{ type: 'text', text: 'ABANDONED ANSWER' }],
      '2026-08-01T10:01:05.000Z'
    );
    // /rewind moves the leaf back to the first answer; the discarded exchange stays in
    // the file because Pi never rewrites entries.
    const replacementQuestion = withParent(
      userEntry('replacement question', '2026-08-01T10:02:00.000Z'),
      answer.id as string
    );
    const replacementAnswer = assistantEntry(
      [{ type: 'text', text: 'replacement answer' }],
      '2026-08-01T10:02:05.000Z'
    );

    await processor.process(
      buildSession([
        question,
        answer,
        rewoundQuestion,
        rewoundAnswer,
        replacementQuestion,
        replacementAnswer,
      ]),
      buildContext()
    );

    expect(readFileSync(conversationsPath(), 'utf-8')).not.toContain('ABANDONED ANSWER');
    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads.map((payload) => payload.payload.history.map((message: any) => message.message))).toEqual([
      ['first question', 'first answer'],
      ['replacement question', 'replacement answer'],
    ]);
    expect(payloads[1].historyIndices).toEqual([1, 1]);
  });

  it('re-uses the history index of an exchange a later /rewind replaced', async () => {
    const processor = await createProcessor();
    const question = userEntry('first question');
    const answer = assistantEntry([{ type: 'text', text: 'first answer' }]);
    const secondQuestion = userEntry('second question', '2026-08-01T10:01:00.000Z');
    const secondAnswer = assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z');

    // Both turns are uploaded before the user rewinds, which is what makes the collision
    // reachable: the second exchange is already published under index 1.
    await processor.process(buildSession([question, answer, secondQuestion, secondAnswer]), buildContext());

    const replacementQuestion = withParent(
      userEntry('replacement question', '2026-08-01T10:02:00.000Z'),
      answer.id as string
    );
    const replacementAnswer = assistantEntry(
      [{ type: 'text', text: 'replacement answer' }],
      '2026-08-01T10:02:05.000Z'
    );
    await processor.process(
      buildSession([question, answer, secondQuestion, secondAnswer, replacementQuestion, replacementAnswer]),
      buildContext()
    );

    // Deliberate, and documented on `scanNextTurn`: the replacement claims the index of the
    // exchange it replaced, so CodeMie is told the two occupy the same slot rather than
    // being shown a conversation in which both happened. Confirm CodeMie's upsert repairs
    // that slot before relying on it.
    const payloads = readPayloads();
    expect(payloads).toHaveLength(3);
    expect(payloads[1].historyIndices).toEqual([1, 1]);
    expect(payloads[2].historyIndices).toEqual([1, 1]);
    expect(payloads[1].payload.history.map((message: any) => message.message)).toEqual([
      'second question',
      'second answer',
    ]);
    expect(payloads[2].payload.history.map((message: any) => message.message)).toEqual([
      'replacement question',
      'replacement answer',
    ]);
  });

  it('ignores the session header line, which is not part of the entry tree', async () => {
    const processor = await createProcessor();
    const header = {
      type: 'session',
      version: 3,
      id: PI_SESSION_ID,
      timestamp: '2026-08-01T09:59:00.000Z',
      cwd: '/tmp/work',
    };

    await processor.process(
      buildSession([header, userEntry('hello'), assistantEntry([{ type: 'text', text: 'hi' }])]),
      buildContext()
    );

    const payloads = readPayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history.map((message: any) => message.message)).toEqual(['hello', 'hi']);
    expect(payloads[0].historyIndices).toEqual([0, 0]);
  });

  it('carries a leading compaction summary into the payload it precedes', async () => {
    const processor = await createProcessor();

    await processor.process(
      buildSession([
        compactionEntry('earlier turns designed the cache layer', '2026-08-01T09:59:30.000Z'),
        userEntry('carry on'),
        assistantEntry([{ type: 'text', text: 'Continuing.' }]),
      ]),
      buildContext()
    );

    const [payload] = readPayloads();
    expect(payload.payload.history[0].message).toBe('carry on');
    const thoughts = payload.payload.history[1].thoughts;
    expect(thoughts).toHaveLength(1);
    expect(thoughts[0]).toMatchObject({
      author_name: 'Compaction Summary',
      output_format: 'summary',
      message: 'earlier turns designed the cache layer',
    });
  });

  it('carries a compaction that lands between two synced turns into the next payload', async () => {
    const processor = await createProcessor();
    const question = userEntry('first question');
    const answer = assistantEntry([{ type: 'text', text: 'first answer' }]);
    await processor.process(buildSession([question, answer]), buildContext());

    const compaction = compactionEntry('the first exchange was summarised', '2026-08-01T10:00:30.000Z');
    const secondQuestion = userEntry('second question', '2026-08-01T10:01:00.000Z');
    const secondAnswer = assistantEntry([{ type: 'text', text: 'second answer' }], '2026-08-01T10:01:05.000Z');
    await processor.process(
      buildSession([question, answer, compaction, secondQuestion, secondAnswer]),
      buildContext()
    );

    const payloads = readPayloads();
    expect(payloads).toHaveLength(2);
    expect(payloads[1].payload.history[0].message).toBe('second question');
    expect(payloads[1].payload.history[1].thoughts.map((thought: any) => thought.author_name)).toEqual([
      'Compaction Summary',
    ]);
  });

  it('does not process when conversation sync is disabled for the session', async () => {
    const processor = await createProcessor();
    const original = process.env.CODEMIE_CONV_SYNC_DISABLED;
    process.env.CODEMIE_CONV_SYNC_DISABLED = '1';
    try {
      expect(processor.shouldProcess(buildSession([userEntry('hi')]))).toBe(false);
    } finally {
      if (original === undefined) {
        delete process.env.CODEMIE_CONV_SYNC_DISABLED;
      } else {
        process.env.CODEMIE_CONV_SYNC_DISABLED = original;
      }
    }
  });
});

describe('resolveConversationFolder — pi', () => {
  async function syncPayloadWithoutFolder(context: Partial<ProcessingContext>, agentName: string): Promise<string> {
    writeFileSync(
      conversationsPath(),
      JSON.stringify({
        payloadId: `${PI_SESSION_ID}@1`,
        timestamp: Date.now(),
        isTurnContinuation: false,
        historyIndices: [0],
        messageCount: 1,
        lastProcessedMessageUuid: `${PI_SESSION_ID}@1`,
        payload: { conversationId: PI_SESSION_ID, history: [{ role: 'User', message: 'hi' }] },
        status: 'pending',
      }) + '\n'
    );

    const { createSyncProcessor } = await import(
      '@/providers/plugins/sso/session/processors/conversations/syncProcessor.js'
    );
    await createSyncProcessor().process(
      { sessionId: SESSION_ID, agentName } as unknown as ParsedSession,
      {
        apiBaseUrl: 'https://codemie.test',
        cookies: '',
        clientType: 'unknown',
        version: '1.0.0',
        dryRun: false,
        ...context,
      } as ProcessingContext
    );

    expect(upsertConversation).toHaveBeenCalledTimes(1);
    return upsertConversation.mock.calls[0][3];
  }

  it('files a codemie-pi client under the pi folder rather than Claude Desktop', async () => {
    expect(await syncPayloadWithoutFolder({ clientType: 'codemie-pi' }, 'Pi')).toBe('pi');
  });

  it('files an agent named pi under the pi folder', async () => {
    expect(await syncPayloadWithoutFolder({ clientType: 'unknown' }, 'pi')).toBe('pi');
  });
});
