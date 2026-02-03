/**
 * Confirmation Prompt Module
 *
 * Handles simple Update/Cancel confirmation after selection
 */

import inquirer from 'inquirer';
import type { ActionType } from '@/cli/commands/assistants/constants.js';
import { MESSAGES, ACTIONS } from '@/cli/commands/assistants/constants.js';

/**
 * Prompt user for confirmation (Update/Cancel)
 */
export async function promptConfirmation(): Promise<{ action: ActionType }> {
  const { action } = await inquirer.prompt([
    {
      type: 'list',
      name: 'action',
      message: MESSAGES.SETUP.PROMPT_ACTION,
      choices: [
        { name: MESSAGES.SETUP.ACTION_UPDATE, value: ACTIONS.UPDATE },
        { name: MESSAGES.SETUP.ACTION_CANCEL, value: ACTIONS.CANCEL }
      ]
    }
  ]);

  return { action };
}
