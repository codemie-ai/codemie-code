/**
 * Pi onSessionStart: the SessionStart event and the config it hands to processEvent.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { PiPluginMetadata } from '../pi.plugin.js';

const processEvent = vi.fn();
vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: (...args: unknown[]) => processEvent(...args) }));
const startPiIncrementalSync = vi.fn();
vi.mock('../pi.incremental-sync.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pi.incremental-sync.js')>()),
  startPiIncrementalSync: (...args: unknown[]) => startPiIncrementalSync(...args),
}));
vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  processEvent.mockReset();
  startPiIncrementalSync.mockReset();
});

describe('Pi onSessionStart', () => {
  it('hands processEvent the wrapper owner from the env, so the record stores it', async () => {
    // The mid-run flush timer is not under test.
    vi.stubEnv('CODEMIE_PI_SYNC_ENABLED', 'false');

    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-owner', {
      CODEMIE_WRAPPER_PID: '4242',
      CODEMIE_WRAPPER_STARTED_AT: '1790000000000',
    });

    expect(processEvent).toHaveBeenCalledWith(
      expect.objectContaining({ hook_event_name: 'SessionStart' }),
      expect.objectContaining({ ownerPid: 4242, ownerStartedAt: 1_790_000_000_000 }),
    );
  });

  it('with no started proxy and no sync URL, the mid-run flush gets no send path: CODEMIE_BASE_URL is the LLM host', async () => {
    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-no-send-path', {
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_BASE_URL: 'https://llm.example.com',
    });

    const options = startPiIncrementalSync.mock.calls[0][0];
    expect(options.syncApiUrl).toBeUndefined();
    expect(options.buildContext().apiBaseUrl).toBe('');
  });

  it('with the started proxy, the mid-run flush sends through it', async () => {
    await PiPluginMetadata.lifecycle!.onSessionStart!('sid-proxy', {
      CODEMIE_URL: 'https://codemie.example.com',
      CODEMIE_BASE_URL: 'http://127.0.0.1:4000',
      CODEMIE_TARGET_API_URL: 'https://codemie.example.com/code-assistant-api',
    });

    const options = startPiIncrementalSync.mock.calls[0][0];
    expect(options.syncApiUrl).toBe('http://127.0.0.1:4000');
    expect(options.buildContext().apiBaseUrl).toBe('http://127.0.0.1:4000');
  });
});
