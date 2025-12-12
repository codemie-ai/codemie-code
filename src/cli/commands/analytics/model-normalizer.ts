/**
 * Model name normalization utilities
 * Handles various provider formats (AWS Bedrock, standard names, etc.)
 */

/**
 * Normalize LLM model names from different provider formats
 *
 * Handles various model name formats:
 * - AWS Bedrock Converse: converse/region.provider.model-v1:0 -> model
 * - AWS Bedrock Direct: region.provider.model-v1:0 -> model
 * - Standard Claude: claude-sonnet-4-5-20250929 (unchanged)
 * - OpenAI: gpt-4-turbo (unchanged)
 * - Google: gemini-1.5-pro (unchanged)
 *
 * Examples:
 *   converse/global.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 *   eu.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 *   claude-sonnet-4-5-20250929 -> claude-sonnet-4-5-20250929
 */
export function normalizeModelName(modelName: string): string {
  // Extract model from AWS Bedrock converse format
  // Format: converse/region.provider.model-v1:0
  // Example: converse/global.anthropic.claude-haiku-4-5-20251001-v1:0
  if (modelName.startsWith('converse/')) {
    const match = modelName.match(/anthropic\.(claude-[a-z0-9-]+)-v\d+:/);
    if (match) {
      return match[1]; // Returns: claude-haiku-4-5-20251001
    }
  }

  // Extract model from AWS Bedrock direct format (without converse/ prefix)
  // Format: region.provider.model-v1:0
  // Examples:
  // - eu.anthropic.claude-haiku-4-5-20251001-v1:0
  // - us-east-1.anthropic.claude-opus-4-20250514-v1:0
  if (modelName.includes('.anthropic.')) {
    const match = modelName.match(/anthropic\.(claude-[a-z0-9-]+)-v\d+:/);
    if (match) {
      return match[1];
    }
  }

  // Return unchanged for standard formats
  return modelName;
}
