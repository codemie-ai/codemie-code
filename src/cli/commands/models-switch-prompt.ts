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

export interface ModelSwitchSelectionUIOptions {
  message: string;
  models: string[];
  activeModel: string;
  cursorIndex: number;
  /** Per-model harnesses it works with; omitted for legacy profiles (no annotation). */
  harnessLabels?: Record<string, string[]>;
}

export function formatHarnessSuffix(harnesses: string[] | undefined): string {
  if (!harnesses) return '';
  return chalk.dim(` [${harnesses.length > 0 ? harnesses.join(', ') : 'none'}]`);
}

function buildModelSelectionRow(
  modelId: string,
  activeModel: string,
  isCursor: boolean,
  harnesses?: string[]
): string {
  const isActive = modelId === activeModel;
  const displayName =
    (isActive ? chalk.green.bold(modelId) : chalk.white(modelId)) + formatHarnessSuffix(harnesses);

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
  harnessLabels,
}: ModelSwitchSelectionUIOptions): string {
  let output = ANSI.CURSOR_HOME_CLEAR;

  output += buildTopLine();
  output += chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b).bold('Models') + '\n\n';
  output += chalk.dim(message) + '\n\n';

  models.forEach((modelId, index) => {
    output += buildModelSelectionRow(modelId, activeModel, index === cursorIndex, harnessLabels?.[modelId]) + '\n';
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
  harnessLabels?: Record<string, string[]>
): Promise<string> {
  const message = 'Select a model to switch to:';
  let cursorIndex = Math.max(0, models.findIndex(id => id === activeModel));
  if (cursorIndex < 0) {
    cursorIndex = 0;
  }

  function render(): void {
    process.stdout.write(renderModelSwitchSelectionUI({ message, models, activeModel, cursorIndex, harnessLabels }));
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
          reject(new Error('Model selection cancelled.'));
          break;
        default:
          break;
      }
    });

    keepAliveTimer = setInterval(() => {}, 1000);
    render();
  });
}
