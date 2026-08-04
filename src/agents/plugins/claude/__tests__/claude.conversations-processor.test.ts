import { describe, it, expect, vi } from 'vitest';
import { ConversationsProcessor } from '../session/processors/claude.conversations-processor.js';

vi.mock('../../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

// Minimal helpers to build Claude Desktop (Cowork) transcript records.
let clock = 0;
const ts = () => new Date(1700000000000 + clock++ * 1000).toISOString();

const user = (uuid: string, content: any) => ({
  type: 'user',
  uuid,
  timestamp: ts(),
  message: { role: 'user', content },
});
const assistant = (uuid: string, content: any[]) => ({
  type: 'assistant',
  uuid,
  timestamp: ts(),
  message: { role: 'assistant', content },
});
// Cowork interleaves many of these *inside* a turn (init + audit events).
const system = (uuid: string, subtype = 'init') => ({ type: 'system', subtype, uuid, timestamp: ts() });

/**
 * Builds a Claude Desktop conversation where a file is uploaded and analysed:
 * system events appear in the middle of the turn and the user message is
 * wrapped in an <uploaded_files> block.
 */
function buildFileAnalysisTurn() {
  return [
    user(
      'u1',
      '<uploaded_files>\n<file><file_path>/Users/me/Documents/Report.docx</file_path>' +
        '<file_uuid>abc</file_uuid></file>\n</uploaded_files>\n\nanalyze this file'
    ),
    system('s-init-1'),
    system('s-init-2'),
    assistant('a1', [
      { type: 'thinking', thinking: 'reading the file' },
      { type: 'tool_use', id: 't1', name: 'Read', input: { file: 'Report.docx' } },
    ]),
    user('tr1', [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }]),
    // Mid-turn system event: this is what used to truncate the turn.
    system('s-audit-1', 'audit'),
    assistant('a2', [{ type: 'text', text: 'This document is a homework guide.' }]),
  ];
}

describe('ClaudeConversationsProcessor.transformMessages — file upload + analysis', () => {
  const proc = new ConversationsProcessor();
  const transform = (messages: unknown[]) =>
    (proc as any).transformMessages(messages, { lastSyncedHistoryIndex: -1 }, 'assistant-id', 'claude', undefined);

  it('keeps the assistant answer even when system events appear mid-turn', async () => {
    const { history } = await transform(buildFileAnalysisTurn());

    const assistantEntry = history.find((h: any) => h.role === 'Assistant');
    expect(assistantEntry).toBeDefined();
    // Regression: this was '' because a mid-turn system event truncated the turn.
    expect(assistantEntry.message).toContain('homework guide');
  });

  it('surfaces uploaded file names inline and strips the <uploaded_files> wrapper', async () => {
    const { history } = await transform(buildFileAnalysisTurn());

    const userEntry = history.find((h: any) => h.role === 'User');
    expect(userEntry).toBeDefined();
    // Imported files are not in CodeMie storage, so no file_names reference is
    // emitted (otherwise the backend file reader 500s on a plain name).
    expect(userEntry.file_names).toEqual([]);
    // The file name is shown inline next to the real prompt; no raw XML leaks.
    expect(userEntry.message).toContain('Report.docx');
    expect(userEntry.message).toContain('analyze this file');
    expect(userEntry.message).not.toContain('<uploaded_files>');
  });

  it('does not treat a plain message without attachments as having files', async () => {
    const { history } = await transform([
      user('u1', 'just a question'),
      assistant('a1', [{ type: 'text', text: 'an answer' }]),
    ]);

    const userEntry = history.find((h: any) => h.role === 'User');
    expect(userEntry.file_names).toEqual([]);
    expect(userEntry.message).toBe('just a question');
  });
});

/**
 * EPMCDME-13675 — `!` bash commands executed in a codemie-claude session must
 * be captured in the conversation log. Claude Code writes them into the raw
 * JSONL as `type:'user'` messages with content
 * `<bash-input>ls -al</bash-input>` and immediately after, the command's
 * output as `<bash-stdout>...</bash-stdout><bash-stderr>...</bash-stderr>`.
 * The `Stop` hook does NOT fire for a pure `!bash` turn (no assistant
 * response), so N bash commands followed by one real LLM question yield only
 * two `processSession()` calls — the processor must drain every pending turn
 * per invocation and it must not treat bash-output injections as fresh turns.
 */
describe('ClaudeConversationsProcessor — !bash command logging (EPMCDME-13675)', () => {
  const proc = new ConversationsProcessor();
  const transform = (messages: unknown[], syncState: any = { lastSyncedHistoryIndex: -1 }) =>
    (proc as any).transformMessages(messages, syncState, 'assistant-id', 'claude', undefined);

  const bashInput = (uuid: string, cmd: string) =>
    user(uuid, `<bash-input> ${cmd}</bash-input>`);
  const bashStdout = (uuid: string, out: string) =>
    user(uuid, `<bash-stdout>${out}</bash-stdout><bash-stderr></bash-stderr>`);
  const bashStderr = (uuid: string, err: string) =>
    user(uuid, `<bash-stderr>${err}</bash-stderr>`);

  it('T1 — a single `!ls -al` becomes a User entry with text `!ls -al`', async () => {
    const { history } = await transform([
      bashInput('u1', 'ls -al'),
      bashStdout('u2', 'total 0'),
    ]);
    const userEntries = history.filter((h: any) => h.role === 'User');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].message).toBe('!ls -al');
    expect(userEntries[0].message).not.toContain('<bash-input>');
  });

  it('T1 — trailing space in `!ls -al ` is trimmed to `!ls -al`', async () => {
    const { history } = await transform([
      bashInput('u1', 'ls -al '),
      bashStdout('u2', 'total 0'),
    ]);
    const userEntries = history.filter((h: any) => h.role === 'User');
    expect(userEntries[0].message).toBe('!ls -al');
  });

  it('T2 — a lone `<bash-stdout>` message is filtered (no User entry)', async () => {
    const { history } = await transform([bashStdout('u1', 'noise')]);
    expect(history).toHaveLength(0);
  });

  it('T2 — a lone `<bash-stderr>` message is filtered (no User entry)', async () => {
    const { history } = await transform([bashStderr('u1', 'oops')]);
    expect(history).toHaveLength(0);
  });

  it('T4 — the full `<bash-input>` + `<bash-stdout>` + `<bash-stderr>` triple emits exactly one User entry from the bash-input', async () => {
    const { history } = await transform([
      bashInput('u1', 'echo hi'),
      bashStdout('u2', 'hi'),
      bashStderr('u3', ''),
    ]);
    const userEntries = history.filter((h: any) => h.role === 'User');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0].message).toBe('!echo hi');
  });

  /**
   * T3 — the drain loop. Three bash commands followed by a real question and
   * assistant answer. Because the Stop hook only fires once (after the real
   * question is answered), `processMessages` must drain every pending turn in
   * one invocation, not stop after the first turn.
   *
   * The test drives the driver-level behavior by iterating transformMessages
   * with an advancing sync state — the same loop shape processMessages must
   * adopt (Task 3).
   */
  it('T3 — multi-bash then code question: every bash turn + the question + the answer are captured in order', async () => {
    const messages = [
      bashInput('u1', 'ls -al'),
      bashStdout('u1o', 'a b c'),
      bashInput('u2', 'pwd'),
      bashStdout('u2o', '/tmp'),
      bashInput('u3', 'whoami'),
      bashStdout('u3o', 'me'),
      user('u4', 'what files are here?'),
      assistant('a1', [{ type: 'text', text: 'a, b, c.' }]),
    ];

    // Drain-loop driver — mirrors what processMessages must do after Task 3.
    let sync: any = { lastSyncedHistoryIndex: -1 };
    const drained: any[] = [];
    for (let guard = 0; guard < 10; guard++) {
      const result = await transform(messages, sync);
      if (result.history.length === 0) break;
      drained.push(...result.history);
      sync = {
        lastSyncedMessageUuid: result.lastProcessedMessageUuid,
        lastSyncedHistoryIndex: result.currentHistoryIndex,
      };
    }

    // Assert the exact order expected by AC.
    const roles = drained.map((h) => h.role);
    const texts = drained.map((h) => h.message);

    // Bash User entries must be in order first
    expect(roles.slice(0, 3)).toEqual(['User', 'User', 'User']);
    expect(texts.slice(0, 3)).toEqual(['!ls -al', '!pwd', '!whoami']);

    // Then the real question and the assistant answer
    expect(drained.some((h) => h.role === 'User' && h.message === 'what files are here?'))
      .toBe(true);
    expect(drained.some((h) => h.role === 'Assistant' && (h.message || '').includes('a, b, c')))
      .toBe(true);

    // history_index must be monotonically increasing across turns
    const indices = drained.map((h) => h.history_index);
    for (let i = 1; i < indices.length; i++) {
      expect(indices[i]).toBeGreaterThanOrEqual(indices[i - 1]);
    }
  });
});
