/**
 * HeaderInjectionPlugin: the client label a model request carries in `X-CodeMie-Client`.
 * @group unit
 */
import { describe, expect, it, vi } from 'vitest';
import { HeaderInjectionPlugin } from '../header-injection.plugin.js';
import type { ProxyContext } from '../../proxy-types.js';
import { logger } from '../../../../../../utils/logger.js';

async function headersFor(
  agentName: string,
  attribution: { repository?: string; branch?: string } = {}
): Promise<Record<string, unknown>> {
  const interceptor = await new HeaderInjectionPlugin().createInterceptor({
    config: { targetApiUrl: 'https://codemie.example.com/code-assistant-api', ...attribution },
    logger,
  });
  const context: ProxyContext = {
    requestId: 'req-1',
    sessionId: 'sess-1',
    agentName,
    method: 'POST',
    url: '/v1/messages',
    headers: {},
    requestBody: null,
    requestStartTime: Date.now(),
    metadata: {},
  };
  await interceptor.onRequest!(context);
  return context.headers;
}

describe('HeaderInjectionPlugin client label', () => {
  it('labels a codex-desktop request codex-desktop', async () => {
    expect((await headersFor('codex-desktop'))['X-CodeMie-Client']).toBe('codex-desktop');
  });

  it('labels a vscode-claude-code request claude-desktop', async () => {
    expect((await headersFor('vscode-claude-code'))['X-CodeMie-Client']).toBe('claude-desktop');
  });

  it('sends no client label for an unknown client', async () => {
    const headers = await headersFor('unknown');
    expect(Object.keys(headers).filter((name) => name.toLowerCase() === 'x-codemie-client')).toEqual([]);
  });
});

describe('HeaderInjectionPlugin log line', () => {
  it('logs whether the attribution headers are set, never their values', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    try {
      const headers = await headersFor('codex-desktop', { repository: 'acme/payments-core', branch: 'feature/q3-plan' });

      expect(headers['X-CodeMie-Repository']).toBe('acme/payments-core');
      expect(headers['X-CodeMie-Branch']).toBe('feature/q3-plan');
      const logged = JSON.stringify(info.mock.calls);
      expect(logged).not.toContain('acme/payments-core');
      expect(logged).not.toContain('feature/q3-plan');
      expect(logged).not.toContain('codex-desktop');
      const line = info.mock.calls.find(([message]) => message === '[header-injection] Request headers');
      expect(line?.[1]).toMatchObject({ hasRepository: true, hasBranch: true, hasClient: true });
    } finally {
      info.mockRestore();
    }
  });
});
