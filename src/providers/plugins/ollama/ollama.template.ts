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
    'qwen3-vl:235b-cloud',
    'deepseek-coder-v2',
    'deepseek-v3.1:671b-cloud'
  ],
  capabilities: ['streaming', 'tools', 'embeddings', 'model-management'],
  supportsModelInstallation: true,
  healthCheckEndpoint: '/api/version',

  // Agent lifecycle hooks
  agentHooks: {
    // Codex-specific hook: Ollama uses "chat" API (not "responses")
    'codex': {
      beforeRun: async (env) => {
        env.CODEMIE_CODEX_WIRE_API = 'chat';
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

**Important**: Agents like Codex require models with function calling/tool support.

- **qwen2.5-coder**: Excellent for coding tasks with tool support (7B, ~5GB)
- **qwen3-vl:235b-cloud**: Latest Qwen with vision and tool support (235B)
- **deepseek-coder-v2**: Advanced coding model with tool support (16B, ~9GB)
- **deepseek-v3.1:671b-cloud**: Latest DeepSeek with advanced reasoning (671B)

**Note**: Models without tool support (like codellama) will fail with agents that require function calling.

## Documentation

- Official website: https://ollama.com
- Model library: https://ollama.com/library
- GitHub: https://github.com/ollama/ollama
`
});
