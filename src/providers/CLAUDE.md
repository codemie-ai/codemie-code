# Provider System Development Guide

This guide provides comprehensive documentation for developing AI provider integrations in the CodeMie CLI.

**Context**: This file is loaded automatically when working in `src/providers/**`. It contains complete guidance for provider plugin development, agent hooks, and integration patterns.

---

## Overview

The Provider System uses a **plugin-based architecture with agent hooks** that enables:
- Agent customization without modifying agent code
- Wildcard hooks that apply to ALL agents
- Agent-specific hooks for fine-grained control
- Automatic hook chaining (wildcard → agent-specific)
- Zero hardcoded provider names in agent code

---

## Core Architecture

### Core Components (`core/`)

- **ProviderTemplate**: Declarative metadata interface with hook registration
- **ProviderRegistry** (`registry.ts`): Centralized provider registration with auto-discovery
- **BaseHealthCheck**: Shared health check implementation
- **BaseModelProxy**: Model fetching abstraction

### Provider Plugins (`plugins/`)

Self-contained implementations with agent customization:
- **`ollama/`**: Local provider with model installation support
- **`sso/`**: Enterprise SSO with browser-based authentication and metrics sync (wildcard hook for all agents)
- **`litellm/`**: Universal proxy gateway to 100+ providers
- **`bedrock/`**: AWS Bedrock with credential management (wildcard + Claude-specific hooks)

### Pluggable Extensions

- **Environment Export** (`exportEnvVars`): Provider-specific env variable export
- **Agent Hooks** (`agentHooks`): Provider registers lifecycle hooks for agents
  - Wildcard hooks (`'*'`): Apply to ALL agents (e.g., AWS credential transformation)
  - Agent-specific hooks (`'claude'`, `'codex'`): Customize behavior per agent
  - Automatic chaining: Wildcard runs first, agent-specific runs second

---

## Critical Principle: Agent Customization via Hooks

**Providers own agent customization logic via hooks. Agents remain provider-agnostic.**

### When to Use Agent Hooks

Use agent hooks when:
- ✅ Agent requires provider-specific environment variables
- ✅ Agent needs credential transformation (e.g., AWS credentials)
- ✅ Provider requires special agent configuration (e.g., Bedrock mode)
- ✅ Provider sends session metrics for all agents (e.g., SSO)

Don't use agent hooks when:
- ❌ Standard `exportEnvVars` is sufficient
- ❌ Agent already handles provider via standard env vars
- ❌ No agent-specific customization needed

### Lifecycle Hook Types

- `onSessionStart(sessionId, env)` - Send session start metrics, early initialization
- `beforeRun(env, config)` - Transform environment, enable provider-specific modes
- `enrichArgs(args, config)` - Inject CLI arguments (rarely needed)
- `onSessionEnd(exitCode, env)` - Send session end metrics, cleanup
- `afterRun(exitCode, env)` - Final cleanup (rarely needed)

---

## Adding New Providers (4 Steps)

### Step 1: Create Template File

**File**: `src/providers/plugins/newprovider/newprovider.template.ts`

```typescript
import type { ProviderTemplate } from '../../core/types.js';
import { registerProvider } from '../../core/decorators.js';

export const NewProviderTemplate = registerProvider<ProviderTemplate>({
  name: 'newprovider',
  displayName: 'New Provider',
  description: 'AI provider description',

  defaultBaseUrl: 'https://api.provider.com/v1',
  requiresAuth: true,
  authType: 'api-key',
  priority: 20,

  recommendedModels: ['model-1', 'model-2'],
  capabilities: ['streaming', 'tools'],

  envMapping: {
    baseUrl: ['NEWPROVIDER_BASE_URL'],
    apiKey: ['NEWPROVIDER_API_KEY'],
    model: ['NEWPROVIDER_MODEL']
  },

  // Pluggable environment export
  exportEnvVars: (config) => {
    const env: Record<string, string> = {};
    if (config.customField) env.CODEMIE_CUSTOM = config.customField;
    return env;
  },

  // Agent hooks (optional)
  agentHooks: {
    '*': {  // Wildcard: ALL agents
      beforeRun: async (env, config) => {
        env.PROVIDER_VAR = 'value';
        return env;
      }
    },
    'claude': {  // Agent-specific
      beforeRun: async (env, config) => {
        env.CLAUDE_CODE_USE_PROVIDER = '1';
        return env;
      }
    }
  }
});
```

### Step 2: Create Setup Steps

**File**: `src/providers/plugins/newprovider/newprovider.setup-steps.ts`

```typescript
import type { ProviderSetupSteps, ProviderCredentials } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';
import { NewProviderTemplate } from './newprovider.template.js';

export const NewProviderSetupSteps: ProviderSetupSteps = {
  name: 'newprovider',

  async getCredentials(): Promise<ProviderCredentials> {
    const inquirer = (await import('inquirer')).default;
    const { apiKey, baseUrl } = await inquirer.prompt([
      { type: 'input', name: 'baseUrl', default: NewProviderTemplate.defaultBaseUrl },
      { type: 'password', name: 'apiKey', validate: (v) => v.trim() !== '' }
    ]);
    return { baseUrl, apiKey };
  },

  async fetchModels(credentials): Promise<string[]> {
    try {
      const response = await fetch(`${credentials.baseUrl}/models`, {
        headers: { 'Authorization': `Bearer ${credentials.apiKey}` }
      });
      const data = await response.json();
      return data.data?.map((m: any) => m.id) || NewProviderTemplate.recommendedModels;
    } catch {
      return NewProviderTemplate.recommendedModels;
    }
  },

  buildConfig(credentials, model) {
    return {
      provider: 'newprovider',
      baseUrl: credentials.baseUrl,
      apiKey: credentials.apiKey,
      model,
      timeout: 300
    };
  }
};

ProviderRegistry.registerSetupSteps('newprovider', NewProviderSetupSteps);
```

### Step 3: Create Index File

**File**: `src/providers/plugins/newprovider/index.ts`

```typescript
export { NewProviderTemplate } from './newprovider.template.js';
export { NewProviderSetupSteps } from './newprovider.setup-steps.js';
```

### Step 4: Import Provider

Add to `src/providers/index.ts`:

```typescript
import './plugins/newprovider/index.js';
```

---

## Real-World Patterns

### Pattern 1: Local Provider (Ollama)

```typescript
export const OllamaTemplate = registerProvider<ProviderTemplate>({
  name: 'ollama',
  defaultBaseUrl: 'http://localhost:11434',
  requiresAuth: false,
  authType: 'none',
  supportsModelInstallation: true  // Can install models locally
});
```

### Pattern 2: SSO Authentication (AI-Run SSO)

```typescript
export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  authType: 'sso',
  agentHooks: {
    '*': {  // Send metrics for ALL agents
      onSessionEnd: async (exitCode, env) => {
        await syncMetrics(env.SESSION_ID);
      }
    }
  }
});
```

### Pattern 3: AWS Bedrock (Wildcard + Agent-Specific)

```typescript
export const BedrockTemplate = registerProvider<ProviderTemplate>({
  name: 'bedrock',
  exportEnvVars: (config) => ({
    CODEMIE_AWS_PROFILE: config.awsProfile,
    CODEMIE_AWS_REGION: config.awsRegion
  }),
  agentHooks: {
    '*': {  // Wildcard: Transform for ALL agents
      beforeRun: async (env, config) => {
        if (env.CODEMIE_AWS_PROFILE) env.AWS_PROFILE = env.CODEMIE_AWS_PROFILE;
        if (env.CODEMIE_AWS_REGION) env.AWS_REGION = env.CODEMIE_AWS_REGION;
        return env;
      }
    },
    'claude': {  // Agent-specific: Enable Bedrock mode
      beforeRun: async (env, config) => {
        env.CLAUDE_CODE_USE_BEDROCK = '1';
        return env;
      }
    }
  }
});
```

### Pattern 4: Model Metadata Enrichment

```typescript
modelMetadata: {
  'qwen2.5-coder': {
    name: 'Qwen 2.5 Coder',
    description: 'Excellent for coding (7B, ~5GB)',
    popular: true,
    contextWindow: 32768,
    pricing: { input: 0.0001, output: 0.0002 }
  }
}
```

---

## Optional Components

### Health Check (Optional)

**File**: `src/providers/plugins/newprovider/newprovider.health.ts`

```typescript
import { BaseHealthCheck } from '../../core/base/BaseHealthCheck.js';
import { ProviderRegistry } from '../../core/registry.js';

export class NewProviderHealthCheck extends BaseHealthCheck {
  constructor(baseUrl: string) {
    super({ provider: 'newprovider', baseUrl });
  }

  protected async ping(): Promise<void> {
    await this.client.get(this.config.baseUrl);
  }

  protected async listModels(): Promise<ModelInfo[]> {
    const response = await this.client.get(`${this.config.baseUrl}/models`);
    return response.data?.map((m: any) => ({ id: m.id, name: m.name })) || [];
  }
}

ProviderRegistry.registerHealthCheck('newprovider', new NewProviderHealthCheck(''));
```

### Model Fetcher (Optional)

**File**: `src/providers/plugins/newprovider/newprovider.models.ts`

```typescript
import type { ProviderModelFetcher } from '../../core/types.js';
import { ProviderRegistry } from '../../core/registry.js';

export class NewProviderModelProxy implements ProviderModelFetcher {
  supports(provider: string): boolean {
    return provider === 'newprovider';
  }

  async fetchModels(config): Promise<ModelInfo[]> {
    const response = await fetch(`${config.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${config.apiKey}` }
    });
    const data = await response.json();
    return data.data?.map((m: any) => ({
      id: m.id,
      name: m.name || m.id,
      contextWindow: m.context_length
    })) || [];
  }
}

ProviderRegistry.registerModelProxy('newprovider', new NewProviderModelProxy());
```

---

## Testing

```bash
# Build and test locally
npm run build && npm link

# Test setup wizard
codemie setup  # Select your new provider

# Test with agents
codemie-code --profile your-profile "test"
codemie-claude --profile your-profile "test"

# Test health check (if implemented)
codemie doctor
```

---

## Validation Checklist

Before submitting:

- ✅ Directory: `src/providers/plugins/{name}/`
- ✅ Template with `registerProvider()` decorator
- ✅ Setup steps with `ProviderSetupSteps` interface
- ✅ Index file exports components
- ✅ Imported in `src/providers/index.ts`
- ✅ Environment variables in `envMapping`
- ✅ Recommended models provided
- ✅ Setup wizard works (`codemie setup`)
- ✅ Provider appears in setup list
- ✅ ESLint passes (`npm run lint`)
- ✅ Build succeeds (`npm run build`)

---

## Reference Implementations

Study these plugins:
- **`ollama/`**: Local provider with model installation
- **`sso/`**: SSO auth with wildcard metrics hook
- **`litellm/`**: Universal proxy
- **`bedrock/`**: Wildcard + agent-specific hooks

---

## Architecture Benefits

✅ **Auto-Discovery**: Registered via imports, no central file modifications
✅ **Type-Safe**: Full TypeScript support with `ProviderTemplate`
✅ **Modular**: Self-contained in plugin directory
✅ **Extensible**: Add health checks, model proxies without modifying core
✅ **Zero Coupling**: Agents remain provider-agnostic via runtime hooks
