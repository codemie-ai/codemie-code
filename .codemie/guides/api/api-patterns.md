# API Patterns

## Quick Summary

API patterns for CodeMie Code: plugin architecture, provider templates, agent adapters, and LangChain integration.

**Category**: API
**Complexity**: Medium
**Prerequisites**: TypeScript, Node.js, plugin pattern basics

---

## Architecture Overview

CodeMie Code is a **CLI tool** (not a REST API server). API patterns refer to:
1. **Plugin APIs** - Agent and provider plugin interfaces
2. **LangChain/LangGraph APIs** - Built-in agent tool system
3. **HTTP Proxy** - SSO provider proxy for streaming
4. **Registry APIs** - Plugin discovery and registration

**No REST endpoints** - this guide covers internal plugin contracts and external API integration patterns.

---

## Provider Plugin API

### ProviderTemplate Interface

```typescript
// Source: src/providers/core/types.ts:48-100
export interface ProviderTemplate {
  // Identity
  name: string;                      // 'ollama', 'sso', 'bedrock'
  displayName: string;               // User-facing name
  description: string;

  // Connectivity
  defaultBaseUrl: string;            // API endpoint
  requiresAuth?: boolean;
  authType?: AuthenticationType;     // 'api-key', 'sso', 'oauth', 'none'

  // Model Configuration
  recommendedModels: string[];
  modelMetadata?: Record<string, ModelMetadata>;

  // Capabilities
  capabilities: ProviderCapability[]; // 'streaming', 'tools', 'vision', etc.
  supportsModelInstallation: boolean;

  // Custom env var export
  exportEnvVars?: (config: CodeMieConfigOptions) => Record<string, string>;

  // Lifecycle hooks (optional)
  lifecycleHooks?: ProviderLifecycleHooks;
}
```

**Pattern**: Declarative configuration over imperative code

---

## Provider Capabilities

| Capability | When to Use | Example |
|------------|-------------|---------|
| `streaming` | Provider supports SSE/streaming | OpenAI, Anthropic, SSO |
| `tools` | Supports function calling | OpenAI, Claude |
| `vision` | Accepts image inputs | Claude, GPT-4 Vision |
| `model-management` | Can install models locally | Ollama |
| `sso-auth` | Requires SSO authentication | AI/Run SSO provider |
| `json-mode` | Supports JSON output mode | OpenAI |

**Source**: src/providers/core/types.ts:13-22

---

## Agent Plugin API

### AgentAdapter Interface

```typescript
// Source: src/agents/core/types.ts (pattern)
export interface AgentAdapter {
  name: string;
  start(message?: string): Promise<void>;
  getName(): string;
}

// Base class provides common functionality
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected name: string;
  protected config: AgentPluginConfig;

  abstract start(message?: string): Promise<void>;

  // Lifecycle hooks (provider-specific)
  protected async beforeRun(env: NodeJS.ProcessEnv): Promise<NodeJS.ProcessEnv> {
    // Default implementation
    return env;
  }
}
```

**Pattern**: Template method pattern with lifecycle hooks

**Source**: src/agents/core/BaseAgentAdapter.ts

---

## Plugin Registration

### Auto-Registration Pattern

```typescript
// Source: src/providers/core/registry.ts:19-31 (pattern)
export class ProviderRegistry {
  private static providers: Map<string, ProviderTemplate> = new Map();

  static registerProvider<T extends ProviderTemplate>(template: T): T {
    this.providers.set(template.name, template);
    return template;
  }

  static getProvider(name: string): ProviderTemplate | undefined {
    return this.providers.get(name);
  }

  static listProviders(): ProviderTemplate[] {
    return Array.from(this.providers.values());
  }
}
```

**Usage** (in plugin file):
```typescript
// src/providers/plugins/ollama/ollama.template.ts
export const ollamaTemplate: ProviderTemplate = {
  name: 'ollama',
  displayName: 'Ollama',
  // ... rest of template
};

// Auto-register
ProviderRegistry.registerProvider(ollamaTemplate);
```

---

## Environment Variable Mapping

### Pattern: exportEnvVars Hook

```typescript
// Example: Bedrock provider
exportEnvVars: (config) => {
  const env: Record<string, string> = {};
  if (config.awsProfile) env.CODEMIE_AWS_PROFILE = config.awsProfile;
  if (config.awsRegion) env.CODEMIE_AWS_REGION = config.awsRegion;
  return env;
}
```

**Purpose**: Each provider defines its own environment variable transformation

**Benefits**:
- No hardcoded provider logic in core
- Provider owns its environment contract
- Extensible for new providers

**Source**: src/providers/core/types.ts:81-99

---

## HTTP Proxy Pattern (SSO Provider)

### Streaming Proxy

```typescript
// Source: src/providers/plugins/sso/proxy/proxy-http-client.ts:28-80
export class ProxyHTTPClient {
  async forward(
    url: URL,
    options: ForwardRequestOptions
  ): Promise<http.IncomingMessage> {
    // Memory-efficient streaming (no buffering)
    return new Promise((resolve, reject) => {
      const req = protocol.request(requestOptions, (res) => {
        resolve(res); // Return stream directly
      });

      if (options.body) {
        req.write(options.body);
      }
      req.end();
    });
  }
}
```

**Key Features**:
- Connection pooling (keep-alive)
- No buffering (streams directly)
- Configurable timeout (0 = unlimited for long AI requests)
- Plugin-based request/response transformation

**Source**: src/providers/plugins/sso/proxy/sso.proxy.ts

---

## Proxy Plugin System

### Plugin Interface

```typescript
// Source: src/providers/plugins/sso/proxy/plugins/types.ts (pattern)
export interface ProxyPlugin {
  name: string;

  // Request transformation
  transformRequest?(
    req: ProxyRequest,
    config: ProxyPluginConfig
  ): Promise<ProxyRequest>;

  // Response transformation
  transformResponse?(
    res: http.IncomingMessage,
    config: ProxyPluginConfig
  ): Promise<http.IncomingMessage>;
}
```

### Built-in Proxy Plugins

| Plugin | Purpose | File |
|--------|---------|------|
| **sso-auth** | Inject SSO cookies/headers | sso-auth.plugin.ts |
| **header-injection** | Add custom headers | header-injection.plugin.ts |
| **endpoint-blocker** | Block dangerous endpoints | endpoint-blocker.plugin.ts |
| **logging** | Request/response logging | logging.plugin.ts |
| **session-sync** | Sync conversation history | sso.session-sync.plugin.ts |

**Source**: src/providers/plugins/sso/proxy/plugins/

---

## Flag Transformation API

### Declarative Flag Mapping

```typescript
// Source: src/agents/core/types.ts:13-37
export interface FlagMapping {
  type: FlagMappingType;    // 'flag', 'subcommand', 'positional'
  target: string | null;
  position?: 'before' | 'after';
}

export interface FlagMappings {
  [sourceFlag: string]: FlagMapping;
}

// Example: Claude agent
flagMappings: {
  '--task': { type: 'flag', target: '-p' },
  '--profile': { type: 'flag', target: '--workspace' }
}

// Transforms: ['--task', 'hello', '--profile', 'work']
//         to: ['-p', 'hello', '--workspace', 'work']
```

**Function**: `transformFlags(args, mappings, config)`

**Source**: src/agents/core/flag-transform.ts

---

## Lifecycle Hooks

```typescript
// Source: src/agents/core/types.ts:43-50 (pattern)
export interface ProviderLifecycleHooks {
  beforeRun?: (env: NodeJS.ProcessEnv, config: AgentConfig) => Promise<NodeJS.ProcessEnv>;
}

// Usage in BaseAgentAdapter: modify env before agent starts
```

---


## Error Handling Pattern

### Structured Errors

```typescript
// Source: src/utils/errors.ts:1-66
export class CodeMieError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodeMieError';
  }
}

export class ConfigurationError extends CodeMieError {}
export class AgentNotFoundError extends CodeMieError {}
export class NpmError extends CodeMieError {
  code: NpmErrorCode;
  context: string;
  hint: string;
}

// Usage
throw new ConfigurationError('Missing API key in profile');
```

**Context Creation**:
```typescript
const context = createErrorContext(error, { sessionId, agent: 'claude' });
logger.error('Operation failed', context);
```

**Source**: src/utils/errors.ts:295-309

---

## Request/Response Patterns

### HTTP Client Pattern

```typescript
// Pattern used in proxy and session sync
interface HTTPClientOptions {
  timeout?: number;
  rejectUnauthorized?: boolean;
}

interface ForwardRequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: Buffer | string;
}

// Return streams, don't buffer
async forward(url: URL, options: ForwardRequestOptions): Promise<http.IncomingMessage>
```

**Benefits**:
- Memory efficient (no buffering)
- Connection pooling (keep-alive)
- Configurable security (rejectUnauthorized)

**Source**: src/providers/plugins/sso/proxy/proxy-http-client.ts:14-80

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use declarative templates (ProviderTemplate) | Hardcode provider logic |
| Return streams for efficiency | Buffer entire responses |
| Use lifecycle hooks for customization | Override core functionality |
| Validate inputs at plugin boundaries | Trust data from plugins |
| Use structured errors (custom error classes) | Generic `Error` everywhere |
| Document plugin contracts | Assume interface is obvious |
| Use type-safe interfaces (TypeScript) | `any` everywhere |
| Test plugins in isolation | Only integration tests |

---

## Plugin Development Checklist

**Provider Plugin**: Define template → Implement setup/health → Register → Test

**Agent Plugin**: Extend BaseAgentAdapter → Implement start() → Define flagMappings → Create installer → Test

---


## References

- **Provider Types**: `src/providers/core/types.ts`
- **Agent Types**: `src/agents/core/types.ts`
- **Provider Registry**: `src/providers/core/registry.ts`
- **Agent Registry**: `src/agents/registry.ts`
- **Base Adapter**: `src/agents/core/BaseAgentAdapter.ts`
- **HTTP Proxy**: `src/providers/plugins/sso/proxy/`
- **Flag Transform**: `src/agents/core/flag-transform.ts`
- **Error Handling**: `src/utils/errors.ts`

---

## Related Guides

- Layered Architecture: .codemie/guides/architecture/layered-architecture.md
- Project Structure: .codemie/guides/architecture/project-structure.md
- Development Practices: .codemie/guides/development/development-practices.md
- Integration Patterns: .codemie/guides/integration/external-integrations.md
