/**
 * provider-settings-check: the shared run of `AgentAdapter.checkProviderSettings` for launch, install and connect.
 * @group unit
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSettingsCheckInput, ProviderSettingsCheckOutcome } from '../types.js';
import { ProviderSettingsSwitch, runProviderSettingsCheck } from '../provider-settings-check.js';
import { ConfigurationError } from '@/utils/errors.js';

const INPUT: ProviderSettingsCheckInput = { flow: 'launch', canPrompt: true, profile: { provider: 'ai-run-sso' } };

function adapter(outcome?: ProviderSettingsCheckOutcome) {
  return {
    displayName: 'Claude Code',
    checkProviderSettings: outcome ? vi.fn(async () => outcome) : undefined,
  };
}

function proceed(backupDir: string | null) {
  const apply = vi.fn(async () => ({ backupDir }));
  return { outcome: { kind: 'proceed', apply } as ProviderSettingsCheckOutcome, apply };
}

describe('runProviderSettingsCheck', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives an adapter without a check a switch that applies nothing', async () => {
    const result = await runProviderSettingsCheck(adapter(), INPUT, 'exit');

    expect(await result.apply()).toBeNull();
    expect(result.backupDir).toBeNull();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('passes the input to the adapter unchanged', async () => {
    const { outcome } = proceed(null);
    const a = adapter(outcome);

    await runProviderSettingsCheck(a, INPUT, 'exit');

    expect(a.checkProviderSettings).toHaveBeenCalledWith(INPUT);
  });

  it('prints the guidance on stderr and exits 1 on a stop with onStop "exit"', async () => {
    const a = adapter({ kind: 'stop', guidance: 'Bedrock is enabled by a managed policy.' });

    await expect(runProviderSettingsCheck(a, INPUT, 'exit')).rejects.toThrow('process.exit:1');

    expect(errorSpy).toHaveBeenCalledWith('Bedrock is enabled by a managed policy.');
  });

  it('throws a ConfigurationError carrying the guidance on a stop with onStop "throw", printing nothing', async () => {
    const a = adapter({ kind: 'stop', guidance: 'Cancelled. Nothing was changed.' });

    const run = runProviderSettingsCheck(a, INPUT, 'throw');

    await expect(run).rejects.toBeInstanceOf(ConfigurationError);
    await expect(run).rejects.toThrow('Cancelled. Nothing was changed.');
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('does not apply the switch until asked', async () => {
    const { outcome, apply } = proceed('/backups/one');

    const result = await runProviderSettingsCheck(adapter(outcome), INPUT, 'exit');

    expect(apply).not.toHaveBeenCalled();
    expect(result.backupDir).toBeNull();
  });
});

describe('ProviderSettingsSwitch', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the switch once, however often apply is called, and keeps the backup folder', async () => {
    const apply = vi.fn(async () => ({ backupDir: '/backups/one' }));
    const settingsSwitch = new ProviderSettingsSwitch('Claude Code', apply);

    expect(await settingsSwitch.apply()).toBe('/backups/one');
    expect(await settingsSwitch.apply()).toBe('/backups/one');

    expect(apply).toHaveBeenCalledTimes(1);
    expect(settingsSwitch.backupDir).toBe('/backups/one');
  });

  it('prints the backup folder with the agent name on stderr once the switch made one', async () => {
    const settingsSwitch = new ProviderSettingsSwitch('Claude Code', async () => ({ backupDir: '/backups/one' }));

    settingsSwitch.printBackupNote();
    expect(errorSpy).not.toHaveBeenCalled();

    await settingsSwitch.apply();
    settingsSwitch.printBackupNote();

    expect(errorSpy.mock.calls.flat().join('\n')).toContain('Backup of your Claude Code settings: /backups/one');
  });

  it('prints nothing when the switch had nothing to back up', async () => {
    const settingsSwitch = new ProviderSettingsSwitch('Claude Code', async () => ({ backupDir: null }));

    await settingsSwitch.apply();
    settingsSwitch.printBackupNote();

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('neutralises control characters in the printed folder and agent name', async () => {
    const settingsSwitch = new ProviderSettingsSwitch('Claude\u001b[31m', async () => ({ backupDir: '/backups/\u001b[2Jone' }));

    await settingsSwitch.apply();
    settingsSwitch.printBackupNote();

    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('\u001b[2J');
    expect(errorSpy.mock.calls.flat().join('\n')).not.toContain('Claude\u001b[31m');
  });
});
