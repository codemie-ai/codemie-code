/**
 * Convert a short model ID to Bedrock inference profile format.
 * Bedrock requires region-prefixed ARN-style model IDs.
 *
 * Examples:
 *   claude-sonnet-4-5-20250929 → us.anthropic.claude-sonnet-4-5-20250929-v1:0
 *   claude-opus-4-6            → us.anthropic.claude-opus-4-6-v1:0
 *
 * If the model ID already contains 'anthropic.', it's returned as-is.
 */
export function toBedrockModelId(modelId: string, region?: string): string {
  if (modelId.includes('anthropic.')) return modelId;

  const regionPrefix = region?.startsWith('eu') ? 'eu'
    : region?.startsWith('ap') ? 'ap'
    : 'us';

  return `${regionPrefix}.anthropic.${modelId}-v1:0`;
}
