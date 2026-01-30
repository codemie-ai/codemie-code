/**
 * Model configuration for OpenCode agent
 * Uses OpenCode's native format for direct injection
 */
export interface OpenCodeModelConfig {
  /** Model identifier (OpenCode format: id) */
  id: string;
  /** Model name (OpenCode format: name) */
  name: string;
  /** Display name for UI (CodeMie extension) */
  displayName?: string;
  /** Model family (e.g., "gpt-5", "claude-4") */
  family: string;
  /** Tool calling support (OpenCode format: tool_call) */
  tool_call: boolean;
  /** Reasoning capability (OpenCode format: reasoning) */
  reasoning: boolean;
  /** Attachment support */
  attachment: boolean;
  /** Temperature control availability */
  temperature: boolean;
  /** Structured output support (OpenCode format: structured_output) */
  structured_output?: boolean;
  /** Modality support */
  modalities: {
    input: string[];
    output: string[];
  };
  /** Knowledge cutoff date (YYYY-MM-DD) */
  knowledge: string;
  /** Release date (YYYY-MM-DD) */
  release_date: string;
  /** Last updated date (YYYY-MM-DD) */
  last_updated: string;
  /** Whether model has open weights */
  open_weights: boolean;
  /** Pricing information (USD per million tokens) */
  cost: {
    input: number;
    output: number;
    cache_read?: number;
  };
  /** Model limits */
  limit: {
    context: number;
    output: number;
  };
  /** Provider-specific options (CodeMie extension) */
  providerOptions?: {
    headers?: Record<string, string>;
    timeout?: number;
  };
}

export const OPENCODE_MODEL_CONFIGS: Record<string, OpenCodeModelConfig> = {
  'gpt-5-2-2025-12-11': {
    id: 'gpt-5-2-2025-12-11',
    name: 'gpt-5-2-2025-12-11',
    displayName: 'GPT-5.2 (Dec 2025)',
    family: 'gpt-5',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: false,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-08-31',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: {
      input: 1.75,
      output: 14,
      cache_read: 0.125
    },
    limit: {
      context: 400000,
      output: 128000
    }
  },
  'gpt-5.1-codex': {
    id: 'gpt-5.1-codex',
    name: 'GPT-5.1 Codex',
    displayName: 'GPT-5.1 Codex',
    family: 'gpt-5-codex',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: false,
    modalities: {
      input: ['text', 'image', 'audio'],
      output: ['text', 'image', 'audio']
    },
    knowledge: '2024-09-30',
    release_date: '2025-11-14',
    last_updated: '2025-11-14',
    open_weights: false,
    cost: {
      input: 1.25,
      output: 10,
      cache_read: 0.125
    },
    limit: {
      context: 400000,
      output: 128000
    }
  },
  'gpt-5.1-codex-mini': {
    id: 'gpt-5.1-codex-mini',
    name: 'GPT-5.1 Codex Mini',
    displayName: 'GPT-5.1 Codex Mini',
    family: 'gpt-5-codex-mini',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: false,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2024-09-30',
    release_date: '2025-11-14',
    last_updated: '2025-11-14',
    open_weights: false,
    cost: {
      input: 0.25,
      output: 2,
      cache_read: 0.025
    },
    limit: {
      context: 400000,
      output: 128000
    }
  },
  'gpt-5.1-codex-max': {
    id: 'gpt-5.1-codex-max',
    name: 'GPT-5.1 Codex Max',
    displayName: 'GPT-5.1 Codex Max',
    family: 'gpt-5-codex-max',
    tool_call: true,
    reasoning: true,
    attachment: true,
    structured_output: true,
    temperature: false,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2024-09-30',
    release_date: '2025-11-13',
    last_updated: '2025-11-13',
    open_weights: false,
    cost: {
      input: 1.25,
      output: 10,
      cache_read: 0.125
    },
    limit: {
      context: 400000,
      output: 128000
    }
  },
  'gpt-5.2-chat': {
    id: 'gpt-5.2-chat',
    name: 'GPT-5.2 Chat',
    displayName: 'GPT-5.2 Chat',
    family: 'gpt-5-chat',
    tool_call: true,
    reasoning: true,
    attachment: true,
    structured_output: true,
    temperature: false,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-08-31',
    release_date: '2025-12-11',
    last_updated: '2025-12-11',
    open_weights: false,
    cost: {
      input: 1.75,
      output: 14,
      cache_read: 0.175
    },
    limit: {
      context: 128000,
      output: 16384
    }
  }
};

/**
 * Get model configuration with fallback for unknown models
 *
 * @param modelId - Model identifier (e.g., 'gpt-5-2-2025-12-11')
 * @returns Model configuration in OpenCode format
 *
 * Note: The returned config is used directly in OPENCODE_CONFIG_CONTENT
 * defaults.model = "<provider>/<modelId>" (e.g., "codemie-proxy/gpt-5-2-2025-12-11")
 */
export function getModelConfig(modelId: string): OpenCodeModelConfig {
  const config = OPENCODE_MODEL_CONFIGS[modelId];
  if (config) {
    return config;
  }

  // Fallback for unknown models - create minimal OpenCode-compatible config
  // Extract family from model ID (e.g., "gpt-4o" -> "gpt-4")
  const family = modelId.split('-').slice(0, 2).join('-') || modelId;

  return {
    id: modelId,
    name: modelId,
    displayName: modelId,
    family,
    tool_call: true,  // Assume tool support
    reasoning: false, // Conservative default
    attachment: false,
    temperature: true,
    modalities: {
      input: ['text'],
      output: ['text']
    },
    knowledge: new Date().toISOString().split('T')[0], // Use current date
    release_date: new Date().toISOString().split('T')[0],
    last_updated: new Date().toISOString().split('T')[0],
    open_weights: false,
    cost: {
      input: 0,
      output: 0
    },
    limit: {
      context: 128000,
      output: 4096
    }
  };
}
