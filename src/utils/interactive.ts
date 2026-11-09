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
 * Whether the launcher may show the one-time project prompt (EPMCDME-15411).
 * Not when a single task runs (`--task`), stdin or stdout is not a terminal, or
 * CODEMIE_NO_PROMPTS=1. Silent mode and the resume check keep their own rules.
 */
export function canPromptForProject(options: { task?: unknown } = {}): boolean {
  if (options.task) return false;
  if (process.env.CODEMIE_NO_PROMPTS === '1') return false;
  return Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY);
}
