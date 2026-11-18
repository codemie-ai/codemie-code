/**
 * The Claude adapters' `checkProviderSettings`: the agent-agnostic core check is mapped onto the gate's
 * Claude flows, the inherited shell flag is dropped for a launch, and ACP never prompts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsCheckInput } from '@/agents/core/types.js';

const gate = vi.hoisted(() => ({ detectAndAsk: vi.fn(), applyConsented: vi.fn() }));

vi.mock('../gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gate.js')>()),
  detectAndAsk: gate.detectAndAsk,
  applyConsented: gate.applyConsented,
}));

const { checkClaudeProviderSettings } = await import('../adapter-check.js');

const FLAG = 'CLAUDE_CODE_USE_BEDROCK';
const TOKEN = { plan: null, deps: {} };
const SSO = { provider: 'ai-run-sso' };

function input(overrides: Partial<ProviderSettingsCheckInput>): ProviderSettingsCheckInput {
  return { flow: 'launch', canPrompt: true, profile: SSO, ...overrides };
}

describe('checkClaudeProviderSettings', () => {
  beforeEach(() => {
    gate.detectAndAsk.mockReset().mockResolvedValue({ kind: 'proceed', token: TOKEN });
    gate.applyConsented.mockReset().mockResolvedValue({ backupDir: null, files: [], changed: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('maps a launch to the claude-agent flow and drops the inherited shell flag from the given env', async () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: '1', PATH: '/bin' };

    await checkClaudeProviderSettings('claude', input({ flow: 'launch' }), { env });

    expect(FLAG in env).toBe(false);
    expect(env).toEqual({ PATH: '/bin' });
    expect(gate.detectAndAsk).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'claude-agent', canPrompt: true, profile: SSO, env })
    );
  });

  it('keeps the shell flag for a Bedrock profile', async () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: '1' };

    await checkClaudeProviderSettings('claude', input({ profile: { provider: 'bedrock' } }), { env });

    expect(env[FLAG]).toBe('1');
  });

  it('never touches the env outside a launch', async () => {
    const env: NodeJS.ProcessEnv = { [FLAG]: '1' };

    await checkClaudeProviderSettings('claude', input({ flow: 'install' }), { env });

    expect(env[FLAG]).toBe('1');
    expect(gate.detectAndAsk).toHaveBeenCalledWith(expect.objectContaining({ flow: 'install' }));
  });

  it('passes a missing profile on as null, so an install without one is skipped by the gate', async () => {
    await checkClaudeProviderSettings('claude', input({ flow: 'install', profile: undefined }));

    expect(gate.detectAndAsk).toHaveBeenCalledWith(expect.objectContaining({ flow: 'install', profile: null }));
  });

  it('maps a Desktop connect to connect-desktop with its applied and managed files', async () => {
    await checkClaudeProviderSettings(
      'claude',
      input({ flow: 'connect', connect: { desktop: { configFile: '/d/applied.json', managedFile: null } } })
    );

    expect(gate.detectAndAsk).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'connect-desktop', paths: { desktopApplied: '/d/applied.json', desktopManaged: null } })
    );
  });

  it('maps a VS Code connect to connect-vscode with its settings files', async () => {
    await checkClaudeProviderSettings('claude', input({ flow: 'connect', connect: { vscodeSettingsFiles: ['/v/settings.json'] } }));

    expect(gate.detectAndAsk).toHaveBeenCalledWith(
      expect.objectContaining({ flow: 'connect-vscode', paths: { vscodeSettings: ['/v/settings.json'] } })
    );
  });

  it('resolves Desktop and VS Code in one gate run, so the user is asked once', async () => {
    await checkClaudeProviderSettings(
      'claude',
      input({
        flow: 'connect',
        connect: {
          desktop: { configFile: '/d/applied.json', managedFile: '/d/managed.json' },
          vscodeSettingsFiles: ['/v/settings.json'],
          claudeCodeOtlp: true,
        },
      })
    );

    expect(gate.detectAndAsk).toHaveBeenCalledTimes(1);
    expect(gate.detectAndAsk).toHaveBeenCalledWith(
      expect.objectContaining({
        flow: 'connect-desktop',
        paths: { desktopApplied: '/d/applied.json', desktopManaged: '/d/managed.json', vscodeSettings: ['/v/settings.json'] },
      })
    );
  });

  it('maps Claude Code analytics alone to connect-otlp-only with no files', async () => {
    await checkClaudeProviderSettings('claude', input({ flow: 'connect', connect: { claudeCodeOtlp: true } }));

    const call = gate.detectAndAsk.mock.calls[0][0];
    expect(call.flow).toBe('connect-otlp-only');
    expect(call.paths).toBeUndefined();
  });

  it('proceeds without consulting the gate when a connect selects no Claude target', async () => {
    for (const connect of [undefined, {}, { claudeCodeOtlp: false }]) {
      const outcome = await checkClaudeProviderSettings('claude', input({ flow: 'connect', connect }));
      expect(outcome.kind).toBe('proceed');
      if (outcome.kind === 'proceed') expect(await outcome.apply()).toEqual({ backupDir: null });
    }
    expect(gate.detectAndAsk).not.toHaveBeenCalled();
    expect(gate.applyConsented).not.toHaveBeenCalled();
  });

  it('returns the guidance of a stop and nothing to apply', async () => {
    gate.detectAndAsk.mockResolvedValue({ kind: 'stop', reason: 'managed', guidance: 'GUIDANCE' });

    const outcome = await checkClaudeProviderSettings('claude', input({}));

    expect(outcome).toEqual({ kind: 'stop', guidance: 'GUIDANCE' });
    expect(gate.applyConsented).not.toHaveBeenCalled();
  });

  it('applies the consent only when apply is called and returns its backup folder', async () => {
    gate.applyConsented.mockResolvedValue({ backupDir: '/backups/1', files: [], changed: ['a'] });

    const outcome = await checkClaudeProviderSettings('claude', input({}));

    expect(gate.applyConsented).not.toHaveBeenCalled();
    if (outcome.kind !== 'proceed') throw new Error('expected proceed');
    expect(await outcome.apply()).toEqual({ backupDir: '/backups/1' });
    expect(gate.applyConsented).toHaveBeenCalledWith(TOKEN);
  });

  it('says nothing routes to the gateway yet after an install switch, and only then', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    gate.applyConsented.mockResolvedValue({ backupDir: '/backups/1', files: [], changed: ['a'] });

    for (const flow of ['launch', 'install'] as const) {
      const outcome = await checkClaudeProviderSettings('claude', input({ flow }), { env: {} });
      if (outcome.kind === 'proceed') await outcome.apply();
    }

    const lines = log.mock.calls.flat().filter((l) => String(l).includes('until the next codemie-claude run'));
    expect(lines).toHaveLength(1);
  });

  it('prints nothing after an install when nothing was switched', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const outcome = await checkClaudeProviderSettings('claude', input({ flow: 'install' }));
    if (outcome.kind === 'proceed') await outcome.apply();

    expect(log).not.toHaveBeenCalled();
  });
});

describe('Claude adapters', () => {
  beforeEach(() => {
    gate.detectAndAsk.mockReset().mockResolvedValue({ kind: 'proceed', token: TOKEN });
  });

  it('ClaudePlugin passes canPrompt through; ClaudeAcpPlugin never prompts', async () => {
    const saved = process.env[FLAG];
    try {
      const { ClaudePlugin } = await import('../../claude.plugin.js');
      const { ClaudeAcpPlugin } = await import('../../claude-acp.plugin.js');

      await new ClaudePlugin().checkProviderSettings({ flow: 'install', canPrompt: true, profile: SSO });
      expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ flow: 'install', canPrompt: true }));

      await new ClaudeAcpPlugin().checkProviderSettings({ flow: 'install', canPrompt: true, profile: SSO });
      expect(gate.detectAndAsk).toHaveBeenLastCalledWith(expect.objectContaining({ flow: 'install', canPrompt: false }));
    } finally {
      if (saved === undefined) delete process.env[FLAG];
      else process.env[FLAG] = saved;
    }
  });
});
