/**
 * End to end, with real files: a hook records the session directory, the daemon resolves the project-scoped
 * setting from it. No mocks of the settings or the mapping.
 * @group integration
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('@/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

describe('resolveSessionObfuscationMode with the real session mapping and settings', () => {
  let root: string;
  let saved: string | undefined;

  const writeConfig = (dir: string, obfuscation: 'on' | 'off'): void => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'codemie-cli.config.json'), JSON.stringify({ analytics: { obfuscation } }));
  };

  beforeEach(() => {
    saved = process.env['CODEMIE_HOME'];
    root = mkdtempSync(join(tmpdir(), 'session-mode-'));
    process.env['CODEMIE_HOME'] = join(root, 'home');
    mkdirSync(process.env['CODEMIE_HOME'], { recursive: true });
    vi.resetModules();
  });

  afterEach(() => {
    if (saved === undefined) delete process.env['CODEMIE_HOME'];
    else process.env['CODEMIE_HOME'] = saved;
    rmSync(root, { recursive: true, force: true });
  });

  it('a project-only on is honoured from the first record, with no hook event spooled', async () => {
    const project = join(root, 'proj');
    writeConfig(join(project, '.codemie'), 'on');
    const { recordSessionCwd } = await import('@/agents/core/session-cwd-pin.js');
    const { resolveSessionObfuscationMode } = await import('../otlp-json-masking.js');
    await recordSessionCwd('sess-1', project);
    expect(await resolveSessionObfuscationMode('sess-1')).toBe('on');
  });

  it('a mapped project with obfuscation off stays off', async () => {
    const project = join(root, 'proj');
    writeConfig(join(project, '.codemie'), 'off');
    const { recordSessionCwd } = await import('@/agents/core/session-cwd-pin.js');
    const { resolveSessionObfuscationMode } = await import('../otlp-json-masking.js');
    await recordSessionCwd('sess-2', project);
    expect(await resolveSessionObfuscationMode('sess-2')).toBe('off');
  });

  it('no mapping: the global layer decides (on when global is on, off otherwise)', async () => {
    const { resolveSessionObfuscationMode } = await import('../otlp-json-masking.js');
    expect(await resolveSessionObfuscationMode('sess-3')).toBe('off');
    writeConfig(process.env['CODEMIE_HOME'] as string, 'on');
    expect(await resolveSessionObfuscationMode('sess-4')).toBe('on');
  });
});
