import { Command, Option } from 'commander';
import { getInvocationContext } from '../utils/invocation-context.js';

export interface DeprecationEntry {
  kind: 'deprecated' | 'removed';
  old: string;
  replacement: string;
  /** Date (YYYY-MM-DD) the deprecated form is removed. Defaults to DEPRECATION_REMOVE_ON. */
  removeOn?: string;
  /** Date (YYYY-MM-DD) the removed stub is dropped. Defaults to DEPRECATION_REMOVE_ON. */
  dropOn?: string;
}

/** One removal date for every form this release deprecates. */
export const DEPRECATION_REMOVE_ON = '2026-12-31';

const registry: DeprecationEntry[] = [];

function register(entry: DeprecationEntry): void {
  if (!registry.some((e) => e.kind === entry.kind && e.old === entry.old)) {
    registry.push(entry);
  }
}

export function listDeprecations(): readonly DeprecationEntry[] {
  return registry;
}

function dueDate(entry: DeprecationEntry): string {
  return (entry.kind === 'removed' ? entry.dropOn : entry.removeOn) ?? DEPRECATION_REMOVE_ON;
}

/** Entries whose removal/drop date is before `today` yet are still registered. */
export function findPastDue(
  entries: readonly DeprecationEntry[],
  today: Date
): DeprecationEntry[] {
  const todayIso = today.toISOString().slice(0, 10);
  return entries.filter((e) => dueDate(e) < todayIso);
}

/** True on main, tag and release builds, where a past-due form must fail the build. */
export function isReleaseGate(env: Record<string, string | undefined>): boolean {
  return (
    env.GITHUB_REF === 'refs/heads/main' ||
    (env.GITHUB_REF ?? '').startsWith('refs/tags/') ||
    env.GITHUB_EVENT_NAME === 'release'
  );
}

/** One stderr line, also under --json; silent in hooks and the scheduled run. */
export function deprecate(entry: DeprecationEntry, ctx: { json?: boolean } = {}): void {
  if (getInvocationContext({ json: ctx.json }).silent) return;
  process.stderr.write(
    `Deprecated: ${entry.old} — use ${entry.replacement} instead (removal on ${dueDate(entry)})\n`
  );
}

function fail(entry: DeprecationEntry): void {
  process.stderr.write(`Removed: ${entry.old} — use ${entry.replacement} instead\n`);
  process.exitCode = 1;
}

export function deprecatedOption(
  entry: DeprecationEntry,
  flags: string,
  description: string
): Option {
  register(entry);
  return new Option(flags, description).hideHelp();
}

export function deprecatedCommand(entry: DeprecationEntry, name: string): Command {
  register(entry);
  const cmd = new Command(name);
  cmd.hook('preAction', () => deprecate(entry));
  return hide(cmd);
}

function hide(cmd: Command): Command {
  // Commander's public way to hide a command is addCommand(cmd, { hidden: true }),
  // which only applies at registration; set the flag directly so it holds either way.
  (cmd as unknown as { _hidden: boolean })._hidden = true;
  return cmd;
}

export function removedCommand(entry: DeprecationEntry, name: string): Command {
  register(entry);
  const cmd = new Command(name)
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => fail(entry));
  return hide(cmd);
}

export function removedOption(entry: DeprecationEntry, flags: string): Option {
  register(entry);
  const option = new Option(flags).hideHelp();
  option.argParser((value: string) => {
    fail(entry);
    return value;
  });
  return option;
}
