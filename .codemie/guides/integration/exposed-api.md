# Exposed API

## Quick Summary

Public API classes and methods exposed by CodeMie Code for external integration: SSO authentication, HTTP proxy, plugin registry, hook event processing, and configuration management.

**Category**: Integration
**Complexity**: Medium
**Prerequisites**: TypeScript/JavaScript, async/await, HTTP concepts

---

## Exposed Classes & Functions

| API | Purpose | Location | Export |
|-----|---------|----------|--------|
| `CodeMieSSO` | Browser-based SSO authentication | `src/providers/plugins/sso/sso.auth.ts` | `src/index.ts` |
| `CodeMieProxy` | Plugin-based HTTP proxy with streaming | `src/providers/plugins/sso/proxy/sso.proxy.ts` | `src/index.ts` |
| `getPluginRegistry` | Plugin registry singleton accessor | `src/providers/plugins/sso/proxy/plugins/registry.ts` | `src/index.ts` |
| `processEvent` | Programmatic hook event processing | `src/cli/commands/hook.ts` | `src/index.ts` |
| `ConfigLoader` | Unified configuration loader | `src/utils/config.ts` | `src/index.ts` |

---

## CodeMieSSO

### Overview

Provides browser-based SSO authentication for CodeMie provider. Manages credential storage, session lifecycle, and OAuth callback handling.

### Class Definition

```typescript
// Source: src/providers/plugins/sso/sso.auth.ts:33-325
export class CodeMieSSO {
  /**
   * Authenticate via browser SSO
   */
  async authenticate(config: SSOAuthConfig): Promise<SSOAuthResult>;

  /**
   * Get stored SSO credentials with fallback and URL validation
   */
  async getStoredCredentials(url?: string, allowFallback?: boolean): Promise<SSOCredentials | null>;

  /**
   * Clear stored credentials
   */
  async clearStoredCredentials(baseUrl?: string): Promise<void>;
}
```

### Authentication Pattern

```typescript
import { CodeMieSSO } from 'codemieai-code';

const sso = new CodeMieSSO();

// Authenticate via browser
const result = await sso.authenticate({
  codeMieUrl: 'https://codemie.lab.epam.com',
  timeout: 120000 // 2 minutes default
});

if (result.success) {
  console.log('Authentication successful');
  console.log('API URL:', result.apiUrl);
  // Credentials are automatically stored
} else {
  console.error('Authentication failed:', result.error);
}
```

**Authentication Flow**:
1. Starts local HTTP server on random port
2. Constructs SSO URL: `${codeMieBase}/v1/auth/login/${port}`
3. Opens browser for user authentication
4. Waits for OAuth callback with credentials
5. Stores credentials securely (24-hour expiration)
6. Returns authentication result

### Credential Management

```typescript
// Retrieve stored credentials
const credentials = await sso.getStoredCredentials('https://codemie.lab.epam.com');

if (credentials) {
  console.log('API URL:', credentials.apiUrl);
  console.log('Cookies:', credentials.cookies);
  console.log('Expires at:', new Date(credentials.expiresAt));
} else {
  console.log('No credentials found');
}

// Clear credentials
await sso.clearStoredCredentials('https://codemie.lab.epam.com');
```

**Credential Storage**:
- Stored per base URL (normalized to protocol + host)
- Supports fallback to global credentials
- Automatic expiration check (24 hours)
- Secure storage via `CredentialStore`

### Type Definitions

```typescript
interface SSOAuthConfig {
  codeMieUrl: string;
  timeout?: number; // Default: 120000ms
}

interface SSOAuthResult {
  success: boolean;
  apiUrl?: string;
  cookies?: Record<string, string>;
  error?: string;
}

interface SSOCredentials {
  cookies: Record<string, string>;
  apiUrl: string;
  expiresAt: number; // Timestamp
}
```

---

## CodeMieProxy

### Overview

Plugin-based HTTP proxy server with streaming support. Forwards HTTP requests to upstream API while running plugin hooks for extensibility (analytics, metrics, etc.).

### Class Definition

```typescript
// Source: src/providers/plugins/sso/proxy/sso.proxy.ts:41-542
export class CodeMieProxy {
  constructor(config: ProxyConfig);

  /**
   * Start the proxy server
   * Returns port and URL for client connections
   */
  async start(): Promise<{ port: number; url: string }>;

  /**
   * Stop the proxy server
   * Calls lifecycle hooks before shutdown
   */
  async stop(): Promise<void>;
}
```

### Proxy Configuration

```typescript
interface ProxyConfig {
  targetApiUrl: string;        // Upstream API URL
  port?: number;                // Optional port (auto-assigned if not provided)
  host?: string;                // Default: 'localhost'
  clientType?: string;          // Client identifier (e.g., 'vscode-codemie')
  timeout?: number;             // Request timeout (default: 300000ms)
  profile?: string;             // Profile name for traceability
  model?: string;               // Model name
  provider?: string;            // Provider type (e.g., 'ai-run-sso')
  integrationId?: string;       // Integration ID
  sessionId?: string;           // Session ID
  version?: string;             // CLI version for metrics
  profileConfig?: CodeMieConfigOptions; // Full profile config
}
```

### Usage Pattern

```typescript
import { CodeMieProxy } from 'codemieai-code';

// Create proxy instance
const proxy = new CodeMieProxy({
  targetApiUrl: 'https://api.codemie.ai',
  provider: 'ai-run-sso',
  sessionId: 'session-123',
  clientType: 'vscode-codemie',
  version: '1.0.0'
});

// Start proxy server
const { port, url } = await proxy.start();
console.log(`Proxy running at ${url}`);

// Use proxy URL in client configuration
// e.g., set CODEMIE_BASE_URL=http://localhost:${port}

// Stop proxy when done
await proxy.stop();
```

### Proxy Flow

**Request Processing**:
1. **Build Context**: Extract request metadata (method, URL, headers, body)
2. **onRequest Hooks**: Run plugin interceptors (can block request)
3. **Forward Request**: Stream request to upstream API
4. **onResponseHeaders Hooks**: Process response headers
5. **Stream Response**: Stream response body with optional chunk transformation
6. **onResponseComplete Hooks**: Final processing after streaming

**Key Features**:
- **Zero Buffering**: Streams requests/responses without buffering
- **Plugin Architecture**: Extensible via plugin registry
- **SSO Support**: Automatic credential loading for SSO providers
- **Error Handling**: Structured error responses with proper status codes
- **Streaming**: Supports chunk-by-chunk processing for large responses

### Plugin Integration

The proxy automatically initializes plugins from the registry:

```typescript
// Plugins are auto-registered on import
import './plugins/index.js';

// Proxy uses registry during start()
const registry = getPluginRegistry();
const interceptors = await registry.initialize(pluginContext);
```

**Plugin Lifecycle**:
- `onProxyStart`: Called when proxy starts
- `onRequest`: Called for each incoming request (can block)
- `onResponseHeaders`: Called with response headers
- `onResponseChunk`: Called for each response chunk (can transform)
- `onResponseComplete`: Called after response streaming completes
- `onProxyStop`: Called when proxy stops
- `onError`: Called on errors

---

## getPluginRegistry

### Overview

Singleton accessor function for the plugin registry. Manages plugin lifecycle, ordering, and initialization for the proxy system.

### Function Definition

```typescript
// Source: src/providers/plugins/sso/proxy/plugins/registry.ts:142-147
export function getPluginRegistry(): PluginRegistry;
```

### PluginRegistry Class

```typescript
// Source: src/providers/plugins/sso/proxy/plugins/registry.ts:14-137
export class PluginRegistry {
  /**
   * Register a plugin (typically called at app startup)
   */
  register(plugin: ProxyPlugin, config?: Partial<PluginConfig>): void;

  /**
   * Initialize all enabled plugins with context
   */
  async initialize(context: PluginContext): Promise<ProxyInterceptor[]>;

  /**
   * Enable/disable plugin at runtime
   */
  async setEnabled(pluginId: string, enabled: boolean): Promise<void>;

  /**
   * Get all registered plugins
   */
  getAll(): ProxyPlugin[];

  /**
   * Get plugin configuration
   */
  getConfig(pluginId: string): PluginConfig | undefined;

  /**
   * Update plugin configuration
   */
  updateConfig(pluginId: string, updates: Partial<PluginConfig>): void;

  /**
   * Clear all plugins (for testing)
   */
  clear(): void;
}
```

### Usage Pattern

```typescript
import { getPluginRegistry } from 'codemieai-code';
import type { ProxyPlugin, PluginContext } from 'codemieai-code';

// Get registry instance
const registry = getPluginRegistry();

// Register custom plugin
const myPlugin: ProxyPlugin = {
  id: 'my-custom-plugin',
  name: 'My Custom Plugin',
  priority: 100, // Lower = earlier execution
  async createInterceptor(context: PluginContext) {
    return {
      name: 'my-custom-plugin',
      async onRequest(ctx) {
        // Modify request context
        ctx.headers['X-Custom-Header'] = 'value';
      },
      async onResponseComplete(ctx, metadata) {
        // Process response metadata
        console.log('Response completed:', metadata);
      }
    };
  }
};

registry.register(myPlugin);

// Initialize plugins (called automatically by CodeMieProxy)
const context: PluginContext = {
  config: proxyConfig,
  logger: loggerInstance,
  credentials: ssoCredentials,
  profileConfig: profileConfig
};

const interceptors = await registry.initialize(context);
```

### Plugin Priority

Plugins are executed in priority order (ascending):
- Lower priority = earlier execution
- Default priority: 0 (highest priority)
- Plugins with same priority execute in registration order

### Type Definitions

```typescript
interface ProxyPlugin {
  id: string;
  name: string;
  priority: number;
  createInterceptor(context: PluginContext): Promise<ProxyInterceptor>;
  onEnable?(): Promise<void>;
  onDisable?(): Promise<void>;
}

interface PluginConfig {
  id: string;
  enabled: boolean;
  priority: number;
}

interface PluginContext {
  config: ProxyConfig;
  logger: Logger;
  credentials?: SSOCredentials;
  profileConfig?: CodeMieConfigOptions;
}

interface ProxyInterceptor {
  name: string;
  onProxyStart?(): Promise<void> | void;
  onRequest?(context: ProxyContext): Promise<void> | void;
  onResponseHeaders?(context: ProxyContext, headers: IncomingHttpHeaders): Promise<void> | void;
  onResponseChunk?(context: ProxyContext, chunk: Buffer): Promise<Buffer | null> | Buffer | null;
  onResponseComplete?(context: ProxyContext, metadata: ResponseMetadata): Promise<void> | void;
  onProxyStop?(): Promise<void> | void;
  onError?(context: ProxyContext, error: Error): Promise<void> | void;
}
```

---

## processEvent

### Overview

Programmatic API for processing hook events from external services (e.g., VSCode plugin). Provides the same functionality as the CLI hook command but accepts event objects directly without stdin/stdout communication. This is a stateless function that processes events based on the provided configuration.

### Function Definition

```typescript
// Source: src/cli/commands/hook.ts:1152-1172
/**
 * Process a hook event programmatically
 * Main entry point that routes to appropriate handler based on event type
 * 
 * @param event - The hook event to process
 * @param config - Optional configuration object (if not provided, uses environment variables)
 * @throws Error if event processing fails and config is provided
 */
export async function processEvent(
  event: BaseHookEvent,
  config?: HookProcessingConfig
): Promise<void>;
```

### Configuration

```typescript
interface HookProcessingConfig {
  agentName: string;           // Required: Agent name (e.g., 'claude', 'gemini')
  sessionId: string;           // Required: CodeMie session ID
  provider?: string;           // Provider name (e.g., 'ai-run-sso')
  apiBaseUrl?: string;         // API base URL
  cookies?: string;             // SSO cookies for authentication
  apiKey?: string;              // API key for localhost development
  clientType?: string;          // Client identifier (e.g., 'vscode-codemie')
  version?: string;            // Client version
  profileName?: string;        // Profile name for logging
  project?: string;            // Project name
  model?: string;              // Model name
  ssoUrl?: string;             // SSO URL for credential loading
}
```

### Usage Pattern

```typescript
import { processEvent, HookProcessingConfig } from 'codemieai-code';
import type { BaseHookEvent, SessionStartEvent } from 'codemieai-code';

// Define configuration (can be reused across multiple events)
const config: HookProcessingConfig = {
  agentName: 'claude',
  sessionId: 'session-123',
  provider: 'ai-run-sso',
  apiBaseUrl: 'https://api.codemie.ai',
  ssoUrl: 'https://codemie.lab.epam.com',
  clientType: 'vscode-codemie',
  version: '1.0.0'
};

// Process SessionStart event
const startEvent: SessionStartEvent = {
  session_id: 'agent-session-456',
  hook_event_name: 'SessionStart',
  transcript_path: '/path/to/transcript.json',
  permission_mode: 'default',
  cwd: '/workspace/project',
  source: 'user-initiated'
};

await processEvent(startEvent, config);

// Process SessionEnd event
const endEvent: SessionEndEvent = {
  session_id: 'agent-session-456',
  hook_event_name: 'SessionEnd',
  transcript_path: '/path/to/transcript.json',
  permission_mode: 'default',
  reason: 'user-completed'
};

await processEvent(endEvent, config);

// Process other event types
await processEvent({
  session_id: 'agent-session-456',
  hook_event_name: 'UserPromptSubmit',
  transcript_path: '/path/to/transcript.json',
  permission_mode: 'default'
}, config);
```

### Event Processing Flow

**SessionStart**:
1. Create session record in SessionStore
2. Send session start metrics to API
3. Initialize activity tracking

**SessionEnd**:
1. Final activity accumulation
2. Transform messages → JSONL (incremental sync)
3. Sync pending data to API
4. Send session end metrics
5. Update session status
6. Rename session files with 'completed_' prefix

**Stop/SubagentStop**:
1. Accumulate active duration
2. Perform incremental sync (transform messages)

**UserPromptSubmit**:
1. Start activity tracking

### Event Types

```typescript
interface BaseHookEvent {
  session_id: string;              // Agent's session ID
  transcript_path: string;         // Path to conversation file (agent session file)
  permission_mode: string;         // "default", "plan", "acceptEdits", "dontAsk", or "bypassPermissions"
  hook_event_name: string;         // Event identifier (SessionStart, SessionEnd, etc.)
  cwd?: string;                    // Current working directory (not present in all hooks)
  source?: string;                 // SessionStart only: "startup", "resume", "clear"
  reason?: string;                 // SessionEnd only: "exit", "logout", "clear", etc.
  agent_id?: string;               // SubagentStop only: Sub-agent ID
  agent_transcript_path?: string;  // SubagentStop only: Path to agent's transcript
  stop_hook_active?: boolean;      // SubagentStop only: Whether stop hook is active
}

interface SessionStartEvent extends BaseHookEvent {
  hook_event_name: 'SessionStart';
  cwd?: string;
  source?: string;
}

interface SessionEndEvent extends BaseHookEvent {
  hook_event_name: 'SessionEnd';
  reason?: string;
}

interface SubagentStopEvent extends BaseHookEvent {
  hook_event_name: 'SubagentStop';
  agent_id?: string;
  agent_transcript_path?: string;
  stop_hook_active?: boolean;
}
```

### Key Differences from CLI

| Feature | CLI Command | processEvent |
|---------|-------------|--------------|
| Input | stdin (JSON) | Event objects |
| Config | Environment variables | Config object (optional, falls back to env vars) |
| Errors | process.exit() | Throws exceptions (when config provided) |
| Logger | Environment-based | Config-based (when config provided) |
| Output | stdout | No output (throws on error) |
| State | Stateless | Stateless function |

### Configuration Behavior

When `config` is provided:
- Uses config values directly
- Throws exceptions on validation/processing errors
- Sets logger context from config

When `config` is not provided (undefined):
- Falls back to environment variables
- Sets `process.exitCode` instead of throwing (CLI-compatible behavior)
- Uses environment-based logger initialization

---

## ConfigLoader

### Overview

Unified configuration loader with priority system. Supports both legacy single-provider config and multi-provider profiles. Loads configuration from multiple sources with proper precedence.

### Class Definition

```typescript
// Source: src/utils/config.ts:29-813
export class ConfigLoader {
  /**
   * Load configuration with proper priority:
   * CLI args > Env vars > Project config > Global config > Defaults
   */
  static async load(
    workingDir?: string,
    cliOverrides?: Partial<CodeMieConfigOptions>
  ): Promise<CodeMieConfigOptions>;

  /**
   * Load configuration with validation (throws if required fields missing)
   */
  static async loadAndValidate(
    workingDir?: string,
    cliOverrides?: Partial<CodeMieConfigOptions>
  ): Promise<CodeMieConfigOptions>;

  /**
   * Load full configuration including analytics
   * Returns the complete multi-provider config
   */
  static async loadFull(
    workingDir?: string,
    cliOverrides?: { name?: string }
  ): Promise<MultiProviderConfig>;

  /**
   * Load configuration with source tracking
   */
  static async loadWithSources(
    workingDir?: string
  ): Promise<Record<string, ConfigWithSource>>;

  /**
   * Show configuration with source attribution
   */
  static async showWithSources(workingDir?: string): Promise<void>;
}
```

### Configuration Priority

Configuration is merged in the following order (highest to lowest priority):

1. **CLI Arguments** (highest priority)
2. **Environment Variables**
3. **Project Config** (`.codemie/codemie-cli.config.json`)
4. **Global Config** (`~/.codemie/codemie-cli.config.json`)
5. **Built-in Defaults** (lowest priority)

### Usage Pattern

```typescript
import { ConfigLoader } from 'codemieai-code';
import type { CodeMieConfigOptions } from 'codemieai-code';

// Load configuration (with defaults)
const config = await ConfigLoader.load();

// Load with working directory
const config = await ConfigLoader.load('/path/to/project');

// Load with CLI overrides
const config = await ConfigLoader.load(process.cwd(), {
  provider: 'ai-run-sso',
  model: 'claude-4-5-sonnet',
  debug: true
});

// Load with validation (throws if invalid)
const config = await ConfigLoader.loadAndValidate();

// Load full multi-provider config
const fullConfig = await ConfigLoader.loadFull();
console.log('Active profile:', fullConfig.activeProfile);
console.log('Available profiles:', Object.keys(fullConfig.profiles));

// Load with source tracking
const sources = await ConfigLoader.loadWithSources();
for (const [key, { value, source }] of Object.entries(sources)) {
  console.log(`${key}: ${value} (from ${source})`);
}
```

### Configuration Structure

**Single Provider (Legacy)**:
```json
{
  "provider": "openai",
  "apiKey": "sk-...",
  "model": "gpt-4",
  "baseUrl": "https://api.openai.com",
  "timeout": 0,
  "debug": false
}
```

**Multi-Provider (Version 2)**:
```json
{
  "version": 2,
  "activeProfile": "work",
  "profiles": {
    "default": {
      "provider": "openai",
      "apiKey": "sk-...",
      "model": "gpt-4"
    },
    "work": {
      "provider": "ai-run-sso",
      "codeMieUrl": "https://codemie.lab.epam.com",
      "codeMieProject": "my-project"
    }
  }
}
```

### Type Definitions

```typescript
interface CodeMieConfigOptions {
  name?: string;
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  timeout?: number;
  debug?: boolean;
  allowedDirs?: string[];
  ignorePatterns?: string[];
  codeMieUrl?: string;
  codeMieProject?: string;
  codeMieIntegration?: CodeMieIntegrationInfo;
  // ... other fields
}

interface MultiProviderConfig {
  version: 2;
  activeProfile: string;
  profiles: Record<string, CodeMieConfigOptions>;
  analytics?: AnalyticsConfig;
}

interface ConfigWithSource {
  value: any;
  source: 'default' | 'global' | 'project' | 'env';
}
```

### Profile Management

When a profile is explicitly selected via CLI, environment variables are filtered to prevent contamination:

```typescript
// Profile protection: env vars for baseUrl, apiKey, model, provider
// are filtered out unless explicitly set in CLI overrides
const config = await ConfigLoader.load(process.cwd(), {
  name: 'work' // Explicit profile selection
});
```

---

## Integration Examples

### Complete Integration: VSCode Plugin

```typescript
import {
  CodeMieSSO,
  CodeMieProxy,
  getPluginRegistry,
  processEvent,
  HookProcessingConfig,
  ConfigLoader
} from 'codemieai-code';

// 1. Load configuration
const config = await ConfigLoader.loadAndValidate(workspaceFolder);

// 2. Authenticate if SSO provider
if (config.provider === 'ai-run-sso') {
  const sso = new CodeMieSSO();
  const credentials = await sso.getStoredCredentials(config.codeMieUrl);
  
  if (!credentials) {
    // Trigger authentication
    const result = await sso.authenticate({
      codeMieUrl: config.codeMieUrl!
    });
    if (!result.success) {
      throw new Error('SSO authentication failed');
    }
  }
}

// 3. Start proxy for agent communication
const proxy = new CodeMieProxy({
  targetApiUrl: config.baseUrl!,
  provider: config.provider,
  sessionId: generateSessionId(),
  clientType: 'vscode-codemie',
  version: extensionVersion,
  profileConfig: config
});

const { url } = await proxy.start();

// 4. Define hook processing configuration
const hookConfig: HookProcessingConfig = {
  agentName: 'claude',
  sessionId: sessionId,
  provider: config.provider,
  apiBaseUrl: config.baseUrl,
  ssoUrl: config.codeMieUrl,
  clientType: 'vscode-codemie',
  version: extensionVersion
};

// 5. Process hook events
vscode.workspace.onDidSaveTextDocument(async (doc) => {
  await processEvent({
    session_id: agentSessionId,
    hook_event_name: 'UserPromptSubmit',
    transcript_path: transcriptPath,
    permission_mode: 'default'
  }, hookConfig);
});

// 6. Register custom plugin
const registry = getPluginRegistry();
registry.register({
  id: 'vscode-analytics',
  name: 'VSCode Analytics',
  priority: 50,
  async createInterceptor(context) {
    return {
      name: 'vscode-analytics',
      async onResponseComplete(ctx, metadata) {
        // Track response metrics
        trackMetrics(ctx, metadata);
      }
    };
  }
});
```

### Custom Plugin Example

```typescript
import { getPluginRegistry, CodeMieProxy } from 'codemieai-code';

// Define custom plugin
const customPlugin: ProxyPlugin = {
  id: 'request-logger',
  name: 'Request Logger',
  priority: 10, // Early execution
  async createInterceptor(context) {
    return {
      name: 'request-logger',
      async onRequest(ctx) {
        console.log(`[${ctx.method}] ${ctx.url}`);
        console.log('Headers:', ctx.headers);
      },
      async onResponseComplete(ctx, metadata) {
        console.log(`Response: ${metadata.statusCode} (${metadata.durationMs}ms)`);
        console.log(`Bytes sent: ${metadata.bytesSent}`);
      }
    };
  }
};

// Register plugin
const registry = getPluginRegistry();
registry.register(customPlugin);

// Plugin will be used automatically by CodeMieProxy
const proxy = new CodeMieProxy(config);
await proxy.start(); // Custom plugin interceptors are active
```

---

## Error Handling

### CodeMieSSO Errors

```typescript
try {
  const result = await sso.authenticate(config);
  if (!result.success) {
    console.error('Authentication failed:', result.error);
  }
} catch (error) {
  console.error('Unexpected error:', error);
}
```

### CodeMieProxy Errors

The proxy handles errors gracefully:
- **AuthenticationError**: SSO credentials not found
- **NetworkError**: Upstream connection failures
- **TimeoutError**: Request timeout
- **Client Disconnect**: Silently handled (no error thrown)

```typescript
try {
  await proxy.start();
} catch (error) {
  if (error instanceof AuthenticationError) {
    // Prompt user to authenticate
  } else if (error instanceof NetworkError) {
    // Retry or show network error
  }
}
```

### processEvent Errors

Throws exceptions for validation and processing errors when `config` is provided:

```typescript
try {
  await processEvent(event, config);
} catch (error) {
  if (error.message.includes('Missing required field')) {
    // Validation error
  } else {
    // Processing error
  }
}
```

**Note**: When `config` is not provided (undefined), `processEvent` behaves like the CLI command and sets `process.exitCode` instead of throwing exceptions.

### ConfigLoader Errors

```typescript
try {
  const config = await ConfigLoader.loadAndValidate();
} catch (error) {
  if (error.message.includes('Profile')) {
    // Profile-related error
  } else if (error.message.includes('API key')) {
    // Configuration error
  }
}
```

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use `loadAndValidate()` for required config | Use `load()` when validation is needed |
| Store SSO credentials per URL | Use global credentials for all URLs |
| Register plugins before proxy start | Register plugins after proxy initialization |
| Handle errors from processEvent | Ignore exceptions from event processing |
| Use profile names for multi-provider config | Hardcode provider configuration |
| Clear credentials on logout | Leave credentials in storage |
| Use ConfigLoader for all config access | Read config files directly |

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "SSO credentials not found" | No stored credentials | Call `sso.authenticate()` first |
| "Profile not found" | Invalid profile name | Check available profiles with `loadFull()` |
| "Plugin not initialized" | Plugin registered after proxy start | Register plugins before `proxy.start()` |
| "Missing required field" | Invalid hook event | Ensure all required fields in event |
| "Authentication timeout" | User didn't complete auth | Increase timeout or retry authentication |
| "Proxy port in use" | Port conflict | Proxy auto-assigns port if not specified |

---

## References

- **SSO Authentication**: `src/providers/plugins/sso/sso.auth.ts`
- **Proxy Implementation**: `src/providers/plugins/sso/proxy/sso.proxy.ts`
- **Plugin Registry**: `src/providers/plugins/sso/proxy/plugins/registry.ts`
- **Hook Event Processing**: `src/cli/commands/hook.ts`
- **Config Loader**: `src/utils/config.ts`
- **Main Exports**: `src/index.ts`
