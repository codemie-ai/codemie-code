# External Integrations

## Quick Summary

External service integration patterns for CodeMie Code: LangGraph orchestration, LangChain LLM abstractions, and multi-provider support.

**Category**: Integration
**Complexity**: Medium-High
**Prerequisites**: LangGraph, LangChain, async/await, LLM concepts

---

## Integrated Services

| Service | Purpose | Auth Method | Configuration |
|---------|---------|-------------|---------------|
| LangGraph | Agent orchestration & state machines | N/A | Framework integration |
| LangChain | LLM abstractions & tool calling | N/A | Framework integration |
| OpenAI | GPT models | API Key | OPENAI_API_KEY |
| Anthropic Claude | Claude models | API Key | ANTHROPIC_API_KEY |
| Google Gemini | Gemini models | API Key | GOOGLE_AI_API_KEY |
| AWS Bedrock | Claude via AWS | AWS Credentials | AWS auth chain |
| Azure OpenAI | GPT via Azure | API Key + Endpoint | Azure credentials |
| LiteLLM | 100+ providers proxy | Varies | Provider-specific |
| OpenCode | Open-source AI assistant | SSO/API Key | Via CodeMie proxy |
| Enterprise SSO | Corporate auth | SAML/OAuth | SSO base URL |

---

## LangGraph Integration

### Agent Orchestration Pattern

```typescript
// Source: src/agents/codemie-code/agent.ts:50-80
import { StateGraph } from '@langchain/langgraph';

// Define state type
interface AgentState {
  messages: BaseMessage[];
  files: FileContext[];
  nextAction: string;
}

// Create state graph
const workflow = new StateGraph<AgentState>({
  channels: {
    messages: {
      reducer: (state, update) => [...state, ...update]
    }
  }
});

// Add nodes
workflow.addNode('process', processNode);
workflow.addNode('execute', executeNode);

// Add edges
workflow.addEdge('__start__', 'process');
workflow.addConditionalEdges('process', routeAction);

// Compile
const app = workflow.compile();
```

**Key Concepts**:
- **State Graph**: Manages agent state transitions
- **Nodes**: Processing functions (process, execute, validate)
- **Edges**: Control flow between nodes
- **Conditional Edges**: Dynamic routing based on state
- **Compilation**: Produces executable agent

---

## LangChain Integration

### LLM Abstraction Pattern

```typescript
// Source: src/providers/plugins/openai/openai.provider.ts:30-50
const llm = new ChatOpenAI({
  modelName: 'gpt-4',
  apiKey: process.env.OPENAI_API_KEY
});

const response = await llm.invoke(messages);
```

**Benefits**: Unified interface, streaming, tool calling, built-in retries

---

## Provider Plugins

### Plugin Pattern

```typescript
// Source: src/providers/core/types.ts:10-30
export interface LLMProvider {
  name: string;
  createChatModel(config: ProviderConfig): BaseChatModel;
  validateConfig(config: ProviderConfig): Promise<void>;
  getDefaultModel(): string;
  getSupportedModels(): string[];
}

// Example: OpenAI Provider
export class OpenAIProvider implements LLMProvider {
  name = 'openai';

  createChatModel(config: ProviderConfig): BaseChatModel {
    return new ChatOpenAI({
      apiKey: config.apiKey,
      model: config.model || 'gpt-4'
    });
  }
}
```

**Provider Registry**:
- OpenAI (direct API)
- Anthropic (direct API)
- AWS Bedrock (Claude via AWS)
- Azure OpenAI (GPT via Azure)
- LiteLLM (unified proxy)
- Enterprise SSO (corporate)

---

## Multi-Provider Configuration

### Profile-Based Provider Selection

```typescript
// Source: src/env/config-loader.ts:100-130
{
  "profiles": {
    "default": {
      "provider": {
        "type": "openai",
        "apiKey": "${OPENAI_API_KEY}",
        "model": "gpt-4"
      }
    },
    "work": {
      "provider": {
        "type": "sso",
        "baseUrl": "https://api.company.com",
        "workspace": "team-workspace"
      }
    },
    "aws": {
      "provider": {
        "type": "bedrock",
        "region": "us-east-1",
        "model": "anthropic.claude-3-sonnet-20240229-v1:0"
      }
    }
  }
}
```

**Profile Management**:
```bash
# Switch profiles
codemie profile use work

# List profiles
codemie profile list

# Create profile
codemie setup  # Interactive
```

---

## Authentication Patterns

### API Key (OpenAI, Anthropic, Gemini)

```typescript
// Environment variable
const apiKey = process.env.OPENAI_API_KEY;

// In provider config
const llm = new ChatOpenAI({
  apiKey: apiKey
});
```

### AWS Bedrock & SSO

```typescript
// AWS: Uses credential chain (env → profile → instance role)
const client = new BedrockRuntimeClient({ region: 'us-east-1' });

// SSO: Stored credentials with auto-refresh
const store = CredentialStore.getInstance();
const creds = await store.retrieveSSOCredentials(baseUrl);
```

**SSO Project Selection:**
- Merges `applications` and `applicationsAdmin` arrays (deduplicated)
- Sorts alphabetically, auto-selects if single project
- Source: `src/providers/plugins/sso/sso.setup-steps.ts:93-106`

---

## Tool Calling Integration

### LangChain Tool Pattern

```typescript
// Source: src/agents/codemie-code/tools/read-file.ts:20-40
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

export const readFileTool = tool(
  async ({ filePath }, { config }) => {
    const content = await fs.readFile(filePath, 'utf-8');
    return content;
  },
  {
    name: 'read_file',
    description: 'Read contents of a file',
    schema: z.object({
      filePath: z.string().describe('Path to file')
    })
  }
);
```

**Tool Features**:
- Schema validation (Zod)
- Type safety
- Auto-generated descriptions for LLMs
- Async execution
- Error handling

---

## Error Handling & Retries

### Provider Error Handling

```typescript
// Source: src/providers/core/retry-handler.ts:20-40
try {
  const response = await llm.invoke(messages);
  return response;
} catch (error) {
  if (isRateLimitError(error)) {
    logger.warn('Rate limit hit, retrying after delay');
    await delay(calculateBackoff(attempt));
    return retry();
  }

  if (isAuthError(error)) {
    throw new ConfigurationError('Invalid API key');
  }

  throw error;
}
```

| Error Type | Status | Action |
|------------|--------|--------|
| Rate Limit | 429 | Exponential backoff, retry |
| Auth Error | 401/403 | Don't retry, throw ConfigurationError |
| Timeout | N/A | Retry with longer timeout |
| Server Error | 500-599 | Retry with backoff |
| Client Error | 400-499 | Don't retry (except 429) |

---

## Streaming Support

### Stream Handler Pattern

```typescript
// Source: src/agents/codemie-code/streaming.ts:30-50
const stream = await llm.stream(messages);
for await (const chunk of stream) {
  process.stdout.write(chunk.content);
  if (chunk.usage_metadata) totalTokens += chunk.usage_metadata.total_tokens;
}
```

---

## LiteLLM Proxy Integration

### Universal Provider Pattern

```typescript
// Source: src/providers/plugins/litellm/litellm.provider.ts:20-40
import { ChatOpenAI } from '@langchain/openai';

// LiteLLM uses OpenAI-compatible API
const llm = new ChatOpenAI({
  apiKey: config.apiKey,
  model: config.model, // Any LiteLLM-supported model
  configuration: {
    baseURL: config.baseUrl || 'http://localhost:4000'
  }
});
```

**Supported via LiteLLM** (100+ providers):
- OpenAI, Anthropic, Gemini
- Cohere, Replicate, HuggingFace
- Azure, AWS, GCP
- Ollama (local models)
- Custom OpenAI-compatible endpoints

---

## OpenCode Integration

### Overview

OpenCode is an open-source AI coding assistant. CodeMie integrates OpenCode via:
- **CLI Wrapper**: Wraps `opencode-ai` npm package
- **SSO/Proxy Support**: Routes through CodeMie SSO proxy
- **Session Analytics**: Automatic metrics extraction and sync
- **Model Configuration**: Dynamic config injection using OpenCode's native format

### Installation

```bash
# Install via CodeMie (recommended)
codemie install opencode

# Or directly via npm
npm install -g opencode-ai
```

### Usage

```bash
# Start OpenCode with CodeMie proxy
codemie-opencode "Generate unit tests"

# Specify model
codemie-opencode --model gpt-5-2-2025-12-11 "Refactor this code"
```

### Configuration Pattern

```typescript
// Source: src/agents/plugins/opencode/opencode.plugin.ts:160-225
// CodeMie injects config via environment variables:
// - OPENCODE_CONFIG_CONTENT (primary): Inline JSON config
// - OPENCODE_CONFIG (fallback): Path to temp config file

const openCodeConfig = {
  enabled_providers: ['codemie-proxy'],
  provider: {
    'codemie-proxy': {
      npm: '@ai-sdk/openai-compatible',
      name: 'CodeMie SSO',
      options: {
        baseURL: `${proxyUrl}/`,
        apiKey: 'proxy-handled',
        timeout: 600000,
        headers: { /* custom headers */ }
      },
      models: {
        [modelConfig.id]: {
          id: 'gpt-5-2-2025-12-11',
          name: 'gpt-5-2-2025-12-11',
          family: 'gpt-5',
          tool_call: true,
          reasoning: true,
          // ... model capabilities
        }
      }
    }
  },
  defaults: {
    model: 'codemie-proxy/gpt-5-2-2025-12-11'
  }
};
```

### Session Analytics

**Automatic Processing**:
- OpenCode sessions stored in `~/.local/share/opencode/storage/` (Linux) or `~/Library/Application Support/opencode/storage/` (macOS)
- Metrics automatically extracted on session end via `onSessionEnd` lifecycle hook
- Synced to v1/metrics API via SessionSyncer (same as Claude/Gemini)

**Manual Processing**:
```bash
# Process specific session
codemie opencode-metrics --session ses_abc123...

# Discover and process all recent sessions
codemie opencode-metrics --discover --verbose
```

### Session File Format

```typescript
// Source: src/agents/plugins/opencode/opencode-message-types.ts
interface OpenCodeSession {
  id: string;
  projectId: string;
  createdAt: number;
  updatedAt: number;
  title?: string;
  metadata?: {
    model?: string;
    provider?: string;
  };
}

interface OpenCodeMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  content: OpenCodePart[];
  createdAt: number;
  metadata?: {
    tokens?: OpenCodeTokens;
    duration?: number;
  };
}

interface OpenCodeTokens {
  input: number;
  output: number;
  total: number;
}
```

### Session Adapter Pattern

```typescript
// Source: src/agents/plugins/opencode/opencode.session.ts:72-100
export class OpenCodeSessionAdapter implements SessionAdapter {
  async discoverSessions(options: SessionDiscoveryOptions): Promise<SessionDescriptor[]> {
    // Find sessions in XDG storage path
    const sessionsPath = getOpenCodeSessionsPath();
    // Discover all sessions modified within maxAgeDays
    return sessions;
  }

  async parseSessionFile(filePath: string, sessionId: string): Promise<ParsedSession> {
    // Read session JSON with retry logic (handles concurrent writes)
    // Extract messages, tokens, duration
    return parsedSession;
  }

  async processSession(filePath: string, sessionId: string, context: ProcessingContext): Promise<AggregatedResult> {
    // Run processor chain: metrics → conversations
    // Each processor writes JSONL deltas
    // SessionSyncer syncs to v1/metrics API
    return result;
  }
}
```

### Metrics Processor Pattern

```typescript
// Source: src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts
export class OpenCodeMetricsProcessor implements SessionProcessor {
  readonly name = 'opencode-metrics';
  readonly priority = 1; // Runs first

  async process(session: ParsedSession, context: ProcessingContext): Promise<ProcessorResult> {
    // Extract metrics from session
    const metrics = {
      sessionId: context.sessionId,
      agentSessionId: session.sessionId,
      tokens: {
        input: totalInputTokens,
        output: totalOutputTokens,
        total: totalInputTokens + totalOutputTokens
      },
      duration: sessionDuration,
      cost: calculatedCost,
      model: session.model
    };

    // Write to JSONL (deduplicated)
    await writeDelta('opencode', 'metrics', context.sessionId, metrics);

    return { success: true, message: 'Metrics extracted', metadata: { deltasWritten: 1 } };
  }
}
```

### XDG Path Conventions

OpenCode follows XDG Base Directory Specification:

```typescript
// Source: src/agents/plugins/opencode/opencode.paths.ts
// Linux: ~/.local/share/opencode/storage/
// macOS: ~/Library/Application Support/opencode/storage/
// Windows: %LOCALAPPDATA%\opencode\storage\

export function getOpenCodeStoragePath(): string | null {
  const platform = process.platform;
  const home = os.homedir();

  if (platform === 'linux') {
    return join(home, '.local', 'share', 'opencode', 'storage');
  } else if (platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'opencode', 'storage');
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(localAppData, 'opencode', 'storage');
  }

  return null;
}
```

### Lifecycle Hooks

```typescript
// Source: src/agents/plugins/opencode/opencode.plugin.ts:145-326
export const OpenCodePluginMetadata: AgentMetadata = {
  lifecycle: {
    // Runs before OpenCode starts
    async beforeRun(env: NodeJS.ProcessEnv, config: AgentConfig) {
      // 1. Create session metadata file
      await ensureSessionFile(sessionId, env);
      // 2. Inject model config via env vars
      env.OPENCODE_CONFIG_CONTENT = configJson;
      return env;
    },

    // Runs after OpenCode exits (before SessionSyncer)
    async onSessionEnd(exitCode: number, env: NodeJS.ProcessEnv) {
      // 1. Discover recent sessions
      const sessions = await adapter.discoverSessions({ maxAgeDays: 1 });
      // 2. Process latest session
      await adapter.processSession(latestSession.filePath, sessionId, context);
      // 3. SessionSyncer runs IMMEDIATELY after (syncs to v1/metrics)
    }
  }
};
```

### Integration with SessionSyncer

**Flow**:
1. OpenCode exits
2. Grace period (wait for file writes)
3. `onSessionEnd` hook processes metrics to JSONL
4. SessionSyncer reads JSONL deltas
5. SessionSyncer sends to v1/metrics API
6. Proxy stops

This matches Claude/Gemini real-time sync behavior where metrics are automatically synced during the session lifecycle.

---

## Environment Variables

### Provider-Specific

```bash
# OpenAI
OPENAI_API_KEY=sk-...
OPENAI_ORG_ID=org-...  # Optional

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Google Gemini
GOOGLE_AI_API_KEY=...

# AWS Bedrock
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_PROFILE=default  # Or use profile

# Azure OpenAI
AZURE_OPENAI_API_KEY=...
AZURE_OPENAI_ENDPOINT=https://....openai.azure.com/
AZURE_OPENAI_DEPLOYMENT_NAME=gpt-4

# LiteLLM
LITELLM_API_KEY=...
LITELLM_BASE_URL=http://localhost:4000

# OpenCode (via CodeMie proxy)
CODEMIE_BASE_URL=https://proxy.codemie.ai
CODEMIE_MODEL=gpt-5-2-2025-12-11
CODEMIE_OPENCODE_BIN=opencode  # Custom OpenCode binary path (optional)

# Enterprise SSO
SSO_BASE_URL=https://api.company.com
SSO_WORKSPACE=team-workspace
SSO_PROJECT=selected-project  # Auto-populated during setup
```

---

## Configuration Validation

### Startup Checks

```typescript
// Source: src/env/config-loader.ts:150-170
export class ConfigLoader {
  private static async validateProvider(config: ProfileConfig): Promise<void> {
    const { provider } = config;

    // Check API key exists
    if (provider.type === 'openai' && !provider.apiKey) {
      throw new ConfigurationError(
        'OpenAI API key required. Set OPENAI_API_KEY or configure in profile.'
      );
    }

    // Validate connectivity
    try {
      await testProviderConnection(provider);
    } catch (error) {
      logger.warn('Provider connection test failed', error);
    }
  }
}
```

---

## Best Practices

| ✅ DO | ❌ DON'T |
|-------|----------|
| Use LangChain abstractions | Implement custom LLM clients |
| Store credentials securely | Hardcode API keys |
| Handle rate limits gracefully | Spam API without backoff |
| Validate config at startup | Fail silently on bad config |
| Use provider-specific models | Use unsupported model names |
| Stream responses for UX | Buffer entire response |
| Log sanitized requests | Log raw API keys |
| Use profiles for environments | Mix dev/prod credentials |

---

## Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| "Invalid API key" | Wrong/missing key | Check env var, regenerate key |
| Rate limit errors | Too many requests | Implement backoff, upgrade plan |
| Timeout errors | Large context/slow model | Increase timeout, use faster model |
| SSO auth fails | Expired token | Refresh credentials via `codemie setup` |
| AWS auth fails | Missing credentials | Configure AWS CLI or set env vars |
| LiteLLM connection error | Proxy not running | Start LiteLLM: `litellm --port 4000` |
| OpenCode not found | Not installed | `codemie install opencode` or `npm i -g opencode-ai` |
| OpenCode sessions not syncing | Metrics processing failed | Check `codemie opencode-metrics --discover --verbose` |

---

## References

- **Provider Plugins**: `src/providers/plugins/`
- **Provider Core**: `src/providers/core/types.ts`
- **Agent System**: `src/agents/codemie-code/`
- **OpenCode Plugin**: `src/agents/plugins/opencode/`
- **Session Adapters**: `src/agents/core/session/`
- **LangGraph Docs**: https://langchain-ai.github.io/langgraphjs/
- **LangChain Docs**: https://js.langchain.com/
- **LiteLLM**: https://docs.litellm.ai/
- **OpenCode**: https://github.com/opencode-ai/opencode

---
