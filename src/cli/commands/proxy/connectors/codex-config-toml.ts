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

export interface ManagedBlocks {
  /** Body of the header region — bare top-level keys, no sentinels. */
  header: string;
  /** Body of the table region — the `[model_providers.codemie]` table. */
  table: string;
}

/**
 * Remove both managed regions, line by line.
 *
 * Line-based rather than offset-based on purpose: `spliceManagedBlocks` inserts
 * each region as whole lines plus exactly one blank separator line, so removing
 * whole lines plus exactly one separator is its precise inverse. Slicing by
 * character offset cannot express "and the blank line that came with it", which
 * is what makes `strip(splice(x)) === x` hold here.
 */
function cutRegionLines(text: string): string {
  const lines = text.split('\n');
  const keep: string[] = [];
  let i = 0;

  while (i < lines.length) {
    if (lines[i] === HEADER_OPEN) {
      while (i < lines.length && lines[i] !== HEADER_CLOSE) i++;
      i++;
      // The header chunk owns exactly one blank line after it.
      if (i < lines.length && lines[i] === '') i++;
      continue;
    }
    if (lines[i] === TABLE_OPEN) {
      // The table chunk owns exactly one blank line before it.
      if (keep.length > 0 && keep[keep.length - 1] === '') keep.pop();
      while (i < lines.length && lines[i] !== TABLE_CLOSE) i++;
      i++;
      continue;
    }
    keep.push(lines[i]);
    i++;
  }

  return keep.join('\n');
}

/** Normalize to `''` or text terminated by exactly one newline. */
function normalizeBase(text: string): string {
  if (text.trim() === '') return '';
  return text.endsWith('\n') ? text : `${text}\n`;
}

/**
 * Insert both managed regions, replacing any that already exist. The header is
 * prepended (TOML bare keys must precede the first table header) and the table
 * is appended. Every line outside the two regions is preserved verbatim.
 */
export function spliceManagedBlocks(text: string, blocks: ManagedBlocks): string {
  const base = normalizeBase(commentDisplacedKeys(cutRegionLines(text)));

  const header = [HEADER_OPEN, blocks.header, HEADER_CLOSE].join('\n');
  const table = [TABLE_OPEN, blocks.table, TABLE_CLOSE].join('\n');

  if (base === '') return `${header}\n\n${table}\n`;
  return `${header}\n\n${base}\n${table}\n`;
}

/**
 * Remove both managed regions and restore any keys the splice displaced,
 * yielding the text the file held before `spliceManagedBlocks` ran.
 */
export function stripManagedRegions(text: string): string {
  const restored = restoreDisplacedKeys(cutRegionLines(text));
  if (restored.trim() === '') return '';
  return restored.endsWith('\n') ? restored : `${restored}\n`;
}

/** The provider id CodeMie owns in the user's Codex config. */
export const CODEMIE_PROVIDER_ID = 'codemie';

export interface ManagedBlockInput {
  baseUrl: string;
  gatewayKey: string;
  model: string;
}

/** Escape a value for a TOML basic string. */
function toTomlString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Render the two managed region bodies.
 *
 * `wire_api` is always `responses`: Codex removed the `chat` wire API in
 * February 2026, so a custom provider declaring anything else fails at startup.
 * The gateway key travels as a static `http_headers` entry rather than an
 * `env_key`, because a desktop app does not inherit the shell environment — and
 * never via `~/.codex/auth.json`, because writing there flips the app into
 * API-key auth mode and disables its ChatGPT-account features.
 */
export function buildManagedBlocks(input: ManagedBlockInput): ManagedBlocks {
  const header = [
    `model_provider = ${toTomlString(CODEMIE_PROVIDER_ID)}`,
    `model = ${toTomlString(input.model)}`,
  ].join('\n');

  const table = [
    `[model_providers.${CODEMIE_PROVIDER_ID}]`,
    `name = ${toTomlString('CodeMie')}`,
    `base_url = ${toTomlString(input.baseUrl)}`,
    'wire_api = "responses"',
    `[model_providers.${CODEMIE_PROVIDER_ID}.http_headers]`,
    `Authorization = ${toTomlString(`Bearer ${input.gatewayKey}`)}`,
  ].join('\n');

  return { header, table };
}
