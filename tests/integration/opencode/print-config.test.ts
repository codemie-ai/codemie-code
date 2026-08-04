import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/agents/core/session/ensure-session.js', () => ({
  ensureSessionFile: vi.fn(() => Promise.resolve()),
}));

import { OpenCodePluginMetadata } from '../../../src/agents/plugins/opencode/opencode.plugin.js';
import { extractGeneratedConfig } from '../../../src/agents/core/print-config.js';
import { redactSecrets } from '../../../src/agents/core/config-redaction.js';

describe('print-config against the real opencode plugin', () => {
  it('produces a redacted, well-formed config from a realistic env (network fetch fails and falls back to static models)', async () => {
    const env = {
      CODEMIE_SESSION_ID: 'test-session-print-config',
      CODEMIE_BASE_URL: 'https://example.invalid', // RFC 2606 reserved TLD: fails fast, no real network dependency
      CODEMIE_MODEL: 'gpt-5-2-2025-12-11',
      CODEMIE_TIMEOUT: '600',
    } as NodeJS.ProcessEnv;

    const resultEnv = await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {});

    const generated = extractGeneratedConfig(resultEnv);
    const redacted = redactSecrets(generated) as Record<string, unknown>;

    expect(redacted.model).toContain('codemie-proxy/');
    const provider = redacted.provider as Record<string, any>;
    expect(provider['codemie-proxy'].options.apiKey).toBe('***REDACTED***');
    expect(provider['codemie-proxy'].options.baseURL).toBe('https://example.invalid/');
  });

  it('extractGeneratedConfig throws when CODEMIE_BASE_URL is missing (beforeRun early-return path)', async () => {
    const env = { CODEMIE_SESSION_ID: 'test-session-no-url' } as NodeJS.ProcessEnv;

    const resultEnv = await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {});

    expect(() => extractGeneratedConfig(resultEnv)).toThrow(
      'Could not generate opencode config: CODEMIE_BASE_URL is missing or invalid',
    );
  });
});
