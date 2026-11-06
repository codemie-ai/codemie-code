/**
 * The guided wizard's steps 5-8 (Trigger URL and test send, External sessions, Lookback,
 * Developers), run from {@link runStepsFiveThroughEight} by `./guided.ts`.
 *
 * Ported from the standalone collector's `src/wizard.js` (`testDelivery`,
 * `askIncludeExternal`, `askLookback`). Every step prints only to `deps.err`; step 8 is the
 * one exception, printing the install command itself to `deps.out`.
 */

import { SyncConfigError } from '@/utils/errors.js';

import { DEFAULT_LOOKBACK_DAYS, validateIncludeExternal, validateLookbackDays } from '../config-store.js';
import { buildInstallCommand } from '../install-command.js';
import { errorMessage } from '../redact.js';
import { validateTriggerUrl } from '../trigger-url.js';
import type { IncludeExternalPolicy } from '../types.js';
import { askValidated } from './guided-support.js';
import type { SaveBootstrapState } from './guided-support.js';
import { cleanPaste } from './links.js';
import { sendFailure4xxHint, setupCheckReport, UPDATE_HINT } from './setup-check.js';
import { toInstallCommandOptions } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading } from './steps.js';
import type { BootstrapDeps } from './types.js';

/**
 * Step 5's trigger-URL prompt: {@link cleanPaste} then {@link validateTriggerUrl} in
 * `'guided'` mode (spec.md AR-2), retried via {@link askValidated} on a {@link
 * SyncConfigError} (e.g. a trailing typographic quote `validateTriggerUrl` rejects as
 * non-ASCII). No raw previous answer is offered as a default: by the time step 5 runs,
 * `state.webhookUrl` is always absent — either this is a fresh run, or `runGuided` already
 * discarded the saved one before re-running this step.
 */
async function askTriggerUrl(deps: BootstrapDeps): Promise<string> {
  return askValidated(deps, 'Trigger URL of the flow', (raw) => validateTriggerUrl(cleanPaste(raw), 'guided'));
}

/**
 * Test-sends one {@link setupCheckReport} through `deps.send` (spec.md plan note "an
 * interactive test-send timeout of about 30 s"), printing `'Sending test file…'` first.
 * Ported from the collector's `testDelivery()`, minus its leading "send a test now?"
 * confirm (AR-1: `webhookTest` is set only on a 2xx or an explicit Skip, so there is no
 * third "never tested" outcome to gate on here) and its ANSI color.
 *
 * On success, prints the collector's success text and returns `'passed'`. On failure,
 * prints the redacted cause (never the URL) plus {@link sendFailure4xxHint} for a 4xx, then
 * offers Try again (loops, re-sending) / Enter a different URL (returns `'retry-url'`, so
 * the caller asks for a new URL) / Skip the test (returns `'skipped'`).
 */
async function testSendLoop(deps: BootstrapDeps, url: string): Promise<'passed' | 'skipped' | 'retry-url'> {
  for (;;) {
    deps.err('Sending test file…');
    const report = setupCheckReport(deps.now());
    try {
      await deps.send(url, report, 30_000);
    } catch (err) {
      deps.err(`Test send failed: ${errorMessage(err)}`);
      const hint = sendFailure4xxHint(err);
      if (hint !== undefined) {
        deps.err(hint);
      }
      const choice = await deps.prompt.select(
        'What now?',
        [
          { value: 'retry', name: 'Try again' },
          { value: 'url', name: 'Enter a different URL' },
          { value: 'skip', name: 'Skip the test' }
        ],
        'retry'
      );
      if (choice === 'retry') {
        continue;
      }
      if (choice === 'url') {
        return 'retry-url';
      }
      return 'skipped';
    }

    deps.err(
      `Within a minute ${report.fileName} should be in the SharePoint folder, and this month's card in the Teams ` +
        'channel should have a reply for it. Delete the file afterwards.'
    );
    deps.err("If nothing shows up, the flow's run history in Power Automate says why.");
    return 'passed';
  }
}

/**
 * Step 5, "Trigger URL": asks for the URL, saves it with `webhookTest` cleared (AR-1) —
 * before the test send, per the plan note "save the URL before the send" — then runs
 * {@link testSendLoop}. "Enter a different URL" loops back to ask again (and save again)
 * rather than retrying the same URL; the heading above is still printed only once.
 */
async function step5TriggerUrl(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<BootstrapState> {
  deps.err('');
  deps.err(stepHeading(4));

  let current = state;
  for (;;) {
    const webhookUrl = await askTriggerUrl(deps);
    await save({ webhookUrl, webhookTest: undefined });
    current = { ...current, webhookUrl, webhookTest: undefined };

    const outcome = await testSendLoop(deps, webhookUrl);
    if (outcome === 'retry-url') {
      continue;
    }

    await save({ webhookTest: outcome });
    return { ...current, webhookTest: outcome };
  }
}

/** One line per {@link IncludeExternalPolicy}, for step 6's menu — ported from the
 * collector's `askIncludeExternal()` menu labels (`describeIncludeExternal` plus its
 * per-choice detail clause). */
const INCLUDE_EXTERNAL_CHOICES: { value: IncludeExternalPolicy; name: string }[] = [
  { value: 'never', name: 'Never (recommended): strictly CodeMie sessions on every platform' },
  { value: 'always', name: 'On all platforms: every agent session on every machine' },
  { value: 'windows', name: 'Windows only: Windows machines also count external sessions (the standalone collector\'s old default)' }
];

/**
 * Step 6, "External sessions": the `--include-external` policy, defaulting to `'never'`
 * (the same default {@link validateIncludeExternal} applies to a missing `--include-external`).
 * Ported from the collector's `askIncludeExternal()`, minus its ANSI `dim()` on the last
 * explanatory line.
 */
async function step6ExternalSessions(
  deps: BootstrapDeps,
  state: BootstrapState,
  save: SaveBootstrapState
): Promise<BootstrapState> {
  deps.err('');
  deps.err(stepHeading(5));

  deps.err('`codemie analytics --include-external` also counts agent sessions not launched through CodeMie.');
  deps.err('Machines with it on and machines with it off report figures that are not directly comparable.');

  const includeExternal = await deps.prompt.select(
    'When should developer machines include external sessions?',
    INCLUDE_EXTERNAL_CHOICES,
    state.includeExternal ?? validateIncludeExternal(undefined)
  );
  await save({ includeExternal });
  return { ...state, includeExternal };
}

/**
 * Step 7, "Lookback": the CLI default (saved as the literal `'default'`, spec.md
 * "Interfaces") or a fixed 1-30, retried via {@link askValidated} on an out-of-range or
 * non-integer answer. Ported from the collector's `askLookback()`, minus its ANSI `dim()`
 * on the last explanatory line.
 */
async function step7Lookback(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<BootstrapState> {
  deps.err('');
  deps.err(stepHeading(6));

  deps.err('`codemie analytics` picks sessions by when they started, so each run looks back a number of');
  deps.err('days to send sessions that were still open last time again, with their later activity.');
  deps.err('Choose the default to let CLI updates lower it once sessions are picked by overlap instead of start.');

  const choice = await deps.prompt.select(
    'How many days should each run look back?',
    [
      {
        value: 'default',
        name: `CLI default (recommended): ${DEFAULT_LOOKBACK_DAYS} days now, follows CLI updates`
      },
      { value: 'fixed', name: 'A fixed number of days: changes only with a new install command' }
    ],
    typeof state.lookbackDays === 'number' ? 'fixed' : 'default'
  );

  if (choice === 'default') {
    await save({ lookbackDays: 'default' });
    return { ...state, lookbackDays: 'default' };
  }

  const lookbackDays = await askValidated(
    deps,
    'Days to look back (1-30)',
    (raw) => {
      const days = validateLookbackDays(raw);
      if (days === undefined) {
        // Unreachable: `raw` is always a defined string here, and validateLookbackDays only
        // returns undefined for an undefined input.
        throw new SyncConfigError('Enter a whole number of days from 1 to 30.');
      }
      return days;
    },
    typeof state.lookbackDays === 'number' ? String(state.lookbackDays) : undefined
  );
  await save({ lookbackDays });
  return { ...state, lookbackDays };
}

/**
 * Step 8, "Developers": the one line that goes to `deps.out` in the whole guided wizard —
 * the install command built from `state` via {@link toInstallCommandOptions} — followed by
 * {@link UPDATE_HINT} on `deps.err`.
 */
async function step8Developers(deps: BootstrapDeps, state: BootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(7));

  deps.out(buildInstallCommand(toInstallCommandOptions(state)));
  deps.err(UPDATE_HINT);
}

/**
 * Steps 5-8 (Trigger URL and test send, External sessions, Lookback, Developers).
 * `runGuided` (`./guided.ts`) calls this whenever the wizard reaches step 5 or later: right after step 4
 * finishes, on a reuse jump straight to step 8, and on any `resumeAt`/"already imported"
 * jump into step 5 or later — `fromStep` says which of steps 5-7 to run; step 8 always
 * runs. Each ran step's returned state feeds the next, since this function's own `state`
 * parameter is a snapshot taken once by its caller and `save`'s mutation of `runGuided`'s
 * `state` variable is not visible here otherwise.
 */
export async function runStepsFiveThroughEight(
  deps: BootstrapDeps,
  state: BootstrapState,
  save: SaveBootstrapState,
  fromStep: number
): Promise<number> {
  let current = state;

  if (fromStep <= 5) {
    current = await step5TriggerUrl(deps, current, save);
  }
  if (fromStep <= 6) {
    current = await step6ExternalSessions(deps, current, save);
  }
  if (fromStep <= 7) {
    current = await step7Lookback(deps, current, save);
  }

  await step8Developers(deps, current);
  return 0;
}
