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

/** Marks a user key the connector commented out so it can be restored verbatim. */
export const DISPLACED_PREFIX = '#codemie-displaced# ';

/** Top-level keys the managed header region owns and therefore must displace. */
const DISPLACED_KEYS = ['model', 'model_provider'];

const DISPLACED_KEY_PATTERN = new RegExp(`^\\s*(?:${DISPLACED_KEYS.join('|')})\\s*=`);

/** A line opening a TOML table, after which bare keys belong to that table. */
function isTableHeader(line: string): boolean {
  return /^\s*\[/.test(line);
}

/**
 * Comment out unmanaged root-level `model` / `model_provider` assignments.
 *
 * Only the document root matters: once the scan passes the first table header,
 * any same-named key belongs to that table and is none of our business.
 * Idempotent — a line already carrying `DISPLACED_PREFIX` is left alone.
 */
export function commentDisplacedKeys(text: string): string {
  let inRootScope = true;

  return text
    .split('\n')
    .map((line) => {
      if (isTableHeader(line)) {
        inRootScope = false;
        return line;
      }
      if (!inRootScope) return line;
      if (line.startsWith(DISPLACED_PREFIX)) return line;
      if (!DISPLACED_KEY_PATTERN.test(line)) return line;
      return `${DISPLACED_PREFIX}${line}`;
    })
    .join('\n');
}

/** Exact inverse of `commentDisplacedKeys`. */
export function restoreDisplacedKeys(text: string): string {
  return text
    .split('\n')
    .map((line) => (line.startsWith(DISPLACED_PREFIX) ? line.slice(DISPLACED_PREFIX.length) : line))
    .join('\n');
}
