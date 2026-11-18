/**
 * The flag rows of a bare-command target list (`proxy connect`, `proxy disconnect`): each flag padded to the longest
 * flag of the list, so every description starts at one column.
 */

/** A flag (or flags, e.g. `--vscode --insiders`) and its one-line description. */
export type FlagRow = readonly [flag: string, description: string];

/** The rows as list lines: two-space indent, the flag padded to the longest flag plus two spaces, the description. */
export function formatFlagRows(rows: readonly FlagRow[]): string[] {
  const width = Math.max(0, ...rows.map(([flag]) => flag.length));
  return rows.map(([flag, description]) => `  ${flag.padEnd(width)}  ${description}`);
}
