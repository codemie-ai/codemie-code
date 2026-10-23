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
| OTLP hook ingestion | Coding tool's own native hook/telemetry events → analytics pipeline | Via CodeMie proxy daemon | `codemie hook --agent <adapter-name>` |

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
- `OPENCODE_CONFIG` (fallback) — path to temp file when the document exceeds the env size limit (same rule for both schemas)

The emitted shape follows the installed OpenCode major version, probed via `opencode --version` and cached with a TTL (`resolveOpenCodeConfigVersion()` — `PATH` resolution, shell execution on Windows for `.cmd` shims, 3s timeout, warn-and-fallback to v1 so startup never blocks on detection; a successful probe is trusted for 5 minutes — a per-invocation CLI process still probes at most once per run — and a failed probe's v1 fallback only for 30 seconds, so a long-lived process picks up an installed/upgraded binary without a restart):

A probe is successful only with exit code `0` and a complete version response (`major.minor.patch`, optional OpenCode label / `v` prefix and prerelease/build suffixes). Empty, malformed, partial or unrelated stdout and nonzero exits use the same warning + 30-second v1 fallback as execution failures, not the five-minute success cache. Raw stdout/stderr is not included in this validation warning. Windows executable quoting matches the launcher for resolved and fallback metadata paths; POSIX remains `shell: false`. Forced schema overrides and valid v1 classification are unchanged.

- OpenCode 1.x: `provider` (singular) + `npm` + `options`
- OpenCode 2.x: native `providers` (plural) + `package` + `settings` via `injectV2Config()` (inline primary, temp-file fallback); Responses-API models carry a per-model `/responses` package override

Both v2 proxy model loops explicitly preserve existing capabilities: `tool_call` → `capabilities.tools`, `modalities.input` → `capabilities.input`, and `modalities.output` → `capabilities.output`. A known `false` tool flag or text-only input must not fall back to OpenCode's custom-model defaults (`tools: true`, image input). This is a field translation only: the dynamic/static catalogue, v1 emission, reasoning/variants, limits, pricing and direct Ollama/Bedrock branches are unchanged.

`CODEMIE_OPENCODE_CONFIG_VERSION=1|2` forces a schema explicitly (e.g. to test v2 output without a v2 binary).

V2 standalone enrichment uses private flag-capability classification, independent of legacy `ownedSubcommands`. Existing server-backed commands with `ServerParams` retain isolation (`run`, `mini`, `api`, `models`, `stats`, `reload`, and the supported leaves under `auth`/`session`); bare `auth`/`session` groups and commands without that flag (`debug`, `mcp`, `plugin`, `upgrade/update`, `uninstall`, `serve`, `service`, `acp`, `pair`) pass through unchanged. Unknown words are not automatically TUI commands: only an existing directory argument or a root invocation without a positional command receives root isolation. Leading root option values are skipped during classification; explicit server/standalone flags are respected before `--`, and an injected flag is inserted before that separator. This does not change v1 argv/ownership or add support for new v2 command/model/resume APIs.

Each v2 branch pins `enabled_providers` to the single provider it declares, excluding other providers from the picker and default fallback. This does **not** prevent fallback to another model within that provider. The v2 proxy branch therefore rejects a selected model absent from the emitted catalogue with `ConfigurationError` before spawning OpenCode, for both explicit CLI/env choices and profile defaults. It neither picks a replacement nor invents a catalogue entry from fallback metadata. Catalogue-fetch fallback to the existing static configs is unchanged; membership in that fallback catalogue is not proof of live backend availability. The v1 emission, full-selector/resume contract and direct Ollama/Bedrock branches are unchanged by this guard.

The missing-model error names the profile when known and uses `CODEMIE_MODEL_SOURCE` to give source-specific recovery: correct `--model` for a CLI override; update/unset `CODEMIE_MODEL` for an env override; use `codemie setup` → **Update an existing profile** → the named profile → select and save an available model for a saved default. A one-run `codemie-opencode --profile <profile-name> --model <model-id>` does not persist the default. Use bare catalogue IDs while the full-selector contract remains unresolved. `codemie models list` lists the active profile only; select the matching profile first when needed. Without a provenance marker, the message does not claim that the model came from a saved profile.

Per-provider behaviour on 2.x:

| Provider | v2 emission | Requirement |
|----------|-------------|-------------|
| SSO/proxy | native `providers.codemie-proxy` with the full catalogue | — |
| Ollama | native endpoint-only block, no `models` map | OpenCode 2.x has no built-in `ollama` provider package. Inventory comes from its bundled discovery plugin, which reads the declared `baseURL`, enumerates `/api/tags` + `/api/show` (1s per request) and keeps only models whose capabilities include `completion`. An unreachable endpoint leaves the provider model-less — the allowlist turns that into an explicit error |
| Bedrock | native `providers.amazon-bedrock` using the built-in `@opencode/ai/providers/amazon-bedrock` package, declaring `region` and the selected model. Reasoning effort on Claude 3.7+ is declared as per-model `variants` mirroring OpenCode's `bedrockConverse` protocol (`output_config.effort` for 4.6+, `settings.thinking.budgetTokens` for 3.7 / 4.0-4.5) plus a `#<level>` reference suffix; The model entry declares the model's real limits, resolved from its Claude version — from the AWS Bedrock model cards (200k / 64k for Sonnet 4 / 4.5, Opus 4.5, Haiku 4.5; 200k / 32k for Opus 4.1; 1M / 64k for Sonnet 4.6; 1M / 128k for Opus 4.6+ and Sonnet 5 / Opus 5). Sonnet 4 uses the budget path; `xhigh` on Sonnet 4.6 is downgraded to `high` — so `fitThinkingBudget` is not clamped by the generic `getModelConfig()` fallback | Region and credentials resolve through the standard AWS environment / default credential chain |

`file:src/agents/plugins/opencode/opencode.plugin.ts:48,96,433-540`

The shared Bedrock model-ID helper preserves the existing `us.` geography when no region is supplied, including the v1 and built-in agent paths. Explicit regions select their routing geography; already-qualified model IDs and ARNs pass through unchanged, including an explicitly selected `global.` profile. Required version suffixes are not invented.

### Session Analytics Flow

1. OpenCode exits → grace period for file writes
2. `onSessionEnd` hook: discovers and processes latest session → writes JSONL deltas
3. `SessionSyncer` reads JSONL → POSTs to `v1/metrics` API

Turn boundaries arrive earlier, from the injected hooks plugin (`UserPromptSubmit` / `Stop` → `codemie hook`); the hook payloads point `transcript_path` at `opencode.db`, so a reader that returns nothing leaves every metric consumer empty while looking healthy.

`file:src/agents/plugins/opencode/opencode.plugin.ts:145-326`

### Session Database Layout

The analytics reader queries `opencode.db`, whose layout differs per OpenCode major. The layout is detected from `sqlite_master` (cached per database path), not from a version probe — the database on disk may have been written by a different release than the binary on `PATH`, and `codemie opencode-metrics` runs without launching the binary.

| Concern | OpenCode 1.x | OpenCode 2.x |
|---------|--------------|--------------|
| Sessions | `session` | `session_v2` (superset of the 1.x columns, plus `cost` / `tokens_*` / `time_idle`) |
| Messages | `message`, role in `data.role` | `session_message`, role in the `type` column, order in `seq` |
| Parts | `part` table, one row per part | no table — nested in the message row's `data.content[]` |
| Tool parts | `callID` / `tool` / `state.output` | `id` / `name` / `state.content[]`, translated on read; part ids are synthetic (`<messageId>:<index>`) |

2.x also stores non-message rows in the same table (`idle`, `system`, `shell`, `synthetic`, `agent-switched`, `model-switched`); only `user` and `assistant` are read.

V2 `edit` and `patch` metadata contains `files[]` entries shaped as `{file, patch, additions, deletions, status}`. The metrics processor translates these into existing file operations: `added` → `write`, `deleted` → `delete`, `modified` → `edit`, and `file` → `path`. Nonnegative integer additions/deletions are used directly (including zero); missing/invalid counts fall back to the existing unified-diff counter. Legacy patch `filePath/relativePath/type` and edit `filediff/diff` retain precedence, including mixed patch lists. No raw metadata rewrite, new delta/API fields, dedup reset or historical backfill is introduced.

Read failures throw instead of returning an empty list, so `discoverSessions` can distinguish "no sessions" from "could not read" and fall back to file-based discovery with a warning. Node 22.5+ uses `node:sqlite`; older Node falls back to the `sqlite3` CLI. The database is always opened read-only — it is the user's live file, possibly being written concurrently.

For a detected v2 database on Windows, `readSessionsFromDb()` converts cwd separators to `/` before binding the SQL filter, then converts returned Windows drive/UNC directory paths back to native `\` for filesystem callers. This mirrors upstream storage/fromDriver representation; it does not change casing, source IDs, query ordering/limits or discovery policy. The v1 layout, file fallback and POSIX paths (including literal backslashes) retain their existing representation. The gate uses the database layout, not the installed CLI version.

`file:src/agents/plugins/opencode/opencode.sqlite-reader.ts`

### Storage Paths and Database Resolution

The table below describes CodeMie's **legacy/file-backed fallback**, not universal OpenCode v2 defaults. SQLite resolution asks the actual metadata CLI binary via `debug paths db` with the launch's child environment. `OpenCodePathContext` carries the command, environment and optional legacy data directory; neither that directory nor platform defaults rewrite the probe's `XDG_DATA_HOME`.

| Platform | Legacy/file-backed fallback |
|----------|------|
| Linux | `~/.local/share/opencode/storage/` |
| macOS | `~/Library/Application Support/opencode/storage/` |
| Windows | `%LOCALAPPDATA%\opencode\storage\` |

OpenCode v2 uses `$XDG_DATA_HOME/opencode`, or `~/.local/share/opencode` when XDG is absent, across these platforms. Its binary reports the release-channel database and resolves relative `OPENCODE_DB` under its actual data root. Absolute `OPENCODE_DB` and `:memory:` do not depend on the root. If probing is unavailable, fallback is cached only for 30 seconds and does not certify channel selection; successful results are cached for five minutes with binary/path-environment-sensitive keys.

The built-in agent retains its deliberate `XDG_DATA_HOME=<codemie-home>/opencode-storage` redirect and uses its own resolved binary. SessionEnd discovery receives that per-run context instead of temporarily mutating/deleting the parent's `OPENCODE_STORAGE_PATH`. Default standalone installation remains `opencode-ai` / v1; v2 support does not change this policy.

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

## Codex Model Resolution

Codex-desktop picks its model by a fixed precedence: **explicit `--model` flag > active profile `config.model` > recency-ranked default deployment**. The profile/undated picker name (e.g. `gpt-5.6-luna`) is resolved to its dated deployment via `resolveCodexDeployment`, never matched literally.

- **Connect-time** — `selectCodexModel(discovered, requested?, profileModel?)` writes the pinned model into `~/.codex/config.toml`. An explicit `--model` resolves-or-throws; otherwise the profile model is resolved and used, dropping to `discovered[0]` when it has no Codex equivalent. `file:src/cli/commands/proxy/connectors/codex-desktop.ts:182`
- **Request-time fallback** — the proxy normalizer's `resolveFallbackModel` substitutes the resolved profile model for an unmatched in-flight request, else the recency default. `file:src/providers/plugins/sso/proxy/plugins/codex-request-normalizer.plugin.ts:217`
- **Non-Codex profile models are ignored, never pinned.** An Anthropic/Sonnet profile model (e.g. `claude-sonnet-5`) is filtered by `isCodexServableDeployment` and resolves to `unresolved`, so it falls back to a Codex deployment rather than being written into a Codex request — and connect-time does **not** throw for it (only an explicit `--model` throws). `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts:89`, `file:src/providers/plugins/sso/proxy/plugins/codex-model-resolver.ts:134`
- **Daemon lifecycle keys on the model.** `normalizeDaemonModel` feeds `daemonMatchesRequest`, so a changed profile model against an otherwise-matching live daemon **forces a restart** rather than reusing the stale one. `file:src/cli/commands/proxy/connect-orchestrator.ts:126`, `file:src/cli/commands/proxy/connect-orchestrator.ts:144`

The pure resolver in `codex-model-resolver.ts` is intentionally self-contained: the proxy must not depend on the Codex agent plugin.

---

## Claude Session Processing

`ConversationsProcessor` transforms raw JSONL transcript messages from a Claude Code session into conversation-log turns and syncs them to a per-session JSONL file. The processor is invoked on every `Stop` and `SessionEnd` hook event.

### Drain Loop

Claude Code's `Stop` hook fires only when the assistant responds. A burst of `!bash` commands with no assistant reply produces zero `Stop` events; without a drain loop those turns are lost before `SessionEnd` finalises the transcript. `processMessages` therefore iterates `transformMessages` in a bounded loop rather than calling it once per hook event.

| Invariant | Rule |
|---|---|
| Hard iteration cap | `Math.max(1, session.messages.length + 1)` — prevents unbounded loops if `transformMessages` regresses |
| Empty-history exit | Loop breaks immediately when `transformMessages` returns `history: []` |
| Advance guard | Loop breaks if `lastProcessedMessageUuid` and `currentHistoryIndex` are both unchanged from the previous iteration |

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:128-156`

### Per-Iteration Sync Checkpoint

After each successful JSONL append, `SessionStore.saveSession()` persists the updated sync pointer to session metadata. A crash mid-drain cannot cause the next invocation to re-append already-written turns; the final `applyProcessingSyncUpdates` pass is idempotent for the same fields.

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:189-211`

### Bash Passthrough Contract

Claude Code injects `!bash` commands as synthetic `type:'user'` messages. The processor must unwrap the command and filter all terminal-output messages so they do not consume turn slots.

| Raw transcript form | Handling |
|---|---|
| `<bash-input>cmd</bash-input>` | Unwrapped to `!cmd` by `extractCommand`; emits a `User` entry |
| `<bash-stdout>…` / `<bash-stderr>…` | Filtered by `isSystemMessage`; never consumes a turn slot |
| `<bash-input></bash-input>` (empty or whitespace) | Filtered; no bare `!` entry emitted |

`file:src/agents/plugins/claude/session/processors/claude.conversations-processor.ts:667-688`, `856-871`

---

## OTLP Hook-Event Ingestion (`OtlpAgentAdapter`)

A separate, agent-agnostic integration from the above: each coding tool that exposes its own native hook/telemetry surface (Claude Code today; e.g. a future Cursor integration) gets one `OtlpAgentAdapter` plugin (`src/agents/plugins/<name>/`) that turns those events into CodeMie analytics via `codemie hook --agent <adapter-name>` → proxy daemon spool → analytics API. The dispatch contract, how to add a new native event to an adapter, and how to wire up a new tool are **not** duplicated here — see `docs/ARCHITECTURE-OTLP-PLUGIN.md`. `claude-code-otlp` (`src/agents/plugins/claude-code-otlp/`) is the current reference implementation.

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
- OTLP hook-event adapters: `docs/ARCHITECTURE-OTLP-PLUGIN.md`
- OpenCode plugin: `src/agents/plugins/opencode/`
- Codex plugin: `src/agents/plugins/codex/`
- Claude plugin: `src/agents/plugins/claude/`
- MCP proxy: `src/mcp/`
- Session adapters: `src/agents/core/session/`
- Config loader: `src/env/config-loader.ts`
- Related guide: `.ai-run/guides/architecture/architecture.md`
