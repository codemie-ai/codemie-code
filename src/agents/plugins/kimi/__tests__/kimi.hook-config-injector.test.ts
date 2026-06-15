import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('fs/promises', async () => ({ ...(await vi.importActual('fs/promises')) }));
const fsp = await import('fs/promises');
import {
  HookInjectionResult,
  KimiHookConfigInjector,
  MANAGED_MARKER,
} from '../kimi.hook-config-injector.js';
import { getKimiConfigPath } from '../kimi.paths.js';
import { ConfigurationError } from '../../../../utils/errors.js';

describe('KimiHookConfigInjector', () => {
  let originalHome: string | undefined;
  let tempDir: string;
  let injector: KimiHookConfigInjector;

  beforeEach(() => {
    originalHome = process.env.KIMI_CODE_HOME;
    tempDir = mkdtempSync(join(tmpdir(), 'kimi-hook-injector-'));
    process.env.KIMI_CODE_HOME = tempDir;
    injector = new KimiHookConfigInjector();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tempDir, { recursive: true, force: true });
    if (originalHome === undefined) {
      delete process.env.KIMI_CODE_HOME;
    } else {
      process.env.KIMI_CODE_HOME = originalHome;
    }
  });

  it('creates config.toml with CodeMie hooks when none exists', async () => {
    const configPath = getKimiConfigPath();

    const result: HookInjectionResult = await injector.inject();

    expect(result.success).toBe(true);
    expect(result.created).toBe(true);
    expect(result.configPath).toBe(configPath);
    expect(existsSync(configPath)).toBe(true);

    const content = readFileSync(configPath, 'utf-8');
    expect(content).toContain(MANAGED_MARKER);
    expect(content).toContain('event = "SessionStart"');
    expect(content).toContain('event = "SessionEnd"');
    expect(content).toContain('event = "UserPromptSubmit"');
    expect(content).toContain('event = "Stop"');
    expect(content).toContain('event = "SubagentStop"');
    expect(content).toContain('event = "PreCompact"');
    expect(content).toContain('command = "codemie hook"');
    expect(content).toContain('timeout = 10');
    expect(content).toContain('timeout = 5');
  });

  it('is idempotent across multiple injections', async () => {
    const configPath = getKimiConfigPath();

    const firstResult = await injector.inject();
    expect(firstResult.created).toBe(true);

    const firstContent = readFileSync(configPath, 'utf-8');
    const firstHookCount = (firstContent.match(/\[\[hooks\]\]/g) || []).length;
    expect(firstHookCount).toBe(6);

    const secondResult = await injector.inject();
    expect(secondResult.success).toBe(true);
    expect(secondResult.created).toBe(false);

    const secondContent = readFileSync(configPath, 'utf-8');
    const secondHookCount = (secondContent.match(/\[\[hooks\]\]/g) || []).length;
    expect(secondHookCount).toBe(6);
    expect(secondContent).toBe(firstContent);
  });

  it('backs up existing config before first modification and preserves original content', async () => {
    const configPath = getKimiConfigPath();
    const backupPath = `${configPath}.codemie-backup`;
    const originalContent = '[existing]\nkey = "value"\n';

    writeFileSync(configPath, originalContent, 'utf-8');

    const result = await injector.inject();

    expect(result.success).toBe(true);
    expect(result.created).toBe(false);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalContent);
    expect(readFileSync(configPath, 'utf-8')).toContain('event = "SessionStart"');
    expect(readFileSync(configPath, 'utf-8')).toContain('key = "value"');

    const restoreResult = await injector.restore();
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.created).toBe(false);
    expect(readFileSync(configPath, 'utf-8')).toBe(originalContent);
  });

  it('does not overwrite an existing backup on subsequent injections', async () => {
    const configPath = getKimiConfigPath();
    const backupPath = `${configPath}.codemie-backup`;
    const originalContent = '[existing]\nkey = "value"\n';

    writeFileSync(configPath, originalContent, 'utf-8');
    const firstResult = await injector.inject();
    expect(firstResult.success).toBe(true);
    expect(firstResult.created).toBe(false);
    expect(readFileSync(backupPath, 'utf-8')).toBe(originalContent);

    // Simulate a later manual edit and re-inject; the original backup must stay intact.
    writeFileSync(configPath, '[existing]\nkey = "updated"\n', 'utf-8');
    const secondResult = await injector.inject();
    expect(secondResult.success).toBe(true);
    expect(secondResult.created).toBe(false);

    expect(readFileSync(backupPath, 'utf-8')).toBe(originalContent);
  });

  it('returns failure when @iarna/toml cannot be loaded', async () => {
    vi.spyOn(
      injector as unknown as { loadTomlModule: () => Promise<typeof import('@iarna/toml')> },
      'loadTomlModule'
    ).mockRejectedValue(new ConfigurationError('Module not found'));

    const result = await injector.inject();

    expect(result.success).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toContain('Module not found');
  });

  it('returns failure when existing config contains invalid TOML', async () => {
    const configPath = getKimiConfigPath();
    writeFileSync(configPath, 'this is not valid toml [[[', 'utf-8');

    const result = await injector.inject();

    expect(result.success).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns failure when config cannot be written', async () => {
    vi.spyOn(fsp, 'writeFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    const result = await injector.inject();

    expect(result.success).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns success from restore when no backup exists', async () => {
    const result = await injector.restore();

    expect(result.success).toBe(true);
    expect(result.created).toBe(false);
    expect(result.configPath).toBe(getKimiConfigPath());
  });

  it('returns failure from restore when backup cannot be copied', async () => {
    const configPath = getKimiConfigPath();
    writeFileSync(configPath, '[existing]\nkey = "value"\n', 'utf-8');
    const injectResult = await injector.inject();
    expect(injectResult.success).toBe(true);

    vi.spyOn(fsp, 'copyFile').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    );

    const result = await injector.restore();

    expect(result.success).toBe(false);
    expect(result.created).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
