/**
 * Access to a settings backup folder on Windows.
 *
 * POSIX modes (0700/0600) do not limit access on Windows: a new folder inherits its parent's access rules. A
 * backup can hold credentials (for example AWS keys), so on Windows the folder's inherited rules are replaced
 * by one rule that gives the current account full control, inherited by every file written into it afterwards.
 * Both tools are called by their System32 path, never through PATH.
 */
import { exec } from '@/utils/exec.js';
import { ConfigurationError } from '@/utils/errors.js';
import { getWindowsSystem32 } from '@/utils/windows-path.js';
import type { CommandRunner } from '@/agents/core/claude-settings.js';

/** Upper bound for one `whoami`/`icacls` run. */
export const BACKUP_ACCESS_TIMEOUT_MS = 5000;

const defaultRunner: CommandRunner = (command, args) => exec(command, args, { timeout: BACKUP_ACCESS_TIMEOUT_MS });

/** The access rules of a backup folder could not be limited to the current account. */
export class BackupAccessError extends ConfigurationError {
  constructor(message: string) {
    super(message);
    this.name = 'BackupAccessError';
  }
}

/** The SID (`S-1-5-21-…`) in `whoami /user /fo csv /nh` output, or undefined. */
export function parseWhoamiSid(stdout: string): string | undefined {
  return /\bS-1-\d+(?:-\d+)+\b/.exec(stdout)?.[0];
}

/**
 * Replaces the folder's inherited access rules with full control for the current account only (by SID, so
 * the account name, its domain and the system language do not matter). Files created in the folder later
 * inherit the rule.
 *
 * @param dir - The new, still empty backup folder
 * @param run - Command runner; production uses the shared exec helper
 * @throws {BackupAccessError} When the account's SID cannot be read or `icacls` fails
 */
export async function restrictToCurrentWindowsUser(dir: string, run: CommandRunner = defaultRunner): Promise<void> {
  const system32 = getWindowsSystem32();
  const who = await run(`${system32}\\whoami.exe`, ['/user', '/fo', 'csv', '/nh']);
  const sid = who.code === 0 ? parseWhoamiSid(who.stdout) : undefined;
  if (!sid) throw new BackupAccessError('the current Windows account could not be determined');
  const result = await run(`${system32}\\icacls.exe`, [dir, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`]);
  if (result.code !== 0) throw new BackupAccessError(`icacls exited with code ${result.code}`);
}
