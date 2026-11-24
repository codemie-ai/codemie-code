import { isScheduledSyncRun } from './scheduled-run.js';
import { isMachineOutputInvocation } from './machine-output.js';

export interface InvocationContext {
  /** A process an agent runs as a hook (`hook` / `sound`): stdout is the agent's protocol channel. */
  hook: boolean;
  /** The unattended OS-scheduler analytics sync run. */
  scheduled: boolean;
  /** Machine-readable output requested (parsed `--json` option or `--json` in argv). */
  json: boolean;
  /** `codemie completion <shell>`: stdout is the script, to be eval'ed or redirected into a file. */
  completion: boolean;
  /** Hook or scheduled run: no notices, hints or prompts. */
  silent: boolean;
}

/** Root options that consume the next word as their value. */
const VALUED_ROOT_OPTIONS = new Set(['--task']);

/** First non-option word, skipping root options (and the value of valued ones) given before the command. */
function firstCommandWord(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('-')) return a;
    if (VALUED_ROOT_OPTIONS.has(a)) i++;
  }
  return undefined;
}

/**
 * Single source of truth for how this process was invoked.
 * Commands pass their parsed `opts.json`; the bin wrapper passes argv only.
 */
export function getInvocationContext(
  options: { argv?: string[]; json?: boolean } = {}
): InvocationContext {
  const argv = options.argv ?? process.argv;
  const hook = argv[2] === 'hook' || argv[2] === 'sound';
  const scheduled = isScheduledSyncRun(argv);
  const json = options.json === true || isMachineOutputInvocation(argv.slice(2));
  const completion = firstCommandWord(argv.slice(2)) === 'completion';
  return { hook, scheduled, json, completion, silent: hook || scheduled };
}
