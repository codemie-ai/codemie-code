/**
 * TTY / interactive-context detection.
 *
 * Single canonical predicate: a session is "interactive" when stdin is a real TTY
 * and the caller has not opted out with `CODEMIE_NO_PROMPTS=1`. This matches the
 * pattern already used in `AgentCLI.ts` for suppressing inquirer prompts in
 * scripts and CI, and is reused by the version-warning path to decide whether
 * to print the chalk banner (versus writing to `logger.warn` only).
 */
export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.env.CODEMIE_NO_PROMPTS !== '1';
}
