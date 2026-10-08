/**
 * An explicit `--model` value must never be silently swapped for the live
 * catalog's top-ranked model, even when this identity's catalog doesn't
 * include the requested id (e.g. a service account lacking entitlement).
 * AgentCLI.ts marks this by setting `CODEMIE_MODEL_SOURCE=cli` on the env;
 * resolveClaudeModel treats that as an unconditional override for the
 * `model` tier and skips the live-catalog auto-heal entirely.
 *
 * Every model that stays is still sized to its catalog context window: `[1m]` is
 * added when `max_input_tokens` reaches 1M and dropped when it is smaller.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmModel } from '../../../../providers/plugins/sso/sso.http-client.js';

const fetchCodeMieLlmModelsMock = vi.fn<() => Promise<LlmModel[]>>();

vi.mock('../../../../providers/plugins/sso/sso.http-client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../providers/plugins/sso/sso.http-client.js')>();
  return {
    ...actual,
    fetchCodeMieLlmModels: fetchCodeMieLlmModelsMock,
  };
});

const ONE_MILLION = 1_000_000;
const TWO_HUNDRED_K = 200_000;

function model(overrides: Partial<LlmModel>): LlmModel {
  return {
    base_name: overrides.base_name ?? overrides.deployment_name ?? overrides.label ?? 'unknown',
    deployment_name: overrides.deployment_name ?? overrides.base_name ?? overrides.label ?? 'unknown',
    label: overrides.label ?? overrides.deployment_name ?? overrides.base_name ?? 'unknown',
    enabled: overrides.enabled ?? true,
    provider: overrides.provider,
    default: overrides.default,
    max_input_tokens: overrides.max_input_tokens,
    features: {
      tools: true,
      streaming: true,
      ...overrides.features,
    },
  };
}

// A catalog that does NOT include "claude-sonnet-5[1m]" nor plain "claude-sonnet-5" —
// simulates a tenant/service-account not entitled to the requested variant, the
// exact scenario that used to trigger the silent opus substitution.
const catalogWithoutSonnet = [
  model({ deployment_name: 'claude-opus-5', default: true, max_input_tokens: ONE_MILLION }),
  model({ deployment_name: 'claude-haiku-4-5', max_input_tokens: TWO_HUNDRED_K }),
];

// Each test uses a distinct CODEMIE_BASE_URL so the module-level catalog TTL
// cache (keyed on base URL) never leaks a previous test's mocked response.
let baseUrlCounter = 0;
function freshEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  baseUrlCounter += 1;
  return {
    CODEMIE_JWT_TOKEN: 'jwt-token',
    CODEMIE_BASE_URL: `https://api.codemie.example/${baseUrlCounter}`,
    ...overrides,
  };
}

describe('resolveClaudeModel — explicit --model override', () => {
  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves an explicit --model "claude-sonnet-5[1m]" even when absent from the live catalog', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5[1m]', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('claude-sonnet-5[1m]');
  });

  it('preserves an explicit --model "claude-sonnet-5" (no [1m] suffix) the same way — no regression', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('claude-sonnet-5');
  });

  it('keeps an explicit --model but sizes its window: a live 1M model gains "[1m]"', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-5', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-opus-5[1m]');
    expect(result?.reason).toBe('one-million-enabled');
  });

  it('keeps the explicit model when the catalog fetch fails', async () => {
    fetchCodeMieLlmModelsMock.mockRejectedValue(new Error('network down'));
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-5', CODEMIE_MODEL_SOURCE: 'cli' });

    expect(await resolveClaudeModel(env, 'model')).toBeNull();
  });

  it('still auto-heals an implicit (non-CLI) stale model when CODEMIE_MODEL_SOURCE is absent', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    // No CODEMIE_MODEL_SOURCE set — e.g. a stale value sitting in a persisted
    // profile the user did not re-specify on this invocation.
    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).not.toBeNull();
    expect(result?.selectedModel).toBe('claude-opus-5[1m]');
    expect(result?.reason).toBe('unavailable');
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalled();
  });

  it('does not extend the CLI-override short-circuit to other tiers (haiku/sonnet/opus have no --model flag)', async () => {
    // Includes a different, available sonnet id so a real auto-heal decision is
    // possible — proves the sonnet tier still re-resolves instead of being
    // suppressed by a CODEMIE_MODEL_SOURCE=cli that only ever describes --model.
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      ...catalogWithoutSonnet,
      model({ deployment_name: 'claude-sonnet-5', max_input_tokens: ONE_MILLION }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_SONNET_MODEL: 'claude-sonnet-4-5[1m]', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'sonnet');

    expect(result).not.toBeNull();
    expect(result?.selectedModel).toBe('claude-sonnet-5[1m]');
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalled();
  });

  it('leaves a model untouched when it IS present in the live catalog, override or not', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      ...catalogWithoutSonnet,
      model({ deployment_name: 'claude-sonnet-5[1m]' }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('claude-sonnet-5[1m]');
  });
});

describe('resolveClaudeModel — catalog context window', () => {
  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds "[1m]" to a bare configured id when the catalog reports a 1M window', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', max_input_tokens: ONE_MILLION }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-4-6' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-sonnet-4-6[1m]');
    expect(result?.reason).toBe('one-million-enabled');
  });

  it('keeps a configured "[1m]" model whose live entry reports a 1M window', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', max_input_tokens: ONE_MILLION }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-4-6[1m]' });

    expect(await resolveClaudeModel(env, 'model')).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('claude-sonnet-4-6[1m]');
  });

  it('drops "[1m]" but keeps the same model when the live entry reports a smaller window', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-opus-4-5', max_input_tokens: TWO_HUNDRED_K }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-4-5[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-opus-4-5');
    expect(result?.reason).toBe('one-million-unsupported');
  });

  it('leaves a bare id bare when the live entry reports a smaller window', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-haiku-4-5', max_input_tokens: TWO_HUNDRED_K }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-haiku-4-5' });

    expect(await resolveClaudeModel(env, 'model')).toBeNull();
  });

  it.each(['claude-sonnet-4-6', 'claude-sonnet-4-6[1m]'])(
    'decides nothing when the entry reports no window — "%s" is left exactly as configured',
    async (configured) => {
      fetchCodeMieLlmModelsMock.mockResolvedValue([model({ deployment_name: 'claude-sonnet-4-6' })]);
      const { resolveClaudeModel } = await import('../claude.models.js');

      const env = freshEnv({ CODEMIE_MODEL: configured });

      expect(await resolveClaudeModel(env, 'model')).toBeNull();
      expect(env.CODEMIE_MODEL).toBe(configured);
    }
  );

  it('treats exactly 1_000_000 as a 1M window and adds "[1m]" to a bare id', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', max_input_tokens: 1_000_000 }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const result = await resolveClaudeModel(freshEnv({ CODEMIE_MODEL: 'claude-sonnet-4-6' }), 'model');

    expect(result?.selectedModel).toBe('claude-sonnet-4-6[1m]');
    expect(result?.reason).toBe('one-million-enabled');
  });

  it('treats 999_999 as below 1M: strips "[1m]" from a suffixed id and leaves a bare id bare', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', max_input_tokens: 999_999 }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const stripped = await resolveClaudeModel(freshEnv({ CODEMIE_MODEL: 'claude-sonnet-4-6[1m]' }), 'model');
    const bare = await resolveClaudeModel(freshEnv({ CODEMIE_MODEL: 'claude-sonnet-4-6' }), 'model');

    expect(stripped?.selectedModel).toBe('claude-sonnet-4-6');
    expect(stripped?.reason).toBe('one-million-unsupported');
    expect(bare).toBeNull();
  });

  it.each([
    ['a numeric string', '1000000'],
    ['null', null],
  ])('treats %s as an absent window and leaves the id untouched', async (_label, value) => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', max_input_tokens: value as unknown as number }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    for (const configured of ['claude-sonnet-4-6', 'claude-sonnet-4-6[1m]']) {
      const env = freshEnv({ CODEMIE_MODEL: configured });

      expect(await resolveClaudeModel(env, 'model')).toBeNull();
      expect(env.CODEMIE_MODEL).toBe(configured);
    }
  });

  it('never touches "[1m]" on a router, which carries no window', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      { ...model({ deployment_name: 'sy-signal-claude-sonnet-haiku' }), is_router: true },
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'sy-signal-claude-sonnet-haiku[1m]' });

    expect(await resolveClaudeModel(env, 'model')).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('sy-signal-claude-sonnet-haiku[1m]');
  });

  it.each([
    ['sonnet', 'CODEMIE_SONNET_MODEL', 'claude-sonnet-4-6', ONE_MILLION, 'claude-sonnet-4-6[1m]'],
    ['opus', 'CODEMIE_OPUS_MODEL', 'claude-opus-5', ONE_MILLION, 'claude-opus-5[1m]'],
    ['haiku', 'CODEMIE_HAIKU_MODEL', 'claude-haiku-4-5', TWO_HUNDRED_K, null],
  ] as const)(
    'sizes the %s tier var from the catalog regardless of CODEMIE_MODEL_SOURCE',
    async (tier, envVar, bareId, window, expectedSelected) => {
      fetchCodeMieLlmModelsMock.mockResolvedValue([model({ deployment_name: bareId, max_input_tokens: window })]);
      const { resolveClaudeModel } = await import('../claude.models.js');

      const env = freshEnv({ [envVar]: bareId, CODEMIE_MODEL_SOURCE: 'cli' });
      const result = await resolveClaudeModel(env, tier);

      expect(result?.selectedModel ?? null).toBe(expectedSelected);
    }
  );

  it('gives the replacement of a retired model its own window, not the retired model\'s', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-haiku-4-5', max_input_tokens: TWO_HUNDRED_K }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-4-1[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-haiku-4-5');
    expect(result?.reason).toBe('unavailable');
  });

  it('gives a 1M replacement "[1m]" even when the retired model never asked for it', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-opus-5', max_input_tokens: ONE_MILLION }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-4-1' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-opus-5[1m]');
    expect(result?.reason).toBe('unavailable');
  });

  it('never double-suffixes a replacement whose catalog id already carries "[1m]"', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-opus-5[1m]', max_input_tokens: ONE_MILLION }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-opus-4-1[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result?.selectedModel).toBe('claude-opus-5[1m]');
  });
});

describe('buildModelPickerOptions', () => {
  beforeEach(() => {
    fetchCodeMieLlmModelsMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists each model once, at its max window: "[1m]" id for 1M models, bare id otherwise', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-4-6', label: 'Sonnet 4.6', max_input_tokens: ONE_MILLION }),
      model({ deployment_name: 'claude-haiku-4-5', label: 'Haiku 4.5', max_input_tokens: TWO_HUNDRED_K }),
      { ...model({ deployment_name: 'claude-router-premium', label: 'Premium Router' }), is_router: true },
    ]);
    const { buildModelPickerOptions } = await import('../claude.models.js');

    const options = await buildModelPickerOptions(freshEnv());

    expect(options).toHaveLength(3);
    expect(options.find((o) => o.label === 'Sonnet 4.6')?.model).toBe('claude-sonnet-4-6[1m]');
    expect(options.find((o) => o.label === 'Haiku 4.5')?.model).toBe('claude-haiku-4-5');
    expect(options.find((o) => o.label === 'Premium Router')?.model).toBe('claude-router-premium');
  });

  it('never adds a second "(1M context)" row for a 1M model', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-5', label: 'Sonnet 5', max_input_tokens: ONE_MILLION }),
    ]);
    const { buildModelPickerOptions } = await import('../claude.models.js');

    const options = await buildModelPickerOptions(freshEnv());

    expect(options.map((o) => o.model)).toEqual(['claude-sonnet-5[1m]']);
    expect(options.some((o) => o.label.includes('1M context'))).toBe(false);
  });

  it('leaves a model with no reported window as its bare id', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([model({ deployment_name: 'claude-sonnet-5', label: 'Sonnet 5' })]);
    const { buildModelPickerOptions } = await import('../claude.models.js');

    const options = await buildModelPickerOptions(freshEnv());

    expect(options.map((o) => o.model)).toEqual(['claude-sonnet-5']);
  });

  it('picks the "[1m]" id at exactly 1_000_000 and the bare id at 999_999', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-5', label: 'Sonnet 5', max_input_tokens: 1_000_000 }),
      model({ deployment_name: 'claude-haiku-5', label: 'Haiku 5', max_input_tokens: 999_999 }),
    ]);
    const { buildModelPickerOptions } = await import('../claude.models.js');

    const options = await buildModelPickerOptions(freshEnv());

    expect(options.find((o) => o.label === 'Sonnet 5')?.model).toBe('claude-sonnet-5[1m]');
    expect(options.find((o) => o.label === 'Haiku 5')?.model).toBe('claude-haiku-5');
  });

  it('never double-suffixes a catalog id that already ends in [1m]', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      model({ deployment_name: 'claude-sonnet-5[1m]', label: 'Sonnet 5 1M', max_input_tokens: ONE_MILLION }),
    ]);
    const { buildModelPickerOptions } = await import('../claude.models.js');

    const options = await buildModelPickerOptions(freshEnv());

    expect(options.map((o) => o.model)).toEqual(['claude-sonnet-5[1m]']);
  });
});
