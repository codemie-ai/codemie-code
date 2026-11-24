import { describe, expect, it } from 'vitest';
import { GeminiHookTransformer } from '../gemini.hook-transformer.js';

describe('GeminiHookTransformer', () => {
  const transformer = new GeminiHookTransformer();

  it('passes the synthetic SessionEnd fields through: transcript_path, endTimeFromActivity, endTime', () => {
    const event = transformer.transform({
      hook_event_name: 'SessionEnd',
      session_id: 'gemini-native-1',
      transcript_path: '/home/u/.gemini/tmp/abc/chats/session-1.json',
      cwd: '/repo',
      reason: 'interrupted',
      endTimeFromActivity: true,
      endTime: 1_790_000_000_000,
    });

    expect(event).toMatchObject({
      hook_event_name: 'SessionEnd',
      session_id: 'gemini-native-1',
      transcript_path: '/home/u/.gemini/tmp/abc/chats/session-1.json',
      reason: 'interrupted',
      endTimeFromActivity: true,
      endTime: 1_790_000_000_000,
    });
  });

  it('adds neither field to a native SessionEnd', () => {
    const event = transformer.transform({
      hook_event_name: 'SessionEnd',
      session_id: 'gemini-native-2',
      transcript_path: '/t.json',
      cwd: '/repo',
      reason: 'exit',
    });

    expect(event).not.toHaveProperty('endTimeFromActivity');
    expect(event).not.toHaveProperty('endTime');
  });
});
