# External Integrations

## Service Overview

| Service | Purpose | Auth Method | Config Key |
|---------|---------|-------------|------------|
| LangGraph | Agent state machine orchestration | N/A | Framework |
| LangChain | LLM abstractions & tool calling | N/A | Framework |
| OpenAI | GPT models | API Key | `OPENAI_API_KEY` |
| Anthropic Claude | Claude models | API Key | `ANTHROPIC_API_KEY` |
| Google Gemini | Gemini models | API Key | `GOOGLE_AI_API_KEY` |
| AWS Bedrock | Claude via AWS | AWS credential chain | `AWS_REGION` + AWS auth |
| Azure OpenAI | GPT via Azure | API Key + Endpoint | `AZURE_OPENAI_*` |
| LiteLLM | 100+ provider proxy | Provider-specific | `LITELLM_BASE_URL` |
| OpenCode | Open-source AI assistant | SSO/API Key | Via CodeMie proxy |
| MCP Servers | Remote MCP tool servers | OAuth 2.0 (auto) | `codemie-mcp-proxy` |
| Enterprise SSO | Corporate auth | SAML/OAuth | `SSO_BASE_URL` |

---

## LangGraph Integration

LangGraph drives agent orchestration as a typed state machine; every node is a processing function and every edge (including conditional) is explicit routing logic.

| Concept | Role |
|---------|------|
| `StateGraph` | Manages agent state transitions |
| Node | Processing function (process / execute / validate) |
| Edge / Conditional Edge | Static or dynamic control flow |
| `workflow.compile()` | Produces the executable agent |

`file:src/agents/codemie-code/agent.ts:50-80`

---

## LangChain Integration

Use LangChain's `BaseChatModel` abstractions rather than raw HTTP calls; they provide streaming, tool calling, and retries out of the box.

| Do | Don't |
|----|-------|
| `new ChatOpenAI({ apiKey, model })` | Custom HTTP client per provider |
| Stream via `llm.stream(messages)` | Buffer entire response before yield |

`file:src/providers/plugins/openai/openai.provider.ts:30-50`

---

## Provider Plugin Contract

Every provider implements `LLMProvider` from `src/providers/core/types.ts`:

```typescript
export interface LLMProvider {
  name: string;
  createChatModel(config: ProviderConfig): BaseChatModel;
  validateConfig(config: ProviderConfig): Promise<void>;
  getDefaultModel(): string;
  getSupportedModels(): string[];
}
```

`file:src/providers/core/types.ts:10-30`

Registered providers: OpenAI, Anthropic, AWS Bedrock, Azure OpenAI, LiteLLM, Enterprise SSO.

---

## Profile-Based Provider Selection

Profiles select the active provider at runtime. Priority: CLI args > env vars > project config > global config > defaults.

| Profile | Provider type | Key config |
|---------|--------------|------------|
| `default` | `openai` | `OPENAI_API_KEY`, model `gpt-4` |
| `work` | `sso` | `SSO_BASE_URL`, `workspace` |
| `aws` | `bedrock` | `AWS_REGION`, Bedrock model ARN |

Switch with `codemie profile use <name>`. `file:src/env/config-loader.ts:100-130`

---

## Authentication Patterns

### API Key (OpenAI / Anthropic / Gemini / Azure)

Read from environment variable; never hardcode. `file:src/providers/plugins/openai/openai.provider.ts`

### AWS Bedrock

Uses the standard AWS credential chain (env → profile → instance role). No custom auth code needed.

### Enterprise SSO

Credentials stored in `CredentialStore` with auto-refresh. Project list merges `applications` + `applicationsAdmin` (deduplicated, sorted alphabetically; auto-selected when only one). `file:src/providers/plugins/sso/sso.setup-steps.ts:93-106`

| Auth Type | Retry on failure? | Error class |
|-----------|------------------|-------------|
| API Key | No — throw `ConfigurationError` | `ConfigurationError` |
| SSO token expired | No — re-run `codemie setup` | `ConfigurationError` |
| AWS credentials missing | No | `ConfigurationError` |

---

## Error Handling & Retries

Classify errors before deciding to retry. `file:src/providers/core/retry-handler.ts:20-40`

| Error | HTTP Status | Action |
|-------|-------------|--------|
| Rate limit | 429 | Exponential backoff, retry |
| Auth error | 401 / 403 | No retry — throw `ConfigurationError` |
| Server error | 500–599 | Retry with backoff |
| Client error | 400–499 (not 429) | No retry |
| Timeout | — | Retry with longer timeout |

---

## LiteLLM Proxy

LiteLLM exposes an OpenAI-compatible API; use `ChatOpenAI` pointed at `baseURL`. `file:src/providers/plugins/litellm/litellm.provider.ts:20-40`

```typescript
const llm = new ChatOpenAI({
  apiKey: config.apiKey,
  model: config.model,
  configuration: { baseURL: config.baseUrl || 'http://localhost:4000' }
});
```

Supported via proxy: OpenAI, Anthropic, Gemini, Cohere, Azure, AWS, GCP, Ollama, custom OpenAI-compatible endpoints.

---

## OpenCode Integration

### Two Deployment Modes

| Mode | Package | Install | Use case |
|------|---------|---------|----------|
| Built-in (`codemie-code`) | `@codemieai/codemie-opencode` binary | Bundled — no install | Default experience |
| Standalone (`opencode`) | `opencode-ai` npm (global) | `codemie install opencode` | Users who prefer standalone |

Both share: SSO/proxy routing, session analytics, model config injection.

### Config Injection

CodeMie injects model config via env vars before spawning OpenCode:
- `OPENCODE_CONFIG_CONTENT` (primary) — inline JSON
- `OPENCODE_CONFIG` (fallback) — path to temp file

`file:src/agents/plugins/opencode/opencode.plugin.ts:215-260`

### Session Analytics Flow

1. OpenCode exits → grace period for file writes
2. `onSessionEnd` hook: discovers and processes latest session → writes JSONL deltas
3. `SessionSyncer` reads JSONL → POSTs to `v1/metrics` API

`file:src/agents/plugins/opencode/opencode.plugin.ts:145-326`

### XDG Storage Paths

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/opencode/storage/` |
| macOS | `~/Library/Application Support/opencode/storage/` |
| Windows | `%LOCALAPPDATA%\opencode\storage\` |

`file:src/agents/plugins/opencode/opencode.paths.ts`

### Key Session Types

`file:src/agents/plugins/opencode/opencode-message-types.ts` — defines `OpenCodeSession`, `OpenCodeMessage`, `OpenCodeTokens`.

### Session Adapter

`file:src/agents/plugins/opencode/opencode.session.ts:72-100` — `OpenCodeSessionAdapter` implements `discoverSessions`, `parseSessionFile`, `processSession` with retry logic for concurrent writes.

### Metrics Processor

`file:src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts` — priority 1; extracts tokens, duration, cost; writes deduplicated JSONL deltas.

---

## MCP Server Integration

The MCP proxy bridges stdio JSON-RPC to streamable HTTP with automatic OAuth 2.0.

| Component | File | Purpose |
|-----------|------|---------|
| Stdio-HTTP Bridge | `src/mcp/stdio-http-bridge.ts` | JSON-RPC stdin ↔ HTTP |
| OAuth Provider | `src/mcp/auth/mcp-oauth-provider.ts` | Browser-based auth code flow |
| Callback Server | `src/mcp/auth/callback-server.ts` | Ephemeral localhost OAuth callback |
| MCP Auth Plugin | `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts` | URL rewriting + SSRF protection |

**OAuth flow**: `401 → metadata → dynamic registration → browser auth → callback → token`

**SSO Proxy Plugin (priority 3) adds:**
- URL rewriting: `/mcp_auth?original=<url>` for initial connections; `/mcp_relay/<root_b64>/<relay_b64>/<path>` for relayed requests
- Replaces `client_name` in Dynamic Client Registration with `MCP_CLIENT_NAME`
- Rejects private/loopback origins (hostname + DNS) — SSRF protection
- Per-flow origin scoping to prevent cross-flow confusion

| Env Var | Default | Purpose |
|---------|---------|---------|
| `MCP_CLIENT_NAME` | `CodeMie CLI` | OAuth registration name |
| `MCP_PROXY_DEBUG` | unset | Verbose proxy logging |
| `CODEMIE_PROXY_PORT` | auto | Fixed proxy port |

---

## Codex Cost & Metrics

Codex uses two pipelines (same model as Claude). Cost computed server-side; CLI never sends `money_spent`.

**Pipeline A — CLI tool/lifecycle → `POST /v1/metrics`**
- Tool deltas: `file:src/agents/plugins/codex/session/processors/codex.metrics-processor.ts` (keyed by `call_id`)
- Lifecycle: `file:src/agents/plugins/codex/codex.plugin.ts` (`onSessionStart`/`onSessionEnd`) → `processEvent` in `file:src/cli/commands/hook.ts:170-228`
- `status` hardcoded `'completed'`; end signal travels in `reason` field. Stale sessions → `reason: 'interrupted'`.

**Pipeline B — LLM proxy traffic → `codemie_litellm_proxy_usage`**
- Traffic routed through `CODEMIE_BASE_URL` via `model_providers.codemie` block: `file:src/agents/plugins/codex/codex.plugin.ts:222-281`
- Headers injected per request: `file:src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:30-83`
- Backend computes cost from `cost_config`; analytics joins pipelines by `session_id`.

**Stale-session reconciliation**: On every `onSessionStart`, `reconcileStaleCodexSessions` scans `~/.codemie/sessions/` for `status: "active"` sessions idle > 30 min and synthesises `SessionEnd` with `reason: 'interrupted'`. `file:src/agents/plugins/codex/codex.reconciliation.ts`

---

## skills.sh Wrapper (`codemie skills`)

Catalog-agnostic thin wrapper around the upstream `skills` npm CLI. Discovery, ranking, and source classification are out of scope for this CLI.

**Wrapper owns:**
- SSO auth gate before any subcommand
- Egress suppression (injects `DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1`, `CI=1`, shim blocks `add-skill.vercel.sh`)
- Best-effort agent auto-detection (`--agent claude-code` if `.claude/` present; `--agent cursor` if `.cursor/` present)
- Lifecycle events POSTed to `<api-base>/v1/skills/events` (`started` / `completed` / `failed`); fan-out per skill when `--skill` lists multiple

**Wrapper does not own:** catalog browsing, source trust labels, alias resolution, parsing upstream output.

| File | Purpose |
|------|---------|
| `src/cli/commands/skills/index.ts` | Entry point |
| `assets/skills-sh-egress-guard.cjs` | Telemetry shim |
| `src/cli/commands/skills/lib/run-skills-cli.ts` | Spawn helper |
| `src/cli/commands/skills/lib/require-auth.ts` | Auth gate |
| `src/cli/commands/skills/lib/skills-metrics.ts` | Event emitter |
| `src/cli/commands/skills/lib/error-classify.ts` | Error classifier |

---

## Configuration Validation

Validate provider config at startup; warn (not throw) on connectivity failures. `file:src/env/config-loader.ts:150-170`

| Check | Behavior |
|-------|----------|
| Missing API key | Throw `ConfigurationError` with env var name |
| Connectivity test fail | `logger.warn` only — don't block startup |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid API key" | Wrong/missing key | Check env var, regenerate |
| Rate limit errors | Too many requests | Add backoff, upgrade plan |
| SSO auth fails | Expired token | `codemie setup` to refresh |
| AWS auth fails | Missing credentials | Configure AWS CLI or set env vars |
| LiteLLM connection error | Proxy not running | `litellm --port 4000` |
| OpenCode not found | Not installed | `codemie install opencode` |
| OpenCode sessions not syncing | Metrics processing failed | `codemie opencode-metrics --discover --verbose` |
| Codex sessions stuck `status: active` | Hard kill skipped `onSessionEnd` | Auto-reconciled on next codex run via `codex.reconciliation.ts` |
| Codex `money_spent` is 0 | Backend `cost_config` missing model entry | Add model pricing in backend `cost_config` |

---

## References

- Provider plugins: `src/providers/plugins/`
- Provider core types: `src/providers/core/types.ts`
- OpenCode plugin: `src/agents/plugins/opencode/`
- Codex plugin: `src/agents/plugins/codex/`
- MCP proxy: `src/mcp/`
- Session adapters: `src/agents/core/session/`
- Config loader: `src/env/config-loader.ts`
- Related guide: `.ai-run/guides/architecture/architecture.md`
