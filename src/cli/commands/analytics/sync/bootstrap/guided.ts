/**
 * `codemie analytics sync bootstrap`'s guided mode (a TTY, no `--webhook` given): the start
 * logic and steps 1-4 (Teams channel, SharePoint folder, time zone, import the flow). Steps
 * 5-8 (trigger URL and test send, external sessions, lookback, developers) live in
 * `./guided-late-steps.ts`, run from {@link runStepsFiveThroughEight}.
 *
 * Ported from the standalone collector's `src/wizard.js` (sequence + start logic) and
 * `src/wizard-support.js` (`importInstructions`, `POWER_AUTOMATE_URL`), adapted to this
 * port's simpler {@link BootstrapPrompter} (no inquirer `validate` callback, no "reuse the
 * saved answer" sentinel): every step validates and retries its own answer in a loop, and
 * earlier answers are offered back as prompt defaults or a "keep it?" confirm.
 *
 * Never imports `./run-bootstrap.ts`, which imports this module to dispatch to it (the
 * reverse import would create a cycle). None of the modules imported here import
 * `run-bootstrap.ts` either.
 *
 * Every step prints only to `deps.err` (spec.md "Only the install command goes to stdout");
 * step 8 is the one exception, printing the install command itself to `deps.out`.
 */

import { errorMessage } from '../redact.js';
import { FLOW_PACKAGE_FILENAME, resolveFlowTemplateDir, writeFlowPackage } from './flow-package.js';
import { runStepsFiveThroughEight } from './guided-late-steps.js';
import { askValidated } from './guided-support.js';
import type { SaveBootstrapState } from './guided-support.js';
import { BootstrapInputError, cleanPaste, parseChannelLink, parseFolderUrl, validateFolderPath, validateSiteUrl } from './links.js';
import type { ChannelLink, FolderLink } from './links.js';
import { checkReuse, loadBootstrapState, saveBootstrapState, summarizeState } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading } from './steps.js';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from './timezones.js';
import type { BootstrapDeps, BootstrapPrompter } from './types.js';

// Re-exported so callers can keep importing the prompter's own interface from here without
// reaching into `./types.js` directly.
export type { BootstrapPrompter };

const POWER_AUTOMATE_URL = 'https://make.powerautomate.com/';
const MANUAL = 'manual';

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

/** Step 2's paste prompt: the parsed folder, or {@link MANUAL} when the lead typed "manual".
 * Retries on a {@link BootstrapInputError}. */
async function askPastedFolder(deps: BootstrapDeps): Promise<FolderLink | typeof MANUAL> {
  for (;;) {
    const raw = await deps.prompt.input(
      'SharePoint folder: open it in your browser and paste the address bar (or type "manual")'
    );
    if (cleanPaste(raw).toLowerCase() === MANUAL) {
      return MANUAL;
    }
    try {
      return parseFolderUrl(raw);
    } catch (err) {
      if (!(err instanceof BootstrapInputError)) {
        throw err;
      }
      deps.err(err.message);
    }
  }
}

/** Step 2's manual entry: the site and the folder path asked separately, each defaulting to
 * the `saved` answer when there is one. */
async function askManualFolder(deps: BootstrapDeps, saved: FolderLink | undefined): Promise<FolderLink> {
  const siteUrl = await askValidated(
    deps,
    'Site address, e.g. https://contoso.sharepoint.com/sites/Analytics',
    validateSiteUrl,
    saved?.siteUrl
  );
  const folderPath = await askValidated(
    deps,
    'Folder path inside that site, e.g. Shared Documents/CodeMie',
    validateFolderPath,
    saved?.folderPath
  );
  return { siteUrl, folderPath };
}

/** The saved step 2 answer, when both halves of it are present. */
function savedFolder(state: BootstrapState): FolderLink | undefined {
  if (state.siteUrl === undefined || state.folderPath === undefined) {
    return undefined;
  }
  return { siteUrl: state.siteUrl, folderPath: state.folderPath };
}

/**
 * Step 2, "SharePoint folder": with a saved folder, first offers to keep it (spec.md AC12,
 * "resumes with the earlier answers as defaults"). Otherwise parses the folder's browser
 * address, or — on typing "manual" or declining the confirm — asks for the site and the
 * folder path separately (spec.md AC5), with the saved ones as defaults.
 */
async function step2Folder(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(1));

  const saved = savedFolder(state);
  if (saved && (await deps.prompt.confirm(`Keep site ${saved.siteUrl}, folder "${saved.folderPath}"?`, true))) {
    await save(saved);
    return;
  }

  let manual = false;
  for (;;) {
    const pasted = manual ? MANUAL : await askPastedFolder(deps);
    const folder = pasted === MANUAL ? await askManualFolder(deps, saved) : pasted;
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

/** Where `runGuided` starts: the first step to run, and the state to run it on. */
interface StartPoint {
  startStep: number;
  state: BootstrapState;
}

/**
 * Drops the answers that re-running the wizard from `startStep` makes stale, and saves the
 * result. Re-running step 5 or earlier drops the saved webhook and its test result: a flow
 * re-imported at step 4 has a new trigger URL, and quitting before step 5 must not leave the
 * old one looking reusable. Re-running step 4 or earlier also drops `skippedSetup`.
 */
async function discardStaleAnswers(state: BootstrapState, startStep: number, statePath: string): Promise<BootstrapState> {
  if (startStep > 5) {
    return state;
  }
  const { webhookUrl: _webhookUrl, webhookTest: _webhookTest, skippedSetup, ...rest } = state;
  const kept: BootstrapState = startStep <= 4 || skippedSetup === undefined ? rest : { ...rest, skippedSetup };
  await saveBootstrapState(kept, statePath);
  return kept;
}

/**
 * The start logic (spec.md "Start logic"):
 * - A saved state with a webhook shows a masked summary and offers reuse. Accepting
 *   re-checks it with `checkReuse`: ok jumps straight to step 8; not ok resumes at
 *   `resumeAt`. Declining restarts at step 1, with the saved answers offered back.
 *   Either way, {@link discardStaleAnswers} drops what the re-run makes stale.
 * - Without a saved webhook, "already imported the flow and copied its trigger URL?"
 *   (default no) starts at step 1 on no. Yes jumps to step 5 and saves `skippedSetup`, so
 *   a later run can reuse the state without steps 1-4's answers.
 */
/**
 * Temporary compatibility shim: `checkReuse` (state-store.ts) now returns a step id
 * (string), but `guided.ts` still gates every step numerically (1-8) — the full
 * migration to the id-based model is Task 5's job. `state.targets` is always
 * `{webhook:true,git:false}` on every path through this file (no UI yet chooses git),
 * so `checkReuse` can only ever resume at one of these 8 ids; `'target'` is always
 * pre-answered (state-store.ts's `isStepAnswered`) and `'git-repo'` never appears for a
 * webhook-only selection. Task 5 deletes this table when it migrates `guided.ts` off
 * the numeric model entirely.
 */
const RESUME_STEP_TO_NUMBER: Record<string, number> = {
  channel: 1,
  folder: 2,
  timezone: 3,
  flow: 4,
  'trigger-url': 5,
  external: 6,
  lookback: 7,
  developers: 8
};

async function resolveStartStep(deps: BootstrapDeps, state: BootstrapState): Promise<StartPoint> {
  if (state.webhookUrl === undefined) {
    const alreadyImported = await deps.prompt.confirm(
      'Have you already imported the flow and copied its trigger URL?',
      false
    );
    if (!alreadyImported) {
      return { startStep: 1, state };
    }
    const skipped: BootstrapState = { ...state, skippedSetup: true };
    await saveBootstrapState(skipped, deps.statePath);
    return { startStep: 5, state: skipped };
  }

  deps.err('Saved settings from an earlier run:');
  for (const line of summarizeState(state)) {
    deps.err(`  ${line}`);
  }

  let startStep = 1;
  if (await deps.prompt.confirm('Reuse them?', true)) {
    const check = checkReuse(state);
    if (check.ok) {
      return { startStep: 8, state };
    }
    startStep = RESUME_STEP_TO_NUMBER[check.resumeAt] ?? 1;
  }
  return { startStep, state: await discardStaleAnswers(state, startStep, deps.statePath) };
}

/**
 * The guided wizard: {@link resolveStartStep}, then steps 1-4 from the start step, then
 * steps 5-8 via {@link runStepsFiveThroughEight}.
 *
 * `resolveFlowTemplateDir()` is checked before any of steps 1-4 runs (step 4 depends on it),
 * so a missing template directory fails fast rather than after three steps of questions.
 *
 * State is saved after every step, via the `save` closure threaded through each step
 * function, so an interrupted run resumes with the earlier answers as defaults.
 */
export async function runGuided(deps: BootstrapDeps): Promise<number> {
  const { state: loaded, notice } = await loadBootstrapState(deps.statePath);
  if (notice !== undefined) {
    deps.err(notice);
  }

  const start = await resolveStartStep(deps, loaded ?? { version: 2, targets: { webhook: true, git: false } });
  const { startStep } = start;
  let state = start.state;
  const save: SaveBootstrapState = async (patch) => {
    state = { ...state, ...patch };
    await saveBootstrapState(state, deps.statePath);
  };

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
