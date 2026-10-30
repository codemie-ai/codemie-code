/**
 * Unattended scheduled start detection
 *
 * The analytics sync OS scheduler job (see `src/cli/commands/analytics/sync/`)
 * invokes `<node> <realpath of bin/codemie.js> analytics sync run --scheduled`.
 * `bin/codemie.js` uses this to recognize that invocation and skip interactive
 * startup work (update check, what's-new notice) while still running pending
 * migrations silently. A manual `codemie analytics sync run` (no `--scheduled`)
 * keeps today's normal startup behavior.
 */

const SYNC_RUN_TOKENS = ['analytics', 'sync', 'run'];
const SCHEDULED_FLAG = '--scheduled';

/**
 * True only when `argv` contains the contiguous tokens `analytics`, `sync`,
 * `run` (in that order) and `--scheduled` appears anywhere after the `run`
 * token.
 */
export function isScheduledSyncRun(argv: string[]): boolean {
  const tokenCount = SYNC_RUN_TOKENS.length;
  let runIndex = -1;

  for (let i = 0; i <= argv.length - tokenCount; i++) {
    const isMatch = SYNC_RUN_TOKENS.every((token, offset) => argv[i + offset] === token);
    if (isMatch) {
      runIndex = i + tokenCount - 1;
      break;
    }
  }

  if (runIndex === -1) {
    return false;
  }

  return argv.slice(runIndex + 1).includes(SCHEDULED_FLAG);
}
