import { describe, it, expect } from 'vitest';
import { recordHookConfig } from '../send-path.js';
import type { Session } from '../types.js';

function record(overrides: Partial<Session>): Session {
  return {
    sessionId: 'sid',
    agentName: 'codex',
    provider: 'ai-run-sso',
    startTime: 1,
    workingDirectory: '/work',
    status: 'completed',
    activeDurationMs: 0,
    correlation: { status: 'matched', retryCount: 0 },
    ...overrides,
  };
}

describe('recordHookConfig client type', () => {
  const launch = { CODEMIE_CLIENT_TYPE: 'codemie-claude' } as NodeJS.ProcessEnv;

  it('a record with none takes its own agent\'s', async () => {
    expect((await recordHookConfig(record({}), launch, { deliver: true })).clientType).toBe('codemie-codex');
  });

  it('a record with its own keeps it', async () => {
    expect((await recordHookConfig(record({ clientType: 'vscode-byok' }), launch, { deliver: true })).clientType).toBe('vscode-byok');
  });

  it('an unknown agent stays unset', async () => {
    const config = await recordHookConfig(record({ agentName: 'no-such-agent' }), launch, { deliver: true });
    expect(config).not.toHaveProperty('clientType');
  });
});
