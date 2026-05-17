# External Integrations Guide

## Quick Summary

CodeMie Code integrates coding agents, LLM providers, OpenCode/Codex runtimes, SSO, MCP servers, and analytics through registries, lifecycle hooks, proxy plugins, and session processors.

**Category**: Integration
**Complexity**: Medium-High
**Prerequisites**: TypeScript, async/await, HTTP proxying, OAuth, LLM APIs

---

## Integration Map

| Integration | Mechanism | Evidence |
|---|---|---|
| Agent CLIs | Agent plugins and `BaseAgentAdapter` | `src/agents/core/BaseAgentAdapter.ts:36` |
| LLM providers | Provider registry and provider configs | `src/providers/core/registry.ts:19` |
| CodeMie SSO | Browser auth and credential store | `src/providers/plugins/sso/sso.auth.ts:44` |
| Local LLM proxy | `CodeMieProxy` and proxy interceptors | `src/providers/plugins/sso/proxy/sso.proxy.ts:133` |
| MCP servers | Stdio-to-HTTP bridge plus OAuth provider | `src/mcp/stdio-http-bridge.ts:24` |
| Session analytics | Session adapters and sync processors | `src/providers/plugins/sso/session/SessionSyncer.ts:4` |
| Workflow automation | Workflow templates and installer | `src/cli/commands/workflow.ts:23` |

---

## Core Integration Principle

CodeMie Code favors loose coupling: agents, providers, proxy behavior, and session processors meet through contracts and registries. Concrete plugins should not import and orchestrate each other directly.

| Avoid | Prefer |
|---|---|
| Agent plugin knows every provider’s special case | Provider `agentHooks` resolved by lifecycle helpers |
| Proxy core hardcodes auth, logging, sanitization, MCP relay | Proxy plugin registry and interceptors |
| Session sync logic duplicated per agent | Shared `SessionSyncer` with agent-specific adapters |
| Config files read ad hoc in integration code | `ConfigLoader` and provider env export helpers |

---

## Agent Integration Pattern

### Rule

Agents implement adapter contracts and let `BaseAgentAdapter` own shared lifecycle, config, proxy setup, and session hooks.

| Concern | Evidence |
|---|---|
| Agent contract | `src/agents/core/types.ts:574` |
| Shared base adapter | `src/agents/core/BaseAgentAdapter.ts:36` |
| Agent registry | `src/agents/registry.ts:17`, `src/agents/registry.ts:30` |
| CodeMie Code plugin | `src/agents/plugins/codemie-code.plugin.ts:458` |
| Claude plugin | `src/agents/plugins/claude/claude.plugin.ts:290` |
| Gemini plugin | `src/agents/plugins/gemini/gemini.plugin.ts:179` |
| Codex plugin | `src/agents/plugins/codex/codex.plugin.ts:435` |

### Practice

| Avoid | Prefer |
|---|---|
| Implementing process spawn logic from scratch | Extend or use `BaseAgentAdapter` |
| Bypassing agent registry | Register the plugin and resolve by name |
| Mixing session parser logic into CLI commands | Provide a session adapter |

---

## Lifecycle Hook Integration

### Rule

Runtime customization belongs in lifecycle hooks. Hooks can be agent defaults, provider wildcard hooks, or provider agent-specific hooks.

| Hook | Integration Use | Evidence |
|---|---|---|
| `onSessionStart` | Session creation, metrics, reconciliation | `src/agents/core/lifecycle-helpers.ts:141` |
| `beforeRun` | Environment and temp config injection | `src/agents/core/lifecycle-helpers.ts:176` |
| `enrichArgs` | Agent argument transformation | `src/agents/core/lifecycle-helpers.ts:205` |
| `onSessionEnd` | Transcript processing and sync | `src/agents/core/lifecycle-helpers.ts:233` |
| `afterRun` | Final cleanup | `src/agents/core/lifecycle-helpers.ts:267` |

### Loose Coupling Evidence

| Design Choice | Evidence |
|---|---|
| Provider hooks take precedence over agent defaults | `src/agents/core/lifecycle-helpers.ts:52` |
| Wildcard and specific hooks can chain | `src/agents/core/lifecycle-helpers.ts:83` |
| Agent fallback remains available | `src/agents/core/lifecycle-helpers.ts:124` |
| Base adapter invokes hooks at runtime boundaries | `src/agents/core/BaseAgentAdapter.ts:496`, `src/agents/core/BaseAgentAdapter.ts:532` |

---

## Provider Integration Pattern

### Rule

Provider integrations should expose configuration and runtime behavior through provider plugins and provider env export paths, not through agent-specific hardcoding.

| Concern | Evidence |
|---|---|
| Provider registry | `src/providers/core/registry.ts:19` |
| SSO provider auth | `src/providers/plugins/sso/sso.auth.ts:44` |
| SSO model loading | `src/providers/plugins/sso/sso.models.ts:162` |
| Bedrock dependency | `package.json:101` |
| LangChain OpenAI dependency | `package.json:115` |

### Practice

| Avoid | Prefer |
|---|---|
| Reading API keys directly in agents | Export provider env through config/provider helpers |
| Assuming SSO credentials are always present | Load credentials and handle missing auth |
| Sending raw tokens to logs | Use `sanitizeLogArgs()` and `CredentialStore` |

---

## SSO Proxy Plugin Pattern

### Rule

Proxy integrations are plugins that create interceptors. They are sorted by priority and can observe, mutate, block, stream, or handle errors.

| Plugin Concern | Evidence |
|---|---|
| Plugin contract | `src/providers/plugins/sso/proxy/plugins/types.ts:18` |
| Interceptor hook contract | `src/providers/plugins/sso/proxy/plugins/types.ts:67` |
| Registry implementation | `src/providers/plugins/sso/proxy/plugins/registry.ts:14` |
| Registry initialization | `src/providers/plugins/sso/proxy/plugins/registry.ts:40` |
| Plugin registration list | `src/providers/plugins/sso/proxy/plugins/index.ts:29` |

### Registered Plugin Examples

| Plugin | Purpose | Evidence |
|---|---|---|
| `MCPAuthPlugin` | MCP OAuth relay and SSRF guard | `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts:266` |
| `EndpointBlockerPlugin` | Block unwanted endpoints early | `src/providers/plugins/sso/proxy/plugins/endpoint-blocker.plugin.ts:25` |
| `SSOAuthPlugin` | Inject SSO auth | `src/providers/plugins/sso/proxy/plugins/sso-auth.plugin.ts:14` |
| `JWTAuthPlugin` | Inject JWT auth | `src/providers/plugins/sso/proxy/plugins/jwt-auth.plugin.ts:14` |
| `RequestSanitizerPlugin` | Strip unsupported request params | `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts:36` |
| `HeaderInjectionPlugin` | Add session and client headers | `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:14` |
| `LoggingPlugin` | Proxy logging with redaction | `src/providers/plugins/sso/proxy/plugins/logging.plugin.ts:27` |

---

## MCP Integration Pattern

### Rule

MCP integration bridges stdio JSON-RPC to streamable HTTP and only enters OAuth when the remote server requires it.

| Concern | Evidence |
|---|---|
| Bridge owns stdio transport | `src/mcp/stdio-http-bridge.ts:88` |
| Bridge owns HTTP transport | `src/mcp/stdio-http-bridge.ts:89` |
| OAuth provider composition | `src/mcp/stdio-http-bridge.ts:90` |
| Auth required on first send | `src/mcp/stdio-http-bridge.ts:185` |
| OAuth provider implementation | `src/mcp/auth/mcp-oauth-provider.ts:27` |
| Callback server | `src/mcp/auth/callback-server.ts:44` |

### Practice

| Avoid | Prefer |
|---|---|
| Storing MCP OAuth tokens broadly by default | Keep OAuth state memory-only unless an explicit store is used |
| Accepting arbitrary local callback paths | Restrict to `/callback` |
| Forwarding private-network MCP auth URLs | Use MCP auth plugin SSRF checks |

---

## Session Analytics Integration

### Rule

Agent-native transcript formats are normalized by session adapters, then metrics and conversation processors write or sync structured records.

| Concern | Evidence |
|---|---|
| Shared session adapter contract | `src/agents/core/session/BaseSessionAdapter.ts:81` |
| Processor contract | `src/agents/core/session/BaseProcessor.ts:73` |
| Gemini processors | `src/agents/plugins/gemini/gemini.session-adapter.ts:97` |
| Codex processors | `src/agents/plugins/codex/codex.session.ts:45` |
| SSO SessionSyncer | `src/providers/plugins/sso/session/SessionSyncer.ts:4` |
| Metrics API client | `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:93` |

### Practice

| Avoid | Prefer |
|---|---|
| Pushing analytics from every parser | Shared processors and syncer |
| Assuming every agent transcript has the same shape | Agent-specific session adapters |
| Blocking agent lifecycle on best-effort analytics | Fire-and-forget where explicitly safe |

---

## OpenCode And Codex Integration

### Rule

OpenCode and Codex integrations inject runtime configuration through environment and args while preserving CodeMie session correlation.

| Agent | Integration Point | Evidence |
|---|---|---|
| CodeMie Code | OpenCode config content and storage paths | `src/agents/plugins/codemie-code.plugin.ts:167`, `src/agents/plugins/codemie-code.plugin.ts:235` |
| OpenCode | Config and session adapter | `src/agents/plugins/opencode/opencode.plugin.ts:314`, `src/agents/plugins/opencode/opencode.session.ts:5` |
| Codex | Model provider and session lifecycle | `src/agents/plugins/codex/codex.plugin.ts:16`, `src/agents/plugins/codex/codex.plugin.ts:240` |
| Gemini | Hook transformation and args enrichment | `src/agents/plugins/gemini/gemini.hook-transformer.ts:53`, `src/agents/plugins/gemini/gemini.plugin.ts:133` |

---

## Quick Reference

| Need | Location |
|---|---|
| Add agent integration | `src/agents/plugins/` |
| Add provider integration | `src/providers/plugins/` |
| Add lifecycle customization | `src/agents/core/lifecycle-helpers.ts` plus provider metadata |
| Add proxy behavior | `src/providers/plugins/sso/proxy/plugins/` |
| Add MCP behavior | `src/mcp/` or MCP auth proxy plugin |
| Add session processor | `src/agents/core/session/` contract plus agent adapter registration |
| Add workflow template | `src/workflows/templates/` |

---

## Delivery Checklist

| Check | Reason |
|---|---|
| New integration enters through registry, hook, or plugin contract | Preserves loose coupling |
| Provider-specific behavior does not leak into unrelated agents | Keeps adapters maintainable |
| Proxy behavior is an interceptor plugin | Maintains request lifecycle ordering |
| Session analytics uses adapter and processor contracts | Supports multiple agent formats |
| Secrets are stored in `CredentialStore` or env vars | Avoids credential leaks |
| Logs use sanitizers for headers and payloads | Protects SSO and API tokens |

---
