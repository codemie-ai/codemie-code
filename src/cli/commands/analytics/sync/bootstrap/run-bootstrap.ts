/**
 * Runner for `codemie analytics sync bootstrap` and its `--webhook` non-interactive mode.
 *
 * `runBootstrap` is a thin dispatcher (spec.md "Non-interactive mode" / "Start logic"):
 * `--webhook` always wins and runs the validate-then-test-send path below, with no prompts,
 * no TTY requirement, and no read or write of the lead's saved wizard state
 * (`bootstrap/state-store.ts`) — a headless run must never change a lead's saved answers.
 * Without `--webhook`, a TTY hands off to the guided wizard (`./guided.ts`, Task 7); no TTY
 * and no `--webhook` fails at once, naming both ways forward.
 *
 * `runBootstrap` never throws and never calls `process.exit`; every failure path prints via
 * `deps.err` and returns a non-zero exit code. Every side effect is injected via
 * {@link BootstrapDeps} so tests run without touching the real filesystem, network or a
 * terminal; `createRealBootstrapDeps()` wires the real ones.
 *
 * Output split (spec.md "Install command", "Constraints and left to the builder"): only the
 * install command goes to `deps.out`/stdout; everything else — including `--webhook` mode's
 * check and cleanup lines and {@link UPDATE_HINT} — goes to `deps.err`/stderr. No display
 * anywhere here names the webhook's `sig` value.
 */

import type { PromptModule } from 'inquirer';

import { SyncConfigError } from '@/utils/errors.js';

import { validateIncludeExternal, validateLookbackDays } from '../config-store.js';
import { buildInstallCommand } from '../install-command.js';
import { errorMessage } from '../redact.js';
import { validateTriggerUrl } from '../trigger-url.js';
import type { SyncReport } from '../types.js';
import { decodeWebhook } from '../webhook-encoding.js';
import { runGuided } from './guided.js';
import { sendFailure4xxHint, setupCheckReport, UPDATE_HINT } from './setup-check.js';
import { getBootstrapStatePath } from './state-store.js';
import type { BootstrapDeps, BootstrapOptions, BootstrapPrompter } from './types.js';

// Re-exported so callers can keep importing the runner's own interface, per the plan's
// controller ruling, without reaching into `./types.js` directly.
export type { BootstrapDeps, BootstrapOptions, BootstrapPrompter };

// Re-exported (plan task 8) so existing imports/tests of this module keep working unchanged
// now that both live in `./setup-check.js`, which the guided wizard's step 5 also imports.
export { setupCheckReport, UPDATE_HINT };

/** Printed to `deps.err` after a successful `--webhook` test send, naming where the test file
 * should show up — never the webhook URL itself. */
function checkLine(report: SyncReport): string {
  return (
    `Sent ${report.fileName}. Within a minute it should appear in the SharePoint folder, with ` +
    "a reply on this month's card in the Teams channel."
  );
}

/** Printed to `deps.err` right after {@link checkLine}. */
const CLEANUP_LINE = 'Delete the test file once you have confirmed delivery.';

/** Printed when there is no TTY and no `--webhook` was given — the only way forward in either
 * case, so both remedies are named. */
const NO_TTY_MESSAGE =
  'No terminal is attached, and no --webhook was given.\n' +
  'Pass --webhook <url> to run `codemie analytics sync bootstrap` non-interactively, or run it ' +
  'again in a terminal for the guided wizard.';

/** Same shape as `install.ts`'s `printGitFailure`: the redacted message, plus {@link
 * sendFailure4xxHint} when the failure was a 4xx. */
function printSendFailure(deps: BootstrapDeps, err: unknown): void {
  deps.err(`Test send failed: ${errorMessage(err)}`);
  const hint = sendFailure4xxHint(err);
  if (hint !== undefined) {
    deps.err(hint);
  }
}

/** The raw trigger URL from `--webhook` or the decoded `--webhook-b64`, same rule as
 * `install`: giving both throws. Only called once at least one of them is set. */
function resolveWebhookOption(opts: BootstrapOptions): string {
  if (opts.webhookB64 === undefined) {
    return opts.webhook ?? '';
  }
  if (opts.webhook !== undefined) {
    throw new SyncConfigError('Pass either --webhook or --webhook-b64, not both.');
  }
  return decodeWebhook(opts.webhookB64);
}

/**
 * `--webhook` non-interactive mode (spec.md "Non-interactive mode"). Validates every option
 * first — webhook, then lookback, then policy — with no network call before all three pass;
 * each failure names its own flag. Test-sends {@link setupCheckReport} through `deps.send`; on
 * a 2xx it prints the check and cleanup lines to `deps.err`, then the install command to
 * `deps.out`, then {@link UPDATE_HINT} to `deps.err` (spec.md "after the command"), and
 * returns 0. On any failure it prints no command and
 * returns a non-zero exit code. Never reads or writes `deps.statePath`.
 */
async function runWebhookMode(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number> {
  let webhookUrl: string;
  let lookbackDays: number | undefined;
  let includeExternal: ReturnType<typeof validateIncludeExternal>;
  try {
    webhookUrl = validateTriggerUrl(resolveWebhookOption(opts), 'option');
    lookbackDays = validateLookbackDays(opts.lookbackDays);
    includeExternal = validateIncludeExternal(opts.includeExternal);
  } catch (err) {
    deps.err(errorMessage(err));
    return 1;
  }

  const report = setupCheckReport(deps.now());
  try {
    await deps.send(webhookUrl, report);
  } catch (err) {
    printSendFailure(deps, err);
    return 1;
  }

  deps.err(checkLine(report));
  deps.err(CLEANUP_LINE);

  deps.out(
    buildInstallCommand({
      webhook: webhookUrl,
      includeExternal,
      ...(lookbackDays !== undefined && { lookbackDays })
    })
  );
  deps.err(UPDATE_HINT);
  return 0;
}

/** Runs the guided wizard, turning anything it throws (a failed zip or state write, a closed
 * prompt) into a message on `deps.err` and exit code 1, so `runBootstrap` never throws. */
async function runGuidedSafely(deps: BootstrapDeps): Promise<number> {
  try {
    return await runGuided(deps);
  } catch (err) {
    deps.err(errorMessage(err));
    return 1;
  }
}

export async function runBootstrap(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number> {
  if (opts.webhook !== undefined || opts.webhookB64 !== undefined) {
    return runWebhookMode(opts, deps);
  }

  if (!deps.isTTY) {
    deps.err(NO_TTY_MESSAGE);
    return 1;
  }

  return runGuidedSafely(deps);
}

/** An inquirer prompt module that draws on stderr, so only the install command reaches
 * stdout and `bootstrap > command.txt` captures nothing else. */
async function loadStderrPrompt(): Promise<PromptModule> {
  const inquirer = (await import('inquirer')).default;
  return inquirer.createPromptModule({ output: process.stderr });
}

/** A real inquirer (`^9`)-backed {@link BootstrapPrompter}, following `install.ts`'s
 * `promptEmail` convention: `inquirer` is loaded with a dynamic `import('inquirer')` so
 * `--webhook` mode and plain `codemie analytics` loading never pull it in. Every prompt
 * writes to stderr ({@link loadStderrPrompt}). */
function createRealPrompter(): BootstrapPrompter {
  return {
    async input(message: string, def?: string): Promise<string> {
      const prompt = await loadStderrPrompt();
      const { value } = await prompt<{ value: string }>([{ type: 'input', name: 'value', message, default: def }]);
      return value;
    },
    async confirm(message: string, def: boolean): Promise<boolean> {
      const prompt = await loadStderrPrompt();
      const { value } = await prompt<{ value: boolean }>([{ type: 'confirm', name: 'value', message, default: def }]);
      return value;
    },
    async select<T extends string>(message: string, choices: { value: T; name: string }[], def?: T): Promise<T> {
      const prompt = await loadStderrPrompt();
      const { value } = await prompt<{ value: T }>([{ type: 'list', name: 'value', message, choices, default: def }]);
      return value;
    }
  };
}

/** Real dependencies for `runBootstrap`: a real TTY check on stdin and stderr (the prompts'
 * streams — stdout may be redirected to capture the install command), a real
 * inquirer-backed prompter, `sendWebhook` at its default timeout, the real browser opener,
 * `console.log`/`console.error` for the stdout/stderr split spec.md requires, and the lead's
 * state-file path. Dynamic-imports `webhook-target.js` and `browser.js` so loading `codemie
 * analytics` never pulls in `fetch`/`open` wiring just to register the command. */
export function createRealBootstrapDeps(): BootstrapDeps {
  return {
    isTTY: Boolean(process.stdin.isTTY) && Boolean(process.stderr.isTTY),
    cwd: process.cwd(),
    now: (): Date => new Date(),
    out: (line: string): void => {
      console.log(line);
    },
    err: (line: string): void => {
      console.error(line);
    },
    send: async (url: string, report: SyncReport, timeoutMs?: number): Promise<void> => {
      const { sendWebhook } = await import('../targets/webhook-target.js');
      await sendWebhook(url, report, undefined, timeoutMs);
    },
    openUrl: async (url: string): Promise<void> => {
      const { openUrlInBrowser } = await import('@/utils/browser.js');
      await openUrlInBrowser(url);
    },
    prompt: createRealPrompter(),
    statePath: getBootstrapStatePath()
  };
}
