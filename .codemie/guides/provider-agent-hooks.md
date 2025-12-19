# Provider-Agent Lifecycle Hooks Architecture

This guide explains how to add provider-specific hooks without hardcoding provider logic in agent code, maintaining **loose coupling** and **pluggability**.

## Architecture Principles

### ✅ Loose Coupling Achieved Through:

1. **Providers own their customization logic** (not agents)
2. **Runtime resolution** (no compile-time dependencies)
3. **Declarative metadata** (data-driven, not code-driven)
4. **Zero hardcoded provider names** in agent code

### Hook Resolution Priority

```
1. Provider Plugin's Agent Hook (highest priority)
   └─> ProviderTemplate.agentHooks[agentName].hookName

2. Agent's Default Hook (fallback)
   └─> AgentMetadata.lifecycle.hookName
```

---

## How to Add Provider-Specific Hooks

### Step 1: Provider Plugin Registers Hooks for Agents

Providers declare which agents they need to customize:

```typescript
// src/providers/plugins/bedrock/bedrock.template.ts

import { registerProvider } from '../../core/decorators.js';
import type { ProviderTemplate } from '../../core/types.js';

export const BedrockTemplate = registerProvider<ProviderTemplate>({
  name: 'bedrock',
  displayName: 'AWS Bedrock',
  description: 'AWS Bedrock - Claude models via AWS',

  defaultBaseUrl: 'https://bedrock-runtime.us-east-1.amazonaws.com',
  requiresAuth: true,
  authType: 'none', // Uses AWS credentials

  recommendedModels: ['claude-4-5-sonnet', 'claude-4-opus'],
  capabilities: ['streaming', 'tools'],
  supportsModelInstallation: false,

  // Provider registers hooks for agents it needs to customize
  agentHooks: {
    // Claude-specific Bedrock setup
    'claude': {
      async beforeRun(env, config) {
        // Enable Bedrock integration
        env.CLAUDE_CODE_USE_BEDROCK = '1';

        // Set AWS region (REQUIRED - Claude Code doesn't read .aws config)
        if (env.CODEMIE_AWS_REGION) {
          env.AWS_REGION = env.CODEMIE_AWS_REGION;
          env.AWS_DEFAULT_REGION = env.CODEMIE_AWS_REGION;
        }

        // Set AWS credentials
        if (env.CODEMIE_AWS_PROFILE) {
          env.AWS_PROFILE = env.CODEMIE_AWS_PROFILE;
        } else if (env.CODEMIE_API_KEY && env.CODEMIE_AWS_SECRET_ACCESS_KEY) {
          env.AWS_ACCESS_KEY_ID = env.CODEMIE_API_KEY;
          env.AWS_SECRET_ACCESS_KEY = env.CODEMIE_AWS_SECRET_ACCESS_KEY;
        }

        // Set model
        if (env.CODEMIE_MODEL) {
          env.ANTHROPIC_MODEL = env.CODEMIE_MODEL;
        }

        // Set output token settings (if configured)
        if (env.CODEMIE_MAX_OUTPUT_TOKENS) {
          env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = env.CODEMIE_MAX_OUTPUT_TOKENS;
        }

        return env;
      }
    }
  }
});
```

### Step 2: Agent Plugin Stays Provider-Agnostic

Agents define ONLY default behavior - no provider knowledge:

```typescript
// src/agents/plugins/claude.plugin.ts

export const ClaudePluginMetadata: AgentMetadata = {
  name: 'claude',
  displayName: 'Claude Code',
  // ... metadata ...

  lifecycle: {
    // ONLY default hooks - no provider-specific logic!
    async beforeRun(env) {
      // Common setup for ALL providers
      env.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = '1';
      env.CLAUDE_CODE_ENABLE_TELEMETRY = '0';
      return env;
    }

    // NO hardcoded provider names here!
    // NO if/else chains for providers!
    // Provider-specific logic is in provider plugins!
  }
};
```

### Step 3: Runtime Resolution (Zero Configuration)

The `lifecycle-helpers.ts` module resolves hooks automatically:

```typescript
// Executed by BaseAgentAdapter.run()
env = await executeBeforeRun(
  this,
  this.metadata.lifecycle,
  this.metadata.name, // agentName
  env,
  config
);

// Inside executeBeforeRun:
function resolveHook(lifecycle, hookName, provider, agentName) {
  // 1. Check if provider registered a hook for this agent
  const providerPlugin = ProviderRegistry.getProvider(provider);
  const providerHook = providerPlugin?.agentHooks?.[agentName]?.[hookName];

  if (providerHook) {
    return providerHook; // Provider customization wins
  }

  // 2. Fall back to agent's default hook
  return lifecycle?.[hookName];
}
```

**Result**: Provider hooks override agent defaults at runtime, with zero hardcoded logic!

---

## Real-World Examples

### Example 1: AI-Run SSO Provider with Session Tracking

```typescript
// src/providers/plugins/sso/sso.template.ts

const sessionHandlers = new Map<string, MetricsLifecycleHandler>();

export const SSOTemplate = registerProvider<ProviderTemplate>({
  name: 'ai-run-sso',
  displayName: 'CodeMie SSO',
  authType: 'sso',

  agentHooks: {
    // Claude-specific SSO session lifecycle
    'claude': {
      async onSessionStart(sessionId, env) {
        if (!env.CODEMIE_BASE_URL) return;

        // Create lifecycle handler
        const handler = await createSSOLifecycleHandler(
          env.CODEMIE_BASE_URL,
          env.CODEMIE_CLI_VERSION,
          'codemie-claude'
        );

        if (handler) {
          sessionHandlers.set(sessionId, handler);
          await handler.sendSessionStart({ sessionId, agentName: 'claude', ... });
        }
      },

      async onSessionEnd(exitCode, env) {
        const sessionId = env.CODEMIE_SESSION_ID;
        const handler = sessionHandlers.get(sessionId);

        if (handler) {
          await handler.sendSessionEnd(exitCode);
          sessionHandlers.delete(sessionId);
        }
      }
    },

    // Codex-specific SSO hooks (if needed)
    'codex': {
      // ... codex-specific SSO logic
    }
  }
});
```

### Example 2: Ollama Provider with Model Installation

```typescript
// src/providers/plugins/ollama/ollama.template.ts

export const OllamaTemplate = registerProvider<ProviderTemplate>({
  name: 'ollama',
  displayName: 'Ollama',
  supportsModelInstallation: true,

  agentHooks: {
    // Codex-specific: check/install models before running
    'codex': {
      async beforeRun(env, config) {
        const model = config.model || 'qwen2.5-coder';

        // Check if model exists locally
        const modelExists = await checkOllamaModel(model);

        if (!modelExists) {
          console.log(`Installing Ollama model: ${model}`);
          await exec('ollama', ['pull', model], { timeout: 300000 });
        }

        return env;
      }
    },

    // Claude doesn't need model installation
    // (no hook registered)
  }
});
```

### Example 3: LiteLLM Provider with API Key Validation

```typescript
// src/providers/plugins/litellm/litellm.template.ts

export const LiteLLMTemplate = registerProvider<ProviderTemplate>({
  name: 'litellm',
  displayName: 'LiteLLM',
  description: 'Universal gateway to 100+ LLM providers',

  agentHooks: {
    // All agents: validate API key format
    'claude': {
      async beforeRun(env, config) {
        if (env.CODEMIE_API_KEY && !env.CODEMIE_API_KEY.startsWith('sk-')) {
          throw new Error('LiteLLM requires API key starting with sk-');
        }
        return env;
      }
    },

    'codex': {
      async beforeRun(env, config) {
        if (env.CODEMIE_API_KEY && !env.CODEMIE_API_KEY.startsWith('sk-')) {
          throw new Error('LiteLLM requires API key starting with sk-');
        }
        return env;
      }
    }

    // Can share logic via helper function:
    // 'claude': { beforeRun: validateLiteLLMKey },
    // 'codex': { beforeRun: validateLiteLLMKey }
  }
});
```

---

## Available Lifecycle Hooks

| Hook | Timing | Use Case |
|------|--------|----------|
| `onSessionStart` | Before env transformation | Early session setup, registration |
| `beforeRun` | After env transformation, before execution | Config files, directories, env vars |
| `enrichArgs` | After beforeRun, before agent spawn | Inject CLI arguments |
| `onSessionEnd` | After agent exits, before cleanup | Session telemetry, metrics |
| `afterRun` | After onSessionEnd, at end of lifecycle | Final cleanup, post-processing |

---

## Benefits of This Architecture

### ✅ Loose Coupling
- **Agents** never know about specific providers
- **Providers** declare what they need from agents
- **Runtime resolution** provides dynamic behavior

### ✅ Pluggability
- Add new provider → register hooks in provider plugin
- Add new agent → providers can opt-in to customize
- No modifications to existing code required

### ✅ Single Responsibility
- **Agents** own default behavior
- **Providers** own provider-specific customizations
- **Registry** owns resolution logic

### ✅ Testability
- Test agent hooks independently (no provider mocks)
- Test provider hooks independently (no agent mocks)
- Test resolution logic in isolation

---

## Migration Pattern: Remove Hardcoded Provider Logic

### ❌ Before (Hardcoded in Agent)

```typescript
// Agent knows about all providers (tight coupling)
export const ClaudePluginMetadata: AgentMetadata = {
  lifecycle: {
    async beforeRun(env) {
      if (env.CODEMIE_PROVIDER === 'bedrock') {
        env.CLAUDE_CODE_USE_BEDROCK = '1';
        // ... bedrock setup
      }

      if (env.CODEMIE_PROVIDER === 'ai-run-sso') {
        // ... sso setup
      }

      // Adding new provider requires modifying this code!
      return env;
    }
  }
};
```

### ✅ After (Provider Owns Logic)

```typescript
// Agent is provider-agnostic (loose coupling)
export const ClaudePluginMetadata: AgentMetadata = {
  lifecycle: {
    async beforeRun(env) {
      // ONLY default behavior
      env.CLAUDE_CODE_DISABLE_BETAS = '1';
      return env;
    }
  }
};

// Provider registers its own hooks
export const BedrockTemplate: ProviderTemplate = {
  agentHooks: {
    'claude': {
      async beforeRun(env) {
        env.CLAUDE_CODE_USE_BEDROCK = '1';
        // ... bedrock setup
        return env;
      }
    }
  }
};

// Adding new provider = create new provider plugin
// NO changes to agent code required!
```

---

## Complete Example: Adding a New Provider

Let's add `azure-openai` provider that needs special header injection for Claude:

### 1. Create Provider Plugin

```typescript
// src/providers/plugins/azure-openai/azure-openai.template.ts

export const AzureOpenAITemplate = registerProvider<ProviderTemplate>({
  name: 'azure-openai',
  displayName: 'Azure OpenAI',
  defaultBaseUrl: 'https://{resource}.openai.azure.com',
  requiresAuth: true,
  authType: 'api-key',

  recommendedModels: ['gpt-4', 'gpt-4-turbo'],
  capabilities: ['streaming', 'tools'],
  supportsModelInstallation: false,

  // Register hooks for agents that need Azure-specific setup
  agentHooks: {
    'claude': {
      async beforeRun(env, config) {
        // Set Azure-specific deployment name
        if (config.model) {
          env.AZURE_DEPLOYMENT_NAME = config.model;
        }

        // Azure requires api-version in URL
        if (env.CODEMIE_BASE_URL && !env.CODEMIE_BASE_URL.includes('api-version')) {
          env.CODEMIE_BASE_URL += '?api-version=2024-02-15-preview';
        }

        return env;
      }
    },

    'codex': {
      async beforeRun(env, config) {
        // Codex needs different Azure configuration
        env.AZURE_OPENAI_DEPLOYMENT = config.model;
        return env;
      }
    }

    // Gemini doesn't need Azure hooks (no entry = uses default)
  }
});
```

### 2. Import Provider Plugin

```typescript
// src/providers/index.ts

// Existing providers
import './plugins/ollama/index.js';
import './plugins/sso/index.js';
import './plugins/litellm/index.js';

// NEW: Import Azure OpenAI (auto-registers)
import './plugins/azure-openai/index.js';
```

### 3. Done! Zero Agent Changes

```typescript
// src/agents/plugins/claude.plugin.ts
// NO CHANGES NEEDED - agent remains provider-agnostic!

export const ClaudePluginMetadata: AgentMetadata = {
  lifecycle: {
    async beforeRun(env) {
      env.CLAUDE_CODE_DISABLE_BETAS = '1';
      return env;
    }
  }
};
```

**Result**: Azure-specific hooks execute automatically when `CODEMIE_PROVIDER=azure-openai`, with zero modifications to agent code!

---

## Architecture Diagram

```
┌──────────────────────────────────────────────────────┐
│         BaseAgentAdapter.run()                       │
│  ┌──────────────────────────────────────────────┐   │
│  │ executeBeforeRun(lifecycle, agentName, ...) │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
                      │
                      ▼
┌──────────────────────────────────────────────────────┐
│      lifecycle-helpers.ts (Runtime Resolver)         │
│  ┌──────────────────────────────────────────────┐   │
│  │ resolveHook(lifecycle, hookName, provider,   │   │
│  │             agentName)                        │   │
│  │   1. Check ProviderRegistry                   │   │
│  │   2. Fall back to agent default               │   │
│  └──────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────┘
        │                              │
        ▼                              ▼
┌─────────────────┐         ┌──────────────────────────┐
│ ProviderRegistry│         │   AgentMetadata          │
│                 │         │                          │
│ getProvider()   │         │   lifecycle: {           │
│ ├─ bedrock      │         │     beforeRun: defaultFn │
│ ├─ ai-run-sso   │         │   }                      │
│ └─ ollama       │         └──────────────────────────┘
│                 │
│ Each provider   │
│ has agentHooks: │
│ {               │
│   'claude': {   │
│     beforeRun   │
│   }             │
│ }               │
└─────────────────┘
```

**Key**: Provider plugins and agent plugins never directly reference each other - runtime registry resolves hooks dynamically!

---

## Summary

### Architectural Principles Achieved:

✅ **Loose Coupling**: Agents and providers are independent
✅ **Pluggability**: Add providers without modifying agents
✅ **Separation of Concerns**: Each component owns its logic
✅ **Open/Closed**: Open for extension, closed for modification
✅ **Single Responsibility**: One clear job per module
✅ **Dependency Inversion**: Core depends on abstractions, not concrete implementations

**Result**: True plugin architecture where components can be added, removed, or modified independently!
