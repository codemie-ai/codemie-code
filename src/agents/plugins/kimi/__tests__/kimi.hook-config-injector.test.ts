import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  HookInjectionResult,
  KimiHookConfigInjector,
} from '../kimi.hook-config-injector.js';
import { getKimiConfigPath } from '../kimi.paths.js';

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
    expect(content).toContain('# CodeMie-managed hooks - do not edit manually');
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

    await injector.restore();
    expect(readFileSync(configPath, 'utf-8')).toBe(originalContent);
  });
});
