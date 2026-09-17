/**
 * Non-interactive environment detection
 *
 * Single source of truth for "can we prompt the user right now?".
 * Used to guard interactive prompts (e.g. inquirer) that would otherwise
 * hang or crash (ERR_USE_AFTER_CLOSE) when no TTY is attached to stdin
 * (CI, automation, piped input).
 */

/**
 * Returns true when the current process cannot receive interactive input,
 * i.e. process.stdin is not a TTY.
 */
export function isNonInteractiveEnvironment(): boolean {
  return !process.stdin.isTTY;
}

/**
 * Returns true when progress output would not reach a terminal.
 *
 * Separate from isNonInteractiveEnvironment() because input and output redirect
 * independently: `cmd > log 2>&1` still has an interactive stdin.
 */
export function isNonInteractiveOutput(): boolean {
  return !process.stderr.isTTY;
}
