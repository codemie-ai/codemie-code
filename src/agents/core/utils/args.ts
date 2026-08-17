/**
 * Shared CLI argument utilities for agent plugins.
 */

/**
 * Returns the value of the first -m / --model / --model=<val> argument found,
 * or undefined if none is present.
 */
export function getExplicitModelArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-m' || arg === '--model') {
      return args[i + 1];
    }
    if (arg.startsWith('--model=')) {
      return arg.slice('--model='.length);
    }
  }
  return undefined;
}
