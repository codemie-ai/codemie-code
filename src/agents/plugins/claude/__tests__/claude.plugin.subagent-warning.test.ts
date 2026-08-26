/**
 * Tests for the Claude plugin's startup log-warning about missing tiers that
 * subagents commonly request (EPMCDME-14355 AC-6).
 *
 * When the sonnet tier is provisioned and haiku is not, subagents that request
 * `model: "haiku"` via the Agent tool fall back to the sonnet default — no
 * dispatch-time hook can intercept per-subagent model resolution inside the
 * upstream binary, so the user learns of the mismatch only when the sub-agent
 * reports the wrong model. This startup log-line surfaces the mismatch at
 * launch instead.
 *
 * @group unit
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AgentConfig } from '../../../core/types.js';

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

vi.mock('../../../../utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    setAgentName: vi.fn(),
    setProfileName: vi.fn(),
    setSessionId: vi.fn(),
  },
}));

vi.mock('../../../../utils/security.js', () => ({
  sanitizeLogArgs: vi.fn((...args: unknown[]) => args),
}));

// resolveClaudeModel is what the beforeRun loop calls per tier to auto-populate
// missing native vars from the live catalog. Returning null means "no change" —
// the input env values pass through unmodified, which lets each test control the
// final tier landscape by seeding ANTHROPIC_DEFAULT_* directly in the env.
vi.mock('../claude.models.js', () => ({
  resolveClaudeModel: vi.fn(async () => null),
}));

type HookEnv = NodeJS.ProcessEnv;
type BeforeRunFn = (env: HookEnv, config: AgentConfig) => Promise<HookEnv>;

describe('Claude Plugin – subagent tier warning (EPMCDME-14355 AC-6)', () => {
  let beforeRun: BeforeRunFn;
  let loggerMod: { logger: Record<string, ReturnType<typeof vi.fn>> };

  const mockConfig: AgentConfig = {};

  beforeEach(async () => {
    vi.resetModules();
    vi.resetAllMocks();

    const mod = await import('../claude.plugin.js');
    beforeRun = mod.ClaudePluginMetadata.lifecycle!.beforeRun!;

    loggerMod = (await import('../../../../utils/logger.js')) as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('logs a subagent-tier warning when sonnet is provisioned but haiku is not', async () => {
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
      // ANTHROPIC_DEFAULT_HAIKU_MODEL intentionally absent
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const haikuWarning = warnCalls.find((msg) => /haiku/i.test(msg) && /subagent/i.test(msg));
    expect(haikuWarning).toBeDefined();
  });

  it('does not warn about haiku when both haiku and sonnet tiers are provisioned', async () => {
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const haikuWarning = warnCalls.find((msg) => /haiku/i.test(msg) && /subagent/i.test(msg));
    expect(haikuWarning).toBeUndefined();
  });

  it('warns about missing haiku on an opus-only tenant, naming opus as the fallback (EPMCDME-14355 AC-6)', async () => {
    // AC-6 says warn whenever haiku is NOT provisioned. On an opus-only tenant a subagent
    // requesting model:"haiku" is redirected to opus, so the warning must still fire and
    // name opus (not sonnet) as the fallback.
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5',
      // no haiku, no sonnet
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const haikuWarning = warnCalls.find((msg) => /haiku/i.test(msg) && /subagent/i.test(msg));
    expect(haikuWarning).toBeDefined();
    expect(haikuWarning).toContain('anthropic/claude-opus-5');
  });

  it('warns about missing opus when only haiku and sonnet are provisioned (EPMCDME-14355 AC-6)', async () => {
    // AC-6 is model-general: any requested-but-unprovisioned tier falls back silently, not
    // just haiku. A subagent dispatched with model:"opus" on a tenant without opus lands on
    // the sonnet default — the same silent-fallback class as the original haiku bug.
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
      // no opus
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const opusWarning = warnCalls.find((msg) => /opus/i.test(msg) && /subagent/i.test(msg));
    expect(opusWarning).toBeDefined();
    expect(opusWarning).toContain('anthropic/claude-sonnet-5');
    // haiku and sonnet are both present, so neither should be warned about
    const haikuWarning = warnCalls.find((msg) => /haiku tier not provisioned/i.test(msg));
    expect(haikuWarning).toBeUndefined();
  });

  it('warns about missing sonnet on a haiku+opus tenant (EPMCDME-14355 AC-6)', async () => {
    // Sonnet is not immune: a subagent dispatched with model:"sonnet" on a tenant that has
    // haiku and opus but no sonnet also falls back silently. Variant-2 coverage warns here too.
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5',
      // no sonnet
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const sonnetWarning = warnCalls.find((msg) => /sonnet tier not provisioned/i.test(msg));
    expect(sonnetWarning).toBeDefined();
  });

  it('does not warn about any tier when all three tiers are provisioned', async () => {
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'anthropic/claude-opus-5',
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const tierWarning = warnCalls.find((msg) => /tier not provisioned/i.test(msg));
    expect(tierWarning).toBeUndefined();
  });

  it('does not warn when no tier at all is provisioned (no fallback to describe)', async () => {
    const env: HookEnv = {
      // no tier vars set on a CodeMie (non-subscription) provider
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const haikuWarning = warnCalls.find((msg) => /haiku/i.test(msg) && /subagent/i.test(msg));
    expect(haikuWarning).toBeUndefined();
  });

  it('does not warn when the provider is anthropic-subscription (no CodeMie catalog applies)', async () => {
    const env: HookEnv = {
      CODEMIE_PROVIDER: 'anthropic-subscription',
      // no tier vars set — upstream binary uses its own defaults
    };

    await beforeRun(env, mockConfig);

    const warnCalls = loggerMod.logger.warn.mock.calls.map((call) => String(call[0]));
    const haikuWarning = warnCalls.find((msg) => /haiku/i.test(msg) && /subagent/i.test(msg));
    expect(haikuWarning).toBeUndefined();
  });

  it('logs a provisioned-tiers summary at info level', async () => {
    const env: HookEnv = {
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'anthropic/claude-haiku-4-5',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'anthropic/claude-sonnet-5',
    };

    await beforeRun(env, mockConfig);

    const infoCalls = loggerMod.logger.info.mock.calls.map((call) => String(call[0]));
    const summary = infoCalls.find((msg) => /provisioned tiers/i.test(msg));
    expect(summary).toBeDefined();
    expect(summary).toContain('haiku');
    expect(summary).toContain('sonnet');
  });
});
