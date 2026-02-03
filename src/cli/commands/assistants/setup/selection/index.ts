/**
 * Selection UI Module
 *
 * Handles the main assistant selection prompt orchestration
 */

import type { Assistant, AssistantBase, CodeMieClient } from 'codemie-sdk';
import type { ActionType } from '@/cli/commands/assistants/constants.js';
import type { ProviderProfile } from '@/env/types.js';
import type { SetupCommandOptions } from '../index.js';
import { TabbedSelectionOrchestrator } from './tabbed-orchestrator.js';

/**
 * Prompt user to select assistants with tabbed interface
 */
export async function promptAssistantSelection(
  initialAssistants: (Assistant | AssistantBase)[],
  registeredIds: Set<string>,
  config: ProviderProfile,
  options: SetupCommandOptions,
  client: CodeMieClient
): Promise<{ selectedIds: string[]; action: ActionType }> {
  const orchestrator = new TabbedSelectionOrchestrator({
    initialAssistants,
    registeredIds,
    config,
    options,
    client
  });

  return await orchestrator.run();
}
