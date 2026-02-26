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
  },

  // ── Claude Models ──────────────────────────────────────────────────
  'claude-4-5-sonnet': {
    id: 'claude-4-5-sonnet',
    name: 'Claude 4.5 Sonnet',
    displayName: 'Claude 4.5 Sonnet',
    family: 'claude-4',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-04-01',
    release_date: '2025-09-29',
    last_updated: '2025-09-29',
    open_weights: false,
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3
    },
    limit: {
      context: 200000,
      output: 16384
    }
  },
  'claude-sonnet-4-5-20250929': {
    id: 'claude-sonnet-4-5-20250929',
    name: 'Claude Sonnet 4.5 (Sep 2025)',
    displayName: 'Claude Sonnet 4.5 (Sep 2025)',
    family: 'claude-4',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-04-01',
    release_date: '2025-09-29',
    last_updated: '2025-09-29',
    open_weights: false,
    cost: {
      input: 3,
      output: 15,
      cache_read: 0.3
    },
    limit: {
      context: 200000,
      output: 16384
    }
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    name: 'Claude Sonnet 4.6',
    displayName: 'Claude Sonnet 4.6',
    family: 'claude-4',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-05-01',
    release_date: '2026-02-01',
    last_updated: '2026-02-01',
    open_weights: false,
    cost: {
      input: 3.30,
      output: 16.50,
      cache_read: 0.33
    },
    limit: {
      context: 200000,
      output: 64000
    }
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    name: 'Claude Opus 4.6',
    displayName: 'Claude Opus 4.6',
    family: 'claude-4',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-05-01',
    release_date: '2026-01-15',
    last_updated: '2026-01-15',
    open_weights: false,
    cost: {
      input: 15,
      output: 75,
      cache_read: 1.5
    },
    limit: {
      context: 200000,
      output: 32000
    }
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    displayName: 'Claude Haiku 4.5',
    family: 'claude-4',
    tool_call: true,
    reasoning: false,
    attachment: true,
    temperature: true,
    modalities: {
      input: ['text', 'image'],
      output: ['text']
    },
    knowledge: '2025-04-01',
    release_date: '2025-10-01',
    last_updated: '2025-10-01',
    open_weights: false,
    cost: {
      input: 0.8,
      output: 4,
      cache_read: 0.08
    },
    limit: {
      context: 200000,
      output: 8192
    }
  },

  // ── Qwen Models (via Bedrock/LiteLLM) ─────────────────────────────
  'qwen.qwen3-coder-30b-a3b-v1': {
    id: 'qwen.qwen3-coder-30b-a3b-v1',
    name: 'Bedrock Qwen3 Coder 30B A3B',
    displayName: 'Qwen3 Coder 30B A3B',
    family: 'qwen3',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: true,
    modalities: {
      input: ['text'],
      output: ['text']
    },
    knowledge: '2025-05-01',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    open_weights: true,
    cost: {
      input: 0.15,
      output: 0.60
    },
    limit: {
      context: 262144,
      output: 131072
    }
  },
  'qwen.qwen3-coder-480b-a35b-v1': {
    id: 'qwen.qwen3-coder-480b-a35b-v1',
    name: 'Bedrock Qwen3 Coder 480B A35B',
    displayName: 'Qwen3 Coder 480B A35B',
    family: 'qwen3',
    tool_call: true,
    reasoning: true,
    attachment: false,
    temperature: true,
    modalities: {
      input: ['text'],
      output: ['text']
    },
    knowledge: '2025-05-01',
    release_date: '2025-05-01',
    last_updated: '2025-05-01',
    open_weights: true,
    cost: {
      input: 0.22,
      output: 1.80
    },
    limit: {
      context: 262000,
      output: 65536
    }
  },

  // ── Gemini Models ──────────────────────────────────────────────────
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    displayName: 'Gemini 2.5 Pro',
    family: 'gemini-2',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image', 'audio', 'video'],
      output: ['text']
    },
    knowledge: '2025-03-01',
    release_date: '2025-06-05',
    last_updated: '2025-06-05',
    open_weights: false,
    cost: {
      input: 1.25,
      output: 10,
      cache_read: 0.31
    },
    limit: {
      context: 1048576,
      output: 65536
    }
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    displayName: 'Gemini 2.5 Flash',
    family: 'gemini-2',
    tool_call: true,
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: {
      input: ['text', 'image', 'audio', 'video'],
      output: ['text']
    },
    knowledge: '2025-03-01',
    release_date: '2025-04-17',
    last_updated: '2025-04-17',
    open_weights: false,
    cost: {
      input: 0.15,
      output: 0.6,
      cache_read: 0.0375
    },
    limit: {
      context: 1048576,
      output: 65536
    }
  }
};

/**
 * Get all model configs stripped of CodeMie-specific fields (displayName, providerOptions).
 * Used to populate all models in the OpenCode config so users can switch models during a session.
 */
export function getAllOpenCodeModelConfigs(): Record<string, Omit<OpenCodeModelConfig, 'displayName' | 'providerOptions'>> {
  const result: Record<string, Omit<OpenCodeModelConfig, 'displayName' | 'providerOptions'>> = {};
  for (const [id, config] of Object.entries(OPENCODE_MODEL_CONFIGS)) {
    const { displayName: _displayName, providerOptions: _providerOptions, ...opencodeConfig } = config;
    result[id] = opencodeConfig;
  }
  return result;
}

/**
 * Family-specific defaults for unknown model variants.
 * Used by getModelConfig() when an exact match isn't found but
 * the model ID prefix matches a known family.
 */
const MODEL_FAMILY_DEFAULTS: Record<string, Partial<OpenCodeModelConfig>> = {
  'claude': {
    family: 'claude-4',
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 200000, output: 16384 }
  },
  'gemini': {
    family: 'gemini-2',
    reasoning: true,
    attachment: true,
    temperature: true,
    structured_output: true,
    modalities: { input: ['text', 'image', 'audio', 'video'], output: ['text'] },
    limit: { context: 1048576, output: 65536 }
  },
  'gpt': {
    family: 'gpt-5',
    reasoning: true,
    attachment: true,
    temperature: false,
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 400000, output: 128000 }
  },
  'qwen': {
    family: 'qwen3',
    reasoning: true,
    attachment: false,
    temperature: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 262000, output: 65536 }
  }
};

/**
 * Get model configuration with fallback for unknown models
 *
 * Resolution order:
 * 1. Exact match in OPENCODE_MODEL_CONFIGS
 * 2. Family-aware fallback using MODEL_FAMILY_DEFAULTS
 * 3. Generic fallback with conservative defaults
 *
 * @param modelId - Model identifier (e.g., 'gpt-5-2-2025-12-11', 'claude-4-5-sonnet')
 * @returns Model configuration in OpenCode format
 *
 * Note: The returned config is used directly in OPENCODE_CONFIG_CONTENT
 * model = "<provider>/<modelId>" (e.g., "codemie-proxy/gpt-5-2-2025-12-11")
 */
export function getModelConfig(modelId: string): OpenCodeModelConfig {
  const config = OPENCODE_MODEL_CONFIGS[modelId];
  if (config) {
    return config;
  }

  // Detect model family from prefix for smarter defaults
  const familyPrefix = Object.keys(MODEL_FAMILY_DEFAULTS).find(
    prefix => modelId.startsWith(prefix)
  );
  const familyDefaults = familyPrefix ? MODEL_FAMILY_DEFAULTS[familyPrefix] : {};

  // Extract family from model ID (e.g., "gpt-4o" -> "gpt-4", "claude-4-5-sonnet" -> "claude-4")
  const family = familyDefaults.family
    || modelId.split('-').slice(0, 2).join('-')
    || modelId;

  const today = new Date().toISOString().split('T')[0];

  return {
    id: modelId,
    name: modelId,
    displayName: modelId,
    family,
    tool_call: true,
    reasoning: familyDefaults.reasoning ?? false,
    attachment: familyDefaults.attachment ?? false,
    temperature: familyDefaults.temperature ?? true,
    structured_output: familyDefaults.structured_output,
    modalities: familyDefaults.modalities ?? { input: ['text'], output: ['text'] },
    knowledge: today,
    release_date: today,
    last_updated: today,
    open_weights: false,
    cost: { input: 0, output: 0 },
    limit: familyDefaults.limit ?? { context: 128000, output: 4096 }
  };
}
