/**
 * Runner for `codemie analytics sync bootstrap` and its `--webhook`/`--git-repo` non-interactive mode.
 *
 * `runBootstrap` is a thin dispatcher (spec.md "Non-interactive mode" / "Start logic"):
 * any delivery target flag (`--webhook`, `--webhook-b64`, `--git-repo`) always wins and runs
 * the validate-then-test path below, with no prompts,
 * no TTY requirement, and no read or write of the lead's saved wizard state
 * (`bootstrap/state-store.ts`) — a headless run must never change a lead's saved answers.
 * Without a target flag, a TTY hands off to the guided wizard (`./guided.ts`); no TTY and no
 * target flag fails at once, naming both ways forward.
 *
 * `runBootstrap` never throws and never calls `process.exit`; every failure path prints via
 * `deps.err` and returns a non-zero exit code. Every side effect is injected via
 * {@link BootstrapDeps} so tests run without touching the real filesystem, network or a
 * terminal; `createRealBootstrapDeps()` wires the real ones.
 *
 * Output split (spec.md "Install command", "Constraints and left to the builder"): only the
 * install command goes to `deps.out`/stdout; everything else — including non-interactive mode's
 * check and cleanup lines and {@link updateHint} — goes to `deps.err`/stderr. No display
 * anywhere here names the webhook's `sig` value.
 */

import { mkdtemp, rm } from 'fs/promises';
import type { PromptModule } from 'inquirer';
import { tmpdir } from 'os';
import { join } from 'path';

import { getCurrentCliVersion } from '@/utils/cli-updater.js';
import { SyncConfigError, SyncGitError } from '@/utils/errors.js';

import {
  hasAnyTarget,
  validateGitSettings,
  validateIncludeExternal,
  validateLookbackDays
} from '../config-store.js';
import { realIdentityDeps, resolveSyncIdentity } from '../identity.js';
import { buildInstallCommand } from '../install-command.js';
import { errorMessage } from '../redact.js';
import { createGitRunner, gitHint } from '../targets/git-client.js';
import { GitTarget } from '../targets/git-target.js';
import { validateTriggerUrl } from '../trigger-url.js';
import type { GitSettings, SyncReport } from '../types.js';
import { decodeWebhook } from '../webhook-encoding.js';
import { runGuided } from './guided.js';
import { GIT_ACCESS_NOTE } from './guided-late-steps.js';
import { sendFailure4xxHint, setupCheckReport, UPDATE_HINT, updateHint } from './setup-check.js';
import { getBootstrapStatePath } from './state-store.js';
import type { BootstrapDeps, BootstrapOptions, BootstrapPrompter } from './types.js';

// Re-exported so callers can keep importing the runner's own interface, per the plan's
// controller ruling, without reaching into `./types.js` directly.
export type { BootstrapDeps, BootstrapOptions, BootstrapPrompter };

// Re-exported (plan task 8) so existing imports/tests of this module keep working unchanged
// now that both live in `./setup-check.js`, which the guided wizard's step 5 also imports.
export { setupCheckReport, UPDATE_HINT, updateHint };

/** Prefix for the temporary working copy the lead-side git test push uses. */
const TEMP_DIR_PREFIX = 'codemie-sync-bootstrap-';

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

/** Printed when there is no TTY and no delivery target flag was given — the only way forward
 * in either case, so both remedies are named. */
const NO_TTY_MESSAGE =
  'No terminal is attached, and no delivery target was given.\n' +
  'Pass --webhook <url> (or --webhook-b64 <value>) and/or --git-repo <url> to run ' +
  '`codemie analytics sync bootstrap` non-interactively, or run it again in a terminal for the ' +
  'guided wizard.';

/** Printed to `deps.err` after a successful git test push. */
const GIT_PASS_LINE = 'Git push succeeded: push access to the repository is confirmed.';

/** Same shape as `install.ts`'s `printGitFailure`: the redacted message, plus {@link
 * sendFailure4xxHint} when the failure was a 4xx. */
function printSendFailure(deps: BootstrapDeps, err: unknown): void {
  deps.err(`Test send failed: ${errorMessage(err)}`);
  const hint = sendFailure4xxHint(err);
  if (hint !== undefined) {
    deps.err(hint);
  }
}

/** The redacted git failure, with the repository URL itself scrubbed from the message, plus
 * `gitHint(err.gitCause)` for a `SyncGitError` (same as `install`'s `printGitFailure`). */
function printGitFailure(deps: BootstrapDeps, git: GitSettings, err: unknown): void {
  deps.err(`Git test push failed: ${errorMessage(err).split(git.repoUrl).join('<repository>')}`);
  if (err instanceof SyncGitError) {
    deps.err(gitHint(err.gitCause));
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

/** Whether `opts` names a delivery target at all, judged on the raw flags (validation comes
 * later, so a bad value still reaches the runner and is reported there). */
function givesAnyTarget(opts: BootstrapOptions): boolean {
  return hasAnyTarget(
    opts.webhook ?? opts.webhookB64,
    opts.gitRepo === undefined ? undefined : { repoUrl: opts.gitRepo }
  );
}

/** Test-pushes `git` into a fresh temporary working copy (never the shared one at
 * `gitWorkingCopyPath()`), always removed afterwards. Throws on failure. */
async function testGitPush(git: GitSettings, email: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX));
  try {
    await new GitTarget(git, email, createGitRunner(), dir).testPush();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Non-interactive mode (spec.md "Non-interactive mode"), for `--webhook`/`--webhook-b64`
 * and/or `--git-repo`. Validates every option first — webhook, git, lookback, policy — and
 * resolves the git report email, with no network call before all of them pass; each failure
 * names its own flag. Then runs the webhook test send ({@link setupCheckReport} through
 * `deps.send`) and the git temp-copy test push concurrently via `Promise.allSettled`, each
 * with its own timeout, so the wait is the slower target alone. On any failure it names the
 * failed target(s) on `deps.err`, prints no command and returns 1. On all-pass it prints the
 * check lines to `deps.err`, then the install command to `deps.out`, then (git only) the
 * developer access note and {@link updateHint} to `deps.err`, and returns 0. Never reads or
 * writes `deps.statePath`.
 */
async function runNonInteractive(opts: BootstrapOptions, deps: BootstrapDeps): Promise<number> {
  let webhookUrl: string | undefined;
  let git: GitSettings | undefined;
  let lookbackDays: number | undefined;
  let includeExternal: ReturnType<typeof validateIncludeExternal>;
  let email: string | undefined;
  try {
    if (opts.webhook !== undefined || opts.webhookB64 !== undefined) {
      webhookUrl = validateTriggerUrl(resolveWebhookOption(opts), 'option');
    }
    git = validateGitSettings({ gitRepo: opts.gitRepo, gitBranch: opts.gitBranch, gitPath: opts.gitPath });
    lookbackDays = validateLookbackDays(opts.lookbackDays);
    includeExternal = validateIncludeExternal(opts.includeExternal);
    if (git !== undefined) {
      email = await resolveSyncIdentity(realIdentityDeps);
    }
  } catch (err) {
    deps.err(errorMessage(err));
    return 1;
  }

  const report = setupCheckReport(deps.now());
  const checks: Promise<void>[] = [];
  const onFail: Array<(err: unknown) => void> = [];
  if (webhookUrl !== undefined) {
    const url = webhookUrl;
    checks.push(deps.send(url, report));
    onFail.push((err) => printSendFailure(deps, err));
  }
  if (git !== undefined && email !== undefined) {
    const settings = git;
    const identity = email;
    checks.push(testGitPush(settings, identity));
    onFail.push((err) => printGitFailure(deps, settings, err));
  }

  const results = await Promise.allSettled(checks);
  let failed = false;
  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      failed = true;
      onFail[index]?.(result.reason);
    }
  });
  if (failed) {
    return 1;
  }

  if (webhookUrl !== undefined) {
    deps.err(checkLine(report));
    deps.err(CLEANUP_LINE);
  }
  if (git !== undefined) {
    deps.err(GIT_PASS_LINE);
  }

  deps.out(
    buildInstallCommand({
      ...(webhookUrl !== undefined && { webhook: webhookUrl }),
      ...(git !== undefined && {
        gitRepo: git.repoUrl,
        ...(git.branch !== undefined && { gitBranch: git.branch }),
        ...(git.path !== undefined && { gitPath: git.path })
      }),
      includeExternal,
      ...(lookbackDays !== undefined && { lookbackDays })
    })
  );
  if (git !== undefined) {
    deps.err(GIT_ACCESS_NOTE);
  }
  deps.err(updateHint(await deps.cliVersion()));
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
  if (givesAnyTarget(opts)) {
    return runNonInteractive(opts, deps);
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
    cliVersion: getCurrentCliVersion,
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
