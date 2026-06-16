/**
 * Regression tests: GPT-5.5 and GPT-5.4 must route to /v1/responses.
 * Tests cover both the dynamic path (convertApiModelToOpenCodeConfig)
 * and the static fallback path (OPENCODE_MODEL_CONFIGS).
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LlmModel } from '../../../providers/plugins/sso/sso.http-client.js';

// ── Module mocks (must be hoisted before any imports of the target modules) ──

vi.mock('../../../utils/logger.js', () => ({
  logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../providers/plugins/sso/sso.http-client.js', () => ({
  fetchCodeMieLlmModels: vi.fn(),
}));

vi.mock('../../../providers/plugins/sso/sso.auth.js', () => ({
  CodeMieSSO: vi.fn().mockImplementation(() => ({
    getStoredCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLlmModel(deploymentName: string): LlmModel {
  return {
    base_name: deploymentName,
    deployment_name: deploymentName,
    label: deploymentName,
    enabled: true,
    features: { tools: true, temperature: false },
    cost: { input: 0.000003, output: 0.000015 },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GPT-5.5 / GPT-5.4 → Responses API routing', () => {
  let convertApiModelToOpenCodeConfig: typeof import('../opencode/opencode-dynamic-models.js').convertApiModelToOpenCodeConfig;
  let OPENCODE_MODEL_CONFIGS: typeof import('../opencode/opencode-model-configs.js').OPENCODE_MODEL_CONFIGS;

  beforeEach(async () => {
    vi.resetModules();
    ({ convertApiModelToOpenCodeConfig } = await import('../opencode/opencode-dynamic-models.js'));
    ({ OPENCODE_MODEL_CONFIGS } = await import('../opencode/opencode-model-configs.js'));
  });

  // ── Dynamic path (live catalogue) ──────────────────────────────────────────

  it('routes gpt-5.5-2026-04-24 to Responses API via dynamic model conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.5-2026-04-24'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes gpt-5-5-2026-04-24 (hyphenated variant) to Responses API via dynamic conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5-5-2026-04-24'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes gpt-5.4-2026-04-24 to Responses API via dynamic model conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.4-2026-04-24'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes gpt-5-4-2026-04-24 (hyphenated variant) to Responses API via dynamic conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5-4-2026-04-24'));
    expect(config.use_responses_api).toBe(true);
  });

  // ── Non-regression: existing Responses API models stay routed correctly ─────

  it('existing gpt-5.3-codex-2026-02-24 still routes to Responses API', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.3-codex-2026-02-24'));
    expect(config.use_responses_api).toBe(true);
  });

  it('existing gpt-5.1-codex still routes to Responses API', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.1-codex'));
    expect(config.use_responses_api).toBe(true);
  });

  it('gpt-4o is NOT routed to Responses API (Chat Completions model)', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-4o'));
    expect(config.use_responses_api).toBeUndefined();
  });

  // ── Static fallback path (OPENCODE_MODEL_CONFIGS) ──────────────────────────

  it('static config has gpt-5.5-2026-04-24 with use_responses_api: true', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.5-2026-04-24']).toBeDefined();
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.5-2026-04-24']!.use_responses_api).toBe(true);
  });

  it('static config gpt-5.5-2026-04-24 supports tool_call', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.5-2026-04-24']!.tool_call).toBe(true);
  });

  // ── Context limits ──────────────────────────────────────────────────────────

  it('dynamic gpt-5.5-2026-04-24 reports context limit of 1050000', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.5-2026-04-24'));
    expect(config.limit.context).toBe(1050000);
  });

  it('dynamic gpt-5-5-2026-04-24 (hyphenated) reports context limit of 1050000', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5-5-2026-04-24'));
    expect(config.limit.context).toBe(1050000);
  });

  it('dynamic gpt-5.2-latest still reports context limit of 400000 (regression)', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.2-latest'));
    expect(config.limit.context).toBe(400000);
  });

  it('static config gpt-5.5-2026-04-24 reports context limit of 1050000', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.5-2026-04-24']!.limit.context).toBe(1050000);
  });
});
