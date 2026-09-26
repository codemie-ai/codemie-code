/**
 * Model name normalization utilities
 * Handles various provider formats (AWS Bedrock, standard names, etc.)
 */

/**
 * Vendor path prefixes some proxies/wire logs prepend ahead of the bare model id — `openai.`
 * (dot form) or `openai/` (slash form), the slash-only `azure/`, `vertex_ai/` and `anthropic/`,
 * and the dot-only `moonshotai.` (e.g. `moonshotai.kimi-k2.5`) and `qwen.` (e.g.
 * `qwen.qwen3-coder-480b-a35b-v1`). Matched case-insensitively and stripped in
 * {@link normalizeModelName}, before {@link canonicalizeModelId}'s later dots-to-dashes pass runs
 * — stripping here first is what keeps `moonshotai.kimi-k2.5` resolving to `kimi-k2-5` rather than
 * `moonshotai-kimi-k2-5`.
 */
const VENDOR_PREFIX_PATTERN = /^(?:openai[./]|azure\/|vertex_ai\/|anthropic\/|moonshotai\.|qwen\.)/i;

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
 *   bedrock/converse/us.anthropic.claude-haiku-4-5-20251001-v1:0 -> claude-haiku-4-5-20251001
 *   kimi-code/kimi-for-coding -> kimi-for-coding
 *   openai.gpt-4o -> gpt-4o
 *   azure/gpt-4o -> gpt-4o
 *   vertex_ai/gemini-3-pro -> gemini-3-pro
 *   claude-sonnet-4-5-20250929 -> claude-sonnet-4-5-20250929
 */
export function normalizeModelName(modelName: string): string {
  // Extract model from an AWS Bedrock id, with or without a `converse/`/`bedrock/` path
  // prefix — including both stacked together as `bedrock/converse/` (observed on real usage
  // data) — and with or without AWS's own `-v1:0` inference-profile version suffix. The
  // suffix is optional because Switchyard's own Bedrock aliases (e.g.
  // `bedrock/us.anthropic.claude-sonnet-5`, seen on a "capable"-tier routed turn) carry no
  // version at all, unlike a native AWS SDK Bedrock id.
  // Formats:
  // - converse/region.provider.model-v1:0
  // - region.provider.model-v1:0
  // - bedrock/region.provider.model
  // - bedrock/converse/region.provider.model-v1:0
  const bedrockMatch = modelName.match(/^(?:bedrock\/)?(?:converse\/)?[a-z0-9-]+\.anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+:\d+)?$/);
  if (bedrockMatch) {
    return bedrockMatch[1]; // Returns: claude-haiku-4-5-20251001
  }

  // Strip Kimi Code vendor prefix so wire-log model aliases resolve to the pricing table.
  // Kimi emits aliases like "kimi-code/kimi-for-coding"; the canonical pricing key is
  // "kimi-for-coding".
  if (modelName.startsWith('kimi-code/')) {
    return modelName.slice('kimi-code/'.length);
  }

  // Strip vendor path/proxy prefixes some gateways prepend ahead of the bare model id, so
  // e.g. "openai.gpt-4o" and "azure/gpt-4o" both resolve to the same pricing-table key as a
  // direct "gpt-4o" id.
  const vendorPrefixMatch = modelName.match(VENDOR_PREFIX_PATTERN);
  if (vendorPrefixMatch) {
    return modelName.slice(vendorPrefixMatch[0].length);
  }

  // Return unchanged for standard formats
  return modelName;
}
