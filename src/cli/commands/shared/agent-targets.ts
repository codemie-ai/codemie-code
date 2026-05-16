import { ConfigurationError } from '@/utils/errors.js';
import { AgentRegistry } from '@/agents/registry.js';
import chalk from 'chalk';
import { COLOR } from '@/cli/commands/shared/constants.js';
import { buildTopLine, buildButtons, buildSelectionRow } from '@/cli/commands/shared/selection/ui.js';
import { ANSI, KEY } from '@/cli/commands/shared/selection/constants.js';
import type { BaseSelectionState } from '@/cli/commands/shared/selection/types.js';

export type TargetAgent = 'claude' | 'codex' | 'gemini';
export type AgentSetupTarget = TargetAgent[];

const SUPPORTED_TARGETS: readonly TargetAgent[] = ['claude', 'codex', 'gemini'];
const VALID_TARGETS = new Set<TargetAgent>(SUPPORTED_TARGETS);

const TARGET_LABELS: Record<TargetAgent, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
};

const TARGET_INVOCATION_PREFIXES: Record<TargetAgent, string> = {
  claude: '@',
  codex: '$',
  gemini: '@',
};

export async function resolveAgentSetupTargets(
  value: string | string[] | undefined,
  hostAgent?: TargetAgent
): Promise<AgentSetupTarget> {
  if (value !== undefined) {
    return parseAgentSetupTarget(value);
  }

  if (hostAgent) {
    return [hostAgent];
  }

  const detectedTargets = await detectInstalledTargets();

  if (detectedTargets.length === 0) {
    throw new ConfigurationError(
      'No supported agent is installed. Install at least one of: claude, codex, gemini.'
    );
  }

  if (detectedTargets.length === 1) {
    return detectedTargets;
  }

  return promptAgentTargetSelection(detectedTargets);
}

export function parseAgentSetupTarget(value: string | string[]): AgentSetupTarget {
  const rawValues = Array.isArray(value) ? value : [value];
  const normalized = rawValues
    .flatMap(item => item.split(','))
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);

  if (normalized.length === 0) {
    throw new ConfigurationError('At least one agent target is required.');
  }

  const targets: TargetAgent[] = [];

  for (const item of normalized) {
    if (!VALID_TARGETS.has(item as TargetAgent)) {
      throw new ConfigurationError(
        `Invalid agent target "${item}". Expected one or more of: ${SUPPORTED_TARGETS.join(', ')}.`
      );
    }

    const target = item as TargetAgent;
    if (!targets.includes(target)) {
      targets.push(target);
    }
  }

  return targets;
}

export function targetsClaude(target: AgentSetupTarget): boolean {
  return target.includes('claude');
}

export function targetsCodex(target: AgentSetupTarget): boolean {
  return target.includes('codex');
}

export function targetsGemini(target: AgentSetupTarget): boolean {
  return target.includes('gemini');
}

export function formatAgentSetupTarget(target: AgentSetupTarget): string {
  if (target.length === 1) {
    return TARGET_LABELS[target[0]];
  }

  const labels = target.map(item => TARGET_LABELS[item]);
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

export function formatAgentInvocation(slug: string, target: TargetAgent): string {
  return `${TARGET_INVOCATION_PREFIXES[target]}${slug} in ${TARGET_LABELS[target]}`;
}

async function detectInstalledTargets(): Promise<TargetAgent[]> {
  const results = await Promise.all(
    SUPPORTED_TARGETS.map(async (target) => {
      const adapter = AgentRegistry.getAgent(target);
      if (!adapter) {
        return null;
      }

      try {
        return await adapter.isInstalled() ? target : null;
      } catch {
        return null;
      }
    })
  );

  return results.filter((target): target is TargetAgent => target !== null);
}

async function promptAgentTargetSelection(targets: TargetAgent[]): Promise<TargetAgent[]> {
  const selected = new Set<TargetAgent>(targets);
  let cursorIndex = 0;
  let buttonsFocused = false;
  let focusedButton: 'continue' | 'cancel' = 'continue';
  let validationError: string | null = null;

  const stateForButtons = (): Pick<BaseSelectionState, 'areNavigationButtonsFocused' | 'focusedButton' | 'isSearchFocused' | 'isPaginationFocused'> => ({
    areNavigationButtonsFocused: buttonsFocused,
    focusedButton,
    isSearchFocused: false,
    isPaginationFocused: null,
  });

  function render(): void {
    let output = ANSI.CURSOR_HOME_CLEAR;
    output += buildTopLine();
    output += chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold('Target Agents') + '\n\n';
    output += chalk.dim('Select one or more agents for setup.\n\n');

    targets.forEach((target, index) => {
      const isCursor = !buttonsFocused && index === cursorIndex;
      output += buildSelectionRow({
        label: TARGET_LABELS[target],
        isCursor,
        isSelected: selected.has(target),
      }) + '\n';
    });

    if (validationError) {
      output += '\n' + chalk.red(validationError) + '\n';
    }

    output += '\n';
    output += buildButtons(stateForButtons());
    output += chalk.dim('↑↓ to Navigate • Space to select item • Enter to Confirm\n');

    process.stdout.write(output);
  }

  return new Promise((resolve, reject) => {
    let keepAliveTimer: NodeJS.Timeout | null = null;

    function cleanup(): void {
      if (keepAliveTimer) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = null;
      }

      process.stdin.removeAllListeners('data');
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
      }
      process.stdin.pause();
      process.stdout.write(ANSI.CURSOR_HOME_CLEAR);
    }

    function confirm(): void {
      if (buttonsFocused && focusedButton === 'cancel') {
        cleanup();
        reject(new ConfigurationError('Agent target selection cancelled.'));
        return;
      }

      if (selected.size === 0) {
        validationError = 'Select at least one agent.';
        render();
        return;
      }

      cleanup();
      resolve(targets.filter(target => selected.has(target)));
    }

    function cancel(): void {
      cleanup();
      reject(new ConfigurationError('Agent target selection cancelled.'));
    }

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      validationError = null;

      switch (key) {
        case KEY.ARROW_UP:
          if (buttonsFocused) {
            buttonsFocused = false;
          } else {
            cursorIndex = Math.max(0, cursorIndex - 1);
          }
          render();
          break;
        case KEY.ARROW_DOWN:
          if (!buttonsFocused && cursorIndex === targets.length - 1) {
            buttonsFocused = true;
            focusedButton = 'continue';
          } else if (!buttonsFocused) {
            cursorIndex = Math.min(targets.length - 1, cursorIndex + 1);
          }
          render();
          break;
        case KEY.ARROW_LEFT:
        case KEY.ARROW_RIGHT:
          if (buttonsFocused) {
            focusedButton = focusedButton === 'continue' ? 'cancel' : 'continue';
            render();
          }
          break;
        case KEY.SPACE: {
          if (buttonsFocused) {
            render();
            break;
          }
          const target = targets[cursorIndex];
          if (selected.has(target)) {
            selected.delete(target);
          } else {
            selected.add(target);
          }
          render();
          break;
        }
        case KEY.ENTER:
        case KEY.NEWLINE:
          confirm();
          break;
        case KEY.ESC:
        case KEY.CTRL_C:
          cancel();
          break;
        default:
          break;
      }
    });

    keepAliveTimer = setInterval(() => {}, 1000);
    render();
  });
}
