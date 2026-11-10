/**
 * Raw-mode picker for `codemie models switch`.
 *
 * Works like the other selection prompts (e.g. the agent-target picker): Space
 * pre-selects the row under the cursor, Enter confirms the pre-selected row, and
 * Continue / Cancel buttons close the screen. Scoped to the list it is given
 * (never the full provider catalog).
 */

import chalk from 'chalk';
import { buildButtons, buildSingleChoiceRow, buildTopLine } from './shared/selection/ui.js';
import { ANSI, KEY, SHARED_TEXT } from './shared/selection/constants.js';
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
  /** Pre-selected id (marked with ●); defaults to the active model. */
  selectedModel?: string;
  /** True while the Continue / Cancel buttons hold the focus instead of the rows. */
  buttonsFocused?: boolean;
  focusedButton?: 'continue' | 'cancel';
  /** Validation message shown under the rows. */
  error?: string;
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
  isSelected: boolean,
  isCursor: boolean,
  agents?: string[]
): string {
  const displayName =
    (isActive ? chalk.green.bold(label) : chalk.white(label)) + formatAgentsSuffix(agents);

  return buildSingleChoiceRow({
    label: displayName,
    isCursor,
    isSelected,
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
  selectedModel = activeModel,
  buttonsFocused = false,
  focusedButton = 'continue',
  error,
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
      modelId === selectedModel,
      !buttonsFocused && index === cursorIndex,
      agentLabels?.[modelId]
    ) + '\n';
  });

  if (error) {
    output += '\n' + chalk.red(error) + '\n';
  }

  output += '\n';
  output += buildButtons({
    areNavigationButtonsFocused: buttonsFocused,
    focusedButton,
    isSearchFocused: false,
    isPaginationFocused: null,
  });
  output += chalk.dim(SHARED_TEXT.INSTRUCTIONS_SINGLE_CHOICE + '\n');

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

interface SingleChoiceState {
  cursorIndex: number;
  selectedModel?: string;
  buttonsFocused: boolean;
  focusedButton: 'continue' | 'cancel';
  error?: string;
}

export type SingleChoiceOutcome =
  | { type: 'render' }
  | { type: 'none' }
  | { type: 'confirm'; model: string }
  | { type: 'cancel' };

/**
 * Applies one key to the picker state. Space pre-selects the row under the cursor; Enter
 * confirms the pre-selected row (or cancels when the Cancel button is focused).
 */
export function applySingleChoiceKey(
  state: SingleChoiceState,
  models: string[],
  key: string
): SingleChoiceOutcome {
  state.error = undefined;

  switch (key) {
    case KEY.CTRL_C:
    case KEY.ESC:
      return { type: 'cancel' };
    case KEY.ARROW_UP:
      if (state.buttonsFocused) {
        state.buttonsFocused = false;
      } else {
        state.cursorIndex = Math.max(0, state.cursorIndex - 1);
      }
      return { type: 'render' };
    case KEY.ARROW_DOWN:
      if (!state.buttonsFocused && state.cursorIndex === models.length - 1) {
        state.buttonsFocused = true;
        state.focusedButton = 'continue';
      } else if (!state.buttonsFocused) {
        state.cursorIndex = Math.min(models.length - 1, state.cursorIndex + 1);
      }
      return { type: 'render' };
    case KEY.ARROW_LEFT:
    case KEY.ARROW_RIGHT:
      if (!state.buttonsFocused) return { type: 'none' };
      state.focusedButton = state.focusedButton === 'continue' ? 'cancel' : 'continue';
      return { type: 'render' };
    case KEY.SPACE:
      if (state.buttonsFocused) return { type: 'none' };
      state.selectedModel = models[state.cursorIndex];
      return { type: 'render' };
    case KEY.ENTER:
    case KEY.NEWLINE:
      if (state.buttonsFocused && state.focusedButton === 'cancel') {
        return { type: 'cancel' };
      }
      if (!state.selectedModel) {
        state.error = 'Press Space to select an item, then Enter to confirm.';
        return { type: 'render' };
      }
      return { type: 'confirm', model: state.selectedModel };
    default:
      return { type: 'none' };
  }
}

function promptRawSingleChoice(
  options: Omit<ModelSwitchSelectionUIOptions, 'cursorIndex' | 'selectedModel' | 'buttonsFocused' | 'focusedButton' | 'error'>
): Promise<string> {
  const { models, activeModel } = options;
  const activeIndex = models.findIndex(id => id === activeModel);
  const state: SingleChoiceState = {
    cursorIndex: Math.max(0, activeIndex),
    selectedModel: activeIndex >= 0 ? activeModel : undefined,
    buttonsFocused: false,
    focusedButton: 'continue',
  };

  function render(): void {
    process.stdout.write(renderModelSwitchSelectionUI({ ...options, ...state }));
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
      const outcome = applySingleChoiceKey(state, models, key);
      if (outcome.type === 'render') {
        render();
      } else if (outcome.type === 'confirm') {
        cleanup();
        resolve(outcome.model);
      } else if (outcome.type === 'cancel') {
        cleanup();
        reject(new ModelSwitchCancelledError());
      }
    });

    keepAliveTimer = setInterval(() => {}, 1000);
    render();
  });
}
