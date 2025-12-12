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
 * Check if a model matches any recommended pattern (using partial matching)
 *
 * Helper function to be used before isRecommendedModel is defined
 */
function matchesAnyRecommendedPattern(modelId: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;

  // Normalize strings for comparison (lowercase, remove special chars except hyphen)
  const normalizeForMatching = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9-]/g, '');

  const normalizedModel = normalizeForMatching(modelId);

  return patterns.some(pattern => {
    // Exact match
    if (modelId === pattern) return true;

    // Partial match
    const normalizedPattern = normalizeForMatching(pattern);
    return normalizedModel.includes(normalizedPattern);
  });
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

  // Check if model is recommended (with partial matching support)
  const isRecommended =
    metadata?.popular ||
    matchesAnyRecommendedPattern(modelId, template?.recommendedModels) ||
    false;

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
 * Check if a model matches a recommended pattern
 *
 * Supports both exact and partial matching:
 * - Exact: "anthropic.claude-3-5-sonnet-20240620-v1:0" matches "anthropic.claude-3-5-sonnet-20240620-v1:0"
 * - Partial: "anthropic.claude-3-5-sonnet-20240620-v1:0" matches "claude-3-5-sonnet"
 * - Partial: "anthropic.claude-sonnet-4-5-20250929-v1:0" matches "claude-sonnet-4-5"
 *
 * @param modelId Full model ID from provider (e.g., "anthropic.claude-3-5-sonnet-20240620-v1:0")
 * @param recommendedPattern Pattern to match (e.g., "claude-3-5-sonnet" or "claude-sonnet-4-5")
 */
function isRecommendedModel(modelId: string, recommendedPattern: string): boolean {
  // Exact match first
  if (modelId === recommendedPattern) {
    return true;
  }

  // Normalize both strings for comparison (lowercase, remove special chars except hyphen)
  const normalizeForMatching = (str: string) =>
    str.toLowerCase().replace(/[^a-z0-9-]/g, '');

  const normalizedModel = normalizeForMatching(modelId);
  const normalizedPattern = normalizeForMatching(recommendedPattern);

  // Check if the model ID contains the pattern
  return normalizedModel.includes(normalizedPattern);
}

/**
 * Get all model choices with metadata
 *
 * Returns array of formatted model choices, sorted by:
 * 1. Recommended models first (template.recommendedModels with partial matching)
 * 2. Alphabetically by model ID
 */
export function getAllModelChoices(
  models: string[],
  template?: ProviderTemplate
): Array<{ name: string; value: string }> {
  // Sort models using common rules
  const sortedModels = [...models].sort((a, b) => {
    // Check if models are recommended (with partial matching)
    const aRecommended = template?.recommendedModels?.some(pattern =>
      isRecommendedModel(a, pattern)
    ) || false;
    const bRecommended = template?.recommendedModels?.some(pattern =>
      isRecommendedModel(b, pattern)
    ) || false;

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
