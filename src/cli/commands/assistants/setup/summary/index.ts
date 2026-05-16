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
import { formatAgentInvocation, type TargetAgent } from '@/cli/commands/shared/agent-targets.js';

/**
 * Display summary of changes
 */
export function displaySummary(
  toRegister: Assistant[],
  toUnregister: CodemieAssistant[],
  profileName: string,
  config: ProviderProfile,
  configLocation?: string
): void {
  const totalChanges = toRegister.length + toUnregister.length;
  console.log(chalk.green(MESSAGES.SETUP.SUMMARY_UPDATED(totalChanges)));
  console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_PROFILE(profileName)));
  if (configLocation) {
    console.log(chalk.dim(MESSAGES.SETUP.SUMMARY_CONFIG_LOCATION(configLocation)));
  }

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

    const targets: TargetAgent[] = assistant.agentTargets?.length
      ? assistant.agentTargets
      : mode === REGISTRATION_MODE.AGENT
        ? ['claude']
        : ['claude'];
    const locationInfo = chalk.dim(` (${formatInvocationList(assistant.slug, targets)})`);

    console.log(`  • ${purpleColor(assistant.slug)} - ${assistant.name}${locationInfo}`);
  });

  console.log('');
  console.log(purpleLine);
  console.log('');
}

function formatInvocationList(slug: string, targets: TargetAgent[]): string {
  const invocations = targets.map(target => formatAgentInvocation(slug, target));

  if (invocations.length === 1) {
    return invocations[0];
  }

  return `${invocations.slice(0, -1).join(', ')} or ${invocations[invocations.length - 1]}`;
}
