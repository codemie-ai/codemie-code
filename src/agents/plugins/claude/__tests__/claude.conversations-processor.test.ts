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
