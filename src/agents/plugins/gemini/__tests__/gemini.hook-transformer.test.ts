import { describe, expect, it } from 'vitest';
import { GeminiHookTransformer } from '../gemini.hook-transformer.js';

describe('GeminiHookTransformer', () => {
  const transformer = new GeminiHookTransformer();

  it('transforms SessionEnd payload with reason, adding a default permission_mode', () => {
    const payload = {
      hook_event_name: 'SessionEnd',
      session_id: 'session-end-1',
      transcript_path: '/tmp/session-end-1.json',
      cwd: '/Users/carol/project',
      timestamp: '2026-01-14T19:24:04.203Z',
      reason: 'logout',
    };

    const event = transformer.transform(payload);

    expect(transformer.agentName).toBe('gemini');
    expect(event.hook_event_name).toBe('SessionEnd');
    expect(event.session_id).toBe('session-end-1');
    expect(event.reason).toBe('logout');
    expect(event.permission_mode).toBe('default');
    expect('timestamp' in event).toBe(false);
  });

  it('passes through endTime on a synthetic SessionEnd from stale-session reconciliation', () => {
    const endTime = Date.now() - 2 * 60 * 60 * 1000;
    const payload = {
      hook_event_name: 'SessionEnd',
      session_id: 'session-reconciled-1',
      transcript_path: '',
      cwd: '/Users/carol/project',
      reason: 'interrupted',
      endTime,
    };

    const event = transformer.transform(payload);

    expect(event.endTime).toBe(endTime);
  });

  it('omits endTime from a live SessionEnd that never set it', () => {
    const payload = {
      hook_event_name: 'SessionEnd',
      session_id: 'session-end-2',
      transcript_path: '/tmp/session-end-2.json',
      cwd: '/Users/carol/project',
      reason: 'exit',
    };

    const event = transformer.transform(payload);

    expect('endTime' in event).toBe(false);
  });
});
