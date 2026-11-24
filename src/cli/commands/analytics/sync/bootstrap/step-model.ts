/**
 * Target-tagged step-descriptor model for `codemie analytics sync bootstrap`.
 *
 * Filters the step sequence based on delivery target selection (webhook, git, or both).
 * Provides step headings in "Step N of M · <title>" format.
 */

/**
 * Delivery target: webhook (Teams/SharePoint), git (GitHub), or both.
 */
export type TargetKind = 'webhook' | 'git';

/**
 * User's selection of which delivery targets to configure.
 */
export interface TargetSelection {
  webhook: boolean;
  git: boolean;
}

/**
 * One step in the bootstrap sequence, optionally filtered by target.
 */
export interface StepDescriptor {
  /**
   * Unique step identifier (e.g., 'target', 'channel', 'git-repo').
   */
  id: string;

  /**
   * Human-readable step title (e.g., 'Delivery target', 'Teams channel').
   */
  title: string;

  /**
   * Targets this step applies to: specific kinds (e.g. ['webhook']),
   * or 'always' for steps that run regardless of target selection.
   */
  targets: TargetKind[] | 'always';
}

/**
 * All 10 bootstrap steps in order.
 *
 * First 5 are webhook-only (target, channel, folder, timezone, flow, trigger-url),
 * next is git-only (git-repo), remaining are always-shown (external, lookback, developers).
 */
export const ALL_STEPS: StepDescriptor[] = [
  {
    id: 'target',
    title: 'Delivery target',
    targets: ['webhook', 'git'],
  },
  {
    id: 'channel',
    title: 'Teams channel',
    targets: ['webhook'],
  },
  {
    id: 'folder',
    title: 'SharePoint folder',
    targets: ['webhook'],
  },
  {
    id: 'timezone',
    title: 'Time zone',
    targets: ['webhook'],
  },
  {
    id: 'flow',
    title: 'Import the flow',
    targets: ['webhook'],
  },
  {
    id: 'trigger-url',
    title: 'Trigger URL',
    targets: ['webhook'],
  },
  {
    id: 'git-repo',
    title: 'Git repository',
    targets: ['git'],
  },
  {
    id: 'external',
    title: 'External sessions',
    targets: 'always',
  },
  {
    id: 'lookback',
    title: 'Lookback',
    targets: 'always',
  },
  {
    id: 'developers',
    title: 'Developers',
    targets: 'always',
  },
];

/**
 * Filter ALL_STEPS by target selection, preserving order.
 *
 * Includes:
 * - 'webhook' steps if selection.webhook is true
 * - 'git' steps if selection.git is true
 * - 'always' steps regardless of selection
 *
 * @param selection User's webhook and git target choices
 * @returns Filtered list of steps in order
 */
export function stepsFor(selection: TargetSelection): StepDescriptor[] {
  return ALL_STEPS.filter((step) => {
    if (step.targets === 'always') {
      return true;
    }

    // step.targets is TargetKind[]
    if (step.targets.includes('webhook') && selection.webhook) {
      return true;
    }

    if (step.targets.includes('git') && selection.git) {
      return true;
    }

    return false;
  });
}

/**
 * Produce a step heading in "Step N of M · <title>" format.
 *
 * Callers pass the filtered step list (from stepsFor()) and a step id
 * to locate its 1-based position and title.
 *
 * @param steps Filtered step list
 * @param id Step id to find
 * @returns Heading string or error if id not found
 */
export function stepHeading(steps: StepDescriptor[], id: string): string {
  const index = steps.findIndex((s) => s.id === id);

  if (index === -1) {
    throw new Error(`Step id '${id}' not found in steps list`);
  }

  const position = index + 1; // 1-based
  const total = steps.length;
  const title = steps[index].title;

  return `Step ${position} of ${total} · ${title}`;
}
