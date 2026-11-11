/**
 * `codemie analytics sync bootstrap`'s guided mode (a TTY, no `--webhook` given): the start
 * logic, the delivery target choice and the webhook setup steps (Teams channel, SharePoint
 * folder, time zone, import the flow). The late steps (trigger URL and test send, git
 * repository and test push, external sessions, lookback, developers) live in
 * `./guided-late-steps.ts`, run from {@link runStepsFiveThroughEight}.
 *
 * Which steps run, in what order and how they are numbered ("Step N of M") comes from the
 * filtered step list `stepsFor(state.targets)` (`./step-model.ts`): every step is addressed
 * by its id, never by a fixed number.
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
 * the Developers step is the one exception, printing the install command itself to `deps.out`.
 */

import { errorMessage } from '../redact.js';
import { FLOW_PACKAGE_FILENAME, resolveFlowTemplateDir, writeFlowPackage } from './flow-package.js';
import { testGitCheck } from './git-step.js';
import { runStepsFiveThroughEight, testSendLoop } from './guided-late-steps.js';
import { askValidated } from './guided-support.js';
import type { SaveBootstrapState } from './guided-support.js';
import { BootstrapInputError, cleanPaste, parseChannelLink, parseFolderUrl, validateFolderPath, validateSiteUrl } from './links.js';
import type { ChannelLink, FolderLink } from './links.js';
import { checkReuse, loadBootstrapState, saveBootstrapState, summarizeState } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading, stepsFor } from './step-model.js';
import type { StepDescriptor, TargetKind, TargetSelection } from './step-model.js';
import { DEFAULT_TIME_ZONE, resolveTimeZone } from './timezones.js';
import type { BootstrapDeps, BootstrapPrompter } from './types.js';

// Re-exported so callers can keep importing the prompter's own interface from here without
// reaching into `./types.js` directly.
export type { BootstrapPrompter };

const POWER_AUTOMATE_URL = 'https://make.powerautomate.com/';
const MANUAL = 'manual';

/** The delivery target choices, in menu order. */
type TargetChoice = 'webhook' | 'git' | 'both';
const TARGET_CHOICES: { value: TargetChoice; name: string }[] = [
  { value: 'webhook', name: 'Teams webhook: a Power Automate flow files reports in SharePoint and posts to Teams' },
  { value: 'git', name: 'Git repository: developer machines push reports to a repository' },
  { value: 'both', name: 'Both' }
];

/**
 * The "Delivery target" step, asked on a fresh run and on a saved run's "Change targets".
 * Its heading's "of M" depends on the answer itself — the filtered list is not
 * known until the lead picks — so, unlike every other step, it asks first and prints its
 * heading afterwards, computed from the chosen selection, as a one-line confirmation.
 */
async function stepTarget(deps: BootstrapDeps): Promise<TargetSelection> {
  const choice = await deps.prompt.select(
    'Where should developer machines deliver their analytics reports?',
    TARGET_CHOICES,
    'webhook'
  );
  const targets: TargetSelection = { webhook: choice !== 'git', git: choice !== 'webhook' };

  deps.err('');
  deps.err(stepHeading(stepsFor(targets), 'target'));
  return targets;
}

/**
 * The "Teams channel" step: parses a "Get link to channel" link, retrying on a {@link
 * BootstrapInputError} (including a `/l/message/` link, spec.md AC4), then confirms the
 * parsed channel name before saving. The saved `channelLink` is offered as the next
 * prompt's default, so re-running after a decline-to-reuse restart is a quick re-confirm
 * rather than a fresh paste.
 */
async function step1Channel(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(stepsFor(state.targets), 'channel'));

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

/** The SharePoint folder step's paste prompt: the parsed folder, or {@link MANUAL} when the
 * lead typed "manual". Retries on a {@link BootstrapInputError}. */
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

/** The SharePoint folder step's manual entry: the site and the folder path asked separately, each defaulting to
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

/** The saved SharePoint folder answer, when both halves of it are present. */
function savedFolder(state: BootstrapState): FolderLink | undefined {
  if (state.siteUrl === undefined || state.folderPath === undefined) {
    return undefined;
  }
  return { siteUrl: state.siteUrl, folderPath: state.folderPath };
}

/**
 * The "SharePoint folder" step: with a saved folder, first offers to keep it (spec.md AC12,
 * "resumes with the earlier answers as defaults"). Otherwise parses the folder's browser
 * address, or — on typing "manual" or declining the confirm — asks for the site and the
 * folder path separately (spec.md AC5), with the saved ones as defaults.
 */
async function step2Folder(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(stepsFor(state.targets), 'folder'));

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

/** The "Time zone" step: a Windows time zone name, default {@link DEFAULT_TIME_ZONE},
 * retried on an unknown name (spec.md AC6). */
async function step3TimeZone(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(stepsFor(state.targets), 'timezone'));

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
 * The "Import the flow" step: writes {@link FLOW_PACKAGE_FILENAME} into `deps.cwd` (never
 * holding a webhook URL), prints a notice if that overwrote an existing file, prints the 6
 * import instructions, offers to open Power Automate in the browser — printing the bare
 * {@link POWER_AUTOMATE_URL} when `deps.openUrl` throws, so the lead always has it to copy
 * — and waits for confirmation that the flow is on and its URL copied before continuing.
 */
async function step4ImportFlow(deps: BootstrapDeps, state: BootstrapState, save: SaveBootstrapState): Promise<void> {
  deps.err('');
  deps.err(stepHeading(stepsFor(state.targets), 'flow'));

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

/** Where `runGuided` starts: the id of the first step to run, and the state to run it on.
 * `onlyTarget`, set by "Change targets" when it adds a target, limits the run to that
 * target's own steps (then Developers): the other target's and the shared steps' saved
 * answers are kept as they are. */
interface StartPoint {
  startId: string;
  state: BootstrapState;
  onlyTarget?: TargetKind;
}

/** Whether `id` is in `steps` at or after position `from` (a step absent from `steps` —
 * one for a target the lead did not choose — never is). */
function isAtOrAfter(steps: readonly StepDescriptor[], from: number, id: string): boolean {
  const index = steps.findIndex((step) => step.id === id);
  return index !== -1 && index >= from;
}

/**
 * Drops the answers that re-running the wizard from `startId` makes stale, and saves the
 * result when anything was dropped. Positions are taken in the filtered list
 * (`stepsFor(state.targets)`):
 * - Re-running the Trigger URL step or earlier drops the saved webhook and its test result:
 *   a flow re-imported at the Import the flow step has a new trigger URL, and quitting before
 *   the Trigger URL step must not leave the old one looking reusable.
 * - Re-running the Git repository step or earlier drops the saved git details and their test
 *   result, so a stale `gitTest: 'passed'` never sits next to new, untested details.
 * - Re-running the Import the flow step or earlier also drops `skippedSetup`.
 */
async function discardStaleAnswers(state: BootstrapState, startId: string, statePath: string): Promise<BootstrapState> {
  const steps = stepsFor(state.targets);
  const from = steps.findIndex((step) => step.id === startId);
  const dropWebhook = isAtOrAfter(steps, from, 'trigger-url');
  const dropGit = isAtOrAfter(steps, from, 'git-repo');
  const dropSkippedSetup = isAtOrAfter(steps, from, 'flow');
  if (!dropWebhook && !dropGit && !dropSkippedSetup) {
    return state;
  }

  const kept: BootstrapState = { ...state };
  if (dropWebhook) {
    delete kept.webhookUrl;
    delete kept.webhookTest;
  }
  if (dropGit) {
    delete kept.gitRepoUrl;
    delete kept.gitBranch;
    delete kept.gitPath;
    delete kept.gitTest;
  }
  if (dropSkippedSetup) {
    delete kept.skippedSetup;
  }
  await saveBootstrapState(kept, statePath);
  return kept;
}

/**
 * A fresh run (nothing saved): the "Delivery target" step first, then — only when the webhook
 * target is included — "Have you already imported the flow and copied its trigger URL?"
 * (default no). No starts at the filtered list's first step after the target choice. Yes
 * jumps to the Trigger URL step and saves `skippedSetup`, so a later run can reuse the state
 * without the webhook setup steps' answers. A git-only run has no flow to ask about and
 * starts at the Git repository step.
 */
async function resolveFreshStart(deps: BootstrapDeps): Promise<StartPoint> {
  const targets = await stepTarget(deps);
  const state: BootstrapState = { version: 2, targets };
  const firstStepId = stepsFor(targets)[1].id;

  if (!targets.webhook) {
    return { startId: firstStepId, state };
  }

  const alreadyImported = await deps.prompt.confirm(
    'Have you already imported the flow and copied its trigger URL?',
    false
  );
  if (!alreadyImported) {
    return { startId: firstStepId, state };
  }
  const skipped: BootstrapState = { ...state, skippedSetup: true };
  await saveBootstrapState(skipped, deps.statePath);
  return { startId: 'trigger-url', state: skipped };
}

/** What to do with a saved setup, in menu order. */
type SavedSetupChoice = 'reuse' | 'change' | 'restart';
const SAVED_SETUP_CHOICES: { value: SavedSetupChoice; name: string }[] = [
  { value: 'reuse', name: 'Reuse them: re-check each delivery target, then print the install command' },
  { value: 'change', name: 'Change targets: keep these answers, add or turn off a delivery target' },
  { value: 'restart', name: 'Start over: go through the steps again, with these answers as defaults' }
];

/** The resume point for re-running from `startId`, after {@link discardStaleAnswers}. */
async function resumeAt(deps: BootstrapDeps, state: BootstrapState, startId: string): Promise<StartPoint> {
  return { startId, state: await discardStaleAnswers(state, startId, deps.statePath) };
}

/**
 * "Reuse": `checkReuse` first (presence plus the saved values' own rules, including
 * `install`'s git URL rule); not ok resumes at its `resumeAt`. Ok then re-checks every chosen
 * target live — the webhook via {@link testSendLoop}, then git via {@link testGitCheck} —
 * saving each passed/skipped outcome, so the install command is printed only once every
 * check has passed or been skipped (D12). "Enter a different URL" resumes at the Trigger URL
 * step; "Enter different repository details" at the Git repository step. A target that is
 * off is never re-checked.
 */
async function resolveReuse(deps: BootstrapDeps, loaded: BootstrapState): Promise<StartPoint> {
  const check = checkReuse(loaded);
  if (!check.ok) {
    return resumeAt(deps, loaded, check.resumeAt);
  }

  let state = loaded;
  if (state.targets.webhook && state.webhookUrl !== undefined) {
    const outcome = await testSendLoop(deps, state.webhookUrl);
    if (outcome === 'retry-url') {
      return resumeAt(deps, state, 'trigger-url');
    }
    state = { ...state, webhookTest: outcome };
    await saveBootstrapState(state, deps.statePath);
  }
  if (state.targets.git && state.gitRepoUrl !== undefined) {
    const git = {
      repoUrl: state.gitRepoUrl,
      ...(state.gitBranch !== undefined && { branch: state.gitBranch }),
      ...(state.gitPath !== undefined && { path: state.gitPath })
    };
    const outcome = await testGitCheck(deps, git, undefined);
    if (outcome === 'retry') {
      return resumeAt(deps, state, 'git-repo');
    }
    state = { ...state, gitTest: outcome };
    await saveBootstrapState(state, deps.statePath);
  }
  return { startId: 'developers', state };
}

/** The first step of `kind`'s own steps in `steps`. */
function firstStepOf(steps: readonly StepDescriptor[], kind: TargetKind): string | undefined {
  return steps.find((step) => step.targets !== 'always' && step.targets.includes(kind))?.id;
}

/**
 * "Change targets" (D3; AC18-AC20): re-asks the target choice and saves the new selection,
 * keeping every saved field — an off target's included, for a later re-enable. Turning a
 * target off only drops it from printing and from Reuse checks.
 *
 * The targets kept from before are re-checked with `checkReuse` (no live check), so a saved
 * value that no longer validates — a credential-bearing git URL above all — never reaches
 * the print; that resumes at the earlier of its `resumeAt` and the added target's first step.
 * Otherwise a newly added target runs only its own steps (`onlyTarget`), and a pure removal
 * goes straight to the Developers step.
 */
async function resolveChangeTargets(deps: BootstrapDeps, loaded: BootstrapState): Promise<StartPoint> {
  const targets = await stepTarget(deps);
  const changed: BootstrapState = { ...loaded, targets };
  await saveBootstrapState(changed, deps.statePath);

  const steps = stepsFor(targets);
  const added: TargetKind | undefined =
    targets.webhook && !loaded.targets.webhook ? 'webhook' : targets.git && !loaded.targets.git ? 'git' : undefined;
  const addedStart = added === undefined ? undefined : firstStepOf(steps, added);

  const kept: TargetSelection = {
    webhook: loaded.targets.webhook && targets.webhook,
    git: loaded.targets.git && targets.git
  };
  const check = checkReuse({ ...changed, targets: kept });
  if (!check.ok) {
    const candidates = [check.resumeAt, addedStart].filter((id): id is string => id !== undefined);
    const startId = steps.find((step) => candidates.includes(step.id))?.id ?? check.resumeAt;
    return resumeAt(deps, changed, startId);
  }

  if (added !== undefined && addedStart !== undefined) {
    return { startId: addedStart, state: changed, onlyTarget: added };
  }
  return { startId: 'developers', state: changed };
}

/**
 * The start logic (spec.md "Start logic"):
 * - Nothing saved: {@link resolveFreshStart}.
 * - A saved state (whichever targets it has) shows a masked summary and offers Reuse /
 *   Change targets / Start over (AC15, AC21):
 *   - Reuse: {@link resolveReuse}.
 *   - Change targets: {@link resolveChangeTargets}.
 *   - Start over: restarts at the filtered list's first step after the target choice — the
 *     saved `targets` are kept, never re-asked — with the saved answers offered back, after
 *     {@link discardStaleAnswers} drops what the re-run makes stale.
 */
async function resolveStartStep(deps: BootstrapDeps, loaded: BootstrapState | null): Promise<StartPoint> {
  if (loaded === null) {
    return resolveFreshStart(deps);
  }

  deps.err('Saved settings from an earlier run:');
  for (const line of summarizeState(loaded)) {
    deps.err(`  ${line}`);
  }

  const choice = await deps.prompt.select('What would you like to do with them?', SAVED_SETUP_CHOICES, 'reuse');
  if (choice === 'reuse') {
    return resolveReuse(deps, loaded);
  }
  if (choice === 'change') {
    return resolveChangeTargets(deps, loaded);
  }
  return resumeAt(deps, loaded, stepsFor(loaded.targets)[1].id);
}

/**
 * The guided wizard: {@link resolveStartStep}, then the webhook setup steps (Teams channel,
 * SharePoint folder, Time zone, Import the flow) that are in the filtered list at or after
 * the start step (only the added target's own steps, then Developers, when the start point
 * carries `onlyTarget`), then the rest via {@link runStepsFiveThroughEight}.
 *
 * `resolveFlowTemplateDir()` is checked before any step runs whenever the Import the flow
 * step will run (it depends on the template), so a missing template directory fails fast
 * rather than after three steps of questions.
 *
 * State is saved after every step, via the `save` closure threaded through each step
 * function, so an interrupted run resumes with the earlier answers as defaults.
 */
export async function runGuided(deps: BootstrapDeps): Promise<number> {
  const { state: loaded, notice } = await loadBootstrapState(deps.statePath);
  if (notice !== undefined) {
    deps.err(notice);
  }

  const start = await resolveStartStep(deps, loaded);
  let state = start.state;
  const save: SaveBootstrapState = async (patch) => {
    state = { ...state, ...patch };
    await saveBootstrapState(state, deps.statePath);
  };

  const shown = stepsFor(state.targets);
  const from = shown.findIndex((step) => step.id === start.startId);
  const { onlyTarget } = start;
  const remaining = shown
    .slice(from)
    .filter(
      (step) =>
        onlyTarget === undefined ||
        step.id === 'developers' ||
        (step.targets !== 'always' && step.targets.includes(onlyTarget))
    );
  const runs = (id: string): boolean => remaining.some((step) => step.id === id);

  if (runs('flow')) {
    try {
      resolveFlowTemplateDir();
    } catch (err) {
      deps.err(errorMessage(err));
      return 1;
    }
  }

  if (runs('channel')) {
    await step1Channel(deps, state, save);
  }
  if (runs('folder')) {
    await step2Folder(deps, state, save);
  }
  if (runs('timezone')) {
    await step3TimeZone(deps, state, save);
  }
  if (runs('flow')) {
    await step4ImportFlow(deps, state, save);
  }

  return runStepsFiveThroughEight(deps, state, save, remaining);
}
