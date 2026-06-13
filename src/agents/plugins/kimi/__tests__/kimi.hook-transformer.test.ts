import { describe, expect, it } from 'vitest';
import { KimiHookTransformer } from '../kimi.hook-transformer.js';
import { getKimiMainWirePath } from '../kimi.paths.js';

describe('KimiHookTransformer', () => {
  const transformer = new KimiHookTransformer();

  it('transforms SessionStart payload with source', () => {
    const payload = {
      hook_event_name: 'SessionStart',
      session_id: 'session-123',
      cwd: '/Users/alice/projects/my-app',
      source: 'startup',
    };

    const event = transformer.transform(payload);

    expect(transformer.agentName).toBe('kimi');
    expect(event.hook_event_name).toBe('SessionStart');
    expect(event.session_id).toBe('session-123');
    expect(event.cwd).toBe('/Users/alice/projects/my-app');
    expect(event.transcript_path).toBe(getKimiMainWirePath('/Users/alice/projects/my-app', 'session-123'));
    expect(event.transcript_path).toMatch(/agents\/main\/wire\.jsonl$/);
    expect(event.permission_mode).toBe('default');
    expect(event.source).toBe('startup');
  });

  it('transforms Stop payload and computes transcript path ending in agents/main/wire.jsonl', () => {
    const payload = {
      hook_event_name: 'Stop',
      session_id: 'session-stop-456',
      cwd: '/Users/bob/workspace',
      stop_hook_active: true,
    };

    const event = transformer.transform(payload);

    expect(event.hook_event_name).toBe('Stop');
    expect(event.session_id).toBe('session-stop-456');
    expect(event.cwd).toBe('/Users/bob/workspace');
    expect(event.transcript_path).toMatch(/agents\/main\/wire\.jsonl$/);
    expect(event.stop_hook_active).toBe(true);
    expect(event.permission_mode).toBe('default');
  });

  it('transforms SessionEnd payload with reason', () => {
    const payload = {
      hook_event_name: 'SessionEnd',
      session_id: 'session-end-789',
      cwd: '/Users/carol/project',
      reason: 'logout',
    };

    const event = transformer.transform(payload);

    expect(event.hook_event_name).toBe('SessionEnd');
    expect(event.session_id).toBe('session-end-789');
    expect(event.reason).toBe('logout');
    expect(event.transcript_path).toBe(getKimiMainWirePath('/Users/carol/project', 'session-end-789'));
    expect(event.permission_mode).toBe('default');
  });

  it('transforms UserPromptSubmit payload without unsupported prompt field', () => {
    const payload = {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'session-prompt-000',
      cwd: '/Users/dave/project',
      prompt: [
        { type: 'text', text: 'hello world' },
      ],
    };

    const event = transformer.transform(payload);

    expect(event.hook_event_name).toBe('UserPromptSubmit');
    expect(event.session_id).toBe('session-prompt-000');
    expect(event.cwd).toBe('/Users/dave/project');
    expect(event.transcript_path).toBe(getKimiMainWirePath('/Users/dave/project', 'session-prompt-000'));
    expect('prompt' in event).toBe(false);
    expect(event.permission_mode).toBe('default');
  });

  it('preserves unknown hook_event_name values', () => {
    const payload = {
      hook_event_name: 'CustomKimiEvent',
      session_id: 'session-custom',
      cwd: '/Users/eve/project',
    };

    const event = transformer.transform(payload);

    expect(event.hook_event_name).toBe('CustomKimiEvent');
    expect(event.session_id).toBe('session-custom');
    expect(event.transcript_path).toBe(getKimiMainWirePath('/Users/eve/project', 'session-custom'));
    expect(event.permission_mode).toBe('default');
  });

  it('falls back to process.cwd() when cwd is missing', () => {
    const payload = {
      hook_event_name: 'SessionStart',
      session_id: 'session-no-cwd',
      source: 'resume',
    };

    const event = transformer.transform(payload);

    expect(event.cwd).toBe(process.cwd());
    expect(event.session_id).toBe('session-no-cwd');
    expect(event.hook_event_name).toBe('SessionStart');
    expect(event.source).toBe('resume');
    expect(event.transcript_path).toBe(getKimiMainWirePath(process.cwd(), 'session-no-cwd'));
  });
});
