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

### Pattern 6: Auth Validation (SSO)

**Use Case**: Validate authentication before agent execution, prompt for re-auth if expired

**Why?** SSO credentials expire. Pre-flight validation prevents failed agent launches.

```typescript
export const SSOSetupSteps: ProviderSetupSteps = {
  // ... other methods ...

  /**
   * Validate SSO authentication status
   */
  async validateAuth(config: CodeMieConfigOptions): Promise<AuthValidationResult> {
    try {
      const codeMieUrl = config.providerConfig?.codeMieUrl as string;
      const sso = new CodeMieSSO();
      const credentials = await sso.getStoredCredentials(codeMieUrl);

      if (!credentials) {
        return {
          valid: false,
          error: `No SSO credentials found for ${codeMieUrl}. Please run: codemie profile login --url ${codeMieUrl}`
        };
      }

      // Test API access
      await fetchCodeMieModels(credentials.apiUrl, credentials.cookies);

      return {
        valid: true,
        expiresAt: credentials.expiresAt
      };
    } catch (error) {
      return {
        valid: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  },

  /**
   * Prompt user for re-authentication
   */
  async promptForReauth(config: CodeMieConfigOptions): Promise<boolean> {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Re-authenticate now?',
        default: true
      }
    ]);

    if (!confirm) return false;

    const sso = new CodeMieSSO();
    const result = await sso.authenticate({
      codeMieUrl: config.codeMieUrl,
      timeout: 120000
    });

    return result.success;
  }
};
```

**Integration:** AgentCLI automatically calls `validateAuth()` before spawning agent. If validation fails, it calls `promptForReauth()`.

### Pattern 7: Environment Export Hook (SSO)

**Use Case**: Transform provider-specific config to environment variables

**Why?** Different providers need different env vars. The `envExport` hook provides custom transformation.

```typescript
// Template with envExport hook
export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  // ... other fields ...

  /**
   * Custom environment variable export
   */
  envExport: (providerConfig) => {
    const env: Record<string, string> = {};

    // SSO-specific vars
    if (providerConfig.codeMieUrl) {
      env.CODEMIE_URL = String(providerConfig.codeMieUrl);
    }

    if (providerConfig.codeMieProject) {
      env.CODEMIE_PROJECT = String(providerConfig.codeMieProject);
    }

    // Integration ID for LiteLLM
    if (providerConfig.codeMieIntegration) {
      const integration = providerConfig.codeMieIntegration as { id?: string };
      if (integration.id) {
        env.CODEMIE_INTEGRATION_ID = integration.id;
      }
    }

    // SSO session config
    if (providerConfig.ssoConfig) {
      const ssoConfig = providerConfig.ssoConfig as Record<string, unknown>;
      if (ssoConfig.apiUrl) {
        env.CODEMIE_API_URL = String(ssoConfig.apiUrl);
      }
    }

    return env;
  }
});
```

**How It Works:**
1. Setup wizard stores provider-specific config in `providerConfig` field
2. During agent execution, `ConfigLoader.exportProviderEnvVars()` calls `envExport()`
3. Returned env vars are merged with standard CODEMIE_* vars
4. Agent receives complete environment

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

  // === Agent Compatibility (Unidirectional: Provider → Agent) ===
  supportedAgents?: string[];            // ['claude', 'codex'] or ['*'] for all
  unsupportedAgents?: string[];          // Explicit exclusions (overrides supportedAgents)

  // === Provider-Level Features (Infrastructure Only) ===
  supportsModelInstallation?: boolean;   // Can install models locally (e.g., Ollama)

  // === Environment Export Hook ===
  envExport?: (providerConfig: Record<string, unknown>) => Record<string, string>;

  // === Health & Setup ===
  healthCheckEndpoint?: string;          // Endpoint for health check
  setupInstructions?: string;            // Markdown installation guide

  // === Custom Extensions ===
  customProperties?: Record<string, unknown>; // Provider-specific metadata
}

/**
 * Provider setup steps interface (extended)
 */
interface ProviderSetupSteps {
  name: string;
  getCredentials(isUpdate?: boolean): Promise<ProviderCredentials>;
  fetchModels(credentials: ProviderCredentials): Promise<string[]>;
  buildConfig(credentials: ProviderCredentials, selectedModel: string): Partial<CodeMieConfigOptions>;

  // Optional methods
  installModel?(credentials: ProviderCredentials, selectedModel: string, availableModels: string[]): Promise<void>;
  validate?(config: Partial<CodeMieConfigOptions>): Promise<ValidationResult>;
  postSetup?(config: Partial<CodeMieConfigOptions>): Promise<void>;

  // Auth validation methods (for SSO, OAuth providers)
  validateAuth?(config: CodeMieConfigOptions): Promise<AuthValidationResult>;
  promptForReauth?(config: CodeMieConfigOptions): Promise<boolean>;
  getAuthStatus?(config: CodeMieConfigOptions): Promise<AuthStatus>;
}

/**
 * Auth validation result
 */
interface AuthValidationResult {
  valid: boolean;
  error?: string;
  expiresAt?: number;
}

/**
 * Auth status information
 */
interface AuthStatus {
  authenticated: boolean;
  expiresAt?: number;
  apiUrl?: string;
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
