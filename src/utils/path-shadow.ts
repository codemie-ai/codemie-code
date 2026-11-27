/**
 * Pure classifier for PATH shadowing of a CodeMie-managed agent install.
 * No I/O: callers supply the command matches (in PATH order), the managed
 * directory, the managed shim path (only when found on disk) and a sync comparer.
 */

import { formatPutAheadLine } from './active-cli.js';
import { getPathModule } from './platform.js';

export type ShadowVerdict =
  | { status: 'shadowed'; active: string; managedDir: string }
  | { status: 'missing-on-path'; managedDir: string; shimPath: string }
  | { status: 'missing' }
  | { status: 'clear' }
  | { status: 'unknown' };

export interface ShadowInput {
  /** Command matches in PATH order, or null when the lookup failed. */
  matches: string[] | null;
  managedDir: string | null;
  /** Non-null only when the managed shim exists on disk. */
  managedShimPath: string | null;
  samePath: (a: string, b: string) => boolean;
}

/** Directory part of a file path, accepting both `/` and `\` separators. */
function dirOf(file: string): string {
  const i = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return i <= 0 ? file : file.slice(0, i);
}

export function classifyShadow(input: ShadowInput): ShadowVerdict {
  const { matches, managedDir, managedShimPath, samePath } = input;
  if (matches === null || managedDir === null) return { status: 'unknown' };

  if (matches.length === 0) {
    return managedShimPath !== null
      ? { status: 'missing-on-path', managedDir, shimPath: managedShimPath }
      : { status: 'missing' };
  }

  const inManaged = (m: string): boolean => samePath(dirOf(m), managedDir);
  if (inManaged(matches[0])) return { status: 'clear' };

  if (managedShimPath !== null || matches.slice(1).some(inManaged)) {
    return { status: 'shadowed', active: matches[0], managedDir };
  }
  return { status: 'clear' };
}

type ShadowedVerdict = Extract<ShadowVerdict, { status: 'shadowed' }>;
type MissingOnPathVerdict = Extract<ShadowVerdict, { status: 'missing-on-path' }>;

/** A directory is safe to embed in a single-quoted PowerShell literal and a PATH entry. */
function isSafeForPowerShell(dir: string): boolean {
  // eslint-disable-next-line no-control-regex
  return !/['"‘-‟;%\u0000-\u001f\u007f]/.test(dir);
}

/**
 * Copy-paste PowerShell command that edits the user PATH, or null when `dir` is not safe to quote.
 * Reads and writes the registry value directly: `SetEnvironmentVariable` would expand `%VAR%` entries
 * and store PATH as REG_SZ (the form `clidiag.ps1` reports as a problem).
 */
function userPathCommand(dir: string, position: 'prepend' | 'append'): string | null {
  if (!isSafeForPowerShell(dir)) return null;
  const open = "$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment',$true)";
  const current = "$k.GetValue('Path','','DoNotExpandEnvironmentNames')";
  const value = position === 'prepend' ? `'${dir};'+${current}` : `${current}+';${dir}'`;
  return `${open}; $k.SetValue('Path',${value},'ExpandString')`;
}

/** Warning lines for an agent whose first PATH match is not the CodeMie-managed install. Never runs anything. */
export function formatShadowWarning(
  verdict: ShadowedVerdict,
  platform: NodeJS.Platform = process.platform
): string[] {
  const { active, managedDir } = verdict;
  const activeDir = getPathModule(platform).dirname(active);
  const lines: string[] = [
    '⚠ Another install of this agent shadows the CodeMie-managed one.',
    `  Active:  ${active}`,
    `  Managed: ${managedDir}`,
    '',
    '  To use the managed install:',
    formatPutAheadLine(managedDir, activeDir),
  ];
  const command = userPathCommand(managedDir, 'prepend');
  if (command) {
    lines.push('    In PowerShell:', `    ${command}`);
  }
  lines.push(
    `  - Or remove or rename the stale copy in "${activeDir}"`,
    '  - Or edit the machine-wide PATH as administrator',
    '  Then open a new terminal.'
  );
  return lines;
}

/** Hint lines for a managed shim that exists on disk but whose directory is not on PATH. */
export function formatNotOnPathHint(
  verdict: MissingOnPathVerdict,
  _platform: NodeJS.Platform = process.platform
): string[] {
  const { managedDir, shimPath } = verdict;
  const lines: string[] = [
    '⚠ Agent not found on PATH.',
    `  Managed shim: ${shimPath}`,
    `  - Add "${managedDir}" to your PATH`,
  ];
  const command = userPathCommand(managedDir, 'append');
  if (command) {
    lines.push('    In PowerShell:', `    ${command}`);
  }
  lines.push('  Then open a new terminal.');
  return lines;
}

/** One-line form of {@link formatNotOnPathHint} for list rows. */
export function formatNotOnPathShort(verdict: MissingOnPathVerdict): string {
  return `not found on PATH — shim at ${verdict.managedDir}`;
}
