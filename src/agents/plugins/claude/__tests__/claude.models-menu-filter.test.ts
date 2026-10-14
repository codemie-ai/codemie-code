/**
 * Tests for intersecting Claude's /model picker options with
 * `CODEMIE_PROFILE_MODELS` (EPMCDME-15639).
 *
 * The picker is built from the live CodeMie catalog (buildModelPickerOptions);
 * when the active profile has 2+ models, CODEMIE_PROFILE_MODELS narrows that
 * list down to the profile's own ids. An empty intersection (stale list, or a
 * live catalog that dropped every one of them) must fall back to the full
 * unfiltered catalog rather than leaving the picker empty (AC22).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';
import type { ModelPickerOption } from '../claude.models.js';

vi.mock('fs/promises');
vi.mock('fs');

vi.mock('../statusline-installer.js', () => ({
  installStatusline: vi.fn(),
}));

vi.mock('../../../../utils/paths.js', () => ({
  resolveHomeDir: vi.fn((dir: string) => `/home/testuser/${dir.replace(/^\./, '')}`),
  getCodemieHome: vi.fn(() => '/home/testuser/.codemie'),
  getCodemiePath: vi.fn((...parts: string[]) => `/home/testuser/.codemie/${parts.join('/')}`),
}));

const loggerMock = {
  debug: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  notice: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
  setAgentName: vi.fn(),
  setProfileName: vi.fn(),
  setSessionId: vi.fn(),
};
vi.mock('../../../../utils/logger.js', () => ({ logger: loggerMock }));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

const buildModelPickerOptionsMock = vi.fn<(env: NodeJS.ProcessEnv) => Promise<ModelPickerOption[]>>();

vi.mock('../claude.models.js', () => ({
  resolveClaudeModel: vi.fn(async () => null),
  listRouterModelIds: vi.fn(async () => []),
  buildModelLabelMap: vi.fn(async () => ({})),
  buildModelPickerOptions: buildModelPickerOptionsMock,
}));

// Capture the settings JSON directly instead of a real temp-file path.
vi.mock('../../../core/temp-config.js', () => ({
  writeConfigToTempFile: vi.fn((configJson: string) => configJson),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;

const FOUR_OPTIONS: ModelPickerOption[] = [
  { model: 'a', label: 'A' },
  { model: 'b', label: 'B' },
  { model: 'c', label: 'C' },
  { model: 'd[1m]', label: 'D (1M)' },
];

describe('Claude /model picker — CODEMIE_PROFILE_MODELS intersection', () => {
  let beforeRun: BeforeRunFn;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    buildModelPickerOptionsMock.mockResolvedValue(FOUR_OPTIONS);

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function writtenOptions(env: HookEnv): ModelPickerOption[] {
    const json = env.CODEMIE_CLAUDE_MODEL_PICKER_SETTINGS!;
    return JSON.parse(json).modelPicker.options;
  }

  it('narrows the written options to CODEMIE_PROFILE_MODELS when set', async () => {
    const env: HookEnv = { CODEMIE_MODEL: 'a', CODEMIE_PROFILE_MODELS: 'a,b' };

    await beforeRun(env, {});

    const options = writtenOptions(env);
    expect(options.map(o => o.model)).toEqual(['a', 'b']);
  });

  it('writes every option unchanged when CODEMIE_PROFILE_MODELS is unset', async () => {
    const env: HookEnv = { CODEMIE_MODEL: 'a' };

    await beforeRun(env, {});

    const options = writtenOptions(env);
    expect(options).toHaveLength(4);
  });

  it('falls back to the full catalog and warns when the intersection is empty', async () => {
    const env: HookEnv = { CODEMIE_MODEL: 'a', CODEMIE_PROFILE_MODELS: 'does-not-exist' };

    await beforeRun(env, {});

    const options = writtenOptions(env);
    expect(options).toHaveLength(4);
    expect(loggerMock.warn).toHaveBeenCalled();
  });
});
