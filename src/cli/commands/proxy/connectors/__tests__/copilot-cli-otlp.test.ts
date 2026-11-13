// src/cli/commands/proxy/connectors/__tests__/copilot-cli-otlp.test.ts

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { logger } from '@/utils/logger.js';
import { getDirname } from '@/utils/paths.js';
import { canonicalizePath } from '@/agents/core/project-allowlist.js';
import { getCopilotConnectorsConfigPath } from '@/agents/core/copilot-connector-scope.js';
import { CLI_HOOK_EVENT_NAMES } from '@/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.constants.js';

const mocks = vi.hoisted(() => ({ projectRoot: '' }));

vi.mock('@/utils/project-root.js', () => ({
  resolveProjectRoot: () => mocks.projectRoot,
}));

import {
  CLI_HOOK_TIMEOUT_SECONDS,
  buildHookFileContent,
  getCopilotCliHookFilePath,
  removeCopilotCliOtlpConfig,
  writeCopilotCliOtlpConfig,
} from '../copilot-cli-otlp.js';

describe('buildHookFileContent', () => {
  const file = buildHookFileContent() as { version: unknown; hooks: Record<string, unknown[]> };

  it('declares the literal config version Copilot CLI requires', () => {
    expect(file.version).toBe(1);
  });

  it('nests every event under a top-level hooks object', () => {
    expect(Object.keys(file).sort()).toEqual(['hooks', 'version']);
    expect(Object.keys(file.hooks)).toEqual([...CLI_HOOK_EVENT_NAMES]);
  });

  it('wires each event to one exec entry that passes its own --event name', () => {
    for (const eventName of CLI_HOOK_EVENT_NAMES) {
      const entries = file.hooks[eventName] as Array<{ exec: string; args: string[]; timeoutSec: number }>;
      expect(entries).toHaveLength(1);
      expect(entries[0].exec).toBe(process.execPath);
      expect(entries[0].args.slice(1)).toEqual(['hook', '--agent', 'copilot-cli-otlp', '--event', eventName]);
      expect(entries[0].timeoutSec).toBe(CLI_HOOK_TIMEOUT_SECONDS);
    }
  });

  it("runs the CodeMie CLI entrypoint as the hook's own script argument", () => {
    const expectedCliEntry = join(getDirname(import.meta.url), '../../../../../../bin/codemie.js');
    for (const eventName of CLI_HOOK_EVENT_NAMES) {
      const entries = file.hooks[eventName] as Array<{ args: string[] }>;
      expect(entries[0].args[0]).toBe(expectedCliEntry);
    }
  });
});

describe('copilot-cli-otlp connector (temp COPILOT_HOME / CODEMIE_HOME)', () => {
  let testDir: string;
  let originalCodemieHome: string | undefined;
  let originalCopilotHome: string | undefined;
  let projectA: string;
  let projectB: string;

  async function readScopeRecord(): Promise<unknown> {
    const file = JSON.parse(await readFile(getCopilotConnectorsConfigPath(), 'utf-8')) as {
      connectors: Record<string, unknown>;
    };
    return file.connectors['copilot-cli-otlp'];
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'codemie-copilot-cli-'));
    originalCodemieHome = process.env.CODEMIE_HOME;
    originalCopilotHome = process.env.COPILOT_HOME;
    process.env.CODEMIE_HOME = join(testDir, 'codemie-home');
    process.env.COPILOT_HOME = join(testDir, 'copilot-home');
    projectA = join(testDir, 'project-a');
    projectB = join(testDir, 'project-b');
    await mkdir(projectA, { recursive: true });
    await mkdir(projectB, { recursive: true });
    mocks.projectRoot = projectA;
    vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalCodemieHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalCodemieHome;
    if (originalCopilotHome === undefined) delete process.env.COPILOT_HOME;
    else process.env.COPILOT_HOME = originalCopilotHome;
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes the hook file under $COPILOT_HOME/hooks and records a user-scope connector', async () => {
    const result = await writeCopilotCliOtlpConfig({ scope: 'user' });

    expect(result.hookFilePath).toBe(join(testDir, 'copilot-home', 'hooks', 'codemie-copilot-cli-hooks.json'));
    expect(result.hookFilePath).toBe(getCopilotCliHookFilePath());
    expect(result.hookEvents).toBe(CLI_HOOK_EVENT_NAMES.length);
    expect(result.allowlist).toEqual([]);
    expect(JSON.parse(await readFile(result.hookFilePath, 'utf-8'))).toEqual(buildHookFileContent());
    expect(await readScopeRecord()).toEqual({ enabled: true, scope: 'user' });
  });

  it('tracks each connected project root in project scope', async () => {
    const first = await writeCopilotCliOtlpConfig({ scope: 'project' });
    mocks.projectRoot = projectB;
    const second = await writeCopilotCliOtlpConfig({ scope: 'project' });

    expect(first.allowlist).toEqual([await canonicalizePath(projectA)]);
    expect(second.allowlist).toEqual([await canonicalizePath(projectA), await canonicalizePath(projectB)]);
  });

  it('removing one of several projects keeps the hook file', async () => {
    await writeCopilotCliOtlpConfig({ scope: 'project' });
    mocks.projectRoot = projectB;
    const { hookFilePath } = await writeCopilotCliOtlpConfig({ scope: 'project' });

    const result = await removeCopilotCliOtlpConfig({ scope: 'project' });

    expect(result).toMatchObject({ removed: true, mode: 'entry-removed' });
    expect(result.allowlist).toEqual([await canonicalizePath(projectA)]);
    expect(existsSync(hookFilePath)).toBe(true);
  });

  it('removing the last tracked project deletes the hook file and disables the connector', async () => {
    const { hookFilePath } = await writeCopilotCliOtlpConfig({ scope: 'project' });

    const result = await removeCopilotCliOtlpConfig({ scope: 'project' });

    expect(result).toMatchObject({ removed: true, mode: 'full' });
    expect(existsSync(hookFilePath)).toBe(false);
    expect(await readScopeRecord()).toEqual({ enabled: false });
  });

  it('is a no-op when the current project is not tracked', async () => {
    await writeCopilotCliOtlpConfig({ scope: 'project' });
    mocks.projectRoot = projectB;

    const result = await removeCopilotCliOtlpConfig({ scope: 'project' });

    expect(result).toMatchObject({ removed: false, mode: 'noop', reason: 'current project is not tracked' });
  });

  it('full disconnect of a user-scoped connector removes the hook file', async () => {
    const { hookFilePath } = await writeCopilotCliOtlpConfig();

    const result = await removeCopilotCliOtlpConfig();

    expect(result).toMatchObject({ removed: true, mode: 'full' });
    expect(existsSync(hookFilePath)).toBe(false);
    expect(await readScopeRecord()).toEqual({ enabled: false });
  });

  it('disconnect with no hook file is a noop', async () => {
    const result = await removeCopilotCliOtlpConfig();

    expect(result).toMatchObject({ removed: false, mode: 'noop', reason: 'no CodeMie hook file found' });
  });

  it('refuses to connect over a corrupt connector config and does not replace it', async () => {
    await mkdir(join(testDir, 'codemie-home'), { recursive: true });
    await writeFile(getCopilotConnectorsConfigPath(), '{ not json', 'utf-8');

    await expect(writeCopilotCliOtlpConfig()).rejects.toThrow(/corrupt/);

    expect(await readFile(getCopilotConnectorsConfigPath(), 'utf-8')).toBe('{ not json');
  });
});
