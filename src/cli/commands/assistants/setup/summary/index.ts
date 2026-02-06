/**
 * Summary Display Functions
 *
 * Functions for displaying registration summaries and currently registered assistants
 */

import chalk from 'chalk';
import type { Assistant } from 'codemie-sdk';
import type { CodemieAssistant, ProviderProfile } from '@/env/types.js';
import { MESSAGES } from '@/cli/commands/assistants/constants.js';
import { REGISTRATION_MODE } from '@/cli/commands/assistants/setup/manualConfiguration/constants.js';
import { COLOR } from '../constants.js';

/**
 * Display summary of changes
 */
export function displaySummary(
  toRegister: Assistant[],
  toUnregister: CodemieAssistant[],
  profileName: string,
  config: ProviderProfile
): void {
  const totalChanges = toRegister.length + toUnregister.length;
  console.log(chalk.green(MESSAGES.SETUP.SUMMARY_UPDATED(totalChanges)));
  console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_PROFILE(profileName)));

  displayCurrentlyRegistered(config);
}

/**
 * Display currently registered assistants
 */
export function displayCurrentlyRegistered(config: ProviderProfile): void {
  if (!config.codemieAssistants || config.codemieAssistants.length === 0) {
    return;
  }

  const purpleColor = chalk.rgb(COLOR.PURPLE.r, COLOR.PURPLE.g, COLOR.PURPLE.b);
  const purpleLine = purpleColor('─'.repeat(60));

  console.log('');
  console.log(purpleLine);
  console.log(chalk.bold('Registered assistants:'));
  console.log('');

  config.codemieAssistants.forEach((assistant: CodemieAssistant) => {
    const mode = assistant.registrationMode || REGISTRATION_MODE.AGENT;

    // Build location info based on registration mode
    let locationInfo = '';
    if (mode === REGISTRATION_MODE.AGENT) {
      locationInfo = chalk.dim(` (@${assistant.slug} in code or claude)`);
    } else if (mode === REGISTRATION_MODE.SKILL) {
      locationInfo = chalk.dim(` (/${assistant.slug} in claude or @${assistant.slug} in code)`);
    }

    console.log(`  • ${purpleColor(assistant.slug)} - ${assistant.name}${locationInfo}`);
  });

  console.log('');
  console.log(purpleLine);
  console.log('');
}
