/**
 * Migration 010 rewrites the bare `codemie hook --agent claude-code-otlp` that
 * `codemie proxy connect` wrote into ~/.claude/settings.json, so Git Bash can run it
 * when only codemie.cmd exists (EPMCDME-15907). User hooks are left alone.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const BARE = 'codemie hook --agent claude-code-otlp';
const BIN = 'C:/Users/u/AppData/Local/CodeMie Connect/bin/codemie.cmd';

describe('010-localize-otlp-hook-commands', () => {
  let home = '';

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'mig010-'));
    vi.doMock('os', async (imp) => ({ ...(await imp<typeof import('os')>()), homedir: () => home }));
    vi.doMock('../../utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }));
    vi.doMock('@/utils/hook-command.js', async (imp) => ({
      ...(await imp<typeof import('../../utils/hook-command.js')>()),
      resolveCodemieBinary: async () => `"${BIN}"`,
    }));
  });

  afterEach(async () => {
    vi.doUnmock('os');
    vi.doUnmock('@/utils/hook-command.js');
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const file = (): string => join(home, '.claude', 'settings.json');
  const seed = async (s: unknown): Promise<void> => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(file(), JSON.stringify(s));
  };
  const run = async () => {
    const { LocalizeOtlpHookCommandsMigration } = await import('../010-localize-otlp-hook-commands.migration.js');
    return new LocalizeOtlpHookCommandsMigration().up();
  };

  it('rewrites only codemie\'s bare hook and leaves the user\'s hook untouched', async () => {
    await seed({
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: BARE }] }],
        Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'codemie notify mine' }] }],
      },
    });
    expect(await run()).toMatchObject({ success: true, migrated: true });
    const out = JSON.parse(await readFile(file(), 'utf-8'));
    const rewritten = out.hooks.SessionStart[0].hooks[0];
    expect(rewritten.command).not.toBe(BARE);
    expect(rewritten.command).toContain(BIN);
    expect(rewritten.command.endsWith(' hook --agent claude-code-otlp')).toBe(true);
    expect(out.hooks.Stop[0].hooks[0].command).toBe('codemie notify mine');
  });

  it('is a no-op without a settings file or when nothing needs rewriting', async () => {
    expect(await run()).toMatchObject({ success: true, migrated: false });
    await seed({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hi' }] }] } });
    expect(await run()).toMatchObject({ success: true, migrated: false });
  });
});
