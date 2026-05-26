# CLI And HTTP API Guide

## Quick Summary

CodeMie Code exposes three user-facing API surfaces: npm binaries, Commander CLI commands, and local HTTP services used for proxying and OAuth callbacks.

**Category**: API
**Complexity**: Medium
**Prerequisites**: TypeScript, Commander, Node.js HTTP, OAuth basics

---

## API Surface Map

| Surface | Purpose | Evidence |
|---|---|---|
| npm binaries | Public executable entrypoints | `package.json:7`, `bin/codemie.js:1` |
| Commander commands | Human-facing CLI API | `src/cli/index.ts:41`, `src/cli/index.ts:72` |
| Hook command | Machine-facing event API for agents | `src/cli/commands/hook.ts:1239` |
| MCP proxy command | Stdio-to-HTTP bridge entrypoint | `src/cli/commands/mcp-proxy.ts:17` |
| SSO proxy | Local HTTP proxy for LLM traffic | `src/providers/plugins/sso/proxy/sso.proxy.ts:133` |
| OAuth callback | Local callback server for browser auth | `src/mcp/auth/callback-server.ts:44` |

---

## Binary Entry Points

### Public Binaries

The package publishes multiple binaries that map to agent-specific launchers and utility commands.

| Binary | Role | Evidence |
|---|---|---|
| `codemie` | Main CLI | `package.json:8`, `bin/codemie.js:1` |
| `codemie-code` | Built-in CodeMie coding agent | `package.json:9`, `bin/agent-executor.js:1` |
| `codemie-claude` | Claude wrapper | `package.json:10`, `bin/codemie-claude.js:1` |
| `codemie-gemini` | Gemini wrapper | `package.json:13`, `bin/codemie-gemini.js:1` |
| `codemie-opencode` | OpenCode wrapper | `package.json:14`, `bin/codemie-opencode.js:1` |
| `codemie-codex` | Codex wrapper | `package.json:15`, `bin/codemie-codex.js:1` |
| `codemie-mcp-proxy` | MCP stdio bridge | `package.json:16`, `bin/codemie-mcp-proxy.js:1` |

### Practice

| Avoid | Prefer |
|---|---|
| Adding a binary without a matching package entry | Update `package.json` `bin` and add a launcher in `bin/` |
| Duplicating command logic in launcher files | Keep launchers thin and route to `src/cli/` or agent adapters |
| Hardcoding provider behavior in a launcher | Use config loading and plugin registry resolution |

---

## Commander CLI Pattern

### Root Command Registration

The root CLI creates one `Command` and attaches subcommands from command factories.

| Rule | Evidence |
|---|---|
| Build commands with Commander factories | `src/cli/index.ts:41` |
| Register command modules centrally | `src/cli/index.ts:72`, `src/cli/index.ts:95` |
| Use `.action(async ...)` for async command bodies | `src/cli/commands/install.ts:20` |
| Keep command examples in help text when command behavior is user-facing | `src/cli/commands/workflow.ts:24` |

### Adding A CLI Command

| Step | Practice | Evidence |
|---|---|---|
| 1 | Create a command factory under `src/cli/commands/` | `src/cli/commands/models.ts:40` |
| 2 | Use Commander options and typed action parameters | `src/cli/commands/mcp/index.ts:39` |
| 3 | Route to registry, config, or service modules | `src/cli/commands/workflow.ts:14` |
| 4 | Add the command to root registration | `src/cli/index.ts:72` |
| 5 | Use logger and typed errors for failures | `src/utils/errors.ts:1`, `src/utils/logger.ts:1` |

### Anti-Patterns

| Avoid | Prefer | Why |
|---|---|---|
| Putting business logic directly in root CLI registration | Command module plus service/registry call | Keeps the CLI layer thin |
| Calling concrete agent plugins from unrelated commands | `AgentRegistry` lookup | Preserves extension via plugins |
| Using `console.log()` for debug output | `logger.debug()` | Prevents noisy CLI output |
| Throwing generic `Error` for user-facing config failures | `ConfigurationError` or project error class | Improves formatting and handling |

---

## Hook Event API

### Purpose

The `codemie hook` command is a machine-facing API used by agent plugins and integrations to report lifecycle events. It accepts JSON on stdin, validates the event, optionally transforms agent-specific payloads, then routes to handlers.

| Capability | Evidence |
|---|---|
| Unified hook event handler | `src/cli/commands/hook.ts:9`, `src/cli/commands/hook.ts:1239` |
| Programmatic API for integrations | `src/cli/commands/hook.ts:1206` |
| Required field validation | `src/cli/commands/hook.ts:1089` |
| Agent-specific transformation | `src/cli/commands/hook.ts:1162`, `src/agents/plugins/gemini/gemini.hook-transformer.ts:53` |
| Event routing | `src/cli/commands/hook.ts:553`, `src/cli/commands/hook.ts:562` |

### Event Types

| Event | Typical Use | Evidence |
|---|---|---|
| `SessionStart` | Create session, sync skills, emit start metrics | `src/cli/commands/hook.ts:170` |
| `SessionEnd` | Sync pending data and update session status | `src/cli/commands/hook.ts:208` |
| `UserPromptSubmit` | Track prompt-time activity | `src/cli/commands/hook.ts:474` |
| `Stop` | Incremental transcript processing | `src/cli/commands/hook.ts:483` |
| `SubagentStop` | Subagent session processing | `src/cli/commands/hook.ts:495` |
| `PreCompact` | Pre-compaction handling | `src/cli/commands/hook.ts:502` |

### Hook API Practice

| Avoid | Prefer |
|---|---|
| Assuming all agents emit identical hook JSON | Use `HookTransformer` when an agent differs |
| Letting hook processing block user work | Log non-critical failures and continue |
| Emitting hook events without session context | Include `session_id`, `hook_event_name`, and transcript path when required |
| Re-implementing session sync in each hook | Use `SessionSyncer` and session adapters |

---

## Local HTTP APIs

### SSO Proxy

The SSO proxy is a local HTTP server that forwards requests to an upstream API and composes plugin interceptors around the request lifecycle.

| Concern | Practice | Evidence |
|---|---|---|
| Server creation | Node HTTP `createServer` | `src/providers/plugins/sso/proxy/sso.proxy.ts:133` |
| Port binding | Fixed or auto-assigned local port | `src/providers/plugins/sso/proxy/sso.proxy.ts:146`, `src/providers/plugins/sso/proxy/sso.proxy.ts:609` |
| Request context | Build context before interceptors | `src/providers/plugins/sso/proxy/sso.proxy.ts:328` |
| Body handling | Read request body once | `src/providers/plugins/sso/proxy/sso.proxy.ts:374` |
| Streaming response | Stream upstream response through interceptors | `src/providers/plugins/sso/proxy/sso.proxy.ts:394` |
| Error response | Central error handler and response writer | `src/providers/plugins/sso/proxy/sso.proxy.ts:520`, `src/providers/plugins/sso/proxy/sso.proxy.ts:577` |

### Proxy Plugin Lifecycle

| Interceptor Hook | Use | Evidence |
|---|---|---|
| `onProxyStart` | Startup initialization | `src/providers/plugins/sso/proxy/plugins/types.ts:75` |
| `onRequest` | Request validation, auth, mutation, blocking | `src/providers/plugins/sso/proxy/plugins/types.ts:79` |
| `onResponseHeaders` | Response metadata inspection | `src/providers/plugins/sso/proxy/plugins/types.ts:83` |
| `onResponseChunk` | Streaming body transformation | `src/providers/plugins/sso/proxy/plugins/types.ts:87` |
| `onResponseComplete` | Metrics and post-response work | `src/providers/plugins/sso/proxy/plugins/types.ts:89` |
| `onError` | Error handling | `src/providers/plugins/sso/proxy/plugins/types.ts:91` |

### OAuth Callback API

| Rule | Evidence |
|---|---|
| Callback server is ephemeral and localhost-only | `src/mcp/auth/callback-server.ts:2`, `src/mcp/auth/callback-server.ts:81` |
| Only `/callback` is accepted | `src/mcp/auth/callback-server.ts:47` |
| Missing code and OAuth errors fail explicitly | `src/mcp/auth/callback-server.ts:60`, `src/mcp/auth/callback-server.ts:67` |
| Timeout closes the flow | `src/mcp/auth/callback-server.ts:96` |

---

## MCP Stdio-HTTP Bridge

The MCP proxy command bridges JSON-RPC over stdio to streamable HTTP and invokes OAuth when the remote server requires it.

| Flow Step | Evidence |
|---|---|
| Command entrypoint | `src/cli/commands/mcp-proxy.ts:17` |
| Bridge class owns stdio and HTTP transports | `src/mcp/stdio-http-bridge.ts:88` |
| OAuth provider is composed into bridge | `src/mcp/stdio-http-bridge.ts:90` |
| Unauthorized responses trigger OAuth | `src/mcp/stdio-http-bridge.ts:162`, `src/mcp/stdio-http-bridge.ts:185` |
| Pending messages flush after auth | `src/mcp/stdio-http-bridge.ts:297` |

---

## Response And Error Patterns

### CLI Responses

| Avoid | Prefer |
|---|---|
| Printing internal stack traces to users | Format errors through project utilities |
| Mixing status output and debug output | User status via logger success/info, debug via file logger |
| Swallowing failures in command handlers | Add useful context and surface actionable messages |

### HTTP Responses

| Avoid | Prefer |
|---|---|
| Writing raw upstream errors directly | Central proxy error handling |
| Logging sensitive headers or payloads | Use sanitizers before logging |
| Buffering streaming LLM responses unnecessarily | Stream through response hooks |

---

## Security Notes

| Concern | Practice | Evidence |
|---|---|---|
| Secrets | Use `CredentialStore` or env vars | `src/utils/security.ts:288` |
| Header logging | Sanitize headers and cookies | `src/utils/security.ts:168` |
| MCP auth relay | Reject private and loopback targets | `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts:119` |
| Gateway auth | Validate local gateway key before upstream | `src/providers/plugins/sso/proxy/plugins/gateway-key.plugin.ts:8` |

---

## Quick Reference

| Need | Location |
|---|---|
| Add root CLI command | `src/cli/index.ts` |
| Add command module | `src/cli/commands/` |
| Add agent binary | `bin/` plus `package.json` `bin` |
| Handle hook event | `src/cli/commands/hook.ts` |
| Add hook transformer | `src/agents/plugins/<agent>/` |
| Add proxy plugin | `src/providers/plugins/sso/proxy/plugins/` |
| Add MCP auth behavior | `src/mcp/` or MCP auth proxy plugin |

---

## Delivery Checklist

| Check | Reason |
|---|---|
| Command is registered in `src/cli/index.ts` | Makes it reachable from `codemie` |
| Exported command factory has explicit return type | Matches TypeScript project standards |
| New runtime behavior routes through registry or hook | Preserves loose coupling |
| Errors use typed classes where available | Keeps user output consistent |
| Logs avoid secrets and use sanitizers | Protects credentials |
| Public binary changes update `package.json` | Keeps npm package correct |

---
