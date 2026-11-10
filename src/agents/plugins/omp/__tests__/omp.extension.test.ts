/**
 * Materialization of the CodeMie omp extensions: under the CodeMie home only, never in ~/.omp.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let home: string;
const savedEnv = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), 'omp-ext-'));
  process.env.CODEMIE_HOME = home;
  delete process.env.CODEMIE_PI_EXTENSION_DISABLED;
});

afterEach(() => {
  process.env = { ...savedEnv };
  rmSync(home, { recursive: true, force: true });
});

describe('omp extension materialization', () => {
  it('installs the ledger and providers extensions under the CodeMie home', async () => {
    const { ensureOmpLedgerExtension, ensureOmpProvidersExtension, getOmpExtensionsDir } = await import('../omp.extension.js');

    const ledger = await ensureOmpLedgerExtension({});
    const providers = await ensureOmpProvidersExtension();

    expect(ledger).toEqual({ installed: true, path: join(getOmpExtensionsDir(), 'codemie-metrics') });
    expect(providers).toEqual({ installed: true, path: join(getOmpExtensionsDir(), 'codemie-providers') });
    expect(getOmpExtensionsDir().startsWith(home)).toBe(true);
    expect(existsSync(join(ledger.path!, 'index.js'))).toBe(true);
    expect(existsSync(join(providers.path!, 'package.json'))).toBe(true);
  });

  it('honours the ledger kill switch', async () => {
    const { ensureOmpLedgerExtension } = await import('../omp.extension.js');
    await ensureOmpLedgerExtension({});

    expect(await ensureOmpLedgerExtension({ CODEMIE_PI_EXTENSION_DISABLED: '1' })).toEqual({
      installed: false, reason: 'disabled',
    });
  });

  it('writes the run\'s provider list owner-only and removes it afterwards', async () => {
    const { writeOmpProvidersConfig, removeOmpProvidersConfig } = await import('../omp.extension.js');

    const path = await writeOmpProvidersConfig('sid-1', { providers: {} });

    expect(path.startsWith(home)).toBe(true);
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ providers: {} });
    expect(statSync(path).mode & 0o077).toBe(0);

    await removeOmpProvidersConfig(path);
    expect(existsSync(path)).toBe(false);
    await expect(removeOmpProvidersConfig(undefined)).resolves.toBeUndefined();
  });
});

describe('omp beforeRun', () => {
  it('sets the ledger and providers env without touching omp\'s own directory', async () => {
    vi.doMock('../../pi/pi.models.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../pi/pi.models.js')>()),
      buildPiModelsConfig: vi.fn().mockResolvedValue({ providers: {} }),
    }));
    const { OmpPluginMetadata } = await import('../omp.plugin.js');
    const env: NodeJS.ProcessEnv = { CODEMIE_SESSION_ID: 'sid-2' };

    await OmpPluginMetadata.lifecycle!.beforeRun!(env, {} as never);

    expect(env.PI_CODING_AGENT_DIR).toBeUndefined();
    expect(env.CODEMIE_PI_LEDGER).toBe(join(home, 'sessions', 'sid-2_pi-run.jsonl'));
    expect(env.CODEMIE_OMP_LEDGER_EXTENSION).toBe(join(home, 'omp', 'extensions', 'codemie-metrics', 'index.js'));
    expect(env.CODEMIE_OMP_PROVIDERS_EXTENSION).toBe(join(home, 'omp', 'extensions', 'codemie-providers', 'index.js'));
    expect(JSON.parse(readFileSync(env.CODEMIE_OMP_PROVIDERS!, 'utf-8'))).toEqual({ providers: {} });
  });
});

describe('omp providers file lifetime', () => {
  it('creates the providers directory owner-only', async () => {
    const { writeOmpProvidersConfig } = await import('../omp.extension.js');

    const path = await writeOmpProvidersConfig('sid-3', { providers: {} });

    expect(statSync(dirname(path)).mode & 0o077).toBe(0);
  });

  it.each([
    ['a dry run, which never reaches onSessionEnd', undefined, { dryRun: true }],
    ['an abort before the spawn', new Error('No model configured'), undefined],
  ])('removes the key-bearing file after %s', async (_label, failure, runOptions) => {
    const { writeOmpProvidersConfig } = await import('../omp.extension.js');
    const { OmpPlugin } = await import('../omp.plugin.js');
    const { BaseAgentAdapter } = await import('../../../core/BaseAgentAdapter.js');
    const path = await writeOmpProvidersConfig('sid-4', { providers: {} });
    process.env.CODEMIE_OMP_PROVIDERS = path;
    const superRun = vi.spyOn(BaseAgentAdapter.prototype, 'run');
    if (failure) superRun.mockRejectedValue(failure);
    else superRun.mockResolvedValue(undefined);

    await new OmpPlugin().run([], undefined, runOptions).catch(() => undefined);

    expect(existsSync(path)).toBe(false);
  });
});

describe('omp enrichArgs', () => {
  it('throws a ConfigurationError when no model is configured', async () => {
    delete process.env.CODEMIE_MODEL;
    const { OmpPluginMetadata } = await import('../omp.plugin.js');
    const { ConfigurationError } = await import('@/utils/errors.js');

    expect(() => OmpPluginMetadata.lifecycle!.enrichArgs!([], {} as never)).toThrow(ConfigurationError);
  });
});
