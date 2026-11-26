/**
 * The running of a mode's install plan for `runInstall`: the plan's steps applied in order and concluded, and the
 * undo of the applied steps, last first, when the install fails after them.
 */
import type { InstallPlan, InstallStep, StepOutcome } from '../../shared/analytics-collection/types.js';
import { errorMessage, redactSecrets } from './redact.js';
import type { SyncSettings } from './types.js';

interface PlanDeps {
  plan: InstallPlan;
  print(line: string): void;
}

/** Prints `Install failed: <message>` for `err`. */
export function printFailure(deps: Pick<PlanDeps, 'print'>, err: unknown): void {
  deps.print(`Install failed: ${errorMessage(err)}`);
}

/**
 * Applies the plan's steps for `settings` in order, then concludes them. A step that throws, or a conclusion that
 * fails, is printed, the applied steps are undone and the answer is `null`; else the applied steps and the summary.
 */
export async function applyPlanSteps(
  deps: PlanDeps,
  settings: SyncSettings
): Promise<{ applied: InstallStep[]; summary: string[] } | null> {
  const applied: InstallStep[] = [];
  let conclusion: ReturnType<InstallPlan['conclude']>;
  try {
    const outcomes: StepOutcome[] = [];
    for (const step of deps.plan.steps(settings)) {
      outcomes.push(await step.apply());
      applied.push(step);
    }
    conclusion = deps.plan.conclude(outcomes);
  } catch (err) {
    printFailure(deps, err);
    await undoSteps(deps, applied);
    return null;
  }
  if (conclusion.failure !== undefined) {
    deps.print(redactSecrets(conclusion.failure));
    await undoSteps(deps, applied);
    return null;
  }
  return { applied, summary: conclusion.summary };
}

/** Undoes the applied plan steps, last first; an undo that fails is reported and the rest still run. */
export async function undoSteps(deps: Pick<PlanDeps, 'print'>, applied: InstallStep[]): Promise<void> {
  for (const step of [...applied].reverse()) {
    try {
      await step.undo();
    } catch (err) {
      deps.print(`Could not undo "${step.name}": ${errorMessage(err)}`);
    }
  }
}
