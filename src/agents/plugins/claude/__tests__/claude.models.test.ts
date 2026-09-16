/**
 * An explicit `--model` value must never be silently swapped for the live
 * catalog's top-ranked model, even when this identity's catalog doesn't
 * include the requested id (e.g. a service account lacking entitlement).
 * AgentCLI.ts marks this by setting `CODEMIE_MODEL_SOURCE=cli` on the env;
 * resolveClaudeModel treats that as an unconditional override for the
 * `model` tier and skips the live-catalog auto-heal entirely.
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

function model(overrides: Partial<LlmModel>): LlmModel {
  return {
    base_name: overrides.base_name ?? overrides.deployment_name ?? overrides.label ?? 'unknown',
    deployment_name: overrides.deployment_name ?? overrides.base_name ?? overrides.label ?? 'unknown',
    label: overrides.label ?? overrides.deployment_name ?? overrides.base_name ?? 'unknown',
    enabled: overrides.enabled ?? true,
    provider: overrides.provider,
    default: overrides.default,
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
  model({ deployment_name: 'claude-opus-5', default: true }),
  model({ deployment_name: 'claude-haiku-4-5' }),
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
    // The override short-circuits before any catalog fetch is needed.
    expect(fetchCodeMieLlmModelsMock).not.toHaveBeenCalled();
  });

  it('preserves an explicit --model "claude-sonnet-5" (no [1m] suffix) the same way — no regression', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).toBeNull();
    expect(env.CODEMIE_MODEL).toBe('claude-sonnet-5');
    expect(fetchCodeMieLlmModelsMock).not.toHaveBeenCalled();
  });

  it('still auto-heals an implicit (non-CLI) stale model when CODEMIE_MODEL_SOURCE is absent', async () => {
    fetchCodeMieLlmModelsMock.mockResolvedValue(catalogWithoutSonnet);
    const { resolveClaudeModel } = await import('../claude.models.js');

    // No CODEMIE_MODEL_SOURCE set — e.g. a stale value sitting in a persisted
    // profile the user did not re-specify on this invocation.
    const env = freshEnv({ CODEMIE_MODEL: 'claude-sonnet-5[1m]' });
    const result = await resolveClaudeModel(env, 'model');

    expect(result).not.toBeNull();
    expect(result?.selectedModel).toBe('claude-opus-5');
    expect(fetchCodeMieLlmModelsMock).toHaveBeenCalled();
  });

  it('does not extend the CLI-override short-circuit to other tiers (haiku/sonnet/opus have no --model flag)', async () => {
    // Includes a different, available sonnet id so a real auto-heal decision is
    // possible — proves the sonnet tier still re-resolves instead of being
    // suppressed by a CODEMIE_MODEL_SOURCE=cli that only ever describes --model.
    fetchCodeMieLlmModelsMock.mockResolvedValue([
      ...catalogWithoutSonnet,
      model({ deployment_name: 'claude-sonnet-5' }),
    ]);
    const { resolveClaudeModel } = await import('../claude.models.js');

    const env = freshEnv({ CODEMIE_SONNET_MODEL: 'claude-sonnet-5[1m]', CODEMIE_MODEL_SOURCE: 'cli' });
    const result = await resolveClaudeModel(env, 'sonnet');

    expect(result).not.toBeNull();
    expect(result?.selectedModel).toBe('claude-sonnet-5');
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
