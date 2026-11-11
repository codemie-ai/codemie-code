/**
 * The guided wizard's start logic (spec.md "Start logic"): the delivery target choice and
 * where `runGuided` (`./guided.ts`) starts — a fresh run, Reuse, Change targets or Start over
 * on a saved setup. Split out of `./guided.ts` to keep that module under the size limit.
 *
 * Never imports `./guided.ts` or `./run-bootstrap.ts` (`./guided.ts` imports this module).
 */

import { testGitCheck } from './git-step.js';
import { testSendLoop } from './guided-late-steps.js';
import { checkReuse, saveBootstrapState, summarizeState } from './state-store.js';
import type { BootstrapState } from './state-store.js';
import { stepHeading, stepsFor } from './step-model.js';
import type { StepDescriptor, TargetKind, TargetSelection } from './step-model.js';
import type { BootstrapDeps } from './types.js';

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

/** Where `runGuided` starts: the id of the first step to run, and the state to run it on.
 * `onlyTarget`, set by "Change targets" when it adds a target, limits the run to that
 * target's own steps (then Developers): the other target's and the shared steps' saved
 * answers are kept as they are. */
export interface StartPoint {
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
  // Saved right away, so an interrupt after the target choice resumes with it (AC23).
  await saveBootstrapState(state, deps.statePath);

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
export async function resolveStartStep(deps: BootstrapDeps, loaded: BootstrapState | null): Promise<StartPoint> {
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
