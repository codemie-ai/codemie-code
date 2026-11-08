# External Integrations

## Service Overview

| Service | Purpose | Auth Method | Config Key |
|---------|---------|-------------|------------|
| LangChain | LLM calls for prompt-driven hooks | Profile credentials | `src/hooks/prompt-executor.ts::PromptHookExecutor` |
| CodeMie SSO (`ai-run-sso`) | Default provider; owns the local proxy | Browser SSO, tokens in `CredentialStore` | `src/providers/plugins/sso/sso.template.ts` |
| Bearer Authorization (`jwt`) | Bearer-token access to CodeMie | JWT in `CredentialStore` | `src/providers/plugins/jwt/jwt.template.ts` |
| LiteLLM (`litellm`) | OpenAI-compatible proxy | API key | `src/providers/plugins/litellm/litellm.template.ts` |
| AWS Bedrock (`bedrock`) | Claude and other models via AWS | AWS credentials / profile | `src/providers/plugins/bedrock/bedrock.template.ts` |
| Ollama (`ollama`) | Local models | None | `src/providers/plugins/ollama/ollama.template.ts` |
| Anthropic / Moonshot subscription | The vendor's own subscription login | None in CodeMie (vendor CLI) | `src/providers/plugins/anthropic-subscription/`, `src/providers/plugins/moonshot-subscription/` |
| OpenCode | Open-source AI assistant | SSO/API Key | Via CodeMie proxy |
| MCP Servers | Remote MCP tool servers | OAuth 2.0 (auto) | `codemie-mcp-proxy` |
| OTLP hook ingestion | Coding tool's own native hook/telemetry events → analytics pipeline | Via CodeMie proxy daemon | `codemie hook --agent <adapter-name>` |

---

## LangChain Integration

LangChain (`@langchain/openai`, `@langchain/core`) is used only for LLM-facing integrations such as prompt-driven hooks, not for an agent runtime or a provider plugin.

| Do | Don't |
|----|-------|
| `new ChatOpenAI({ apiKey, model })` for a hook prompt | Custom HTTP client per hook |

`file:src/hooks/prompt-executor.ts::PromptHookExecutor`

---

## Provider Plugin Contract

Every provider exports a `ProviderTemplate` (`src/providers/core/types.ts::ProviderTemplate`): `name`, `displayName`, `description`, `defaultBaseUrl`, `authType`, `recommendedModels`, `capabilities`, `supportsModelInstallation`, plus optional `exportEnvVars`, `agentHooks` and setup metadata. The template calls `ProviderRegistry.registerProvider()` when its module is imported; health checks, model fetchers and setup steps register beside it.

Registered providers: `ai-run-sso`, `jwt`, `litellm`, `bedrock`, `ollama`, `anthropic-subscription`, `moonshot-subscription`.

---

## Profile-Based Provider Selection

Profiles select the active provider at runtime. Priority: CLI args > env vars > project config > global config > defaults.

Each profile in `~/.codemie/codemie-cli.config.json` (global) or `.codemie/codemie-cli.config.json` (project) names its `provider`, `baseUrl`, `model` and credentials; `activeProfile` picks one.

Switch with `codemie profile switch <name>`. `file:src/utils/config.ts::ConfigLoader.load`

---

## Authentication Patterns

### API key (LiteLLM, Bedrock)

Stored in the profile or supplied by the `CODEMIE_API_KEY` override; never hardcode.

### AWS Bedrock

Bedrock setup reads AWS credentials (profile or access keys) through the AWS SDK credential providers. `file:src/providers/plugins/bedrock/bedrock.setup-steps.ts`

### Enterprise SSO

Credentials stored in `CredentialStore` with auto-refresh. Project list merges `applications` + `applicationsAdmin` (deduplicated, sorted alphabetically; auto-selected when only one). `file:src/providers/core/codemie-auth-helpers.ts::applicationsAdmin`

---


## LiteLLM Proxy

LiteLLM exposes an OpenAI-compatible API; the `litellm` provider points agents at the profile's `baseUrl` with its API key. `file:src/providers/plugins/litellm/litellm.template.ts`

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

`file:src/agents/plugins/opencode/opencode.plugin.ts::OPENCODE_CONFIG_CONTENT`

### Session Analytics Flow

1. OpenCode exits → grace period for file writes
2. `onSessionEnd` hook: selects the run's own sessions — the session id the launch named (`--session <ses_>`), plus every session created inside the run window `[startTime, nextRecordStart)` in the record's working directory (by realpath), a subagent's child sessions included (with no conversation and no user prompt of their own); a run launched as a continuation (`--continue` / `-c`) adds, of the older sessions (not a subagent's child) updated inside the window, the newest with a message inside it, else the newest updated; a record with no directory selects only the session it named. A fresh run with no session of its own selects nothing: nothing is flushed, the record still finalizes. There is no "newest anywhere" fallback. Each selected session is processed in turn — its deltas go to the record's JSONL, its turns to its own conversation
3. `SessionSyncer` reads JSONL → POSTs to `v1/metrics` API

`file:src/agents/plugins/opencode/opencode.plugin.ts::onSessionEnd`

### XDG Storage Paths

| Platform | Path |
|----------|------|
| Linux | `~/.local/share/opencode/storage/` |
| macOS | `~/Library/Application Support/opencode/storage/` |
| Windows | `%LOCALAPPDATA%\opencode\storage\` |

`file:src/agents/plugins/opencode/opencode.paths.ts::getOpenCodeStoragePath` — the built-in `codemie-code` points OpenCode's XDG data dir at `~/.codemie/opencode-storage`, and storage is either the legacy file layout or `opencode.db` (SQLite, `opencode.sqlite-reader.ts`).

### Key Session Types

`file:src/agents/plugins/opencode/opencode-message-types.ts` — defines `OpenCodeSession`, `OpenCodeMessage`, `OpenCodeTokens`.

### Session Adapter

`file:src/agents/plugins/opencode/opencode.session.ts::OpenCodeSessionAdapter` — implements `discoverSessions`, `parseSessionFile`, `processSession` with retry logic for concurrent writes.

### Metrics Processor

`file:src/agents/plugins/opencode/session/processors/opencode.metrics-processor.ts` — priority 1; extracts tokens, duration, cost; hands its deltas to the shared `MetricsWriter`, which dedupes them by `recordId`, applies the run window and appends them to the JSONL.

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
- Tool deltas: `file:src/agents/plugins/codex/session/processors/codex.metrics-processor.ts` (keyed by `call_id`): a call gives its delta once its output appears, as success, at its own line's time; a call without output is not counted
- Lifecycle: `file:src/agents/plugins/codex/codex.plugin.ts` (`onSessionStart`/`onSessionEnd`) → `processEvent` in `file:src/cli/commands/hook.ts::processEvent`
- `status` hardcoded `'completed'`; end signal travels in `reason` field. Stranded sessions (a dead owner) → `reason: 'interrupted'`, sent with the native `session_id`.

**Pipeline B — LLM proxy traffic → `codemie_litellm_proxy_usage`**
- Traffic routed through `CODEMIE_BASE_URL` via `model_providers.codemie` block: `file:src/agents/plugins/codex/codex.plugin.ts::model_providers`
- Headers injected per request: `file:src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts::buildAttributionHeaders`
- Backend computes cost from `cost_config`; analytics joins pipelines by `session_id`.

**Session reconciliation** (every agent, every wrapper start): `reconcileOtherSessions` scans `~/.codemie/sessions/<uuid>.json` — a `stranded` record (`status: "active"` whose owner process `ownerPid` + `ownerStartedAt` is gone; no inactivity threshold) gets a synthetic `SessionEnd` (`reason: 'interrupted'`, `endTimeFromActivity`, the native `session_id`) with the final flush of its transcript, ending at its last recorded activity; an `undelivered` record (`completed` but still `{id}.json`) is delivered through the launch's own send path, same CodeMie host only; a `legacy` record (no `ownerPid`) idle > 72 h is finalized locally, nothing sent. A record is renamed `completed_*` only once delivered — the file name is the queue. ≤ 5 records per start, ≤ 3 attempts each, each attempt stopped 10 s after it starts, under `{id}.reconcile.lock`. The wrapper awaits the pass and finalizes its own record at exit within a 10 s budget; on a normal exit (`prompt_input_exit` / `logout`) of an agent whose `SessionEnd` runs as a `codemie hook` process, the hook only finalizes locally and this exit step sends the end metric, syncs and renames. `file:src/agents/core/session/stale-session-reconciliation.ts::reconcileOtherSessions`

---

## Codex Model Resolution

Codex-desktop picks its model by a fixed precedence: **explicit `--model` flag > active profile `config.model` > recency-ranked default deployment**. The profile/undated picker name (e.g. `gpt-5.6-luna`) is resolved to its dated deployment via `resolveCodexDeployment`, never matched literally.

- **Connect-time** — `selectCodexModel(discovered, requested?, profileModel?)` writes the pinned model into `~/.codex/config.toml`. An explicit `--model` resolves-or-throws; otherwise the profile model is resolved and used, dropping to `discovered[0]` when it has no Codex equivalent. `file:src/cli/commands/proxy/connectors/codex-desktop.ts::selectCodexModel`
- **Request-time fallback** — the proxy normalizer's `resolveFallbackModel` substitutes the resolved profile model for an unmatched in-flight request, else the recency default. `file:src/providers/plugins/sso/proxy/plugins/codex-request-normalizer.plugin.ts::resolveFallbackModel`
- **Non-Codex profile models are ignored, never pinned.** An Anthropic/Sonnet profile model (e.g. `claude-sonnet-5`) is filtered by `isCodexServableDeployment` and resolves to `unresolved`, so it falls back to a Codex deployment rather than being written into a Codex request — and connect-time does **not** throw for it (only an explicit `--model` throws). `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts::isCodexServableDeployment`, `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts::resolveCodexDeployment`
- **Daemon lifecycle keys on the model.** `normalizeDaemonModel` feeds `daemonMatchesRequest`, so a changed profile model against an otherwise-matching live daemon **forces a restart** rather than reusing the stale one. `file:src/cli/commands/proxy/connect-orchestrator.ts::normalizeDaemonModel`, `file:src/cli/commands/proxy/connect-orchestrator.ts::daemonMatchesRequest`

The pure resolver in `codex-model-resolver.ts` is intentionally self-contained: the proxy must not depend on the Codex agent plugin.

---

## Claude Session Processing

`ConversationsProcessor` transforms raw JSONL transcript messages from a Claude Code session into conversation-log turns and syncs them to a per-session JSONL file. The processor is invoked on every `Stop` and `SessionEnd` hook event.

### Drain Loop

Claude Code's `Stop` hook fires only when the assistant responds. A burst of `!bash` commands with no assistant reply produces zero `Stop` events; without a drain loop those turns are lost before `SessionEnd` finalises the transcript. `processMessages` therefore iterates `transformMessages` in a bounded loop rather than calling it once per hook event.

| Invariant | Rule |
|---|---|
| Hard iteration cap | `Math.max(1, n + 1)`, `n` — the length of the conversation view (`conversationMessages`, else `messages`) — prevents unbounded loops if `transformMessages` regresses |
| Empty-history exit | Loop breaks immediately when `transformMessages` returns `history: []` |
| Advance guard | Loop breaks if `lastProcessedMessageUuid` and `currentHistoryIndex` are both unchanged from the previous iteration |

The main-transcript sync reads the conversation view `conversationMessages`: a line re-written with the same `uuid` after a compaction (`compact_boundary` between the copies) keeps its first copy, so it is not turned into a history entry again after the sync pointer; other duplicates keep their last copy, as in `messages`. `computeBaselinePointer` reads the same view. A CLI `claude` / `claude-acp` record takes the same start-time baseline as Desktop, judged by each line's timestamp rather than its position in the file, so a resumed or continued transcript sends only what follows the record's start, and a run takes no prompt or invocation from a line stamped before it; invocation counts are per run. The `SessionEnd` pass also counts the prompts typed after the last answered turn, as one prompts-only delta when no turn emits.

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::processMessages`

### Per-Iteration Sync Checkpoint

After each successful JSONL append, `SessionStore.saveSession()` persists the updated sync pointer to session metadata. A crash mid-drain cannot cause the next invocation to re-append already-written turns; the final `applyProcessingSyncUpdates` pass is idempotent for the same fields.

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::saveSession`

### Bash Passthrough Contract

Claude Code injects `!bash` commands as synthetic `type:'user'` messages. The processor must unwrap the command and filter all terminal-output messages so they do not consume turn slots.

| Raw transcript form | Handling |
|---|---|
| `<bash-input>cmd</bash-input>` | Unwrapped to `!cmd` by `extractCommand`; emits a `User` entry |
| `<bash-stdout>…` / `<bash-stderr>…` | Filtered by `isSystemMessage`; never consumes a turn slot |
| `<bash-input></bash-input>` (empty or whitespace) | Filtered; no bare `!` entry emitted |

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::extractCommand`, `file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts::isSystemMessage`

---

## OTLP Hook-Event Ingestion (`OtlpAgentAdapter`)

A separate, agent-agnostic integration from the above: each coding tool that exposes its own native hook/telemetry surface (Claude Code today; e.g. a future Cursor integration) gets one `OtlpAgentAdapter` plugin (`src/agents/plugins/<name>/`) that turns those events into CodeMie analytics via `codemie hook --agent <adapter-name>` → proxy daemon spool → analytics API. The dispatch contract, how to add a new native event to an adapter, and how to wire up a new tool are **not** duplicated here — see `docs/ARCHITECTURE-OTLP-PLUGIN.md`. `claude-code-otlp` (`src/agents/plugins/claude-code-otlp/`) is the current reference implementation.

---

## Other Managed Agents

| Agent | Integration point | Evidence |
|---|---|---|
| Pi | Each run gets `PI_CODING_AGENT_DIR` (project-local `.pi/codemie/agent` by default); metrics come from an injected extension plus a run ledger | `file:src/agents/plugins/pi/pi.paths.ts::getPiAgentDir` |
| Kimi / Kimi ACP | ACP variant prepends `acp` to argv | `file:src/agents/plugins/kimi/kimi-acp.plugin.ts::KimiAcpPlugin` |
| Copilot CLI (managed) | Launches the real `copilot` binary and syncs conversations and usage to the shared spool | `file:src/agents/plugins/copilot-cli/copilot-cli.plugin.ts::CopilotCliPlugin` |

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

`ConfigLoader.load` merges CLI overrides, `CODEMIE_*` env vars, project config, global config and defaults; it throws for no missing key. Provider health checks (`ProviderRegistry.getHealthCheck`) run from `codemie doctor`. `file:src/providers/core/registry.ts::ProviderRegistry.getHealthCheck`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid API key" | Wrong/missing key in the profile | `codemie setup` or `codemie profile` to update it |
| Rate limit errors | Too many requests | Add backoff, upgrade plan |
| SSO auth fails | Expired token | `codemie setup` to refresh |
| AWS auth fails | Missing credentials | Configure AWS CLI or set env vars |
| LiteLLM connection error | Proxy not reachable at the profile `baseUrl` | Start LiteLLM or fix `baseUrl` |
| OpenCode not found | Not installed | `codemie install opencode` |
| OpenCode sessions not syncing | Metrics processing failed | `codemie opencode-metrics --discover --verbose` |
| Sessions stuck `status: active` | Hard kill skipped `onSessionEnd` | Finalized by the next wrapper start of any agent once the owner process is gone (`stale-session-reconciliation.ts`); a legacy record without `ownerPid` after 72 h idle |
| Codex `money_spent` is 0 | Backend `cost_config` missing model entry | Add model pricing in backend `cost_config` |

---

## References

- Provider plugins: `src/providers/plugins/`
- Provider core types: `src/providers/core/types.ts`
- OTLP hook-event adapters: `docs/ARCHITECTURE-OTLP-PLUGIN.md`
- OpenCode plugin: `src/agents/plugins/opencode/`
- Codex plugin: `src/agents/plugins/codex/`
- Claude plugin: `src/agents/plugins/claude/`
- MCP proxy: `src/mcp/`
- Session adapters: `src/agents/core/session/`
- Config loader: `src/utils/config.ts`
- Related guide: `.ai-run/guides/architecture/architecture.md`
