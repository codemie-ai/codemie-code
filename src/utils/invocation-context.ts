import { isScheduledSyncRun } from './scheduled-run.js';
import { isMachineOutputInvocation } from './machine-output.js';

export interface InvocationContext {
  /** A process an agent runs as a hook (`hook` / `sound`): stdout is the agent's protocol channel. */
  hook: boolean;
  /** The unattended OS-scheduler analytics sync run. */
  scheduled: boolean;
  /** Machine-readable output requested (parsed `--json` option or `--json` in argv). */
  json: boolean;
  /** Hook or scheduled run: no notices, hints or prompts. */
  silent: boolean;
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
  return { hook, scheduled, json, silent: hook || scheduled };
}
