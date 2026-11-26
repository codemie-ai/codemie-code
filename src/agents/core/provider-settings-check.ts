/**
 * Runs an adapter's provider-settings check (`AgentAdapter.checkProviderSettings`) for one command.
 *
 * Every command that launches, installs or connects an agent follows the same steps: run the check, stop the
 * command when it says so, apply the agreed switch once the command is ready, and point at the backup folder
 * if a later step fails. This module holds those steps so each command only says when they happen.
 */
import chalk from 'chalk';
import { ConfigurationError } from '@/utils/errors.js';
import { sanitizeDisplayText } from '@/utils/project-binding.js';
import type { AgentAdapter, ProviderSettingsCheckInput, ProviderSettingsSwitchResult } from './types.js';

/** How the command ends when the check stops it: print the guidance and exit 1, or throw it to the caller. */
export type ProviderSettingsStopAction = 'exit' | 'throw';

/** The part of an adapter the check needs. */
export type ProviderSettingsCheckAdapter = Pick<AgentAdapter, 'displayName' | 'checkProviderSettings'>;

/** The switch a check agreed on, applied at most once, and the backup folder it made. */
export class ProviderSettingsSwitch {
  private pending: (() => Promise<ProviderSettingsSwitchResult>) | null;
  private dir: string | null = null;

  constructor(
    private readonly agentDisplayName: string,
    apply: (() => Promise<ProviderSettingsSwitchResult>) | null
  ) {
    this.pending = apply;
  }

  /** Backup folder of the applied switch, or null when nothing was switched (yet). */
  get backupDir(): string | null {
    return this.dir;
  }

  /**
   * Applies the agreed switch. Later calls do nothing, so a command may call it on every path that needs it.
   *
   * @returns The backup folder, or null when nothing needed switching
   */
  async apply(): Promise<string | null> {
    const run = this.pending;
    if (!run) return this.dir;
    this.pending = null;
    this.dir = (await run()).backupDir;
    return this.dir;
  }

  /** Points at the backup folder on stderr, when the switch made one; for failures after the switch. */
  printBackupNote(): void {
    if (!this.dir) return;
    console.error(
      chalk.yellow(`Backup of your ${sanitizeDisplayText(this.agentDisplayName)} settings: ${sanitizeDisplayText(this.dir)}`)
    );
  }
}

/**
 * Runs the adapter's check. An adapter without one gets a switch that applies nothing.
 *
 * @param adapter - The agent whose settings are checked
 * @param input - The flow, whether a question may be asked, the profile and, for connect, the targets
 * @param onStop - `exit` prints the guidance on stderr and exits 1; `throw` raises it to the caller
 * @returns The agreed switch, to apply once the command is ready
 * @throws {ConfigurationError} When the check stops the command and `onStop` is `throw`
 */
export async function runProviderSettingsCheck(
  adapter: ProviderSettingsCheckAdapter,
  input: ProviderSettingsCheckInput,
  onStop: ProviderSettingsStopAction
): Promise<ProviderSettingsSwitch> {
  if (!adapter.checkProviderSettings) return new ProviderSettingsSwitch(adapter.displayName, null);
  const outcome = await adapter.checkProviderSettings(input);
  if (outcome.kind === 'stop') {
    if (onStop === 'throw') throw new ConfigurationError(outcome.guidance);
    // stderr: stdout must stay clean for wrappers (and ACP editors) that parse it
    console.error(outcome.guidance);
    process.exit(1);
  }
  return new ProviderSettingsSwitch(adapter.displayName, outcome.apply);
}
