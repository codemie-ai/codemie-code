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
import { runStepsFiveThroughEight } from './guided-late-steps.js';
import { askValidated } from './guided-support.js';
import type { SaveBootstrapState } from './guided-support.js';
import { BootstrapInputError, cleanPaste, parseChannelLink, parseFolderUrl, validateFolderPath, validateSiteUrl } from './links.js';
import type { ChannelLink, FolderLink } from './links.js';
import { checkReuse, loadBootstrapState, saveBootstrapState, summarizeState } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading, stepsFor } from './step-model.js';
import type { StepDescriptor, TargetSelection } from './step-model.js';
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
 * The "Delivery target" step, asked only on a fresh run (a saved run already has
 * `targets`). Its heading's "of M" depends on the answer itself — the filtered list is not
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

/** Where `runGuided` starts: the id of the first step to run, and the state to run it on. */
interface StartPoint {
  startId: string;
  state: BootstrapState;
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

/** Whether the lead wants to reuse the saved settings just summarized. Kept as its own call
 * so the choice can grow beyond yes/no without touching {@link resolveStartStep}. */
async function askReuse(deps: BootstrapDeps): Promise<boolean> {
  return deps.prompt.confirm('Reuse them?', true);
}

/**
 * The start logic (spec.md "Start logic"):
 * - Nothing saved: {@link resolveFreshStart}.
 * - A saved state (whichever targets it has) shows a masked summary and offers reuse.
 *   Accepting re-checks it with `checkReuse`: ok jumps straight to the Developers step; not
 *   ok resumes at `resumeAt`. Declining restarts at the filtered list's first step after the
 *   target choice — the saved `targets` are kept, never re-asked — with the saved answers
 *   offered back. Either way, {@link discardStaleAnswers} drops what the re-run makes stale.
 */
async function resolveStartStep(deps: BootstrapDeps, loaded: BootstrapState | null): Promise<StartPoint> {
  if (loaded === null) {
    return resolveFreshStart(deps);
  }

  deps.err('Saved settings from an earlier run:');
  for (const line of summarizeState(loaded)) {
    deps.err(`  ${line}`);
  }

  let startId = stepsFor(loaded.targets)[1].id;
  if (await askReuse(deps)) {
    const check = checkReuse(loaded);
    if (check.ok) {
      return { startId: 'developers', state: loaded };
    }
    startId = check.resumeAt;
  }
  return { startId, state: await discardStaleAnswers(loaded, startId, deps.statePath) };
}

/**
 * The guided wizard: {@link resolveStartStep}, then the webhook setup steps (Teams channel,
 * SharePoint folder, Time zone, Import the flow) that are in the filtered list at or after
 * the start step, then the rest via {@link runStepsFiveThroughEight}.
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
  const runs = (id: string): boolean => isAtOrAfter(shown, from, id);

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

  return runStepsFiveThroughEight(deps, state, save, shown.slice(from));
}
