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

import { SyncDeliveryError } from '@/utils/errors.js';

import { validateIncludeExternal, validateLookbackDays, validateTriggerUrl } from '../config-store.js';
import { buildInstallCommand } from '../install-command.js';
import { errorMessage } from '../redact.js';
import type { SyncReport } from '../types.js';
import { runGuided } from './guided.js';
import { getBootstrapStatePath } from './state-store.js';
import type { BootstrapDeps, BootstrapOptions, BootstrapPrompter } from './types.js';

// Re-exported so callers can keep importing the runner's own interface, per the plan's
// controller ruling, without reaching into `./types.js` directly.
export type { BootstrapDeps, BootstrapOptions, BootstrapPrompter };

/**
 * `setup-check-<stamp>.json`: the `--webhook` mode's connectivity test payload. Same shape as
 * the standalone collector's own check (`wizard-support.js`'s `setupCheckFile`) so a lead
 * reading Power Automate's run history sees a familiar payload. Carries no analytics data and
 * no webhook URL. Deliberately not named `codemie-analytics-…`: analysis tooling attributes
 * files by that prefix, and this one belongs to nobody.
 */
export function setupCheckReport(now: Date): SyncReport {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const payload = {
    setupCheck: true,
    sentAt: now.toISOString(),
    note: 'Sent by `codemie analytics sync bootstrap` to test the flow. Safe to delete.'
  };

  return {
    fileName: `setup-check-${stamp}.json`,
    bytes: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`, 'utf-8')
  };
}

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

/** Printed to `deps.err` after every successful `--webhook` send, right before the install
 * command. Names no version, so it reads the same across CLI releases (spec.md "Install
 * command", decision AR-5). */
export const UPDATE_HINT =
  'Developers who see "unknown command" need a newer CodeMie CLI: have them run `codemie self-update`.';

/** Printed when there is no TTY and no `--webhook` was given — the only way forward in either
 * case, so both remedies are named. */
const NO_TTY_MESSAGE =
  'No terminal is attached, and no --webhook was given.\n' +
  'Pass --webhook <url> to run `codemie analytics sync bootstrap` non-interactively, or run it ' +
  'again in a terminal for the guided wizard.';

/** Same shape as `install.ts`'s `printGitFailure`: the redacted message, plus the "flow on /
 * Anyone / whole URL" hint when the failure was a 4xx — keyed off `SyncDeliveryError.status`,
 * never message text, per spec.md "Constraints and left to the builder". */
function printSendFailure(deps: BootstrapDeps, err: unknown): void {
  deps.err(`Test send failed: ${errorMessage(err)}`);
  if (err instanceof SyncDeliveryError && err.status !== undefined && err.status >= 400 && err.status < 500) {
    deps.err('Check that the flow is turned on, that its trigger allows "Anyone", and that the whole URL was copied.');
  }
}

/**
 * `--webhook` non-interactive mode (spec.md "Non-interactive mode"). Validates every option
 * first — webhook, then lookback, then policy — with no network call before all three pass;
 * each failure names its own flag. Test-sends {@link setupCheckReport} through `deps.send`; on
 * a 2xx it prints the check and cleanup lines plus {@link UPDATE_HINT} to `deps.err`, then the
 * install command to `deps.out`, and returns 0. On any failure it prints no command and
 * returns a non-zero exit code. Never reads or writes `deps.statePath`.
 */
async function runWebhookMode(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number> {
  const rawWebhook = opts.webhook;
  if (rawWebhook === undefined) {
    // Unreachable: runBootstrap only takes this branch once opts.webhook is defined.
    return 1;
  }

  let webhookUrl: string;
  let lookbackDays: number | undefined;
  let includeExternal: ReturnType<typeof validateIncludeExternal>;
  try {
    webhookUrl = validateTriggerUrl(rawWebhook, 'option');
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
  deps.err(UPDATE_HINT);

  deps.out(
    buildInstallCommand({
      webhook: webhookUrl,
      includeExternal,
      ...(lookbackDays !== undefined && { lookbackDays })
    })
  );
  return 0;
}

export async function runBootstrap(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number> {
  if (opts.webhook !== undefined) {
    return runWebhookMode(opts, deps);
  }

  if (!deps.isTTY) {
    deps.err(NO_TTY_MESSAGE);
    return 1;
  }

  return runGuided(deps);
}

/** A real inquirer (`^9`)-backed {@link BootstrapPrompter}, following `install.ts`'s
 * `promptEmail` convention: `inquirer` is loaded with a dynamic `import('inquirer')` so
 * `--webhook` mode and plain `codemie analytics` loading never pull it in. */
function createRealPrompter(): BootstrapPrompter {
  return {
    async input(message: string, def?: string): Promise<string> {
      const inquirer = (await import('inquirer')).default;
      const { value } = await inquirer.prompt<{ value: string }>([
        { type: 'input', name: 'value', message, default: def }
      ]);
      return value;
    },
    async confirm(message: string, def: boolean): Promise<boolean> {
      const inquirer = (await import('inquirer')).default;
      const { value } = await inquirer.prompt<{ value: boolean }>([
        { type: 'confirm', name: 'value', message, default: def }
      ]);
      return value;
    },
    async select<T extends string>(message: string, choices: { value: T; name: string }[], def?: T): Promise<T> {
      const inquirer = (await import('inquirer')).default;
      const { value } = await inquirer.prompt<{ value: T }>([
        { type: 'list', name: 'value', message, choices, default: def }
      ]);
      return value;
    }
  };
}

/** Real dependencies for `runBootstrap`: a real TTY check on both stdin and stdout, a real
 * inquirer-backed prompter, `sendWebhook` at its default timeout, the real browser opener,
 * `console.log`/`console.error` for the stdout/stderr split spec.md requires, and the lead's
 * state-file path. Dynamic-imports `webhook-target.js` and `browser.js` so loading `codemie
 * analytics` never pulls in `fetch`/`open` wiring just to register the command. */
export function createRealBootstrapDeps(): BootstrapDeps {
  return {
    isTTY: Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
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
