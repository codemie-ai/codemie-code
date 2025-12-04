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
  recommendedModels: [
    'qwen2.5-coder',
    'codellama',
    'deepseek-coder-v2'
  ],
  modelMetadata: {
    'qwen2.5-coder': {
      name: 'Qwen 2.5 Coder',
      description: 'Excellent for coding tasks (7B, ~5GB)',
    },
    'codellama': {
      name: 'Code Llama',
      description: 'Optimized for code generation (7B, ~3.8GB)',
    },
    'deepseek-coder-v2': {
      name: 'DeepSeek Coder V2',
      description: 'Advanced coding model (16B, ~9GB)',
    }
  },
  capabilities: ['streaming', 'tools', 'embeddings', 'model-management'],
  supportsModelInstallation: true,
  envMapping: {
    baseUrl: ['OPENAI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY'],
    model: ['OPENAI_MODEL']
  },
  healthCheckEndpoint: '/api/tags',
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

## Starting Ollama

Ollama runs as a background service after installation.

### Verify Running
\`\`\`bash
curl http://localhost:11434/api/tags
\`\`\`

### Using CodeMie
\`\`\`bash
codemie models install ollama/llama3.2
codemie models list ollama
\`\`\`

## Recommended Coding Models (16GB RAM Compatible)

- **qwen2.5-coder**: Excellent for coding tasks (7B parameters, ~5GB)
- **codellama**: Optimized for code generation (7B parameters, ~3.8GB)
- **deepseek-coder-v2**: Advanced coding model (16B parameters, ~9GB)

## Documentation

- Official website: https://ollama.com
- Model library: https://ollama.com/library
- GitHub: https://github.com/ollama/ollama
`
});
