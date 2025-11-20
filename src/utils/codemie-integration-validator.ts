import inquirer from 'inquirer';
import chalk from 'chalk';
import { CodeMieIntegration, SSOAuthResult } from '../types/sso.js';
import { fetchCodeMieIntegrations, CODEMIE_ENDPOINTS } from './codemie-model-fetcher.js';

/**
 * Validates that the user has required CodeMie integrations and prompts for selection
 */
export async function validateCodeMieIntegrations(
  authResult: SSOAuthResult,
  spinner?: any
): Promise<{ id: string; alias: string }> {
  const integrations = await fetchCodeMieIntegrations(authResult.apiUrl!, authResult.cookies!, CODEMIE_ENDPOINTS.USER_SETTINGS);

  // Integrations are already filtered by API for LiteLLM type
  if (integrations.length === 0) {
    console.log(chalk.red('\n❌ No CodeMie LiteLLM integration found\n'));
    console.log(chalk.yellow('📋 Required Setup Steps:'));
    console.log(chalk.white('  1. Contact your support team to request a LiteLLM key'));
    console.log(chalk.white('  2. In CodeMie, go to Integrations → User Integrations'));
    console.log(chalk.white('  3. Add the key as a new integration with type "LiteLLM"'));
    console.log(chalk.white('  4. Re-run: codemie setup\n'));

    throw new Error('CodeMie LiteLLM integration setup required');
  }

  // Return selected integration ID and alias
  return await promptForIntegrationSelection(integrations, spinner);
}

/**
 * Prompts user to select from available LiteLLM integrations
 */
async function promptForIntegrationSelection(
  integrations: CodeMieIntegration[],
  spinner?: any
): Promise<{ id: string; alias: string }> {
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

    const { confirm } = await inquirer.prompt([{
      type: 'confirm',
      name: 'confirm',
      message: `Use CodeMie LiteLLM integration "${displayName}"?`,
      default: true
    }]);

    if (!confirm) {
      throw new Error('Setup cancelled by user');
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

  const { selectedId } = await inquirer.prompt([{
    type: 'list',
    name: 'selectedId',
    message: `Choose a CodeMie LiteLLM integration (${integrations.length} available):`,
    choices,
    pageSize: 15
  }]);

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