/**
 * Ollama Provider Template
 *
 * Template definition for Ollama local LLM runtime.
 * Ollama is a popular open-source tool for running LLMs locally.
 *
 * Auto-registers on import via registerProvider().
 */

import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

export const OllamaTemplate = registerProvider<ProviderTemplate>({
  name: 'ollama',
  displayName: 'Ollama',
  description: 'Popular open-source local LLM runner - optimized for coding with 16GB RAM',
  defaultPort: 11434,
  defaultBaseUrl: 'http://localhost:11434',
  requiresAuth: false,
  authType: 'none',
  recommendedModels: [
    'qwen2.5-coder',
    'gpt-oss:120b-cloud',
    'deepseek-coder-v2'
  ],
  modelMetadata: {
    'qwen2.5-coder': {
      name: 'Qwen 2.5 Coder',
      description: 'Excellent coding model with tool support (7B, ~5GB download)',
      popular: true,
      minMemoryGb: 8
    },
    'gpt-oss:120b-cloud': {
      name: 'GPT-OSS 120B (cloud)',
      description: 'OpenAI open-weight model on Ollama cloud - no local memory required',
      popular: true
      // No minMemoryGb: runs on ollama.com, not on the local machine
    },
    'deepseek-coder-v2': {
      name: 'DeepSeek Coder V2',
      description: 'Advanced coding model with tool support (16B, ~9GB download)',
      popular: true,
      minMemoryGb: 12
    }
  },
  capabilities: ['streaming', 'tools', 'embeddings', 'model-management'],
  supportsModelInstallation: true,
  healthCheckEndpoint: '/api/version',

  // Agent lifecycle hooks
  agentHooks: {
    // Wildcard hook: adjust env for ALL agents when running against Ollama.
    // Chained before each agent's own default hooks (see resolveHook).
    '*': {
      beforeRun: async (env, config) => {
        // Claude Code speaks the Anthropic Messages API, which Ollama serves
        // at the host root (https://docs.ollama.com/api/anthropic-compatibility),
        // while the profile baseUrl carries the OpenAI-compatible /v1 suffix.
        if (env.ANTHROPIC_BASE_URL) {
          env.ANTHROPIC_BASE_URL = env.ANTHROPIC_BASE_URL.replace(/\/v1\/?$/, '');

          // Ollama ignores the token but Claude Code requires it to be set.
          // A real ollama.com API key is used when configured (cloud access).
          env.ANTHROPIC_AUTH_TOKEN =
            config.apiKey && config.apiKey !== 'not-required' ? config.apiKey : 'ollama';

          // Model tiers: ollama model names never match the haiku/sonnet/opus
          // auto-selection, so route every tier to the selected model instead
          // of letting Claude Code fall back to its built-in claude-* defaults.
          if (env.CODEMIE_MODEL) {
            if (!env.ANTHROPIC_DEFAULT_HAIKU_MODEL) {
              env.ANTHROPIC_DEFAULT_HAIKU_MODEL = env.CODEMIE_MODEL;
            }
            if (!env.ANTHROPIC_DEFAULT_SONNET_MODEL) {
              env.ANTHROPIC_DEFAULT_SONNET_MODEL = env.CODEMIE_MODEL;
            }
            if (!env.ANTHROPIC_DEFAULT_OPUS_MODEL) {
              env.ANTHROPIC_DEFAULT_OPUS_MODEL = env.CODEMIE_MODEL;
            }
          }
        }

        return env;
      }
    }
  },

  setupInstructions: `
# Ollama Setup Instructions

## Installation

### macOS
Download from: https://ollama.com/download/mac

### Linux
\`\`\`bash
curl -fsSL https://ollama.com/install.sh | sh
\`\`\`

### Windows
Download from: https://ollama.com/download

## Recommended Coding Models (Tool Support Required)

**Important**: Some agents require models with function calling/tool support.

- **qwen2.5-coder**: Excellent for coding tasks with tool support (7B, ~5GB)
- **gpt-oss:120b-cloud**: OpenAI's open-weight model via Ollama cloud (120B, no download)
- **deepseek-coder-v2**: Advanced coding model with tool support (16B, ~9GB)

**Note**: Models without tool support (like codellama) will fail with agents that require function calling.

## Ollama Cloud (ollama.com)

Signed in locally via \`ollama signin\`? The local daemon authenticates cloud
models automatically - no extra configuration needed to *run* \`-cloud\` models.
The cloud model catalog is listed automatically during setup (public endpoint).

An optional API key from https://ollama.com/settings/keys additionally enables:
- Running cloud models directly on ollama.com (no local daemon required)
- Ollama's web search / web fetch API

## Documentation

- Official website: https://ollama.com
- Model library: https://ollama.com/library
- GitHub: https://github.com/ollama/ollama
`
});
