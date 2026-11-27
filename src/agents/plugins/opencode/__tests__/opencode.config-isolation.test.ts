/**
 * EPMCDME-16963: the plain opencode and opencode-acp agents keep reading the user's own
 * OpenCode config; only codemie-code redirects XDG_CONFIG_HOME.
 *
 * @group unit
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: vi.fn(),
  stopOpenCodeIncrementalSync: vi.fn(),
}));
vi.mock('../../../core/session/ensure-session.js', () => ({ ensureSessionFile: vi.fn() }));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginDirUrl: () => 'file:///tmp/codemie-hooks/opencode-v2/',
  cleanupHooksPluginDir: vi.fn(),
}));

const { OpenCodePluginMetadata } = await import('../opencode.plugin.js');

describe('plain opencode agent config location', () => {
  it('does not redirect XDG_CONFIG_HOME away from the user\'s own OpenCode config', async () => {
    const env: NodeJS.ProcessEnv = {
      CODEMIE_SESSION_ID: 'codemie-uuid-1',
      CODEMIE_AGENT: 'opencode',
      CODEMIE_PROVIDER: 'ai-run-sso',
      CODEMIE_URL: 'https://sso.example.com',
      CODEMIE_BASE_URL: 'http://localhost:1234',
    };

    await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    expect(env.XDG_CONFIG_HOME).toBeUndefined();
  });
});
