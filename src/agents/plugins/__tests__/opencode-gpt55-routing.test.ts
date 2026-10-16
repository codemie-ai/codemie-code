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
  isRouterModel: vi.fn(() => false),
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

describe('GPT-5.6 → Responses API routing', () => {
  let convertApiModelToOpenCodeConfig: typeof import('../opencode/opencode-dynamic-models.js').convertApiModelToOpenCodeConfig;
  let OPENCODE_MODEL_CONFIGS: typeof import('../opencode/opencode-model-configs.js').OPENCODE_MODEL_CONFIGS;

  beforeEach(async () => {
    vi.resetModules();
    ({ convertApiModelToOpenCodeConfig } = await import('../opencode/opencode-dynamic-models.js'));
    ({ OPENCODE_MODEL_CONFIGS } = await import('../opencode/opencode-model-configs.js'));
  });

  // ── Dynamic path (live catalogue) ──────────────────────────────────────────

  it('routes gpt-5.6-sol-2026-07-09 to Responses API via dynamic model conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.6-sol-2026-07-09'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes gpt-5-6-sol-2026-07-09 (hyphenated variant) to Responses API via dynamic conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5-6-sol-2026-07-09'));
    expect(config.use_responses_api).toBe(true);
  });

  it('dynamic gpt-5.6-sol-2026-07-09 reports context limit of 1050000', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-5.6-sol-2026-07-09'));
    expect(config.limit.context).toBe(1050000);
  });

  // ── Static fallback path (OPENCODE_MODEL_CONFIGS) ──────────────────────────

  it('static config has gpt-5.6-sol-2026-07-09 with use_responses_api: true', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.6-sol-2026-07-09']).toBeDefined();
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.6-sol-2026-07-09']!.use_responses_api).toBe(true);
  });

  it('static config gpt-5.6-sol-2026-07-09 supports tool_call', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.6-sol-2026-07-09']!.tool_call).toBe(true);
  });

  it('static config gpt-5.6-sol-2026-07-09 reports context limit of 1050000', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-5.6-sol-2026-07-09']!.limit.context).toBe(1050000);
  });
});

describe('GPT-6 → Responses API routing', () => {
  let convertApiModelToOpenCodeConfig: typeof import('../opencode/opencode-dynamic-models.js').convertApiModelToOpenCodeConfig;
  let OPENCODE_MODEL_CONFIGS: typeof import('../opencode/opencode-model-configs.js').OPENCODE_MODEL_CONFIGS;

  beforeEach(async () => {
    vi.resetModules();
    ({ convertApiModelToOpenCodeConfig } = await import('../opencode/opencode-dynamic-models.js'));
    ({ OPENCODE_MODEL_CONFIGS } = await import('../opencode/opencode-model-configs.js'));
  });

  // ── Dynamic path (live catalogue) ──────────────────────────────────────────

  it('routes gpt-6-luna to Responses API via dynamic model conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-6-luna'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes openai.gpt-6-luna (vendor-prefixed) to Responses API via dynamic conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('openai.gpt-6-luna'));
    expect(config.use_responses_api).toBe(true);
  });

  it('routes gpt-6-sol-2026-09-22 (dated) to Responses API via dynamic conversion', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-6-sol-2026-09-22'));
    expect(config.use_responses_api).toBe(true);
  });

  it('detects the gpt-6 family for vendor-prefixed ids', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('openai.gpt-6-sol'));
    expect(config.family).toBe('gpt-6');
  });

  it('dynamic gpt-6-luna reports context limit of 1050000', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('gpt-6-luna'));
    expect(config.limit.context).toBe(1050000);
    expect(config.limit.output).toBe(128000);
  });

  it('dynamic openai.gpt-6-luna reports context limit of 1050000', () => {
    const config = convertApiModelToOpenCodeConfig(makeLlmModel('openai.gpt-6-luna'));
    expect(config.limit.context).toBe(1050000);
  });

  // ── Static fallback path (OPENCODE_MODEL_CONFIGS) ──────────────────────────

  it('static config has gpt-6-luna with use_responses_api: true', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-6-luna']).toBeDefined();
    expect(OPENCODE_MODEL_CONFIGS['gpt-6-luna']!.use_responses_api).toBe(true);
  });

  it('static config gpt-6-sol supports tool_call', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-6-sol']!.tool_call).toBe(true);
  });

  it('static config gpt-6-luna reports context limit of 1050000', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-6-luna']!.limit.context).toBe(1050000);
  });

  it('static config gpt-6-sol reports context limit of 1050000', () => {
    expect(OPENCODE_MODEL_CONFIGS['gpt-6-sol']!.limit.context).toBe(1050000);
  });
});

// ── Unknown future majors ────────────────────────────────────────────────────
//
// The name patterns enumerate the families the proxy currently serves. A
// Responses-only major deployed before the list is updated used to be routed to
// chat-completions and fail at request time with no warning at config-generation
// time, so any single-digit GPT major at or beyond 6 is treated as Responses-only.

describe('Unknown future GPT majors → Responses API routing', () => {
  let convertApiModelToOpenCodeConfig: typeof import('../opencode/opencode-dynamic-models.js').convertApiModelToOpenCodeConfig;

  beforeEach(async () => {
    vi.resetModules();
    ({ convertApiModelToOpenCodeConfig } = await import('../opencode/opencode-dynamic-models.js'));
  });

  it('routes an unlisted gpt-7 id to Responses API', () => {
    expect(convertApiModelToOpenCodeConfig(makeLlmModel('gpt-7-preview')).use_responses_api).toBe(true);
  });

  it('routes an unlisted vendor-prefixed gpt-8 id to Responses API', () => {
    expect(convertApiModelToOpenCodeConfig(makeLlmModel('openai.gpt-8-codex')).use_responses_api).toBe(true);
  });

  it('routes an unlisted gpt-6 variant to Responses API', () => {
    expect(convertApiModelToOpenCodeConfig(makeLlmModel('gpt-6.9-unknown-luna')).use_responses_api).toBe(true);
  });

  it('leaves two-digit majors out so an explicit pattern must claim them', () => {
    // Same reason the (?!\d) guards exclude gpt-60: a new major of that shape is
    // claimed deliberately, never by accident.
    expect(convertApiModelToOpenCodeConfig(makeLlmModel('gpt-60')).use_responses_api).toBeUndefined();
  });

  it('still routes older and non-GPT families to chat completions', () => {
    for (const id of ['gpt-4o-mini', 'gpt-5', 'claude-4-5-sonnet', 'gemini-2.5-pro', 'o3-mini', 'qwen3-coder']) {
      expect(convertApiModelToOpenCodeConfig(makeLlmModel(id)).use_responses_api).toBeUndefined();
    }
  });
});
