/**
 * `codemie analytics sync bootstrap`'s guided mode (a TTY, no `--webhook` given).
 *
 * Plan task 7 (EPMCDME-16487) implements the start logic and steps 1-4 (Teams channel,
 * SharePoint folder, time zone, import the flow). Plan task 8 adds steps 5-8 (trigger URL
 * and test send, external sessions, lookback, developers) in the same file, run from
 * {@link runStepsFiveThroughEight}.
 *
 * Ported from the standalone collector's `src/wizard.js` (sequence + start logic) and
 * `src/wizard-support.js` (`importInstructions`, `POWER_AUTOMATE_URL`), adapted to this
 * port's simpler {@link BootstrapPrompter} (no inquirer `validate` callback, no "reuse the
 * saved answer" sentinel): every step validates and retries its own answer in a loop, and
 * only a raw previous answer (not a derived/structured one) is ever offered as a prompt
 * default.
 *
 * Imports only from `./types.ts`, `./steps.ts`, `./state-store.ts`, `./links.ts`,
 * `./timezones.ts`, `./flow-package.ts`, `./setup-check.ts`, `../config-store.ts`,
 * `../install-command.ts` and `../redact.ts` — never from `./run-bootstrap.ts`, which
 * imports this module to dispatch to it (the reverse import would create a cycle). None of
 * those modules import `run-bootstrap.ts` either.
 *
 * Every step prints only to `deps.err` (spec.md "Only the install command goes to stdout");
 * step 8 is the one exception, printing the install command itself to `deps.out`.
 */

import { SyncConfigError } from '@/utils/errors.js';

import { DEFAULT_LOOKBACK_DAYS, validateIncludeExternal, validateLookbackDays, validateTriggerUrl } from '../config-store.js';
import { buildInstallCommand } from '../install-command.js';
import { errorMessage } from '../redact.js';
import type { IncludeExternalPolicy } from '../types.js';
import { FLOW_PACKAGE_FILENAME, resolveFlowTemplateDir, writeFlowPackage } from './flow-package.js';
import { BootstrapInputError, cleanPaste, parseChannelLink, parseFolderUrl, validateFolderPath, validateSiteUrl } from './links.js';
import type { ChannelLink, FolderLink } from './links.js';
import { sendFailure4xxHint, setupCheckReport, UPDATE_HINT } from './setup-check.js';
import { checkReuse, loadBootstrapState, saveBootstrapState, summarizeState, toInstallCommandOptions } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading } from './steps.js';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from './timezones.js';
import type { BootstrapDeps, BootstrapPrompter } from './types.js';

// Re-exported so callers (and Task 8's continuation of this file) can keep importing the
// prompter's own interface from here without reaching into `./types.js` directly.
export type { BootstrapPrompter };

/** Persists a patch onto the in-flight wizard state, both in memory and on disk, after
 * every step (spec.md "State is saved after every step"). */
type SaveBootstrapState = (patch: Partial<BootstrapState>) => Promise<void>;

const POWER_AUTOMATE_URL = 'https://make.powerautomate.com/';
const MANUAL = 'manual';

/**
 * Calls `deps.prompt.input(message, def)` in a loop, retrying on a {@link
 * BootstrapInputError} or {@link SyncConfigError} (printed to `deps.err`) until `validate`
 * accepts the answer — the two error classes steps 1-4 (`links.ts`, `timezones.ts`) and
 * steps 5-7 (`config-store.ts`'s trigger-URL and lookback validators) throw on a bad
 * answer. Any other thrown error propagates — it is a bug, not a bad answer.
 */
async function askValidated<T>(
  deps: BootstrapDeps,
  message: string,
  validate: (raw: string) => T,
  def?: string
): Promise<T> {
  for (;;) {
    const raw = await deps.prompt.input(message, def);
    try {
      return validate(raw);
    } catch (err) {
      if (!(err instanceof BootstrapInputError) && !(err instanceof SyncConfigError)) {
        throw err;
      }
      deps.err(err.message);
    }
  }
}

/**
 * Step 1, "Teams channel": parses a "Get link to channel" link, retrying on a {@link
 * BootstrapInputError} (including a `/l/message/` link, spec.md AC4), then confirms the
 * parsed channel name before saving. The saved `channelLink` is offered as the next
 * prompt's default, so re-running after a decline-to-reuse restart is a quick re-confirm
 * rather than a fresh paste.
 */
async function step1Channel(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(0));

  for (;;) {
    const raw = await deps.prompt.input(
      'Teams channel link (on the channel: ⋯ → Get link to channel)',
      state.channelLink
    );
    let parsed: ChannelLink;
    try {
      parsed = parseChannelLink(raw);
    } catch (err) {
      if (!(err instanceof BootstrapInputError)) {
        throw err;
      }
      deps.err(err.message);
      continue;
    }
    if (await deps.prompt.confirm(`Channel "${parsed.channelName}" — is that the one?`, true)) {
      await save({
        channelLink: cleanPaste(raw),
        teamId: parsed.teamId,
        channelId: parsed.channelId,
        channelName: parsed.channelName
      });
      return;
    }
  }
}

/**
 * Step 2, "SharePoint folder": parses the folder's browser address, or — on typing
 * "manual" or declining the confirm — asks for the site and the folder path separately
 * (spec.md AC5). There is no raw address to offer back as a prompt default (only the
 * parsed site/path are saved), so a restart always starts this step with a fresh paste.
 */
async function step2Folder(deps: BootstrapDeps, _state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(1));

  let manual = false;
  for (;;) {
    let folder: FolderLink | undefined;
    if (!manual) {
      const raw = await deps.prompt.input(
        'SharePoint folder: open it in your browser and paste the address bar (or type "manual")'
      );
      if (cleanPaste(raw).toLowerCase() === MANUAL) {
        manual = true;
      } else {
        try {
          folder = parseFolderUrl(raw);
        } catch (err) {
          if (!(err instanceof BootstrapInputError)) {
            throw err;
          }
          deps.err(err.message);
          continue;
        }
      }
    }
    if (manual) {
      const siteUrl = await askValidated(
        deps,
        'Site address, e.g. https://contoso.sharepoint.com/sites/Analytics',
        validateSiteUrl
      );
      const folderPath = await askValidated(
        deps,
        'Folder path inside that site, e.g. Shared Documents/CodeMie',
        validateFolderPath
      );
      folder = { siteUrl, folderPath };
    }

    // Unreachable: `folder` is always set by one of the two branches above.
    if (folder === undefined) {
      continue;
    }

    if (await deps.prompt.confirm(`Site ${folder.siteUrl}, folder "${folder.folderPath}" — correct?`, true)) {
      await save(folder);
      return;
    }
    manual = true;
    deps.err('Then give the site and the folder separately.');
  }
}

/** Step 3, "Time zone": a Windows time zone name, default {@link DEFAULT_TIME_ZONE},
 * retried on an unknown name (spec.md AC6). */
async function step3TimeZone(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(2));

  const timeZone = await askValidated(
    deps,
    'Time zone for the timestamps in Teams (a Windows time zone name)',
    resolveTimeZone,
    state.timeZone ?? DEFAULT_TIME_ZONE
  );
  await save({ timeZone });
}

/**
 * The 6 numbered import instructions a lead follows in Power Automate after the flow
 * package is written. Ported from the standalone collector's `wizard-support.js`
 * `importInstructions()`, minus its ANSI color (this wizard prints plain text to stderr).
 */
function importInstructions(flowZipPath: string): string[] {
  return [
    `Flow package written to ${flowZipPath}`,
    '',
    'Import it in Power Automate:',
    `  1. Open ${POWER_AUTOMATE_URL} and sign in with your work account.`,
    '  2. My flows → Import → Import Package (Legacy) → Upload → choose the file above.',
    '  3. Under "Related resources", for the SharePoint and the Microsoft Teams connection,',
    '     click "Select during import" and pick (or create) your own connection. Save.',
    '  4. Click Import, then open the flow "CodeMie analytics delivery (webhook)".',
    '  5. Turn it on if it is off.',
    '  6. Edit it and open its trigger, "When a Teams webhook request is received":',
    '     check "Who can trigger the flow?" is "Anyone", then copy the URL shown there.'
  ];
}

/**
 * Step 4, "Import the flow": writes {@link FLOW_PACKAGE_FILENAME} into `deps.cwd` (never
 * holding a webhook URL), prints a notice if that overwrote an existing file, prints the 6
 * import instructions, offers to open Power Automate in the browser — printing the bare
 * {@link POWER_AUTOMATE_URL} when `deps.openUrl` throws, so the lead always has it to copy
 * — and waits for confirmation that the flow is on and its URL copied before continuing.
 */
async function step4ImportFlow(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(3));

  const { path, overwritten } = await writeFlowPackage(deps.cwd, {
    siteUrl: state.siteUrl ?? '',
    folderPath: state.folderPath ?? '',
    teamId: state.teamId ?? '',
    channelId: state.channelId ?? '',
    timeZone: state.timeZone ?? DEFAULT_TIME_ZONE
  });
  if (overwritten) {
    deps.err(`Overwrote the existing ${FLOW_PACKAGE_FILENAME}.`);
  }

  deps.err('');
  for (const line of importInstructions(path)) {
    deps.err(line);
  }
  deps.err('');

  if (await deps.prompt.confirm(`Open ${POWER_AUTOMATE_URL} in your browser now?`, true)) {
    try {
      await deps.openUrl(POWER_AUTOMATE_URL);
    } catch {
      deps.err(POWER_AUTOMATE_URL);
    }
  }

  let flowReady = false;
  while (!flowReady) {
    flowReady = await deps.prompt.confirm('Press Enter once the flow is on and you have copied its URL...', true);
  }

  await save({ flowImported: true });
}

/**
 * Step 5's trigger-URL prompt: {@link cleanPaste} then {@link validateTriggerUrl} in
 * `'guided'` mode (spec.md AR-2), retried via {@link askValidated} on a {@link
 * SyncConfigError} (e.g. a trailing typographic quote `validateTriggerUrl` rejects as
 * non-ASCII). No raw previous answer is offered as a default: by the time step 5 runs,
 * `state.webhookUrl` is always absent — either this is a fresh run, or `runGuided` already
 * discarded a saved-but-invalid one before jumping here.
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
  { value: 'windows', name: 'Windows only (recommended): Windows sends data, macOS and Linux stay CodeMie-only' },
  { value: 'always', name: 'On all platforms: every agent session on every machine' },
  { value: 'never', name: 'Never: strictly CodeMie sessions; Windows machines send nothing' }
];

/**
 * Step 6, "External sessions": the `--include-external` policy, defaulting to `'windows'`
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
  deps.err("Windows needs it: there the CLI can't recognise CodeMie's own sessions, so without it the export is empty.");
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
 * `runGuided` calls this whenever the wizard reaches step 5 or later: right after step 4
 * finishes, on a reuse jump straight to step 8, and on any `resumeAt`/"already imported"
 * jump into step 5 or later — `fromStep` says which of steps 5-7 to run; step 8 always
 * runs. Each ran step's returned state feeds the next, since this function's own `state`
 * parameter is a snapshot taken once by its caller and `save`'s mutation of `runGuided`'s
 * `state` variable is not visible here otherwise.
 */
async function runStepsFiveThroughEight(
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

/**
 * The guided wizard's start logic (spec.md "Start logic") and steps 1-4.
 *
 * `resolveFlowTemplateDir()` is checked before step 1 can run (and before any step 1-4
 * that a resume lands on, since step 4 depends on it too) — a missing template directory
 * fails fast rather than after three steps of questions.
 *
 * - A saved state with a webhook shows a masked summary and offers reuse. Accepting
 *   re-checks it with `checkReuse`: ok jumps straight to step 8; not ok discards the saved
 *   webhook (when the failure is at step 5) and resumes at `resumeAt`. Declining restarts
 *   at step 1, with the saved answers offered back as defaults.
 * - Without a saved webhook, "already imported the flow and copied its trigger URL?"
 *   (default no) jumps to step 5 on yes, or starts at step 1 on no.
 *
 * State is saved after every step, via the `save` closure threaded through each step
 * function, so an interrupted run resumes with the earlier answers as defaults.
 */
export async function runGuided(deps: BootstrapDeps): Promise<number> {
  const { state: loaded, notice } = await loadBootstrapState(deps.statePath);
  if (notice !== undefined) {
    deps.err(notice);
  }
  let state: BootstrapState = loaded ?? { version: 1 };

  const save: SaveBootstrapState = async (patch) => {
    state = { ...state, ...patch };
    await saveBootstrapState(state, deps.statePath);
  };

  let startStep: number;
  if (state.webhookUrl !== undefined) {
    deps.err('Saved settings from an earlier run:');
    for (const line of summarizeState(state)) {
      deps.err(`  ${line}`);
    }
    const reuse = await deps.prompt.confirm('Reuse them?', true);
    if (!reuse) {
      startStep = 1;
    } else {
      const check = checkReuse(state);
      if (check.ok) {
        startStep = 8;
      } else {
        startStep = check.resumeAt;
        if (startStep === 5) {
          const { webhookUrl: _discardedUrl, webhookTest: _discardedTest, ...rest } = state;
          state = rest;
          await saveBootstrapState(state, deps.statePath);
        }
      }
    }
  } else {
    const alreadyImported = await deps.prompt.confirm(
      'Have you already imported the flow and copied its trigger URL?',
      false
    );
    startStep = alreadyImported ? 5 : 1;
  }

  if (startStep <= 4) {
    try {
      resolveFlowTemplateDir();
    } catch (err) {
      deps.err(errorMessage(err));
      return 1;
    }
  }

  if (startStep <= 1) {
    await step1Channel(deps, state, save);
  }
  if (startStep <= 2) {
    await step2Folder(deps, state, save);
  }
  if (startStep <= 3) {
    await step3TimeZone(deps, state, save);
  }
  if (startStep <= 4) {
    await step4ImportFlow(deps, state, save);
  }

  return runStepsFiveThroughEight(deps, state, save, Math.max(startStep, 5));
}
