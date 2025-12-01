import inquirer from 'inquirer';
import chalk from 'chalk';
import { CodeMieIntegration, SSOAuthResult } from '../types/sso.js';
import { fetchCodeMieIntegrations, CODEMIE_ENDPOINTS } from './codemie-model-fetcher.js';

/**
 * Validates CodeMie integrations and prompts for selection (SSO provider only)
 * Returns null if user opts out or no integrations available
 */
export async function validateCodeMieIntegrations(
  authResult: SSOAuthResult,
  spinner?: any
): Promise<{ id: string; alias: string } | null> {
  const integrations = await fetchCodeMieIntegrations(authResult.apiUrl!, authResult.cookies!, CODEMIE_ENDPOINTS.USER_SETTINGS);

  // Integrations are already filtered by API for LiteLLM type
  if (integrations.length === 0) {
    // No integrations found - continue without integration
    if (spinner) {
      spinner.info(chalk.white('No CodeMie integrations found - continuing without integration'));
    }
    return null;
  }

  // Return selected integration ID and alias (or null if user opts out)
  return await promptForIntegrationSelection(integrations, spinner);
}

/**
 * Prompts user to select from available LiteLLM integrations
 * Returns null if user chooses to skip
 */
async function promptForIntegrationSelection(
  integrations: CodeMieIntegration[],
  spinner?: any
): Promise<{ id: string; alias: string } | null> {
  if (integrations.length === 1) {
    // Auto-select single integration with confirmation
    const integration = integrations[0];
    const displayName = integration.project_name
      ? `${integration.alias} (${integration.project_name})`
      : integration.alias;

    // Stop spinner before showing prompt
    if (spinner) {
      spinner.stop();
    }

    const { action } = await inquirer.prompt([{
      type: 'list',
      name: 'action',
      message: `Use CodeMie LiteLLM integration "${displayName}"?`,
      choices: [
        { name: `Yes, use "${displayName}"`, value: 'use' },
        { name: 'Skip (continue without integration)', value: 'skip' }
      ],
      default: 'use'
    }]);

    if (action === 'skip') {
      console.log(chalk.white('Skipping integration setup'));
      return null;
    }

    console.log(chalk.green(`✓ Selected integration: ${displayName}`));
    return { id: integration.id, alias: integration.alias };
  }

  // Multiple integrations - show selection list
  // Stop spinner before showing prompt
  if (spinner) {
    spinner.stop();
  }

  const choices = integrations.map(integration => {
    // Show both alias and project_name
    const displayName = integration.project_name && integration.project_name.trim() !== ''
      ? `${integration.alias} (${integration.project_name})`
      : integration.alias;

    return {
      name: displayName,
      value: integration.id
    };
  });

  // Add skip option
  choices.push({
    name: chalk.white('Skip (continue without integration)'),
    value: 'skip'
  });

  const { selectedId } = await inquirer.prompt([{
    type: 'list',
    name: 'selectedId',
    message: `Choose a CodeMie LiteLLM integration (${integrations.length} available):`,
    choices,
    pageSize: 15
  }]);

  if (selectedId === 'skip') {
    console.log(chalk.white('Skipping integration setup'));
    return null;
  }

  const selectedIntegration = integrations.find(i => i.id === selectedId);
  const displayName = selectedIntegration?.project_name
    ? `${selectedIntegration.alias} (${selectedIntegration.project_name})`
    : selectedIntegration?.alias || selectedId;

  console.log(chalk.green(`✓ Selected integration: ${displayName}`));
  return { id: selectedId, alias: selectedIntegration?.alias || '' };
}

/**
 * Validates that a specific integration alias exists and is of type LiteLLM
 */
export async function validateIntegrationAlias(
  apiUrl: string,
  cookies: Record<string, string>,
  integrationAlias: string
): Promise<boolean> {
  try {
    const integrations = await fetchCodeMieIntegrations(apiUrl, cookies);

    const integration = integrations.find(
      i => i.alias === integrationAlias && i.credential_type === 'LiteLLM'
    );

    return !!integration;
  } catch (error) {
    console.error('Error validating integration alias:', error);
    return false;
  }
}

/**
 * Gets all available integration types for debugging/informational purposes
 */
export async function getAvailableIntegrationTypes(
  apiUrl: string,
  cookies: Record<string, string>
): Promise<string[]> {
  try {
    const integrations = await fetchCodeMieIntegrations(apiUrl, cookies);
    const types = [...new Set(integrations.map(i => i.credential_type))];
    return types.sort();
  } catch (error) {
    console.error('Error fetching integration types:', error);
    return [];
  }
}