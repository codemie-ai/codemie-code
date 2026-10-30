/**
 * Raw-mode picker for `codemie models switch`.
 *
 * Built the same way profile/index.ts's promptProfileSelectionCustom is, on
 * top of the shared selection UI primitives — but renders model ids instead
 * of ProfileInfo rows, and is scoped to the active profile's own model list
 * (never the full provider catalog).
 */

import chalk from 'chalk';
import { buildSingleChoiceRow, buildTopLine } from './shared/selection/ui.js';
import { ANSI, KEY } from './shared/selection/constants.js';
import { COLOR } from './shared/constants.js';

/** The user left a switch prompt (Esc / Ctrl+C); nothing was changed. */
export class ModelSwitchCancelledError extends Error {
  constructor() {
    super('Model selection cancelled.');
    this.name = 'ModelSwitchCancelledError';
  }
}

export interface ModelSwitchSelectionUIOptions {
  message: string;
  models: string[];
  activeModel: string;
  cursorIndex: number;
  /** Per-model agents whose list holds it; omitted for legacy profiles (no annotation). */
  agentLabels?: Record<string, string[]>;
  /** Screen title; defaults to "Models". */
  title?: string;
  /** Row label per id (e.g. an agent display name); defaults to the id itself. */
  rowLabel?: (id: string) => string;
}

/** Dim " [claude, opencode]" suffix naming the agents a model belongs to. */
export function formatAgentsSuffix(agents: string[] | undefined): string {
  if (!agents) return '';
  return chalk.dim(` [${agents.length > 0 ? agents.join(', ') : 'none'}]`);
}

function buildModelSelectionRow(
  label: string,
  isActive: boolean,
  isCursor: boolean,
  agents?: string[]
): string {
  const displayName =
    (isActive ? chalk.green.bold(label) : chalk.white(label)) + formatAgentsSuffix(agents);

  return buildSingleChoiceRow({
    label: displayName,
    isCursor,
    isSelected: isActive,
    formatLabel: value => value,
    formatSelectedMarker: marker => chalk.green(marker),
    formatUnselectedMarker: marker => chalk.white(marker),
  });
}

export function renderModelSwitchSelectionUI({
  message,
  models,
  activeModel,
  cursorIndex,
  agentLabels,
  title = 'Models',
  rowLabel = id => id,
}: ModelSwitchSelectionUIOptions): string {
  let output = ANSI.CURSOR_HOME_CLEAR;

  output += buildTopLine();
  output += chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold(title) + '\n\n';
  output += chalk.dim(message) + '\n\n';

  models.forEach((modelId, index) => {
    output += buildModelSelectionRow(
      rowLabel(modelId),
      modelId === activeModel,
      index === cursorIndex,
      agentLabels?.[modelId]
    ) + '\n';
  });

  output += '\n';
  output += chalk.dim('↑↓ to Navigate • Enter to Confirm • Esc to Cancel\n');

  return output;
}

/**
 * Interactively pick one model from the active profile's own list (never the
 * full provider catalog — see `runModelsSwitch` in models.ts).
 */
export async function promptModelSwitchSelection(
  models: string[],
  activeModel: string,
  agentLabels?: Record<string, string[]>,
  message = 'Select a model to switch to:'
): Promise<string> {
  return promptRawSingleChoice({ message, models, activeModel, agentLabels });
}

/**
 * Pick which agent's active model `codemie models switch` changes, on a profile set up per
 * agent. Each row shows the agent's display name and its current active model.
 */
export async function promptAgentSwitchSelection(
  agents: Array<{ name: string; displayName: string; model: string }>
): Promise<string> {
  const byName = new Map(agents.map(agent => [agent.name, agent]));
  return promptRawSingleChoice({
    title: 'Agents',
    message: 'Select the agent whose active model to switch:',
    models: agents.map(agent => agent.name),
    activeModel: '',
    rowLabel: name => {
      const agent = byName.get(name);
      return agent ? `${agent.displayName} ${chalk.dim(`(active: ${agent.model})`)}` : name;
    },
  });
}

function promptRawSingleChoice(options: Omit<ModelSwitchSelectionUIOptions, 'cursorIndex'>): Promise<string> {
  const { models, activeModel } = options;
  let cursorIndex = Math.max(0, models.findIndex(id => id === activeModel));

  function render(): void {
    process.stdout.write(renderModelSwitchSelectionUI({ ...options, cursorIndex }));
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

    process.stdin.resume();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (key: string) => {
      switch (key) {
        case KEY.ARROW_UP:
          cursorIndex = Math.max(0, cursorIndex - 1);
          render();
          break;
        case KEY.ARROW_DOWN:
          cursorIndex = Math.min(models.length - 1, cursorIndex + 1);
          render();
          break;
        case KEY.ENTER:
        case KEY.NEWLINE:
          cleanup();
          resolve(models[cursorIndex]);
          break;
        case KEY.ESC:
        case KEY.CTRL_C:
          cleanup();
          reject(new ModelSwitchCancelledError());
          break;
        default:
          break;
      }
    });

    keepAliveTimer = setInterval(() => {}, 1000);
    render();
  });
}
