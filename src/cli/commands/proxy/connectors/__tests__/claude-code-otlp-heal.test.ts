/**
 * healClaudeSettingsHooks repairs stale CodeMie CLI paths in the claude-code-otlp hooks of
 * ~/.claude/settings.json (EPMCDME-17164) and leaves everything else alone.
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const BIN = 'C:/Users/u/AppData/Local/CodeMie Connect/bin/codemie.cmd';
const TAIL = ' hook --agent claude-code-otlp';

describe('healClaudeSettingsHooks', () => {
  let home = '';

  beforeEach(async () => {
    vi.resetModules();
    home = await mkdtemp(join(tmpdir(), 'heal-'));
    vi.doMock('os', async (imp) => ({ ...(await imp<typeof import('os')>()), homedir: () => home }));
    vi.doMock('@/utils/hook-command.js', async (imp) => ({
      ...(await imp<typeof import('@/utils/hook-command.js')>()),
      resolveCodemieBinary: async () => `"${BIN}"`,
    }));
  });

  afterEach(async () => {
    vi.doUnmock('os');
    vi.doUnmock('@/utils/hook-command.js');
    await rm(home, { recursive: true, force: true, maxRetries: 3 });
  });

  const file = (): string => join(home, '.claude', 'settings.json');
  const seedRaw = async (raw: string): Promise<void> => {
    await mkdir(join(home, '.claude'), { recursive: true });
    await writeFile(file(), raw);
  };
  const heal = async (): Promise<boolean> => {
    const { healClaudeSettingsHooks } = await import('../claude-code-otlp.js');
    return healClaudeSettingsHooks();
  };

  it('rewrites a removed executable to the current binary', async () => {
    const stale = `"C:/gone/nowhere/codemie.cmd"${TAIL}`;
    await seedRaw(JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: stale }] }] } }));
    expect(await heal()).toBe(true);
    const out = JSON.parse(await readFile(file(), 'utf-8'));
    const cmd: string = out.hooks.Stop[0].hooks[0].command;
    expect(cmd).toContain(BIN);
    expect(cmd.endsWith(TAIL)).toBe(true);
  });

  it('does not write when the path is still valid', async () => {
    const valid = JSON.stringify({
      hooks: { Stop: [{ matcher: '', hooks: [{ type: 'command', command: `"${process.execPath}"${TAIL}` }] }] },
    });
    await seedRaw(valid);
    expect(await heal()).toBe(false);
    expect(await readFile(file(), 'utf-8')).toBe(valid);
  });

  it('preserves user hooks and unrelated keys', async () => {
    await seedRaw(JSON.stringify({
      model: 'opus',
      hooks: {
        Stop: [{ matcher: '', hooks: [
          { type: 'command', command: `"C:/gone/codemie.cmd"${TAIL}` },
          { type: 'command', command: 'codemie notify mine' },
        ] }],
      },
    }));
    expect(await heal()).toBe(true);
    const out = JSON.parse(await readFile(file(), 'utf-8'));
    expect(out.model).toBe('opus');
    expect(out.hooks.Stop[0].hooks[1].command).toBe('codemie notify mine');
  });

  it('returns false for a missing file and leaves invalid JSON untouched', async () => {
    expect(await heal()).toBe(false);
    await seedRaw('{ not json');
    expect(await heal()).toBe(false);
    expect(await readFile(file(), 'utf-8')).toBe('{ not json');
  });
});
