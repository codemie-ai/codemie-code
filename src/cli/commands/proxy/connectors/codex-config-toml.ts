/**
 * Pure string surgery for the CodeMie-managed regions of `~/.codex/config.toml`.
 *
 * Nothing here touches the filesystem, the network, or the logger. The Codex
 * config file is user-owned, so the managed content is spliced in as delimited
 * text rather than round-tripped through a TOML serializer: `@iarna/toml`'s
 * `stringify` discards comments and key order, which would silently rewrite the
 * user's file on every connect.
 *
 * TOML permits bare top-level keys only *before* the first table header, so the
 * managed content cannot be one contiguous block. It is two regions: a header
 * region prepended to the file (holding `model_provider` and `model`) and a
 * table region appended to it (holding `[model_providers.codemie]`).
 */

export const HEADER_OPEN = '# >>> codemie proxy connect (codex-desktop) header - managed block, do not edit';
export const HEADER_CLOSE = '# <<< codemie proxy connect (codex-desktop) header';
export const TABLE_OPEN = '# >>> codemie proxy connect (codex-desktop) provider - managed block, do not edit';
export const TABLE_CLOSE = '# <<< codemie proxy connect (codex-desktop) provider';

/** A half-open character range `[start, end)` covering a managed region. */
export interface Region {
  start: number;
  end: number;
}

export interface ManagedRegions {
  header: Region | null;
  table: Region | null;
}

function locate(text: string, open: string, close: string): Region | null {
  const start = text.indexOf(open);
  if (start === -1) return null;
  const closeAt = text.indexOf(close, start + open.length);
  if (closeAt === -1) return null;
  return { start, end: closeAt + close.length };
}

/**
 * Locate both managed regions. A region whose close sentinel is missing is
 * reported as absent rather than guessed at — a truncated block is treated as
 * unmanaged text so the writer never deletes content it cannot delimit.
 */
export function findManagedRegions(text: string): ManagedRegions {
  return {
    header: locate(text, HEADER_OPEN, HEADER_CLOSE),
    table: locate(text, TABLE_OPEN, TABLE_CLOSE),
  };
}
