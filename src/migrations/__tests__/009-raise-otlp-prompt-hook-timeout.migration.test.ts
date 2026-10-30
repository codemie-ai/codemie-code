/**
 * Migration 009 raises the claude-code-otlp UserPromptSubmit hook timeout that
 * `codemie proxy connect` wrote before EPMCDME-16568 (30s), so the SSO sign-in
 * wait is not capped at 15s for existing installs.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const CODEMIE = 'codemie hook --agent claude-code-otlp';

describe('009-raise-otlp-prompt-hook-timeout', () => {
  let home = '';

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'mig009-'));
    vi.doMock('os', async (imp) => ({ ...(await imp<typeof import('os')>()), homedir: () => home }));
    vi.doMock('../../utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
  });

  afterEach(async () => {
    vi.doUnmock('os');
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const settingsFile = (): string => join(home, '.claude', 'settings.json');

  async function seed(settings: unknown): Promise<void> {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsFile(), JSON.stringify(settings));
  }

  async function run(): Promise<{ success: boolean; migrated: boolean }> {
    const { RaiseOtlpPromptHookTimeoutMigration } = await import('../009-raise-otlp-prompt-hook-timeout.migration.js');
    return new RaiseOtlpPromptHookTimeoutMigration().up();
  }

  it('raises the legacy 30s codemie prompt hook and adds the status message', async () => {
    await seed({
      env: { KEEP: '1' },
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'other-tool', timeout: 5 }] },
          { matcher: '', hooks: [{ type: 'command', command: `/abs/${CODEMIE}`, timeout: 30 }] },
        ],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: `/abs/${CODEMIE}`, timeout: 30 }] }],
      },
    });

    expect(await run()).toMatchObject({ success: true, migrated: true });

    const settings = JSON.parse(await readFile(settingsFile(), 'utf-8'));
    expect(settings.env).toEqual({ KEEP: '1' });
    expect(settings.hooks.UserPromptSubmit[0].hooks[0]).toEqual({ type: 'command', command: 'other-tool', timeout: 5 });
    expect(settings.hooks.UserPromptSubmit[1].hooks[0]).toMatchObject({ timeout: 180, statusMessage: expect.any(String) });
    expect(settings.hooks.Stop[0].hooks[0].timeout).toBe(30);
  });

  it('is idempotent and leaves an already-raised entry untouched', async () => {
    await seed({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: CODEMIE, timeout: 30 }] }] } });
    await run();

    expect(await run()).toMatchObject({ success: true, migrated: false });
  });

  it('is a no-op without a settings file or with malformed JSON', async () => {
    expect(await run()).toMatchObject({ success: true, migrated: false });

    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(settingsFile(), '{ not json');
    expect(await run()).toMatchObject({ success: true, migrated: false });
    expect(await readFile(settingsFile(), 'utf-8')).toBe('{ not json');
  });
});
