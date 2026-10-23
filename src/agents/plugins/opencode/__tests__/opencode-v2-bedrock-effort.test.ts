/**
 * Tests for the Bedrock-specific reasoning-effort logic on the OpenCode 2.x
 * config path: per-generation output limits, the manual-budget vs
 * adaptive-effort split, and the Sonnet-4.6 `xhigh` downgrade.
 *
 * Third-audit defects 1 and 3 (Sonnet 4.6 output limit over-declared 2x,
 * Sonnet 4 wrongly excluded from thinking) are fixed and covered here;
 * defect 2 (`xhigh`/`max` sent literally where Bedrock supports them
 * per-model only) is covered for the one case confirmed by AWS's published
 * adaptive-thinking effort table (docs.aws.amazon.com/bedrock/latest/
 * userguide/claude-messages-adaptive-thinking.html): Sonnet 4.6 does not
 * support `xhigh` and downgrades to `high`.
 *
 * `CODEMIE_OPENCODE_CONFIG_VERSION=2` pins the schema so the assertions do
 * not depend on the binary installed on the machine running them. The live
 * catalogue is stubbed; everything else is real.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getHooksPluginFileUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks.ts');
const getHooksV2PluginDirUrl = vi.fn(() => 'file:///tmp/codemie-hooks/shell-hooks-v2');
const cleanupHooksPlugin = vi.fn();
const cleanupHooksV2Plugin = vi.fn();

vi.mock('../../../../cli/commands/hook.js', () => ({ processEvent: vi.fn() }));
vi.mock('../opencode.incremental-sync.js', () => ({
  startOpenCodeIncrementalSync: vi.fn(),
  stopOpenCodeIncrementalSync: vi.fn(),
}));
vi.mock('../opencode.paths.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode.paths.js')>()),
  getOpenCodeDbPath: () => '/data/opencode/opencode.db',
  resolveOpenCodeDbPath: vi.fn(async () => '/data/opencode/opencode.db'),
}));
vi.mock('../../codemie-code-hooks/index.js', () => ({
  getHooksPluginFileUrl,
  cleanupHooksPlugin,
  getHooksV2PluginDirUrl,
  cleanupHooksV2Plugin,
}));
vi.mock('../opencode-dynamic-models.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../opencode-dynamic-models.js')>()),
  fetchDynamicModelConfigs: vi.fn(),
}));

const { fetchDynamicModelConfigs } = await import('../opencode-dynamic-models.js');
const { OpenCodePluginMetadata, resetOpenCodeConfigVersionCache } = await import('../opencode.plugin.js');

const EFFORT_MARKER = 'CODEMIE_OPENCODE_V2_EFFORT_APPLIED';
const ORIGINAL_OVERRIDE = process.env.CODEMIE_OPENCODE_CONFIG_VERSION;

function bedrockEnv(modelId: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    CODEMIE_SESSION_ID: 'codemie-uuid-1',
    CODEMIE_AGENT: 'opencode',
    CODEMIE_PROVIDER: 'bedrock',
    CODEMIE_URL: 'https://sso.example.com',
    CODEMIE_CLI_VERSION: '9.9.9',
    CODEMIE_MODEL: modelId,
    CODEMIE_BASE_URL: 'http://localhost:1234',
    AWS_REGION: 'us-east-1',
    ...extra,
  };
}

/** Run beforeRun and return the emitted v2 document. */
async function emitV2(env: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  await OpenCodePluginMetadata.lifecycle!.beforeRun!(env, {} as never);
  return JSON.parse(env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
}

function bedrockModel(config: Record<string, unknown>): Record<string, unknown> {
  const providers = config.providers as Record<string, Record<string, unknown>>;
  const models = providers['amazon-bedrock'].models as Record<string, Record<string, unknown>>;
  const [modelKey] = Object.keys(models);
  return models[modelKey];
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
let loggerWarnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  vi.clearAllMocks();
  resetOpenCodeConfigVersionCache();
  process.env.CODEMIE_OPENCODE_CONFIG_VERSION = '2';
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { logger } = await import('../../../../utils/logger.js');
  loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as never);
  // CodeMie's catalogue has no Bedrock rows; the dynamic-models stub only
  // needs to resolve the model name requested, mirroring the generic fallback.
  vi.mocked(fetchDynamicModelConfigs).mockResolvedValue({});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  loggerWarnSpy.mockRestore();
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.CODEMIE_OPENCODE_CONFIG_VERSION;
  } else {
    process.env.CODEMIE_OPENCODE_CONFIG_VERSION = ORIGINAL_OVERRIDE;
  }
});

describe('OpenCode v2 Bedrock — per-generation output limits', () => {
  const cases: Array<{ name: string; modelId: string; context: number; output: number }> = [
    { name: 'Sonnet 4 (May 2025) — manual-budget generation', modelId: 'claude-sonnet-4-20250514', context: 200_000, output: 64_000 },
    { name: 'Sonnet 4.5', modelId: 'claude-sonnet-4-5-20250929', context: 200_000, output: 64_000 },
    { name: 'Opus 4.5', modelId: 'claude-opus-4-5-20251101', context: 200_000, output: 64_000 },
    { name: 'Haiku 4.5', modelId: 'claude-haiku-4-5-20251001', context: 200_000, output: 64_000 },
    { name: 'Opus 4.1 — the one 200k-context model capped at 32k', modelId: 'claude-opus-4-1-20250805', context: 200_000, output: 32_000 },
    { name: 'Sonnet 4.6 — the one 1M-context model capped at 64k', modelId: 'claude-sonnet-4-6', context: 1_000_000, output: 64_000 },
    { name: 'Opus 4.6', modelId: 'claude-opus-4-6', context: 1_000_000, output: 128_000 },
    { name: 'Opus 4.7', modelId: 'claude-opus-4-7', context: 1_000_000, output: 128_000 },
    { name: 'Sonnet 5', modelId: 'claude-sonnet-5', context: 1_000_000, output: 128_000 },
    { name: 'Opus 5', modelId: 'claude-opus-5', context: 1_000_000, output: 128_000 },
  ];

  for (const { name, modelId, context, output } of cases) {
    it(`declares { context: ${context}, output: ${output} } for ${name}`, async () => {
      const config = await emitV2(bedrockEnv(modelId));
      const model = bedrockModel(config);

      expect(model.limit).toEqual({ context, output });
    });
  }
});

describe('OpenCode v2 Bedrock — Sonnet 4 is no longer excluded from thinking', () => {
  it('honors a requested effort on Sonnet 4 via the manual-budget overlay', async () => {
    const env = bedrockEnv('claude-sonnet-4-20250514', { CODEMIE_REASONING_EFFORT: 'high' });

    const config = await emitV2(env);
    const model = bedrockModel(config);

    expect(env[EFFORT_MARKER]).toBe('1');
    expect(config.model).toMatch(/#high$/);
    expect(model.variants).toContainEqual({
      id: 'high',
      settings: { thinking: { type: 'enabled', budgetTokens: 16_000 } },
    });
    // Degradation path (modelConfig.reasoning / unsupported generation) must
    // not fire for Sonnet 4 — no "not a Claude generation with extended
    // thinking" warning.
    expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining('not a Claude generation'));
  });
});

describe('OpenCode v2 Bedrock — manual budget vs adaptive effort split', () => {
  it('emits settings.thinking.budgetTokens for a 3.7/4.0-4.5 generation (manual)', async () => {
    const config = await emitV2(bedrockEnv('claude-3-7-sonnet-20250219', { CODEMIE_REASONING_EFFORT: 'medium' }));
    const model = bedrockModel(config);

    expect(model.variants).toContainEqual({
      id: 'medium',
      settings: { thinking: { type: 'enabled', budgetTokens: 8_192 } },
    });
  });

  it('emits output_config.effort + adaptive thinking for a 4.6+ generation', async () => {
    const config = await emitV2(bedrockEnv('claude-opus-4-6', { CODEMIE_REASONING_EFFORT: 'high' }));
    const model = bedrockModel(config);

    expect(model.variants).toContainEqual({
      id: 'high',
      body: {
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        },
      },
    });
  });
});

describe('OpenCode v2 Bedrock — Sonnet 4.6 xhigh downgrade', () => {
  it("downgrades 'xhigh' to 'high' for Sonnet 4.6 and warns", async () => {
    const config = await emitV2(bedrockEnv('claude-sonnet-4-6', { CODEMIE_REASONING_EFFORT: 'xhigh' }));
    const model = bedrockModel(config);

    // The resolved level selects the model-ref suffix; AWS only rejects the
    // literal effort value sent in the request body, so the variant catalog
    // (ids) stays the canonical six levels while the 'xhigh' entry's body
    // carries 'high'.
    const xhighVariant = (model.variants as Array<Record<string, unknown>>).find((v) => v.id === 'xhigh');
    expect(xhighVariant).toEqual({
      id: 'xhigh',
      body: {
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'high' },
        },
      },
    });
    expect(loggerWarnSpy).toHaveBeenCalledWith(expect.stringContaining("does not support effort 'xhigh'"));
  });

  it("does not downgrade 'xhigh' for Opus 4.6", async () => {
    const config = await emitV2(bedrockEnv('claude-opus-4-6', { CODEMIE_REASONING_EFFORT: 'xhigh' }));
    const model = bedrockModel(config);

    const xhighVariant = (model.variants as Array<Record<string, unknown>>).find((v) => v.id === 'xhigh');
    expect(xhighVariant).toEqual({
      id: 'xhigh',
      body: {
        additionalModelRequestFields: {
          thinking: { type: 'adaptive', display: 'summarized' },
          output_config: { effort: 'xhigh' },
        },
      },
    });
    expect(loggerWarnSpy).not.toHaveBeenCalledWith(expect.stringContaining("does not support effort 'xhigh'"));
  });

  it("downgrades the selected level's own suffix when the requested level is 'xhigh' on Sonnet 4.6", async () => {
    // The #<level> suffix on the model reference still uses the canonical
    // level id ('xhigh') so the variant resolves; only the request-body
    // value inside that variant is downgraded.
    const config = await emitV2(bedrockEnv('claude-sonnet-4-6', { CODEMIE_REASONING_EFFORT: 'xhigh' }));

    expect(config.model).toMatch(/#xhigh$/);
  });
});

describe('OpenCode v2 Bedrock — non-Claude models get no effort overlay', () => {
  it('declares no variants for a Nova model even with effort requested', async () => {
    const config = await emitV2(bedrockEnv('amazon.nova-pro-v1:0', { CODEMIE_REASONING_EFFORT: 'high' }));
    const model = bedrockModel(config);

    expect(model.variants).toBeUndefined();
  });
});
