/**
 * Pure classifier for PATH shadowing of a CodeMie-managed agent install.
 * No I/O: callers supply the command matches (in PATH order), the managed
 * directory, the managed shim path (only when found on disk) and a sync comparer.
 */

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
