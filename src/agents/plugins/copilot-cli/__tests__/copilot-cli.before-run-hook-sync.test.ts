import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CopilotCliPluginMetadata } from '../copilot-cli.plugin.js';
import { buildHookFileContent } from '@/cli/commands/proxy/connectors/copilot-cli-otlp.js';
import type { AgentConfig } from '@/agents/core/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), success: vi.fn() },
}));

const HOOK = join('hooks', 'codemie-copilot-cli-hooks.json');
const saved = { home: process.env.HOME, profile: process.env.USERPROFILE };

let home: string;
let defaultHome: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cop-before-run-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  defaultHome = join(home, '.copilot');
  mkdirSync(join(defaultHome, 'hooks'), { recursive: true });
  writeFileSync(join(defaultHome, HOOK), '{}');
});

afterEach(() => {
  if (saved.home === undefined) delete process.env.HOME; else process.env.HOME = saved.home;
  if (saved.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = saved.profile;
  rmSync(home, { recursive: true, force: true });
});

// beforeRun only uses these two adapter helpers from `this`.
const adapter = {
  ensureDirectory: async (dir: string): Promise<void> => {
    mkdirSync(dir, { recursive: true });
  },
  resolveDataPath: (): string => defaultHome,
};

async function beforeRun(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
  const config = { provider: 'ai-run-sso' } as AgentConfig;
  const launchEnv = { CODEMIE_BASE_URL: 'https://codemie.example/api', CODEMIE_MODEL: 'gpt-5.4', ...env };
  return CopilotCliPluginMetadata.lifecycle!.beforeRun!.call(adapter, launchEnv, config) as Promise<NodeJS.ProcessEnv>;
}

describe('copilot-cli beforeRun hook-file sync', () => {
  it('writes the CodeMie hook file into an explicit COPILOT_HOME resolved by the launch', async () => {
    const override = join(home, 'custom-copilot');
    const env = await beforeRun({ COPILOT_HOME: override });

    expect(env.COPILOT_HOME).toBe(override);
    expect(readFileSync(join(override, HOOK), 'utf-8')).toBe(`${JSON.stringify(buildHookFileContent(), null, 2)}\n`);
  });

  it('writes nothing when COPILOT_HOME is unset and the default home is used', async () => {
    const env = await beforeRun({});

    expect(env.COPILOT_HOME).toBe(defaultHome);
    expect(readFileSync(join(defaultHome, HOOK), 'utf-8')).toBe('{}');
    expect(existsSync(join(home, 'custom-copilot'))).toBe(false);
  });
});
