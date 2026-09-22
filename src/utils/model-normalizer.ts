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
 * - Switchyard Bedrock alias: bedrock/region.provider.model -> model (no version suffix)
 * - Kimi Code: kimi-code/kimi-for-coding -> kimi-for-coding
 * - Standard Claude: claude-sonnet-4-5-20250929 (unchanged)
 * - OpenAI: gpt-4-turbo (unchanged)
 * - Google: gemini-1.5-pro (unchanged)
 *
 * Examples:
 *   converse/global.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 *   eu.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 *   bedrock/us.anthropic.claude-sonnet-5 -> claude-sonnet-5
 *   kimi-code/kimi-for-coding -> kimi-for-coding
 *   claude-sonnet-4-5-20250929 -> claude-sonnet-4-5-20250929
 */
export function normalizeModelName(modelName: string): string {
  // Extract model from an AWS Bedrock id, with or without a `converse/`/`bedrock/` path
  // prefix, and with or without AWS's own `-v1:0` inference-profile version suffix. The
  // suffix is optional because Switchyard's own Bedrock aliases (e.g.
  // `bedrock/us.anthropic.claude-sonnet-5`, seen on a "capable"-tier routed turn) carry no
  // version at all, unlike a native AWS SDK Bedrock id.
  // Formats:
  // - converse/region.provider.model-v1:0
  // - region.provider.model-v1:0
  // - bedrock/region.provider.model
  const bedrockMatch = modelName.match(/^(?:converse\/|bedrock\/)?[a-z0-9-]+\.anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+:\d+)?$/);
  if (bedrockMatch) {
    return bedrockMatch[1]; // Returns: claude-haiku-4-5-20251001
  }

  // Strip Kimi Code vendor prefix so wire-log model aliases resolve to the pricing table.
  // Kimi emits aliases like "kimi-code/kimi-for-coding"; the canonical pricing key is
  // "kimi-for-coding".
  if (modelName.startsWith('kimi-code/')) {
    return modelName.slice('kimi-code/'.length);
  }

  // Return unchanged for standard formats
  return modelName;
}
