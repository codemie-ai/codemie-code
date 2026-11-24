/**
 * Start-up output (migration progress, update prompts, what's-new notices) must stay off
 * stdout when the caller asked for machine-readable output: a script that parses the
 * `--json` answer fails on any extra byte. The wrapper runs before commander parses the
 * command line, so argv is the only signal available.
 *
 * `--json <path>` (SDK commands take a file as input) is matched too: telling it apart
 * from the output switch needs the parsed command, and silent start-up only moves the
 * details to the log file.
 *
 * @param argv CLI arguments after the script name (`process.argv.slice(2)`)
 */
export function isMachineOutputInvocation(argv: readonly string[]): boolean {
  for (const arg of argv) {
    // Everything after `--` belongs to a spawned agent, not to this CLI.
    if (arg === '--') {
      return false;
    }
    if (arg === '--json' || arg.startsWith('--json=')) {
      return true;
    }
  }
  return false;
}
