/**
 * Model configuration for OpenCode agent
 */
export interface OpenCodeModelConfig {
  /** Model identifier as used by the provider */
  modelId: string;
  /** Display name for the model */
  displayName: string;
  /** Provider-specific options */
  providerOptions?: {
    headers?: Record<string, string>;
    timeout?: number;
  };
  /** Model capabilities */
  capabilities?: {
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    maxTokens?: number;
  };
  /** Pricing information (USD per million tokens) */
  cost?: {
    input: number;
    output: number;
    cache_read?: number;
  };
  /** Model limits */
  limit?: {
    context: number;
    output: number;
  };
  /** Modality support */
  modalities?: {
    input: string[];
    output: string[];
  };
  /** Attachment support */
  attachment?: boolean;
  /** Temperature control availability */
  temperature?: boolean;
}

export const OPENCODE_MODEL_CONFIGS: Record<string, OpenCodeModelConfig> = {
  'gpt-5-2-2025-12-11': {
    modelId: 'gpt-5-2-2025-12-11',
    displayName: 'GPT-5.2 (Dec 2025)',
    capabilities: {
      tools: true,        // tool_call: true
      vision: true,       // modalities.input includes "image"
      reasoning: true,    // reasoning: true
      maxTokens: 128000   // limit.output
    },
    cost: {
      input: 1.75,        // $1.75 per million input tokens
      output: 14,         // $14.00 per million output tokens
      cache_read: 0.125   // $0.125 per million cache read tokens
    },
    limit: {
      context: 400000,    // 400K context window
      output: 128000      // 128K max output tokens
    },
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    attachment: true,     // Attachment support enabled
    temperature: false    // Temperature control disabled for this model
  }
};

/**
 * Get model configuration with fallback for unknown models
 *
 * @param modelId - Model identifier (e.g., 'gpt-4o', 'claude-sonnet-4-20250514')
 * @returns Model configuration including capabilities and provider options
 *
 * Note: The returned config is used in OPENCODE_CONFIG_CONTENT with format:
 * defaults.model = "<provider>/<modelId>" (e.g., "codemie-proxy/gpt-4o")
 */
export function getModelConfig(modelId: string): OpenCodeModelConfig {
  const config = OPENCODE_MODEL_CONFIGS[modelId];
  if (config) {
    return config;
  }
  // Fallback for unknown models
  return {
    modelId,
    displayName: modelId,
    capabilities: { tools: true }
  };
}
