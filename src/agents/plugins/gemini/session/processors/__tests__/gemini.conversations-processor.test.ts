import { describe, it, expect } from 'vitest';
import { GeminiConversationsProcessor } from '../gemini.conversations-processor.js';
import { detectTurns, type GeminiMessage } from '../../utils/turn-detector.js';
import { NON_TEXT_PROMPT_PLACEHOLDER } from '../../utils/message-text.js';
import type { ProcessingContext } from '../../../../../core/session/BaseProcessor.js';

const context = { agentSessionId: 'agent-session' } as ProcessingContext;

function msg(id: string, type: GeminiMessage['type'], content: GeminiMessage['content'], second = 0): GeminiMessage {
  return { id, type, content, timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString() };
}

function transform(messages: GeminiMessage[], lastHistoryIndex = 0): any[] {
  const processor = new GeminiConversationsProcessor();
  return (processor as any).transformTurnsToPayloads(detectTurns(messages), context, lastHistoryIndex);
}

describe('GeminiConversationsProcessor.transformTurnsToPayloads', () => {
  it('syncs plain-string user and gemini messages', () => {
    const [payload] = transform([msg('1', 'user', 'hello'), msg('2', 'gemini', 'hi there', 1)]);
    const [user, assistant] = payload.payload.history;

    expect(user.message).toBe('hello');
    expect(assistant.message).toBe('hi there');
  });

  it('keeps message_raw verbatim while message has <session_context> stripped', () => {
    const raw = '<session_context>ctx</session_context>\nfix the bug';
    const [payload] = transform([msg('1', 'user', raw), msg('2', 'gemini', 'done', 1)]);
    const [user] = payload.payload.history;

    expect(user.message).toBe('fix the bug');
    expect(user.message_raw).toBe(raw);
  });

  it('emits a placeholder user record when the prompt has no text but Gemini replied', () => {
    const [payload] = transform([
      msg('1', 'user', '<session_context>ctx</session_context>'),
      msg('2', 'gemini', 'substantive answer', 1)
    ]);
    const [user, assistant] = payload.payload.history;

    expect(user.message).toBe(NON_TEXT_PROMPT_PLACEHOLDER);
    expect(assistant.message).toBe('substantive answer');
    expect(user.history_index).toBe(1);
  });

  it('skips a turn with neither user text nor reply, without consuming a history index', () => {
    const payloads = transform([
      msg('1', 'user', ''),
      msg('2', 'gemini', '', 1),
      msg('3', 'user', 'real question', 2),
      msg('4', 'gemini', 'real answer', 3)
    ]);

    expect(payloads).toHaveLength(1);
    expect(payloads[0].payload.history[0].history_index).toBe(1);
  });
});
