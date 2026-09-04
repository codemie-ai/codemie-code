/**
 * Setup UI Utilities
 *
 * Auto-generates UI elements based on provider capabilities and metadata.
 * Provides consistent, polished user experience across all providers.
 */

import chalk from 'chalk';
import type { ProviderTemplate } from '../core/types.js';
import { getSystemCapabilities, modelFitsSystem } from '../../utils/hardware.js';

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
  // Filter out providers hidden from interactive setup (used for script/auto-configuration only)
  const visible = providers.filter(p => !p.hidden);

  // Sort providers: by priority (lower number = higher priority), then alphabetically
  const sorted = [...visible].sort((a, b) => {
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
export function displaySetupInstructions(
  template: Pick<ProviderTemplate, 'setupInstructions'>
): void {
  if (!template.setupInstructions) {
    return;
  }

  console.log(chalk.cyan('\n📖 Setup Instructions:\n'));
  console.log(template.setupInstructions);
  console.log('');
}

// Normalize strings for comparison (lowercase, remove special chars except hyphen)
function normalizeForMatching(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

/**
 * Check if a model matches any recommended pattern (using partial matching)
 *
 * Helper function to be used before isRecommendedModel is defined
 */
function matchesAnyRecommendedPattern(modelId: string, patterns?: string[]): boolean {
  if (!patterns || patterns.length === 0) return false;

  const normalizedModel = normalizeForMatching(modelId);

  return patterns.some(pattern => {
    // Exact match
    if (modelId === pattern) return true;

    // Partial match
    const normalizedPattern = normalizeForMatching(pattern);
    return normalizedModel.includes(normalizedPattern);
  });
}

// `recommendedModels` entries are usually written against one specific version
// (e.g. "claude-sonnet-4-6") so they stay valid as a literal last-resort model
// id when no live catalog is available at all. For matching purposes here we
// only care about the family the pattern identifies, so strip a trailing
// version/date tail (e.g. "-4-6", "-4-5-20251001") to get a version-agnostic
// root that also matches newer releases the pattern predates.
function familyRoot(pattern: string): string {
  const normalized = normalizeForMatching(pattern);
  const stripped = normalized.replace(/-\d[\d-]*$/, '');
  return stripped || normalized;
}

function extractVersionParts(text: string): number[] {
  const matches = text.match(/\d+/g) || [];
  return matches.map(Number);
}

// Descending comparator: negative means `a` is the newer/higher version.
function compareVersionParts(a: number[], b: number[]): number {
  const max = Math.max(a.length, b.length);
  for (let i = 0; i < max; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve `template.recommendedModels` patterns against the actual list of
 * available model ids, so only the single latest version within each
 * recommended family is marked recommended — not every version that has ever
 * matched a (possibly stale, version-pinned) pattern.
 *
 * Falls back to an exact/substring match against the literal pattern when no
 * model in `allModelIds` shares its family root (e.g. a static offline list
 * that IS the recommendedModels array itself).
 */
export function computeRecommendedModelIds(
  allModelIds: string[],
  patterns?: string[]
): Set<string> {
  const recommended = new Set<string>();
  if (!patterns || patterns.length === 0) return recommended;

  for (const pattern of patterns) {
    const root = familyRoot(pattern);
    const candidates = allModelIds.filter(id => normalizeForMatching(id).includes(root));

    if (candidates.length === 0) {
      const fallback = allModelIds.find(id => matchesAnyRecommendedPattern(id, [pattern]));
      if (fallback) recommended.add(fallback);
      continue;
    }

    const latest = [...candidates].sort((a, b) =>
      compareVersionParts(extractVersionParts(a), extractVersionParts(b))
    )[0];
    recommended.add(latest);
  }

  return recommended;
}

/**
 * Format model choice with metadata
 *
 * Enhances model display with metadata if available
 */
export function formatModelChoice(
  modelId: string,
  template?: ProviderTemplate,
  isRecommendedOverride?: boolean
): { name: string; value: string; disabled?: boolean | string } {
  const metadata = template?.modelMetadata?.[modelId];

  // Check if model is recommended. `isRecommendedOverride` — precomputed by
  // getAllModelChoices via computeRecommendedModelIds so only the latest
  // version per family is starred — wins when provided; otherwise fall back
  // to a plain pattern match for a standalone call.
  const isRecommended =
    metadata?.popular ||
    isRecommendedOverride ||
    (isRecommendedOverride === undefined && matchesAnyRecommendedPattern(modelId, template?.recommendedModels)) ||
    false;

  // Models with a memory requirement that exceeds this system are shown
  // but disabled, so users see why a recommended model is unavailable.
  let disabled: string | undefined;
  if (metadata?.minMemoryGb && !modelFitsSystem(metadata.minMemoryGb)) {
    const capabilities = getSystemCapabilities();
    disabled = `needs ~${metadata.minMemoryGb}GB, only ~${Math.round(capabilities.usableMemoryGb)}GB usable on this system`;
  }

  // If no metadata and not recommended, return plain format
  if (!metadata && !isRecommended) {
    return { name: modelId, value: modelId, disabled };
  }

  const popularBadge = isRecommended ? chalk.yellow('⭐ ') : '';
  const mainLine = `${popularBadge}${chalk.white.bold(metadata?.name || modelId)}`;

  const details: string[] = [];
  if (metadata?.description) {
    details.push(metadata.description);
  }
  if (metadata?.minMemoryGb) {
    details.push(`requires ~${metadata.minMemoryGb}GB memory`);
  }
  if (metadata?.contextWindow) {
    details.push(`${metadata.contextWindow.toLocaleString()} tokens`);
  }

  const detailLine = details.length > 0 ? `\n   ${chalk.dim(details.join(' • '))}` : '';

  return {
    name: mainLine + detailLine,
    value: modelId,
    disabled
  };
}

/**
 * Get all model choices with metadata
 *
 * Returns array of formatted model choices, sorted by:
 * 1. Recommended models first — only the latest version within each
 *    recommendedModels family (see computeRecommendedModelIds)
 * 2. Alphabetically by model ID
 *
 * Choices whose declared memory requirement (modelMetadata.minMemoryGb)
 * exceeds the current system are included but disabled with an explanation.
 */
export function getAllModelChoices(
  models: string[],
  template?: ProviderTemplate
): Array<{ name: string; value: string; disabled?: boolean | string }> {
  const recommendedIds = computeRecommendedModelIds(models, template?.recommendedModels);

  // Sort models using common rules
  const sortedModels = [...models].sort((a, b) => {
    const aRecommended = recommendedIds.has(a);
    const bRecommended = recommendedIds.has(b);

    // Recommended models first
    if (aRecommended && !bRecommended) return -1;
    if (!aRecommended && bRecommended) return 1;

    // Then sort alphabetically
    return a.localeCompare(b);
  });

  return sortedModels.map(model => formatModelChoice(model, template, recommendedIds.has(model)));
}

/**
 * The setup-summary model line. On the Anthropic Subscription profile there is no
 * stored model to show — the model is chosen per session by Claude Code and the
 * user's Anthropic subscription — so state that instead of an (empty) model name.
 */
export function setupModelSummaryLine(provider: string, model: string): string {
  if (provider === 'anthropic-subscription') {
    return '🤖 Model: chosen per session by Claude Code and your Anthropic subscription';
  }
  return `🤖 Model: ${model}`;
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
  console.log(chalk.cyan(setupModelSummaryLine(provider, model)));
  console.log(chalk.cyan(`📁 Config: ~/.codemie/codemie-cli.config.json\n`));
  
  console.log(chalk.bold('  Next Steps:'));
  console.log('');
  console.log('  ' + chalk.white('• Verify setup:') + '           ' + chalk.cyan('codemie doctor'));
  console.log('  ' + chalk.white('• Run native task:') + '        ' + chalk.cyan('codemie --task "analyze project"'));
  console.log('  ' + chalk.white('• Install an agent:') + '       ' + chalk.cyan('codemie install claude'));
  console.log('  ' + chalk.white('• Run agent task:') + '         ' + chalk.cyan('codemie-claude --task "fix bugs"'));
  console.log('  ' + chalk.white('• Explore more:') + '           ' + chalk.cyan('codemie --help'));
  console.log('');
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
