/**
 * Setup UI Utilities
 *
 * Auto-generates UI elements based on provider capabilities and metadata.
 * Provides consistent, polished user experience across all providers.
 */

import chalk from 'chalk';
import type { ProviderTemplate } from '../core/types.js';

/**
 * Format provider choice for inquirer
 *
 * Auto-generates formatted choice with:
 * - Auth indicator (🔐 for auth required, 🔓 for no auth)
 * - Display name
 * - Description
 * - Capability hints (dimmed)
 */
export function formatProviderChoice(template: ProviderTemplate): string {
  return `${template.displayName} - ${template.description}`;
}

/**
 * Get provider choice object for inquirer
 *
 * Returns properly formatted choice with name and value
 */
export function getProviderChoice(template: ProviderTemplate): { name: string; value: string } {
  return {
    name: formatProviderChoice(template),
    value: template.name
  };
}

/**
 * Get all provider choices for inquirer
 *
 * Returns array of formatted choices sorted by:
 * 1. Recommended providers first (SSO)
 * 2. Alphabetically
 */
export function getAllProviderChoices(providers: ProviderTemplate[]): Array<{ name: string; value: string }> {
  // Sort providers: by priority (lower number = higher priority), then alphabetically
  const sorted = [...providers].sort((a, b) => {
    // First, sort by priority (default to 999 if not specified)
    const priorityA = a.priority ?? 999;
    const priorityB = b.priority ?? 999;

    if (priorityA !== priorityB) {
      return priorityA - priorityB; // Lower priority number comes first
    }

    // If priority is the same, sort alphabetically by display name
    return a.displayName.localeCompare(b.displayName);
  });

  return sorted.map(getProviderChoice);
}

/**
 * Display provider setup instructions
 *
 * Shows markdown-formatted instructions if available
 */
export function displaySetupInstructions(template: ProviderTemplate): void {
  if (!template.setupInstructions) {
    return;
  }

  console.log(chalk.cyan('\n📖 Setup Instructions:\n'));
  console.log(template.setupInstructions);
  console.log('');
}

/**
 * Format model choice with metadata
 *
 * Enhances model display with metadata if available
 */
export function formatModelChoice(
  modelId: string,
  template?: ProviderTemplate
): { name: string; value: string } {
  const metadata = template?.modelMetadata?.[modelId];

  // Check if model is recommended (either via metadata or recommendedModels array)
  const isRecommended = metadata?.popular || template?.recommendedModels?.includes(modelId) || false;

  // If no metadata and not recommended, return plain format
  if (!metadata && !isRecommended) {
    return { name: modelId, value: modelId };
  }

  const popularBadge = isRecommended ? chalk.yellow('⭐ ') : '';
  const mainLine = `${popularBadge}${chalk.white.bold(metadata?.name || modelId)}`;

  const details: string[] = [];
  if (metadata?.description) {
    details.push(metadata.description);
  }
  if (metadata?.contextWindow) {
    details.push(`${metadata.contextWindow.toLocaleString()} tokens`);
  }

  const detailLine = details.length > 0 ? `\n   ${chalk.dim(details.join(' • '))}` : '';

  return {
    name: mainLine + detailLine,
    value: modelId
  };
}

/**
 * Get all model choices with metadata
 *
 * Returns array of formatted model choices, sorted by:
 * 1. Recommended models first (template.recommendedModels)
 * 2. Alphabetically by model ID
 */
export function getAllModelChoices(
  models: string[],
  template?: ProviderTemplate
): Array<{ name: string; value: string }> {
  // Sort models using common rules
  const sortedModels = [...models].sort((a, b) => {
    // Check if models are recommended
    const aRecommended = template?.recommendedModels?.includes(a) || false;
    const bRecommended = template?.recommendedModels?.includes(b) || false;

    // Recommended models first
    if (aRecommended && !bRecommended) return -1;
    if (!aRecommended && bRecommended) return 1;

    // Then sort alphabetically
    return a.localeCompare(b);
  });

  return sortedModels.map(model => formatModelChoice(model, template));
}

/**
 * Display success message
 *
 * Shows formatted success message with configuration summary
 */
export function displaySetupSuccess(
  profileName: string,
  provider: string,
  model: string
): void {
  console.log(chalk.bold.green(`\n✅ Profile "${profileName}" configured successfully!\n`));
  console.log(chalk.cyan(`🔗 Provider: ${provider}`));
  console.log(chalk.cyan(`🤖 Model: ${model}`));
  console.log(chalk.cyan(`📁 Config: ~/.codemie/config.json\n`));
  console.log(chalk.bold(`🚀 Ready to use! Try: ${chalk.white('codemie-code "test task"')}\n`));
}

/**
 * Display error with remediation
 *
 * Shows formatted error message with actionable steps
 */
export function displaySetupError(error: Error, remediation?: string): void {
  console.log(chalk.red(`\n❌ Setup failed: ${error.message}\n`));

  if (remediation) {
    console.log(chalk.yellow('💡 How to fix:\n'));
    console.log(remediation);
    console.log('');
  }
}
