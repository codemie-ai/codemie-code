# Configuration Architecture

**Version**: 2.0
**Last Updated**: 2025-12-24
**Purpose**: Reference guide for understanding how configuration flows through the system from user input to agents, adapters, proxy plugins, and the hooks-based lifecycle system.

---

## 1. Configuration Sources (Priority Order)

```
1. CLI Arguments      (Highest)  → --profile, --model, --provider, --api-key, --base-url, --timeout
2. Environment Vars   (High)     → CODEMIE_*, OPENAI_*, ANTHROPIC_*, etc.
3. Project Config     (Medium)   → .codemie/codemie-cli.config.json (local)
4. Global Config      (Low)      → ~/.codemie/codemie-cli.config.json
5. Built-in Defaults  (Lowest)   → Hardcoded in ConfigLoader
```

---

## 2. Parameter Flow Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  USER INPUT                                                         │
├─────────────────────────────────────────────────────────────────────┤
│  CLI:   codemie-claude --profile work --model claude-3-5-sonnet     │
│  ENV:   CODEMIE_PROVIDER=ai-run-sso                                 │
│  FILE:  ~/.codemie/codemie-cli.config.json (active profile: work)               │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 1: AgentCLI.handleRun()                                       │
│  Location: src/agents/core/AgentCLI.ts:84                           │
├─────────────────────────────────────────────────────────────────────┤
│  Collects CLI options:                                              │
│  - profile, provider, model, apiKey, baseUrl, timeout               │
│                                                                     │
│  Calls ConfigLoader.load(cwd, cliOverrides)                         │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 2: ConfigLoader.load()                                        │
│  Location: src/utils/config-loader.ts:40                            │
├─────────────────────────────────────────────────────────────────────┤
│  Merges config with priority:                                       │
│  1. Built-in defaults                                               │
│  2. Global config (active profile)                                  │
│  3. Project-local config                                            │
│  4. Environment variables (CODEMIE_*)                               │
│  5. CLI overrides                                                   │
│                                                                     │
│  Returns: CodeMieConfigOptions                                      │
│  {                                                                  │
│    name: 'work',                                                    │
│    provider: 'ai-run-sso',                                          │
│    model: 'claude-3-5-sonnet',                                      │
│    baseUrl: 'https://codemie.ai',                                   │
│    apiKey: '...',                                                   │
│    timeout: 300                                                     │
│  }                                                                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 3: ConfigLoader.exportProviderEnvVars()                       │
│  Location: src/utils/config-loader.ts:639                           │
├─────────────────────────────────────────────────────────────────────┤
│  Converts config → environment variables:                           │
│                                                                     │
│  GENERIC (always set):                                              │
│  - CODEMIE_PROVIDER       = ai-run-sso                              │
│  - CODEMIE_BASE_URL       = https://codemie.ai                      │
│  - CODEMIE_API_KEY        = (SSO session token)                     │
│  - CODEMIE_MODEL          = claude-3-5-sonnet                       │
│  - CODEMIE_TIMEOUT        = 300                                     │
│  - CODEMIE_DEBUG          = 0/1                                     │
│                                                                     │
│  PROVIDER-SPECIFIC (via envMapping):                                │
│  - OPENAI_BASE_URL        = https://codemie.ai                      │
│  - OPENAI_API_KEY         = (SSO session token)                     │
│  - ANTHROPIC_BASE_URL     = https://codemie.ai                      │
│  - ANTHROPIC_API_KEY      = (SSO session token)                     │
│                                                                     │
│  ADDITIONAL (added by AgentCLI):                                    │
│  - CODEMIE_PROFILE_NAME   = work                                    │
│  - CODEMIE_CLI_VERSION    = 0.0.16                                  │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 3A: ProviderTemplate.exportEnvVars() [PLUGGABLE]              │
│  Location: src/providers/plugins/{provider}/{provider}.template.ts  │
├─────────────────────────────────────────────────────────────────────┤
│  Provider-specific environment variable export (if defined):        │
│                                                                     │
│  Example - SSO Provider:                                            │
│  exportEnvVars: (config) => {                                       │
│    const env = {};                                                  │
│    if (config.codeMieUrl) env.CODEMIE_URL = config.codeMieUrl;      │
│    if (config.codeMieProject) env.CODEMIE_PROJECT = ...;            │
│    if (config.codeMieIntegration?.id)                               │
│      env.CODEMIE_INTEGRATION_ID = ...;                              │
│    return env;                                                      │
│  }                                                                  │
│                                                                     │
│  Example - Bedrock Provider:                                        │
│  exportEnvVars: (config) => {                                       │
│    const env = {};                                                  │
│    if (config.awsProfile) env.CODEMIE_AWS_PROFILE = ...;            │
│    if (config.awsRegion) env.CODEMIE_AWS_REGION = ...;              │
│    if (config.awsSecretAccessKey)                                   │
│      env.CODEMIE_AWS_SECRET_ACCESS_KEY = ...;                       │
│    return env;                                                      │
│  }                                                                  │
│                                                                     │
│  Result: Provider-specific CODEMIE_* env vars added                 │
│  - CODEMIE_URL            = https://codemie.ai                      │
│  - CODEMIE_INTEGRATION_ID = (if configured)                         │
│  - CODEMIE_AWS_PROFILE    = bedrock (if Bedrock)                   │
│  - CODEMIE_AWS_REGION     = us-east-1 (if Bedrock)                 │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4: BaseAgentAdapter.run()                                     │
│  Location: src/agents/core/BaseAgentAdapter.ts:140                  │
├─────────────────────────────────────────────────────────────────────┤
│  Receives: envOverrides (environment variables from Step 3/3A)      │
│                                                                     │
│  Generates session ID:                                              │
│  sessionId = randomUUID()                                           │
│                                                                     │
│  Merges with process.env:                                           │
│  env = {                                                            │
│    ...process.env,                                                  │
│    ...envOverrides,                                                 │
│    CODEMIE_SESSION_ID: sessionId,                                   │
│    CODEMIE_AGENT: this.metadata.name                                │
│  }                                                                  │
│                                                                     │
│  Calls: setupProxy(env)  [if SSO provider]                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4A: Lifecycle Hook - onSessionStart() [OPTIONAL]              │
│  Location: src/agents/core/lifecycle-helpers.ts:125                 │
├─────────────────────────────────────────────────────────────────────┤
│  Hook Resolution Priority (Chain of Responsibility):                │
│  1. Provider wildcard hook ('*' for all agents)                     │
│  2. Provider agent-specific hook (e.g., 'claude')                   │
│  3. Agent default hook (fallback)                                   │
│                                                                     │
│  Example - SSO Provider Wildcard Hook:                              │
│  agentHooks: {                                                      │
│    '*': {  // Applies to ALL agents                                 │
│      async onSessionStart(sessionId, env) {                         │
│        // Send session start metric to backend                      │
│        await handler.sendSessionStart({                             │
│          sessionId, agentName, provider, project, model             │
│        }, 'started');                                               │
│      }                                                              │
│    }                                                                │
│  }                                                                  │
│                                                                     │
│  Example - Gemini Agent Default Hook:                               │
│  lifecycle: {                                                       │
│    async onSessionStart(sessionId, env) {                           │
│      // Register current project for analytics mapping              │
│      registerCurrentProject('gemini', process.cwd());               │
│    }                                                                │
│  }                                                                  │
│                                                                     │
│  Use Cases: Session metrics, project registration, early init       │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 4B: Lifecycle Hook - beforeRun() [OPTIONAL]                   │
│  Location: src/agents/core/lifecycle-helpers.ts:160                 │
├─────────────────────────────────────────────────────────────────────┤
│  Hook Resolution Priority (with Automatic Chaining):                │
│  1. Provider wildcard hook runs FIRST                               │
│  2. Provider agent-specific hook runs SECOND (receives result)      │
│  3. Agent default hook runs as FALLBACK (if no provider hooks)      │
│                                                                     │
│  Example - Bedrock Provider (Automatic Chaining):                   │
│                                                                     │
│  Wildcard Hook (runs FIRST for ALL agents):                         │
│  agentHooks: {                                                      │
│    '*': {                                                           │
│      async beforeRun(env, config) {                                 │
│        // Transform CODEMIE_AWS_* → AWS_* for all agents            │
│        if (env.CODEMIE_AWS_PROFILE) {                               │
│          env.AWS_PROFILE = env.CODEMIE_AWS_PROFILE;                 │
│          delete env.AWS_ACCESS_KEY_ID;  // Avoid conflicts          │
│        }                                                            │
│        if (env.CODEMIE_AWS_REGION) {                                │
│          env.AWS_REGION = env.CODEMIE_AWS_REGION;                   │
│        }                                                            │
│        return env;                                                  │
│      }                                                              │
│    },                                                               │
│                                                                     │
│  Claude-Specific Hook (runs SECOND, receives wildcard result):      │
│    'claude': {                                                      │
│      async beforeRun(env, config) {                                 │
│        // AWS credentials already set by wildcard hook!             │
│        // Now add Claude-specific Bedrock configuration             │
│        env.CLAUDE_CODE_USE_BEDROCK = '1';                           │
│        delete env.ANTHROPIC_AUTH_TOKEN;  // Use AWS creds only      │
│        if (env.CODEMIE_MODEL) {                                     │
│          env.ANTHROPIC_MODEL = env.CODEMIE_MODEL;                   │
│        }                                                            │
│        return env;                                                  │
│      }                                                              │
│    }                                                                │
│  }                                                                  │
│                                                                     │
│  Chaining Logic (lifecycle-helpers.ts):                             │
│  if (wildcardHook && specificHook) {                                │
│    // Execute wildcard first                                        │
│    const intermediateEnv = await wildcardHook(env, config);         │
│    // Execute specific hook with wildcard result                    │
│    return await specificHook(intermediateEnv, config);              │
│  }                                                                  │
│                                                                     │
│  Use Cases: Env transformation, config files, credential setup      │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 5: BaseAgentAdapter.setupProxy()                              │
│  Location: src/agents/core/BaseAgentAdapter.ts:288                  │
├─────────────────────────────────────────────────────────────────────┤
│  Checks if SSO provider → needs proxy                               │
│                                                                     │
│  Extracts from environment:                                         │
│  - targetApiUrl  ← env.CODEMIE_BASE_URL                             │
│  - timeout       ← env.CODEMIE_TIMEOUT * 1000                       │
│                                                                     │
│  Calls extractConfig(env) → AgentConfig:                            │
│  {                                                                  │
│    provider: env.CODEMIE_PROVIDER,                                  │
│    model: env.CODEMIE_MODEL,                                        │
│    baseUrl: env.CODEMIE_BASE_URL,                                   │
│    apiKey: env.CODEMIE_API_KEY,                                     │
│    timeout: env.CODEMIE_TIMEOUT                                     │
│  }                                                                  │
│                                                                     │
│  Gets sessionId from env.CODEMIE_SESSION_ID                         │
│  (generated at agent start in BaseAgentAdapter.run())               │
│                                                                     │
│  Creates ProxyConfig:                                               │
│  {                                                                  │
│    targetApiUrl: 'https://codemie.ai',                              │
│    clientType: 'codemie-claude',                                    │
│    timeout: 300000,                                                 │
│    model: 'claude-3-5-sonnet',                                      │
│    provider: 'ai-run-sso',                                          │
│    profile: env.CODEMIE_PROFILE_NAME,  ← 'work'                     │
│    integrationId: env.CODEMIE_INTEGRATION_ID,                       │
│    sessionId: 'uuid-from-agent'                                     │
│  }                                                                  │
│                                                                     │
│  Calls: new CodeMieProxy(proxyConfig)                               │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 6: CodeMieProxy.start()                                       │
│  Location: src/utils/codemie-proxy.ts:59                            │
├─────────────────────────────────────────────────────────────────────┤
│  Loads SSO credentials from CredentialStore                         │
│                                                                     │
│  Builds PluginContext:                                              │
│  {                                                                  │
│    config: proxyConfig,  ← Full ProxyConfig from Step 5             │
│    logger: logger,                                                  │
│    credentials: {                                                   │
│      cookies: { session: 'token', ... }                             │
│    }                                                                │
│  }                                                                  │
│                                                                     │
│  Calls: registry.initialize(pluginContext)                          │
└────────────────────────────┬────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────────┐
│  STEP 7: Plugin Initialization                                      │
│  Location: src/proxy/plugins/metrics-sync.plugin.ts:31              │
├─────────────────────────────────────────────────────────────────────┤
│  MetricsSyncPlugin.createInterceptor(context)                       │
│                                                                     │
│  Accesses:                                                          │
│  - context.config.sessionId      ← 'uuid-from-agent'                │
│  - context.config.targetApiUrl   ← 'https://codemie.ai'             │
│  - context.config.model          ← 'claude-3-5-sonnet'              │
│  - context.config.provider       ← 'ai-run-sso'                     │
│  - context.config.profile        ← 'work'                           │
│  - context.credentials.cookies   ← { session: 'token' }             │
│                                                                     │
│  Creates MetricsSyncInterceptor with:                               │
│  - sessionId (from context.config)                                  │
│  - baseUrl (from context.config)                                    │
│  - cookies (from context.credentials)                               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Parameter Categories

### 3.1 Configuration Parameters (from config files/CLI)

| Parameter | Source Priority | Env Var | Config Key | ProxyConfig | PluginContext |
|-----------|----------------|---------|------------|-------------|---------------|
| profile name | CLI > Env > Config | CODEMIE_PROFILE_NAME | `name` | `profile` | via `config.profile` |
| provider | CLI > Env > Config | CODEMIE_PROVIDER | `provider` | `provider` | via `config.provider` |
| model | CLI > Env > Config | CODEMIE_MODEL | `model` | `model` | via `config.model` |
| base URL | CLI > Env > Config | CODEMIE_BASE_URL | `baseUrl` | `targetApiUrl` | via `config.targetApiUrl` |
| API key | CLI > Env > Config | CODEMIE_API_KEY | `apiKey` | ❌ | via `credentials` |
| timeout | CLI > Env > Config | CODEMIE_TIMEOUT | `timeout` | `timeout` | via `config.timeout` |

### 3.2 Runtime Parameters (generated at execution)

| Parameter | Generated By | Location | ProxyConfig | PluginContext |
|-----------|-------------|----------|-------------|---------------|
| sessionId | Agent | randomUUID() in BaseAgentAdapter.run() | `sessionId` | via `config.sessionId` |
| clientType | Agent Metadata | metadata.ssoConfig.clientType | `clientType` | via `config.clientType` |
| integrationId | Config | config.codeMieIntegration?.id | `integrationId` | via `config.integrationId` |

### 3.3 Authentication Parameters (from CredentialStore)

| Parameter | Source | ProxyConfig | PluginContext |
|-----------|--------|-------------|---------------|
| SSO cookies | CredentialStore.retrieveSSOCredentials() | ❌ | via `credentials.cookies` |

---

## 4. Environment Variable Reference

### Generic (Always Set)

```bash
CODEMIE_PROVIDER=ai-run-sso
CODEMIE_BASE_URL=https://codemie.ai
CODEMIE_API_KEY=<session-token>
CODEMIE_MODEL=claude-3-5-sonnet
CODEMIE_TIMEOUT=300
CODEMIE_DEBUG=1
CODEMIE_PROFILE_NAME=work
CODEMIE_CLI_VERSION=0.0.16
```

### Provider-Specific (SSO)

```bash
CODEMIE_URL=https://codemie.ai
CODEMIE_INTEGRATION_ID=<integration-uuid>
```

### Agent-Specific (via envMapping)

Provider templates define which vars to set:

**OpenAI-compatible agents** (Codex, Gemini):
```bash
OPENAI_BASE_URL=https://codemie.ai
OPENAI_API_KEY=<session-token>
```

**Anthropic agents** (Claude):
```bash
ANTHROPIC_BASE_URL=https://codemie.ai
ANTHROPIC_API_KEY=<session-token>
```

---

## 5. Data Flow Summary

### Config → Environment → Agent → Proxy → Plugins

1. **Config Sources Merged** (ConfigLoader.load)
   - Priority: CLI > Env > Project > Global > Defaults
   - Result: `CodeMieConfigOptions`

2. **Converted to Environment Variables** (exportProviderEnvVars)
   - Generic: `CODEMIE_*`
   - Provider-specific: Based on `envMapping`
   - Result: `Record<string, string>`

3. **Extracted by Agent** (BaseAgentAdapter.extractConfig)
   - Reads back from environment variables
   - Result: `AgentConfig`

4. **Passed to Proxy** (CodeMieProxy constructor)
   - Combined with runtime values (sessionId)
   - Result: `ProxyConfig`

5. **Available to Plugins** (PluginContext)
   - Config: via `context.config`
   - Credentials: via `context.credentials`
   - Logger: via `context.logger`
