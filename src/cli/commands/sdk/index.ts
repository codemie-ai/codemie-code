import { Command } from 'commander';
import { createAssistantsSubcommand } from './assistants.js';
import { createWorkflowsSubcommand } from './workflows.js';
import { createDatasourcesSubcommand } from './datasources.js';
import { createIntegrationsSubcommand } from './integrations.js';
import { createLlmModelsSubcommand } from './llm.js';
import { createSkillsSubcommand } from './skills.js';
import { createUsersSubcommand } from './users.js';
import { createCategoriesSubcommand } from './categories.js';

export function createSdkCommand(): Command {
  const cmd = new Command('sdk');

  cmd.description(
    'Manage CodeMie platform assets (assistants, workflows, datasources, integrations, skills, users, assistant-categories) via the SDK'
  );

  cmd.addCommand(createAssistantsSubcommand());
  cmd.addCommand(createWorkflowsSubcommand());
  cmd.addCommand(createDatasourcesSubcommand());
  cmd.addCommand(createIntegrationsSubcommand());
  cmd.addCommand(createLlmModelsSubcommand());
  cmd.addCommand(createSkillsSubcommand());
  cmd.addCommand(createUsersSubcommand());
  cmd.addCommand(createCategoriesSubcommand());

  return cmd;
}
