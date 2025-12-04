# Provider Plugin Development Guide

This guide shows you how to add new AI provider integrations to CodeMie CLI using the plugin pattern.

**Reference implementations**: `src/providers/plugins/` → `ollama/`, `sso/`, `litellm/`

## Quick Start (3 Steps)

1. **Create Provider Plugin** (`src/providers/plugins/newprovider/`)
2. **Register Components** (auto-registered via imports)
3. **Build & Test** (`npm run build && npm link`)

---

## Step 1: Create Provider Plugin

### Directory Structure

```
src/providers/plugins/newprovider/
├── index.ts                    # Main exports
├── newprovider.template.ts     # Provider metadata (required)
├── newprovider.setup-steps.ts  # Setup wizard flow (required)
├── newprovider.health.ts       # Health checks (optional)
└── newprovider.models.ts       # Model discovery (optional)
```

### Minimal Provider (Cloud API)

#### 1. Template File (`newprovider.template.ts`)

```typescript
import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

export const NewProviderTemplate = registerProvider<ProviderTemplate>({
  // === Identity ===
  name: 'newprovider',                  // Internal ID
  displayName: 'New Provider',          // User-facing name
  description: 'AI provider description',

  // === Connectivity ===
  defaultBaseUrl: 'https://api.provider.com/v1',
  requiresAuth: true,                   // Requires API key
  authType: 'api-key',                  // 'api-key' | 'sso' | 'oauth' | 'none'

  // === UI & UX ===
  priority: 20,                         // Display order (0=highest)
  defaultProfileName: 'newprovider',    // Suggested profile name

  // === Models ===
  recommendedModels: [
    'model-name-1',
    'model-name-2'
  ],

  // Optional: Enriched model metadata
  modelMetadata: {
    'model-name-1': {
      name: 'Model Display Name',
      description: 'Model description (e.g., Fast, 8K context)',
      popular: true,
      contextWindow: 8000
    }
  },

  // === Capabilities ===
  capabilities: ['streaming', 'tools', 'function-calling'],
  supportsModelInstallation: false,     // Set true for local providers
  supportsStreaming: true,

  // === Environment Variable Mapping ===
  envMapping: {
    baseUrl: ['NEWPROVIDER_BASE_URL'],
    apiKey: ['NEWPROVIDER_API_KEY'],
    model: ['NEWPROVIDER_MODEL']
  }
});
```

#### 2. Setup Steps (`newprovider.setup-steps.ts`)

```typescript
import type { ProviderSetupSteps, ProviderCredentials } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { NewProviderTemplate } from './newprovider.template.js';

export const NewProviderSetupSteps: ProviderSetupSteps = {
  name: 'newprovider',

  /**
   * Step 1: Gather credentials
   */
  async getCredentials(isUpdate = false): Promise<ProviderCredentials> {
    const inquirer = (await import('inquirer')).default;

    const { apiKey, baseUrl } = await inquirer.prompt([
      {
        type: 'input',
        name: 'baseUrl',
        message: 'Base URL:',
        default: NewProviderTemplate.defaultBaseUrl
      },
      {
        type: 'password',
        name: 'apiKey',
        message: 'API Key:',
        validate: (input: string) => input.trim() !== '' || 'API key is required'
      }
    ]);

    return { baseUrl, apiKey };
  },

  /**
   * Step 2: Fetch available models
   */
  async fetchModels(credentials: ProviderCredentials): Promise<string[]> {
    // Try to fetch from API, fallback to recommended
    try {
      const response = await fetch(`${credentials.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${credentials.apiKey}` }
      });

      if (!response.ok) {
        return NewProviderTemplate.recommendedModels;
      }

      const data = await response.json();
      return data.data?.map((m: any) => m.id) || NewProviderTemplate.recommendedModels;
    } catch {
      return NewProviderTemplate.recommendedModels;
    }
  },

  /**
   * Step 3: Build final configuration
   */
  buildConfig(credentials: ProviderCredentials, model: string): Partial<CodeMieConfigOptions> {
    return {
      provider: 'newprovider',
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model,
      timeout: 300
    };
  }
};

// Auto-register
ProviderRegistry.registerSetupSteps('newprovider', NewProviderSetupSteps);
```

#### 3. Index File (`index.ts`)

```typescript
import { ProviderRegistry } from '../../core/registry.js';
import { NewProviderSetupSteps } from './newprovider.setup-steps.js';

export { NewProviderTemplate } from './newprovider.template.js';
export { NewProviderSetupSteps } from './newprovider.setup-steps.js';

// Register setup steps
ProviderRegistry.registerSetupSteps('newprovider', NewProviderSetupSteps);
```

---

## Step 2: Optional Components

### Health Check (`newprovider.health.ts`)

```typescript
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import type { ModelInfo } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';

export class NewProviderHealthCheck extends BaseHealthCheck {
  constructor(baseUrl: string) {
    super({
      provider: 'newprovider',
      baseUrl
    });
  }

  /**
   * Ping server
   */
  protected async ping(): Promise<void> {
    await this.client.get(this.config.baseUrl);
  }

  /**
   * Get version
   */
  protected async getVersion(): Promise<string | undefined> {
    try {
      const response = await this.client.get(`${this.config.baseUrl}/version`);
      return response.version;
    } catch {
      return undefined;
    }
  }

  /**
   * List models
   */
  protected async listModels(): Promise<ModelInfo[]> {
    const response = await this.client.get(`${this.config.baseUrl}/models`);
    return response.data?.map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description
    })) || [];
  }
}

// Auto-register
ProviderRegistry.registerHealthCheck('newprovider', new NewProviderHealthCheck(''));
```

### Model Fetcher (`newprovider.models.ts`)

```typescript
import type { ProviderModelFetcher, ModelInfo } from '../../core/types.js';
import type { CodeMieConfigOptions } from '../../../env/types.js';
import { ProviderRegistry } from '../../core/registry.js';

export class NewProviderModelProxy implements ProviderModelFetcher {
  constructor(private baseUrl: string) {}

  supports(provider: string): boolean {
    return provider === 'newprovider';
  }

  async fetchModels(config: CodeMieConfigOptions): Promise<ModelInfo[]> {
    const response = await fetch(`${this.baseUrl}/models`, {
      headers: {
        'Authorization': `Bearer ${config.apiKey}`
      }
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = await response.json();
    return data.data?.map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      description: m.description,
      contextWindow: m.context_length
    })) || [];
  }
}

// Auto-register
ProviderRegistry.registerModelProxy('newprovider', new NewProviderModelProxy(''));
```

---

## Step 3: Import Provider

Add to `src/providers/index.ts`:

```typescript
// New Provider
import './plugins/newprovider/index.js';
```

---

## Real-World Patterns

### Pattern 1: Local Provider with Model Installation (Ollama)

**Use Case**: Provider runs locally and supports model installation

```typescript
// Template
export const OllamaTemplate = registerProvider<ProviderTemplate>({
  name: 'ollama',
  defaultPort: 11434,
  defaultBaseUrl: 'http://localhost:11434',
  requiresAuth: false,                    // No API key needed
  authType: 'none',
  supportsModelInstallation: true,        // Can install models
  capabilities: ['streaming', 'tools', 'embeddings', 'model-management']
});

// Setup Steps
export const OllamaSetupSteps: ProviderSetupSteps = {
  async getCredentials(): Promise<ProviderCredentials> {
    // Check if Ollama is running
    const healthCheck = new OllamaHealthCheck(baseUrl);
    const result = await healthCheck.check(config);

    if (result.status === 'unreachable') {
      // Show installation instructions
    }

    return { baseUrl, apiKey: '' };
  },

  async installModel(credentials, selectedModel, availableModels): Promise<void> {
    // Check if model is installed
    const isInstalled = availableModels.includes(selectedModel);

    if (!isInstalled) {
      // Pull model from Ollama library
      await modelProxy.installModel(selectedModel);
    }
  }
};
```

### Pattern 2: SSO Authentication (AI-Run SSO)

**Use Case**: Provider requires SSO login flow

```typescript
// Template
export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  requiresAuth: true,
  authType: 'sso',                        // SSO authentication
  capabilities: ['streaming', 'tools', 'sso-auth']
});

// Setup Steps
export const SSOSetupSteps: ProviderSetupSteps = {
  async getCredentials(): Promise<ProviderCredentials> {
    // Open browser for SSO login
    const ssoAuth = new CodeMieSSO({
      codeMieUrl: baseUrl,
      timeout: 60000
    });

    const result = await ssoAuth.authenticate();

    if (!result.success) {
      throw new Error('SSO authentication failed');
    }

    // Store cookies and API URL
    return {
      baseUrl: result.apiUrl,
      apiKey: result.cookies?.session || '',
      additionalConfig: {
        cookies: result.cookies
      }
    };
  }
};
```

### Pattern 3: Universal Proxy (LiteLLM)

**Use Case**: Gateway to multiple providers

```typescript
export const LiteLLMTemplate = registerProvider<ProviderTemplate>({
  name: 'litellm',
  displayName: 'LiteLLM',
  description: 'Universal gateway to 100+ LLM providers',
  requiresAuth: false,                    // Optional auth
  envMapping: {
    // Support all common env vars
    baseUrl: ['OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL', 'GOOGLE_GEMINI_BASE_URL'],
    apiKey: ['OPENAI_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'GEMINI_API_KEY'],
    model: ['OPENAI_MODEL', 'ANTHROPIC_MODEL', 'GEMINI_MODEL']
  }
});
```

### Pattern 4: Model Metadata Enrichment

**Use Case**: Show helpful model information in setup wizard

```typescript
export const NewProviderTemplate = registerProvider<ProviderTemplate>({
  recommendedModels: [
    'qwen2.5-coder',
    'codellama'
  ],
  modelMetadata: {
    'qwen2.5-coder': {
      name: 'Qwen 2.5 Coder',
      description: 'Excellent for coding tasks (7B, ~5GB)',
      popular: true,
      contextWindow: 32768,
      pricing: {
        input: 0.0001,   // Per token
        output: 0.0002
      }
    },
    'codellama': {
      name: 'Code Llama',
      description: 'Optimized for code generation (7B, ~3.8GB)',
      contextWindow: 16384
    }
  }
});
```

### Pattern 5: Custom Validation

**Use Case**: Validate configuration before saving

```typescript
export const NewProviderSetupSteps: ProviderSetupSteps = {
  // ... other methods ...

  async validate(config: Partial<CodeMieConfigOptions>): Promise<ValidationResult> {
    const errors: string[] = [];

    // Validate API key format
    if (config.apiKey && !config.apiKey.startsWith('sk-')) {
      errors.push('API key must start with "sk-"');
    }

    // Validate base URL
    if (config.baseUrl && !config.baseUrl.startsWith('https://')) {
      errors.push('Base URL must use HTTPS');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }
};
```

---

## Testing Your Provider

```bash
# Build and link for local development
npm run build && npm link

# Test setup wizard
codemie setup
# Select "Add new profile"
# Choose your new provider from the list

# Test with built-in agent
codemie-code --profile your-profile "test prompt"

# Test with external agents
codemie-claude --profile your-profile "test prompt"

# Test doctor health check (if health check implemented)
codemie doctor
```

---

## Validation Checklist

Before submitting:

- ✅ Provider directory follows naming: `src/providers/plugins/{name}/`
- ✅ Template file defines `ProviderTemplate` with auto-registration
- ✅ Setup steps implement `ProviderSetupSteps` interface
- ✅ Index file exports and registers components
- ✅ Provider imported in `src/providers/index.ts`
- ✅ Environment variables documented in `envMapping`
- ✅ Recommended models provided
- ✅ Setup wizard works (`codemie setup`)
- ✅ Provider appears in setup wizard list
- ✅ Health check works if implemented (`codemie doctor`)
- ✅ ESLint passes (`npm run lint`)
- ✅ Builds successfully (`npm run build`)

---

## Architecture Benefits

✅ **Auto-Discovery**: Registered via imports, no central file modifications
✅ **Type-Safe**: Full TypeScript support with `ProviderTemplate` interface
✅ **Modular**: Each provider is self-contained in its directory
✅ **Extensible**: Add health checks, model proxies without modifying core
✅ **Reusable Logic**: `BaseHealthCheck` handles common patterns

---

## ProviderTemplate Interface Reference

```typescript
interface ProviderTemplate {
  // === Identity ===
  name: string;                          // Internal ID (e.g., 'ollama')
  displayName: string;                   // User-facing name (e.g., 'Ollama')
  description: string;                   // Short description

  // === Connectivity ===
  defaultPort?: number;                  // Default port (e.g., 11434)
  defaultBaseUrl: string;                // Default API endpoint
  requiresAuth?: boolean;                // Whether auth is required (default: false)
  authType?: AuthenticationType;         // 'api-key' | 'sso' | 'oauth' | 'none'

  // === UI & UX ===
  priority?: number;                     // Display order (0=highest)
  defaultProfileName?: string;           // Suggested profile name

  // === Model Configuration ===
  recommendedModels: string[];           // Default models
  modelMetadata?: Record<string, ModelMetadata>; // Enriched info

  // === Capabilities ===
  capabilities: ProviderCapability[];    // Supported features
  supportsModelInstallation: boolean;    // Can install models locally
  supportsStreaming?: boolean;           // Streaming support (default: true)

  // === Environment Variable Mapping ===
  envMapping?: {
    baseUrl?: string[];                  // Env var fallback chain
    apiKey?: string[];
    model?: string[];
  };

  // === Health & Setup ===
  healthCheckEndpoint?: string;          // Endpoint for health check
  setupInstructions?: string;            // Markdown installation guide

  // === Custom Extensions ===
  customProperties?: Record<string, unknown>; // Provider-specific data
}
```

---

## Troubleshooting

### Provider not appearing in setup wizard
- Check import in `src/providers/index.ts`
- Verify `registerProvider()` is called on template
- Run `npm run build` after changes

### Health check fails
- Verify health check endpoint is correct
- Check timeout configuration (default: 5000ms)
- Test manual API call: `curl http://localhost:port/endpoint`

### Model fetching fails
- Check API endpoint in `fetchModels()`
- Verify API key/authentication
- Fallback to `recommendedModels` on error

### Setup wizard validation errors
- Implement `validate()` method in setup steps
- Provide clear error messages
- Test all input edge cases

---

## Examples

See existing plugins for complete examples:
- **Ollama** (`ollama/`): Local provider with model installation
- **AI-Run SSO** (`sso/`): SSO authentication flow with browser login
- **LiteLLM** (`litellm/`): Universal proxy with minimal setup
