/**
 * The daemon entry point writes its state file before the Desktop telemetry runtime starts.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const runtimeStart = vi.fn();
const writeFileSpy = vi.fn();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => {
      writeFileSpy(args[0]);
      return actual.writeFile(...args);
    }),
  };
});
vi.mock('../../providers/plugins/sso/index.js', () => ({
  CodeMieProxy: class {
    start = async () => ({ port: 47999, url: 'http://127.0.0.1:47999' });
    stop = async () => undefined;
  },
}));
vi.mock('../../providers/plugins/sso/proxy/plugins/index.js', () => ({}));
vi.mock('../../telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js', () => ({
  ClaudeDesktopTelemetryAdapter: class {},
}));
vi.mock('../../telemetry/runtime/DesktopRepositoryResolver.js', () => ({
  DesktopRepositoryResolver: class {},
}));
vi.mock('../../telemetry/runtime/DesktopTelemetryRuntime.js', () => ({
  DesktopTelemetryRuntime: class {
    start = runtimeStart;
    triggerPoll = async () => undefined;
    stop = async () => undefined;
  },
}));
vi.mock('../../utils/system-proxy-dispatcher.js', () => ({
  installSystemProxyDispatcher: vi.fn(),
}));
vi.mock('../../cli/commands/proxy/watcher.js', () => ({
  ProxyWatcher: class {
    start = () => undefined;
    stop = () => undefined;
  },
}));

import { isDaemonAlive, type DaemonState } from '../../cli/commands/proxy/daemon-manager.js';

/** Waits (real time) until `condition` holds; fails the test after ~5 s. */
async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (condition()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('condition not met');
}

describe('proxy-daemon entry point', () => {
  const originalArgv = process.argv;
  const signalListeners = { SIGTERM: process.listeners('SIGTERM'), SIGINT: process.listeners('SIGINT') };
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await mkdtemp(join(tmpdir(), 'proxy-daemon-'));
    stateFile = join(tempDir, 'proxy-daemon.json');
    process.argv = [
      'node', 'proxy-daemon',
      '--target-url', 'https://upstream.example.com',
      '--state-file', stateFile,
      '--telemetry-mode', 'claude-desktop',
    ];
  });

  afterEach(async () => {
    process.argv = originalArgv;
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      for (const listener of process.listeners(signal)) {
        if (!signalListeners[signal].includes(listener)) process.off(signal, listener);
      }
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  it('writes a live state while the runtime start is still pending', async () => {
    let finishStart!: () => void;
    runtimeStart.mockReturnValue(new Promise<void>(resolve => { finishStart = resolve; }));

    // Not awaited: the module's top-level await holds until the runtime start resolves
    const daemon = import('../proxy-daemon.js');
    await waitFor(() => runtimeStart.mock.calls.length > 0);

    expect(existsSync(stateFile)).toBe(true);
    const state = JSON.parse(await readFile(stateFile, 'utf-8')) as DaemonState;
    expect(state).toMatchObject({ pid: process.pid, port: 47999, telemetryMode: 'claude-desktop' });
    expect(await isDaemonAlive(state)).toBe(true);

    finishStart();
    await daemon;
  });

  it('writes the state through a temp file named after its own pid', async () => {
    process.argv = process.argv.slice(0, -2);

    await import('../proxy-daemon.js');

    expect(writeFileSpy).toHaveBeenCalledWith(`${stateFile}.${process.pid}.tmp`);
    expect(existsSync(stateFile)).toBe(true);
  });
});
