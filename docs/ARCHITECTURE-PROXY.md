# CodeMie Proxy Architecture

**Version**: 2.0
**Date**: 2026-09-10
**Status**: Production

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Overview](#2-architecture-overview)
3. [Core Components](#3-core-components)
4. [Plugin System](#4-plugin-system)
5. [Data Flow](#5-data-flow)
6. [Plugin Implementations](#6-plugin-implementations)
7. [Quality Attributes](#7-quality-attributes)
8. [Design Patterns](#8-design-patterns)
9. [Deployment & Operations](#9-deployment--operations)
10. [Future Extensions](#10-future-extensions)

---

## 1. Executive Summary

### 1.1 Purpose

The CodeMie Proxy is a **plugin-based HTTP streaming proxy** that sits between AI coding agents and their target API endpoints. It enables:

- **SSO / JWT Authentication**: Automatic cookie or bearer-token injection for enterprise auth
- **Local Gateway Auth**: Static bearer key validation for daemon-mode clients (e.g. Claude Desktop, VS Code BYOK)
- **MCP Authorization**: OAuth proxy for remote MCP servers with SSRF protection
- **Request Normalization & Sanitization**: Per-agent body fixes (Claude thinking params, Kimi token caps, Codex model mapping, encrypted reasoning-state replay/retry, VS Code user-id constraints)
- **Header Management**: CodeMie-specific header injection for traceability
- **Observability**: Detailed logging and metrics collection
- **Session Sync**: Background sync of session metrics _and_ conversations to the CodeMie API
- **Desktop Telemetry**: Local Claude Desktop 3P transcript discovery and conversation sync when daemon mode is enabled
- **VS Code BYOK**: Profile-configured OpenAI-compatible custom endpoints with transparent forwarding
- **Self-Healing Daemon**: Background watcher that detects a dead/unhealthy proxy and restarts it in-process on the same pinned port
- **Extensibility**: Plugin architecture for future features

### 1.2 Key Design Principles

- ✅ **KISS (Keep It Simple)**: Core does ONE thing - forwards HTTP with streaming
- ✅ **SOLID**: Single Responsibility, Open/Closed via plugins, Dependency Injection
- ✅ **Zero Buffering**: True HTTP streaming with no body buffering (buffering is an opt-in exception for a few auth/reasoning-state hooks, see §6.5 and §6.9)
- ✅ **Plugin-Based**: Core is stable, features added via plugins
- ✅ **Fail-Safe**: Plugin failures don't break proxy flow

---

## 2. Architecture Overview

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Coding Agent                         │
│              (claude, codex, gemini, kimi, vscode-byok, ...)    │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP Request
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       CodeMie Proxy                             │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │               Plugin System (Priority-Based)               │ │
│  │                                                            │ │
│  │  [3]   MCP Auth               → MCP OAuth proxy & URL rewrite│
│  │  [5]   Endpoint Blocker       → block unwanted endpoints early│
│  │  [7]   Gateway Key            → validate local daemon bearer key│
│  │  [10]  SSO Auth / JWT Auth    → Inject cookies / bearer token│
│  │  [14]  Claude/Kimi/Codex Normalizers → per-agent body fixes │
│  │  [15]  Request Sanitizer      → strip unsupported reasoning params│
│  │  [16]  Codex/Copilot Encrypted-Content Sanitizers → reasoning replay retry│
│  │  [17]  VS Code Request Normalizer → constrain user identifiers│
│  │  [20]  Header Injection       → Add X-CodeMie headers      │
│  │  [50]  Logging                → Log requests/responses     │
│  │  [100] SSO Session Sync       → Background metrics + conversation sync│
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  HTTP Streaming Core                       │ │
│  │  • Build context                                           │ │
│  │  • /health, /healthz liveness probe (pre-auth, pre-hooks)  │ │
│  │  • Run handleRequest hooks (full-bypass, e.g. MCP relay)    │ │
│  │  • Run onRequest hooks                                     │ │
│  │  • Forward to upstream (no buffering)                      │ │
│  │  • Run onUpstreamResponse hooks (optional buffered retry)   │ │
│  │  • Run onResponseHeaders hooks                              │ │
│  │  • Stream response chunks (with optional transform)        │ │
│  │  • Run onResponseComplete hooks                            │ │
│  └────────────────────────────────────────────────────────────┘ │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP Request (modified)
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Target API Endpoint                          │
│           (OpenAI, Anthropic, CodeMie SSO, LiteLLM, etc.)       │
└─────────────────────────────────────────────────────────────────┘
```

### 2.2 Layered Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Layer 1: Entry Point (CodeMieProxy class)                      │
│  • HTTP server management                                       │
│  • Port binding and error handling                              │
│  • Top-level error handler                                      │
└─────────────────────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 2: Plugin Management (PluginRegistry)                    │
│  • Plugin registration and initialization                       │
│  • Priority-based sorting                                       │
│  • Lifecycle management (enable/disable)                        │
└─────────────────────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 3: Request Handling                                      │
│  • Context building                                             │
│  • Hook orchestration (onRequest, onResponseHeaders, etc.)      │
│  • Error handling with plugin hooks                             │
└─────────────────────────────────────────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│  Layer 4: HTTP Forwarding (ProxyHTTPClient)                     │
│  • Upstream connection management                               │
│  • True HTTP streaming (no buffering)                           │
│  • SSL/TLS handling                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

> All proxy source lives under `src/providers/plugins/sso/proxy/` (proxy core + plugins are shipped as part of the `sso` provider plugin, not a standalone top-level module).

### 3.1 CodeMieProxy

**Location**: `src/providers/plugins/sso/proxy/sso.proxy.ts`

**Responsibilities**:

- HTTP server lifecycle (start/stop)
- Request routing to plugins
- Error handling and recovery
- Port management (dynamic allocation, or pinned-port EADDRINUSE retry for daemon restarts)
- `/health` and `/healthz` liveness probe, answered before authentication and before any plugin hook

**Key Operations**:

- Initialize plugins and start server
- Graceful shutdown with plugin cleanup (force-drains keep-alive sockets before closing, so a persistent client like Claude Desktop can't hang an in-process restart)
- Main request handler (`handleRequest`)
- Streaming response handler (`streamResponse`)

**Configuration Parameters** (`ProxyConfig`, `src/providers/plugins/sso/proxy/proxy-types.ts`):

- Target API URL (upstream endpoint), host/port (0 = dynamic allocation), `pinnedPort` (retry same port on EADDRINUSE instead of falling back to random)
- Client type (agent identifier), timeout duration
- Profile name, provider, model, integration ID
- Session ID, CLI version
- `authMethod` (`'sso' | 'jwt'`), `jwtToken`
- `repository` / `branch` / `project` (header injection), `gatewayKey` (local daemon auth)
- `syncApiUrl` / `syncCodeMieUrl` (session sync target and credential lookup, independent of the main upstream)
- `telemetryMode` (`'none' | 'claude-desktop'`) and related poll/inactivity timeouts

### 3.2 PluginRegistry

**Location**: `src/providers/plugins/sso/proxy/plugins/registry.ts`

**Responsibilities**:

- Plugin registration and storage
- Dependency resolution
- Priority-based sorting (0-1000)
- Lifecycle hook invocation

**Key Operations**:

- Register plugins at startup
- Initialize plugins with context (`getPluginRegistry()` / `resetPluginRegistry()`)
- Enable/disable plugins at runtime
- Retrieve plugin configurations

**Plugin Priority Levels** (current, see §6 for the full plugin list):

- **0-3**: MCP protocol handling (MCP Auth: 3)
- **4-10**: Endpoint blocking, gateway/local auth, and upstream authentication (Endpoint Blocker: 5, Gateway Key: 7, SSO Auth: 10, JWT Auth: 10)
- **11-19**: Per-agent request normalization and sanitization (Claude/Kimi/Codex Normalizers: 14, Request Sanitizer: 15, Codex/Copilot Encrypted-Content Sanitizers: 16, VS Code Request Normalizer: 17)
- **20-50**: Header manipulation and observability (Header Injection: 20, Logging: 50)
- **100**: Session sync (SSO Session Sync: 100)

Note: priorities 14-17 do request-_body_ normalization/sanitization, not header work — despite falling inside what an older version of this doc called the "header manipulation" band. Priority bands are a loose grouping, not a hard contract; always check the actual `priority` field and registration comments in `plugins/index.ts` before assuming a band's purpose.

### 3.3 ProxyHTTPClient

**Location**: `src/providers/plugins/sso/proxy/proxy-http-client.ts`

**Responsibilities**:

- HTTP/HTTPS forwarding with streaming
- Connection pooling
- Timeout management
- SSL/TLS certificate handling

**Features**:

- Zero buffering (streams directly)
- Async iteration over response chunks
- Custom SSL/TLS options (self-signed certs; `rejectUnauthorized: false` by default)
- Configurable timeouts
- `readResponseBody()` helper used by plugins that need to buffer-and-retry (see `onUpstreamResponse` in §4.1)

### 3.4 ProxyContext

**Location**: `src/providers/plugins/sso/proxy/proxy-types.ts`

**Purpose**: Shared state across all plugin hooks for a single request

**Context Attributes**:

- **Identity**: Request ID, Session ID, Agent name (`agentName`)
- **Traceability**: Profile, Provider, Model
- **Request Details**: Method, URL, Headers, Body (`Buffer`, to preserve byte integrity for multi-byte UTF-8)
- **Timing**: Request start time
- **Upstream**: Target URL
- **Extensibility**: Metadata dictionary for plugin-specific data (also used for the `blocked` / `blockedResponseBody` short-circuit, and `gatewayKeyValidated` flag)

---

## 4. Plugin System

### 4.1 Plugin Architecture

**Design Pattern**: Chain of Responsibility + Observer

**Plugin Interface** (`ProxyPlugin`, `src/providers/plugins/sso/proxy/plugins/types.ts`):

- **Metadata**: ID, name, version, priority, dependencies
- **Factory Method**: `createInterceptor()` — creates interceptor instance with context
- **Lifecycle Hooks**: Install, uninstall, enable, disable

**Interceptor Interface** (`ProxyInterceptor`):

- **Proxy Lifecycle**: `onProxyStart`, `onProxyStop`
- **Full Request Bypass**: `handleRequest` — optional hook checked in priority order _before_ the standard pipeline; if a plugin returns `true`, it has fully handled the request (response written) and the entire onRequest → forward → onResponseHeaders → stream → onResponseComplete pipeline is skipped. Used for traffic that doesn't go to the configured `targetApiUrl` at all (e.g. MCP Auth's `/mcp_auth` and `/mcp_relay/...` routes to arbitrary MCP servers). The handling plugin owns all security guarantees (SSRF checks etc.) for its own traffic.
- **Request Lifecycle**: `onRequest`, `onUpstreamResponse`, `onResponseHeaders`, `onResponseChunk`, `onResponseComplete`, `onError`

`onUpstreamResponse(context, upstreamResponse, tools)` runs immediately after the upstream call and before header/streaming hooks. `tools` gives a plugin `readBody()` (buffer the full response), `retry()` (re-issue the same request, e.g. after stripping now-rejected state), and `fromBuffer()` (turn a buffered `Buffer` back into a stream-shaped `IncomingMessage`). Only the Copilot encrypted-content sanitizer uses this hook (see §6.8) — the Codex one instead watches `onResponseChunk` and flips a permanent `onRequest`-time flag; see §6.8 for why these two plugins differ.

**`handleRequest` is not limited to non-upstream traffic.** In addition to MCP Auth's full off-upstream relay (§6.1), the Gateway Key Plugin (§6.3) also implements `handleRequest` — it runs _before_ `onRequest`, validating the local daemon bearer key and returning `true` with a 401 body on failure, or `false` to let the same upstream-bound request continue into the normal `onRequest` pipeline. So `handleRequest` is used both for "this traffic never reaches `targetApiUrl`" (MCP Auth) and "reject this upstream-bound request early, before auth injection" (Gateway Key) — check each plugin's own hook rather than assuming from the hook name alone.

### 4.2 Plugin Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│  Application Startup                                         │
│  ├─ Import: src/providers/plugins/sso/proxy/plugins/index.ts │
│  ├─ Auto-register: registerCorePlugins()                     │
│  └─ Plugins registered in PluginRegistry                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Proxy Start (per session)                                   │
│  ├─ CodeMieProxy.start() called                              │
│  ├─ Build PluginContext (config, credentials, profileConfig) │
│  ├─ PluginRegistry.initialize(context)                       │
│  │   ├─ Filter enabled plugins (createInterceptor may throw  │
│  │   │   ConfigurationError to opt itself out silently)      │
│  │   ├─ Sort by priority                                     │
│  │   ├─ Call createInterceptor() for each                    │
│  │   └─ Return sorted interceptor list                       │
│  ├─ Bind server (dynamic port, or pinned-port EADDRINUSE retry)│
│  └─ Call onProxyStart() on all interceptors, then resolve     │
│      (only once the final bound port is known)                │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Request Handling (per request)                              │
│  ├─ /health, /healthz short-circuit (no context, no hooks)   │
│  ├─ Build ProxyContext                                       │
│  ├─ handleRequest() hooks (full bypass, priority order)      │
│  ├─ onRequest() hooks (all interceptors, early-exit if blocked)│
│  ├─ Forward to upstream                                      │
│  ├─ onUpstreamResponse() hooks (optional buffer/retry)        │
│  ├─ onResponseHeaders() hooks                                │
│  ├─ Stream response with onResponseChunk() hooks             │
│  └─ onResponseComplete() hooks                               │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Proxy Stop (per session)                                    │
│  ├─ CodeMieProxy.stop() called                               │
│  ├─ Call onProxyStop() on all interceptors                   │
│  └─ Cleanup resources                                         │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Plugin Registration Pattern

**Auto-Registration**:

- Plugins register themselves on module import via `registerCorePlugins()`, called at the bottom of `plugins/index.ts`
- Any consumer that imports `plugins/index.ts` (the proxy core itself, or `bin/proxy-daemon.ts`) triggers registration as a side effect

**Opt-Out via createInterceptor()**:

- A plugin opts itself out for a given session by throwing `ConfigurationError` from `createInterceptor()` (e.g. SSO Session Sync throws if there's no session ID, credentials aren't SSO, or sync is disabled by config/env var) rather than through a separate enable/disable flag

### 4.4 Error Handling

**Fail-Safe Design**: Plugin errors don't break proxy flow

**Error Handling Strategy**:

- Try-catch wrapper around all plugin hooks (`runHook()` in `sso.proxy.ts`)
- Errors logged for debugging
- Execution continues with remaining interceptors
- Graceful degradation ensures proxy availability
- Exception: `handleRequest` hook errors are routed through the normal error pipeline (`onError` interceptors run) instead of being swallowed, since a full-bypass plugin failing usually means the request truly cannot be served

**Benefits**:

- One misbehaving plugin doesn't crash the proxy
- Full error context captured in logs
- System remains operational under failure conditions

---

## 5. Data Flow

### 5.1 Request Flow (Successful)

```
Client → Proxy → Upstream → Proxy → Client

Detailed Flow:
1. Agent sends HTTP request to localhost:PORT

2. Proxy receives request
   ├─ Short-circuit /health, /healthz (before context/auth/hooks)
   ├─ Build ProxyContext (requestId, sessionId, agentName, headers, body)
   ├─ Run handleRequest() hooks in priority order — a plugin here can either
   │   fully handle the request (MCPAuthPlugin relaying to an MCP server,
   │   short-circuiting the rest of this flow entirely) or reject it early
   │   (GatewayKeyPlugin returning a 401 before auth injection runs); any
   │   plugin returning false here falls through to onRequest() below
   ├─ Run onRequest() hooks (priority order), e.g.:
   │   ├─ EndpointBlockerPlugin: reject/short-circuit unwanted endpoints
   │   ├─ SSOAuthPlugin / JWTAuthPlugin: inject cookies / bearer token
   │   ├─ Claude/Kimi/Codex request normalizers: fix up model-specific body fields
   │   ├─ RequestSanitizerPlugin: strip unsupported reasoning params
   │   ├─ Codex/Copilot encrypted-content sanitizers: forward reasoning state as-is
   │   ├─ VsCodeRequestNormalizerPlugin: constrain user identifiers
   │   ├─ HeaderInjectionPlugin: add X-CodeMie headers
   │   └─ LoggingPlugin: log request
   ├─ Check context.metadata.blocked — if set by any onRequest hook, respond
   │   immediately (200 + configured body) without contacting upstream
   ├─ Build target URL (targetApiUrl + request path)
   └─ Forward to upstream via ProxyHTTPClient

3. Upstream responds
   ├─ Run onUpstreamResponse() hooks — most plugins pass the stream through
   │   untouched; the encrypted-content sanitizers may buffer, detect a
   │   reasoning-replay rejection, strip the offending state, and retry here
   ├─ Receive response headers
   ├─ Run onResponseHeaders() hooks
   │   └─ LoggingPlugin: Log response headers
   └─ Start streaming response body

4. Stream response chunks
   ├─ For each chunk from upstream:
   │   ├─ Run onResponseChunk() hooks (optional transform)
   │   └─ Write chunk to client immediately
   └─ End stream

5. Response complete
   ├─ Run onResponseComplete() hooks
   │   ├─ LoggingPlugin: Log final stats
   │   └─ SSOSessionSyncPlugin: No-op (runs on timer)
   └─ Close connection
```

### 5.2 Error Flow

```
Client → Proxy → Error → Proxy → Client

Error Handling:
1. Error occurs (network, timeout, upstream error, or a handleRequest hook throwing)

2. Proxy catches error
   ├─ Check if client disconnected (abort error)
   │   └─ If yes: Log and exit silently
   ├─ Build minimal ProxyContext
   ├─ Run onError() hooks on all interceptors
   │   └─ LoggingPlugin: Log error details
   ├─ Normalize error (NetworkError, TimeoutError, etc.)
   └─ Send JSON error response to client

3. Client receives structured error with:
   - Error type and message
   - HTTP status code
   - Request ID
   - Timestamp
```

### 5.3 Streaming Flow (Zero Buffering)

```
Upstream Response → Proxy → Client (no intermediate buffering)

Streaming Strategy:
- Upstream is Node.js stream (IncomingMessage)
- Async iteration over chunks
- Optional transformation via plugin hooks
- Immediate write to client (no accumulation)
- Constant memory footprint
- Downstream disconnect is detected mid-stream and iteration stops early

Benefits:
- ~90% less memory usage (no buffering)
- Constant memory regardless of response size
- True streaming for SSE and long responses
- Real-time data delivery

Exceptions (deliberate, narrow buffering):
- MCP Auth buffers small JSON auth-metadata responses to rewrite embedded URLs (§6.5)
- Codex/Copilot encrypted-content sanitizers buffer a response only after detecting a
  reasoning-state replay rejection, to retry with state stripped (§6.9)
```

---

## 6. Plugin Implementations

All plugin files below live under `src/providers/plugins/sso/proxy/plugins/`. Registration order and priority comments are the source of truth in `plugins/index.ts`.

### 6.1 MCP Auth Plugin

**Priority**: 3 (runs before all other plugins)
**File**: `mcp-auth.plugin.ts`

**Purpose**: Proxy MCP OAuth authorization flows through the CodeMie proxy so that all auth traffic is routed centrally and `client_name` can be overridden via the `MCP_CLIENT_NAME` environment variable.

#### 6.1.1 URL Scheme

The plugin intercepts two URL patterns via its `handleRequest` hook (full bypass of the standard pipeline):

| Route       | Pattern                                    | Purpose                                     |
| ----------- | ------------------------------------------ | ------------------------------------------- |
| **Initial** | `/mcp_auth?original=<url>`                 | First MCP connection — starts an OAuth flow |
| **Relay**   | `/mcp_relay/<root_b64>/<relay_b64>/<path>` | Subsequent requests routed through proxy    |

- `root_b64`: Base64url-encoded root MCP server origin (for per-flow isolation)
- `relay_b64`: Base64url-encoded actual target origin (may differ when auth server is on a separate host)

#### 6.1.2 Request Handling

**`/mcp_auth` route:**

1. Extract `original` query parameter (the real MCP server URL)
2. Validate URL (SSRF check)
3. Forward request to the target MCP server
4. Buffer the JSON response and rewrite all discovered URLs to proxy relay URLs
5. Return the rewritten response to the MCP client

**`/mcp_relay` route:**

1. Decode `root_b64` and `relay_b64` to recover target origin
2. Validate root-relay association (per-flow origin scoping)
3. Reconstruct the full target URL from relay origin + path + query
4. Forward request to the real target
5. Buffer JSON auth metadata responses and rewrite URLs; stream all other responses

#### 6.1.3 Response URL Rewriting

The plugin buffers JSON responses (auth metadata, client registration, etc.) and rewrites all absolute HTTP(S) URLs found in JSON values to proxy relay URLs. This ensures the MCP client routes all subsequent requests through the proxy.

**Exceptions**: Token audience identifiers (e.g., `resource` field) are not rewritten — they are logical identifiers, not URLs to access.

**Browser endpoints** (e.g., `authorization_endpoint`) are left as-is so the user's browser navigates directly to the auth server.

#### 6.1.4 Security

**SSRF Protection:**

- Private/loopback IP addresses are rejected (both literal hostname check and DNS resolution)
- Only `http:` and `https:` schemes are allowed

**Per-Flow Origin Scoping:**

- Discovered origins (from auth metadata) are tagged with their root MCP server origin
- Relay requests validate that the relay origin is associated with the claimed root origin
- Prevents cross-flow origin confusion

**Buffering Policy:**

- Only auth metadata responses are buffered (for URL rewriting)
- Post-auth MCP traffic streams through without buffering

#### 6.1.5 Companion Components

The MCP Auth Plugin works in conjunction with the stdio-to-HTTP bridge:

| Component         | File                                 | Purpose                                                       |
| ----------------- | ------------------------------------ | ------------------------------------------------------------- |
| Stdio-HTTP Bridge | `src/mcp/stdio-http-bridge.ts`       | Bridges stdio JSON-RPC to streamable HTTP transport           |
| OAuth Provider    | `src/mcp/auth/mcp-oauth-provider.ts` | Implements `OAuthClientProvider` for browser-based OAuth flow |
| Callback Server   | `src/mcp/auth/callback-server.ts`    | Ephemeral localhost server for receiving OAuth callbacks      |
| Proxy Logger      | `src/mcp/proxy-logger.ts`            | File-based logger for proxy operations                        |
| Constants         | `src/mcp/constants.ts`               | `MCP_CLIENT_NAME` default and accessor                        |

#### 6.1.6 Configuration

**Environment Variables:**

- `MCP_CLIENT_NAME`: Client name for OAuth Dynamic Client Registration (default: `CodeMie CLI`)
- `MCP_PROXY_DEBUG`: Enable verbose proxy logging
- `CODEMIE_PROXY_PORT`: Fixed proxy port (for stable MCP auth URLs across restarts)

**Log Location**: `~/.codemie/logs/mcp-proxy.log`

### 6.2 Endpoint Blocker Plugin

**Priority**: 5
**File**: `endpoint-blocker.plugin.ts`

**Purpose**: Blocks unwanted upstream endpoints early, before any auth or normalization work runs, by short-circuiting via `context.metadata.blocked` (see §5.1 step 2).

### 6.3 Gateway Key Plugin

**Priority**: 7
**File**: `gateway-key.plugin.ts`

**Purpose**: Validates a static local bearer key (`gatewayKey` on `ProxyConfig`) for daemon-mode clients (Claude Desktop, VS Code BYOK) so they authenticate to the local proxy without ever seeing real SSO/JWT credentials. Strips the header before the request is forwarded upstream.

**Hook used**: `handleRequest`, not `onRequest` — this plugin runs in the earlier full-bypass phase (§4.1) so an invalid key is rejected (401) before any auth-injection or normalization plugin sees the request. On a valid key it returns `false` and the request falls through to the normal `onRequest` pipeline.

### 6.4 SSO Auth Plugin

**Priority**: 10 (must run early, alongside JWT Auth)
**File**: `sso-auth.plugin.ts`

**Purpose**: Inject SSO cookies into requests for enterprise authentication

**Behavior**:

- Reads cookies from PluginContext credentials
- Builds Cookie header from key-value pairs
- Only runs when SSO credentials present
- Executes in onRequest() hook

**Architecture**:

- Single responsibility: Cookie injection
- No state maintained between requests
- Fails if credentials missing

### 6.5 JWT Auth Plugin

**Priority**: 10 (alternative to SSO Auth — mutually exclusive per `ProxyConfig.authMethod`)
**File**: `jwt-auth.plugin.ts`

**Purpose**: Injects a Bearer `Authorization` header from a JWT token (CLI arg, `CODEMIE_JWT_TOKEN` env var, or credential store) instead of SSO cookies, for the `authMethod: 'jwt'` path.

### 6.6 Per-Agent Request Normalizers

**Priority**: 14
**Files**: `claude-request-normalizer.plugin.ts`, `kimi-request-normalizer.plugin.ts`, `codex-request-normalizer.plugin.ts`

**Purpose**: Fix up agent-specific request body quirks before the request reaches upstream:

- **Claude**: normalizes `thinking` params for Claude models
- **Kimi**: caps Kimi output-token requests to stay within upstream limits
- **Codex**: maps the Codex app's undated model names onto dated CodeMie deployments

### 6.7 Request Sanitizer Plugin

**Priority**: 15
**File**: `request-sanitizer.plugin.ts`

**Purpose**: Strips reasoning parameters the target upstream doesn't support, independent of any single agent's normalizer.

### 6.8 Codex / Copilot Encrypted-Content Sanitizer Plugins

**Priority**: 16
**Files**: `codex-encrypted-content-sanitizer.plugin.ts`, `copilot-encrypted-content-sanitizer.plugin.ts`

**Shared purpose**: Forward Responses-API encrypted reasoning state untouched by default (preserving cross-turn reasoning continuity), and self-heal once the upstream signals the state is no longer replayable. **The two plugins implement this with genuinely different mechanisms — do not assume one describes the other:**

- **Codex** (`codex-encrypted-content-sanitizer.plugin.ts`): watches for the rejection marker in **`onResponseChunk`** (streaming inspection of the SSE body), not `onUpstreamResponse`. On the first sighting it sets a permanent `reasoningStateUnusable` flag (comment: "never cleared for this proxy") that causes its `onRequest` hook to strip reasoning state from every _future_ request. It does **not** retry the failing turn — that turn's response streams through unchanged and its error surfaces to the client; only the _next_ request onward gets the stripped-state treatment.
- **Copilot** (`copilot-encrypted-content-sanitizer.plugin.ts`): uses **`onUpstreamResponse`** with `tools.readBody`/`tools.retry` and retries the _same_ failing request once, inline, after stripping the offending state (`return tools.retry(sanitizedRequest.body)`). It keeps **no persistent latch** — every subsequent request is re-checked independently rather than being pre-stripped based on prior failures.

In short: Codex = detect-in-stream, no retry, permanent latch for later requests. Copilot = detect-post-response, immediate retry of the same request, no latch. Both achieve "the session keeps working instead of repeatedly replaying unusable state," but via opposite trade-offs (Copilot fixes the current turn but re-pays the detection cost every time; Codex pays once and then avoids the cost, at the price of always failing the turn that first triggers it). See §6.13 for the VS Code BYOK context this was built for; the same class of self-healing applies uniformly to `codemie-codex`, `codemie-code`, `codemie-opencode`, `codemie-pi`, and `vscode-byok`.

### 6.9 VS Code Request Normalizer Plugin

**Priority**: 17
**File**: `vscode-request-normalizer.plugin.ts`

**Purpose**: Constrains the Responses `user` identifier for `vscode-byok` traffic (bounded compatibility normalization only — see §6.14).

### 6.10 Header Injection Plugin

**Priority**: 20
**File**: `header-injection.plugin.ts`

**Purpose**: Add CodeMie-specific headers for traceability

**Headers Injected**: only `X-CodeMie-Request-ID` and `X-CodeMie-CLI` are truly unconditional (`header-injection.plugin.ts:30-73`). Every other header — including `X-CodeMie-Session-ID` and `X-CodeMie-Client` — is conditional on the corresponding value being present.

**Always Injected:**

- `X-CodeMie-CLI`: CLI wrapper and version (e.g., `codemie-cli/0.0.16`)
- `X-CodeMie-Request-ID`: Request UUID for traceability

**Conditionally Injected:**

- `X-CodeMie-Session-ID`: Session UUID for correlation, only `if (context.sessionId && context.sessionId !== 'unknown')`
- `X-CodeMie-Client`: Agent identifier (e.g., `codemie-claude`, `codemie-gemini`, `codemie-code`), only `if (config.clientType)`
- `X-CodeMie-Integration`: Integration ID (only when provider requires integration via `requiresIntegration` flag)
- `X-CodeMie-CLI-Model`: Model name from config (if configured) — this fires for `vscode-byok` too whenever the active profile has a `model` set, since the daemon receives `--model` for every target (see §6.13)
- `X-CodeMie-CLI-Timeout`: Timeout value from config (if configured)
- `X-CodeMie-Repository`: Repository name (parent/current format), from `ProxyConfig.repository`
- `X-CodeMie-Branch`: Git branch at proxy startup, from `ProxyConfig.branch`
- `X-CodeMie-Project`: CodeMie project name, from `ProxyConfig.project` (also used by VS Code BYOK, see §6.13)
- `x-litellm-session-id`: session ID, injected only for `codemie-codex`/`codemie-copilot` client types (`header-injection.plugin.ts:41-43`) — not a `X-CodeMie-*` header, easy to miss when scanning for the CodeMie prefix

**Architecture**:

- Reads values from PluginContext and ProxyContext
- Adds headers to outgoing request
- Executes in onRequest() hook
- Fails gracefully if values are missing (optional headers)

### 6.11 Logging Plugin

**Priority**: 50
**File**: `logging.plugin.ts`

**Purpose**: Log detailed proxy activity

**Log Destinations**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Log Level**: DEBUG (file only, console when CODEMIE_DEBUG=1)

**Lifecycle Hooks**:

- **onRequest**: Log request details (method, URL, headers, body size)
- **onResponseHeaders**: Log response headers (content-type, encoding)
- **onResponseChunk**: Log streaming progress (1st chunk, then every 1000th chunk)
- **onResponseComplete**: Log final stats (status, duration, bytes sent)
- **onError**: Log error details (type, message, stack trace)

**Architecture**:

- Stateless within single request
- Maintains chunk counter for sampling
- No impact on proxy performance (async logging)

### 6.12 SSO Session Sync Plugin (Unified)

**Priority**: 100
**File**: `sso.session-sync.plugin.ts`

**Purpose**: Unified background orchestrator that syncs session data — both metrics _and_ conversations — to the CodeMie API. This plugin replaced an earlier, metrics-only "Metrics Sync Plugin"; if you find references to `metrics-sync.plugin.ts` or `CODEMIE_METRICS_SYNC_*` env vars elsewhere (old docs, old comments), they describe the previous design and no longer match the code.

#### 6.12.1 Overview

**Design Decisions**:

- ✅ **Unified Orchestration**: Sessions are discovered and read once, then handed to multiple pluggable processors (metrics, conversations) — zero duplicated I/O
- ✅ **Agent-Agnostic**: Adapters support Claude, Gemini, and others behind a common interface
- ✅ **Session-Level Sync**: Plugin is session-scoped (syncs only current session)
- ✅ **SSO-Only Operation**: Only runs when credentials are SSO cookies (guards against JWT-only sessions)
- ✅ **Opt-Out via createInterceptor()**: Throws `ConfigurationError` (not a separate flag) when session ID, SSO credentials, client type, or sync-enabled config is missing — the plugin simply isn't registered for that session

#### 6.12.2 Architecture

**Lifecycle**:

```
Proxy Start
  └─ onProxyStart()
      ├─ Initialize SessionSyncer
      ├─ Start background timer (every 2 minutes by default — see §6.12.6)
      └─ Log: "Starting session sync"

Background Timer (every 2 minutes by default)
  └─ sync()
      ├─ Discover session files via adapter (once)
      ├─ Pass parsed sessions to all processors (metrics, conversations)
      ├─ Each processor aggregates/syncs its own concern
      └─ Log: "Synced N sessions"

Proxy Stop
  └─ onProxyStop()
      ├─ Stop background timer
      ├─ Final sync (ensures all pending data sent)
      └─ Log: "Final sync completed"
```

**Components**:

- `SSOSessionSyncPlugin` / `SSOSessionSyncInterceptor`: Plugin registration and timer/sync orchestration (`sso.session-sync.plugin.ts`)
- `SessionSyncer` (`src/providers/plugins/sso/session/SessionSyncer.ts`): Discovery + I/O shared across processors
- `BaseProcessor` (`src/providers/plugins/sso/session/BaseProcessor.ts`) and concrete processors under `src/providers/plugins/sso/session/processors/` (e.g. `processors/metrics/metrics-sync-processor.ts` for the metrics-aggregation logic previously described as the whole plugin)

#### 6.12.3 Claude Desktop 3P Telemetry Runtime

When the proxy daemon is started in Desktop mode, the daemon also starts a local telemetry runtime for Claude Desktop 3P:

- Discovers session metadata under `<config root>/local-agent-mode-sessions/`, where the config root is `~/Library/Application Support/Claude-3p/` on macOS, `%LOCALAPPDATA%\Claude-3p\` on Windows, and `$XDG_CONFIG_HOME/Claude-3p/` (else `~/.config/Claude-3p/`) on Linux
- Reads sibling `audit.jsonl` transcripts for each detected `local_<session>` directory
- Correlates each local Desktop session to a CodeMie session stored in `~/.codemie/sessions/`
- Normalizes Desktop events into the existing Claude metrics/conversation processors
- Syncs pending JSONL metrics and conversations through `SessionSyncer`
- Sends session lifecycle metrics with client identity `claude-desktop`

This path is intentionally separate from the hook-based `codemie-claude` flow. Claude Desktop does not expose CodeMie-managed lifecycle hooks, so ingestion is file-discovery driven rather than event-callback driven. The shared runtime is generic; client-specific logic lives behind a Desktop adapter (`src/telemetry/clients/claude-desktop/ClaudeDesktopTelemetryAdapter.js`, wired into `src/telemetry/runtime/DesktopTelemetryRuntime.ts`) so future IDE or desktop clients can plug into the same sync pipeline. Started/stopped directly by `src/bin/proxy-daemon.ts` when `--telemetry-mode claude-desktop` is passed.

#### 6.12.4 API Contract

**Endpoint**: `POST ${apiUrl}/metrics`
**Example**: `POST https://codemie.ai/metrics`
**Content-Type**: `application/json`
**Auth**: `Cookie: session={token}` (SSO cookies)

**Metric Structure**:

- **metric_name**: Always `codemie_coding_agent_usage`
- **attributes**: Session-aggregated metrics
- **time**: ISO timestamp

**Metric Attributes**:

- **Identity**: agent, agent_version, llm_model, project, session_id
- **Interaction**: total_user_prompts, total_ai_requests, total_ai_responses
- **Tokens**: total_input_tokens, total_output_tokens, total_cache_read_input_tokens
- **Tools**: total_tool_calls, successful_tool_calls, failed_tool_calls
- **Files**: files_created, files_modified, files_deleted, lines_added, lines_removed
- **Session**: session_duration_ms, exit_reason, had_errors, status, is_final, count

**Response Structure**:

- success: Boolean flag
- received: Number of metrics received
- processed: Number successfully processed
- failed: Number of failures
- timestamp: Server timestamp

#### 6.12.5 Data Flow

**Local Metrics Storage**: `~/.codemie/sessions/`

- `{sessionId}.json`: Session metadata
- `{sessionId}_metrics.jsonl`: Delta records (one per line)

**Delta Lifecycle**:

1. Metrics orchestrator writes delta with syncStatus='pending'
2. SSOSessionSyncPlugin's metrics processor reads all pending deltas periodically (every `CODEMIE_SESSION_SYNC_INTERVAL` ms, default 120000 = 2 minutes, see §6.12.6)
3. All pending deltas aggregated into single session metric
4. Single metric sent to API as JSON object
5. On success: All aggregated deltas marked with syncStatus='synced'

**Sync Algorithm**:

1. Read all deltas from JSONL file
2. Filter for syncStatus='pending' only
3. Load session metadata
4. Aggregate pending deltas into single session metric (sum tokens, count tools, calculate duration)
5. POST single metric to API with SSO cookies
6. On success: Mark all aggregated deltas as 'synced' with atomic JSONL rewrite
7. On failure: Retry with exponential backoff, keep deltas as 'pending'

#### 6.12.6 Configuration

**Priority**: Environment Variables > Profile Config > Default (true)

**Environment Variables**:

- `CODEMIE_SESSION_SYNC_ENABLED`: Enable/disable sync (default: true for SSO)
- `CODEMIE_SESSION_DRY_RUN`: Run sync logic without actually sending data (default: false)
- `CODEMIE_SESSION_SYNC_INTERVAL`: Background sync interval in milliseconds (default: `120000` = 2 minutes). Not gated by profile config — env var only.

**Profile Configuration**:

- Location: `~/.codemie/codemie-cli.config.json`
- Path: `profiles[name].session.sync` (properties: `enabled`, `dryRun`)

**Opt-Out Options**:

- Single session: Set env var to false
- Profile-wide: Disable in profile config

#### 6.12.7 Error Handling

**Retryable Errors** (exponential backoff: 1s → 2s → 5s):

- Network timeouts
- 5xx server errors
- 429 Rate limiting
- Connection refused

**Non-Retryable Errors** (fail immediately):

- 401 Unauthorized (SSO session expired)
- 403 Forbidden (insufficient permissions)
- 400 Bad Request (invalid payload)

**Failure Strategy**:

- On retry exhaustion: Keep deltas as 'pending'
- Next sync cycle retries automatically
- Errors logged at ERROR level
- Plugin failure doesn't break proxy

**Concurrency Protection**:

- isSyncing flag prevents concurrent syncs
- Timer skips if sync already in progress
- Serial processing guaranteed

#### 6.12.8 Performance

**Memory**: ~5MB for plugin (within proxy process)
**Disk I/O**: O(1) - single session file read/write
**Network**: ~1KB per sync (single aggregated metric)
**CPU**: Minimal (simple arithmetic aggregation)

**Scalability**:

- Session-scoped: Only syncs current session
- No cross-session interference
- Timer-based: Predictable resource usage

#### 6.12.9 Monitoring

**Log Location**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Log Events**:

- Starting session sync (with interval)
- Syncing N pending deltas
- Successfully synced N deltas
- Stopping session sync
- Final sync completed
- Sync failures with error details

**Troubleshooting**:

- Check syncStatus in JSONL file (pending/synced)
- Verify SSO cookies valid
- Check network connectivity to API
- Enable debug logging

### 6.13 VS Code BYOK Profile Configuration

`codemie proxy connect --vscode` resolves one effective CodeMie profile before configuring the client. It does **not** write the profile's single `model` into VS Code's config as one entry — `writeVsCodeLanguageModelsConfig()` (`connectors/vscode.ts`, `vscode-models.ts`) writes the **entire fixed `VS_CODE_SUPPORTED_MODELS` catalog** (~20 entries, including the GPT-5.5/5.6 Responses-API entries described below) into a single managed provider in `chatLanguageModels.json`. The profile's `model` field is not read by this write path at all. The profile's `codeMieProject` is passed independently to the daemon for `X-CodeMie-Project` header injection.

The persistent daemon **does** receive a configured model: `spawnDaemon()` passes `--model <normalizedModel>` whenever the active profile has a `model` set, and this is shared across every `proxy connect` target (`--vscode`, `--claude-desktop`, `--codex-desktop`), not restricted to Codex. When present, the daemon injects `X-CodeMie-CLI-Model` (§6.10) for `vscode-byok` traffic same as any other client. What the daemon does _not_ do for VS Code traffic is rewrite the **request body's** model field — the Codex request normalizer (§6.6), which does that kind of body rewrite, explicitly excludes `vscode-byok` from its allowed client list. It validates the local gateway key (via the Gateway Key Plugin, §6.3), injects SSO authentication and CodeMie context headers, then forwards request and response bodies through the existing streaming path byte-for-byte.

The command reuses a healthy daemon when its profile, project, provider, target URL, `vscode-byok` client type, **and configured model** all match (`daemonMatchesRequest()` in `connect-orchestrator.ts` also compares model when the request specifies one — a mismatch spawns a fresh daemon rather than silently reusing a stale one).

The connector merges one managed model into VS Code's `chatLanguageModels.json` and preserves unrelated models plus an existing `${input:chat.lm.secret.*}` reference as `apiKey`. If no valid reference exists, it omits `apiKey` rather than generating a placeholder and directs the user to open `Chat: Manage Language Models`, right-click **CodeMie Profile Model**, and choose **Update API Key**. VS Code then stores the local `codemie-proxy` key in secret storage; CodeMie SSO credentials never enter VS Code configuration.

GPT-5.5 and all three GPT-5.6 entries use `/v1/responses` with
`zeroDataRetentionEnabled: true`, `thinking: true`, and Responses-format reasoning efforts. VS
Code owns the complete conversation history for these entries and sends stateless requests with
`store: false`, no `previous_response_id`, and replayed assistant, function-call, and
function-call-output items. This keeps LiteLLM free to load-balance each request across Azure
deployments.

The proxy performs only bounded compatibility normalization for `vscode-byok` (§6.9): it constrains the
Responses `user` identifier and forwards reasoning state untouched. It preserves the selected
`reasoning.effort`, visible messages, assistant phases, tools, call IDs, and tool outputs. The
proxy does not persist conversation content, add session affinity, buffer Responses events, or
transform the SSE stream.

Deployment-bound reasoning state is now handled server-side: the gateway runs LiteLLM
`encrypted_content_affinity`, which routes a follow-up carrying encrypted content back to the
deployment that produced it. Follow-ups therefore keep full cross-turn reasoning continuity.

The proxy retains a self-healing fallback (§6.8) for the case where an affinity pin has expired
(`deployment_affinity_ttl_seconds`). It watches upstream responses for `invalid_encrypted_content`
and for bare-reasoning-id rejections; on the first sighting it strips reasoning state from every
later request for the life of that proxy. The failing turn surfaces its error, then the session
continues with degraded hidden-reasoning continuity rather than replaying unusable state forever.
This applies uniformly to `codemie-codex`, `codemie-code`, `codemie-opencode`, `codemie-pi`, and
`vscode-byok`.

```mermaid
sequenceDiagram
    participant VS as VS Code Agent
    participant PX as CodeMie Proxy
    participant GW as CodeMie Gateway
    participant LM as Profile Model

    VS->>PX: POST /v1/responses<br/>store=false<br/>input=full local history<br/>Bearer local gateway key
    PX->>PX: Validate and strip local key
    PX->>PX: Inject CodeMie SSO cookies
    PX->>PX: Inject profile/project context headers
    PX->>PX: Normalize user; forward reasoning state as-is
    PX->>GW: Forward stateless request
    GW->>LM: Invoke configured model
    LM-->>GW: Streaming events / tool calls
    GW-->>PX: SSE stream
    PX-->>VS: Byte-preserved SSE stream
```

---

## 7. Quality Attributes

### 7.1 Performance

**Streaming**: Zero buffering, constant memory

- Before: ~100MB memory for 10MB response (buffered)
- After: ~10MB memory for 10MB response (streamed)

**Throughput**: No artificial limits

- Limited only by network and upstream API
- No CPU-intensive operations in hot path

**Latency**: Minimal overhead

- Plugin hooks: ~1-5ms per request
- Streaming: No added latency (pass-through)

**Concurrency**: Multi-request support

- Node.js event loop handles concurrent requests
- No blocking operations in request path

### 7.2 Reliability

**Fail-Safe**: Plugin failures don't break proxy

- Try-catch around all plugin hooks
- Log errors and continue

**Graceful Shutdown**: Clean resource cleanup

- Call onProxyStop() on all plugins
- Final sync operations complete
- Force-drain keep-alive sockets, then close the HTTP server

**Self-Healing (daemon mode)**: `ProxyWatcher` (`src/cli/commands/proxy/watcher.ts`) deep-checks the daemon every 30s via `/health`; on failure it restarts the proxy in-process on the same pinned port (up to 3 attempts) before giving up and recording `health: 'unhealthy'` in the daemon state file. See §9.1.

**Error Recovery**: Structured error responses

- Normalized error types
- Actionable error messages
- Full error context in logs

### 7.3 Maintainability

**SOLID Principles**:

- **Single Responsibility**: Core = forward HTTP, Plugins = features
- **Open/Closed**: Add features via plugins without modifying core
- **Liskov Substitution**: All plugins implement same interface
- **Interface Segregation**: Optional hooks (only implement what you need)
- **Dependency Inversion**: Core depends on plugin abstractions

**Code Organization**:

```
src/providers/plugins/sso/proxy/
├── proxy-errors.ts           # Error types
├── proxy-http-client.ts      # HTTP forwarding
├── proxy-types.ts            # Core types
├── sso.proxy.ts              # CodeMieProxy core
└── plugins/
    ├── index.ts                                     # Plugin registration
    ├── registry.ts                                   # Plugin management
    ├── types.ts                                       # Plugin interfaces
    ├── mcp-auth.plugin.ts                             # priority 3
    ├── endpoint-blocker.plugin.ts                     # priority 5
    ├── gateway-key.plugin.ts                          # priority 7
    ├── sso-auth.plugin.ts                             # priority 10
    ├── jwt-auth.plugin.ts                             # priority 10
    ├── claude-request-normalizer.plugin.ts            # priority 14
    ├── kimi-request-normalizer.plugin.ts               # priority 14
    ├── codex-request-normalizer.plugin.ts              # priority 14
    ├── request-sanitizer.plugin.ts                     # priority 15
    ├── codex-encrypted-content-sanitizer.plugin.ts      # priority 16
    ├── copilot-encrypted-content-sanitizer.plugin.ts    # priority 16
    ├── vscode-request-normalizer.plugin.ts              # priority 17
    ├── header-injection.plugin.ts                       # priority 20
    ├── logging.plugin.ts                                # priority 50
    └── sso.session-sync.plugin.ts                       # priority 100

src/providers/plugins/sso/session/
├── SessionSyncer.ts           # discovery + I/O shared by processors
├── BaseProcessor.ts
└── processors/
    ├── metrics/metrics-sync-processor.ts
    └── ...                    # conversation and other processors
```

### 7.4 Security

**Authentication**: SSO cookie / JWT bearer / local gateway key handling

- Credentials never logged (sanitized)
- Secure credential storage (CredentialStore)
- Encrypted at rest

**TLS/SSL**: Support for self-signed certs

- `rejectUnauthorized` option configurable (defaults to `false`)
- Allows enterprise CA certificates

**Input Validation**: Header sanitization

- Remove Host and Connection headers
- Validate proxy configuration

**Audit Trail**: Full request logging

- Request ID for tracing
- Session ID for correlation
- Detailed logs for forensics

### 7.5 Extensibility

**Plugin System**: Add features without core changes

**Extension Points**:

- **onProxyStart**: Initialization tasks, background services
- **handleRequest**: Full request bypass for traffic that doesn't target the main upstream (rare — use only when the standard pipeline genuinely doesn't apply)
- **onRequest**: Request modification, authentication, validation
- **onUpstreamResponse**: Inspect/replace the raw upstream response before header/streaming hooks run (buffer-and-retry patterns)
- **onResponseHeaders**: Header inspection, caching decisions
- **onResponseChunk**: Streaming transformation, filtering
- **onResponseComplete**: Analytics, logging, cleanup
- **onError**: Error handling, alerting, recovery

**Future Plugin Examples**:

- Rate Limiting: Per-session request throttling
- Caching: LRU cache with TTL expiration
- Request Replay: Store/retry failed requests
- Content Transformation: Request/response body modification

---

## 8. Design Patterns

### 8.1 Chain of Responsibility

**Pattern**: Plugins form a chain of handlers
**Implementation**: PluginRegistry + ProxyInterceptor hooks
**Benefit**: Add/remove handlers without modifying core

### 8.2 Observer Pattern

**Pattern**: Plugins observe proxy events
**Implementation**: Lifecycle hooks (onRequest, onResponseHeaders, etc.)
**Benefit**: Decoupled event handling

### 8.3 Strategy Pattern

**Pattern**: Different plugin implementations for same interface
**Implementation**: All plugins implement ProxyPlugin
**Benefit**: Swap implementations at runtime

### 8.4 Factory Pattern

**Pattern**: createInterceptor() method
**Implementation**: Each plugin creates its interceptor
**Benefit**: Encapsulate interceptor creation logic

### 8.5 Singleton Pattern

**Pattern**: Single PluginRegistry instance
**Implementation**: getPluginRegistry() function
**Benefit**: Centralized plugin management

### 8.6 Template Method Pattern

**Pattern**: Core defines request handling flow, plugins fill in steps
**Implementation**: handleRequest() method with hook call-outs
**Benefit**: Consistent flow, customizable steps

---

## 9. Deployment & Operations

### 9.1 Startup Flow

```
1. Agent CLI starts, or `codemie proxy start` / `codemie proxy connect ...` spawns the daemon
   └─ e.g. codemie-claude "implement feature" --provider ai-run-sso

2. Agent/CLI detects SSO provider (or daemon mode is requested)
   └─ Checks if proxy is needed

3a. In-process usage: agent spawns proxy directly
   ├─ Create ProxyConfig (targetApiUrl, sessionId, etc.)
   ├─ new CodeMieProxy(config)
   └─ await proxy.start()
       ├─ Load SSO/JWT credentials
       ├─ Initialize plugins
       ├─ Call onProxyStart() hooks
       └─ Bind to dynamic port

3b. Daemon usage (src/bin/proxy-daemon.ts, detached process, e.g. for Claude
    Desktop or VS Code BYOK, spawned via src/cli/commands/proxy/daemon-manager.ts):
   ├─ Parse CLI args (--target-url, --state-file, --gateway-key, --port, ...)
   ├─ new CodeMieProxy(config) and await proxy.start()
   ├─ Optionally start DesktopTelemetryRuntime (--telemetry-mode claude-desktop)
   ├─ Persist state file atomically (pid, port, url, health, timestamps)
   ├─ Start ProxyWatcher: deep-checks /health every 30s, restarts the proxy
   │   in-process on the SAME pinned port (up to 3 attempts) on failure,
   │   records health: 'unhealthy' in the state file if it gives up
   └─ Register SIGTERM/SIGINT handlers that stop the watcher, telemetry
       runtime, and proxy, then delete the state file

4. Proxy returns URL
   └─ http://localhost:PORT or http://127.0.0.1:PORT (daemon binds 127.0.0.1
      explicitly — Claude Desktop's gateway URL validator requires the literal
      loopback IP; 'localhost' can resolve to IPv6 ::1 only on macOS)

5. Agent uses proxy URL
   └─ Set environment variable: ANTHROPIC_BASE_URL=http://localhost:PORT

6. Agent runs normally
   └─ All API requests go through proxy
```

### 9.2 Shutdown Flow

```
1. User exits agent (Ctrl+C or normal exit), or sends SIGTERM/SIGINT to the daemon

2. Cleanup
   ├─ Stop the ProxyWatcher (daemon mode only)
   ├─ Stop the Desktop telemetry runtime, if running
   └─ await proxy.stop()
       ├─ Call onProxyStop() hooks
       │   └─ SSOSessionSyncPlugin: Final sync
       ├─ Force-drain keep-alive sockets, then close HTTP server
       └─ Cleanup HTTP client

3. Daemon mode also deletes the state file

4. Process exits
```

### 9.3 Configuration

**Programmatic Configuration**:

- Target API URL
- Port (0 = dynamic), pinned-port retry flag
- Client type
- Session ID
- Profile, provider, model
- Auth method (`sso` | `jwt`), gateway key
- Telemetry mode and intervals

**Environment Variables** (plugin-specific):

- `CODEMIE_SESSION_SYNC_ENABLED`
- `CODEMIE_SESSION_DRY_RUN`
- `CODEMIE_DEBUG`
- `MCP_PROXY_DEBUG`
- `MCP_CLIENT_NAME`
- `CODEMIE_PROXY_PORT`
- `CODEMIE_JWT_TOKEN`

**Profile Configuration** (plugin-specific):

- Location: ~/.codemie/codemie-cli.config.json
- Provider-specific settings
- Session sync configuration (`profiles[name].session.sync`)

**Priority**: Environment variables > Profile config > Defaults

### 9.4 Monitoring

**Log Files**: `~/.codemie/logs/debug-YYYY-MM-DD.log`, `~/.codemie/logs/mcp-proxy.log`

**Log Levels**:

- ERROR: Plugin failures, network errors
- WARN: Retry attempts, deprecated features
- INFO: Plugin initialization, sync operations
- DEBUG: All proxy activity (file only)

**Metrics** (via SSO Session Sync Plugin):

- Request count per session
- Token usage
- Tool calls
- File operations
- Session duration

**Health Indicators**:

- `/health` / `/healthz` responds (used by CLI commands and the in-daemon watcher)
- Daemon state file `health` field (`ok` / `unhealthy`)
- Plugins loaded successfully
- No critical errors in logs

### 9.5 Troubleshooting

**Problem**: Proxy not starting
**Diagnosis**: Check logs for port binding errors
**Solution**: Use dynamic port (port: 0), or check for a stale pinned-port daemon holding the port

**Problem**: SSO auth failing
**Diagnosis**: Check if credentials exist
**Solution**: Re-authenticate with auth command

**Problem**: Session sync not working
**Diagnosis**: Check plugin enabled in config/env; confirm credentials are SSO (not JWT)
**Solution**: Enable via `CODEMIE_SESSION_SYNC_ENABLED` or `profiles[name].session.sync.enabled`

**Problem**: Daemon restarts repeatedly / marked unhealthy
**Diagnosis**: Check `ProxyWatcher` log lines and the daemon state file's `healthReason`
**Solution**: After 3 failed restarts the watcher gives up rather than looping forever — investigate the underlying upstream/auth failure before forcing another daemon start

**Problem**: Plugin error breaking proxy
**Diagnosis**: Check logs for plugin name
**Solution**: Plugins are fail-safe - verify implementation

---

## 10. Future Extensions

### 10.1 Planned Features

> These were speculative when originally written. Priorities 15-17 are now occupied by shipped
> request-sanitization plugins (§6.7-6.9), so any new plugin in this range should pick an unused
> priority rather than reusing the numbers below verbatim.

**Request Caching**:

- LRU cache for identical requests
- TTL-based expiration
- Cache invalidation API

**Rate Limiting**:

- Per-session rate limits
- Token bucket algorithm
- Configurable limits per profile

**Request Replay**:

- Store failed requests
- Automatic retry on recovery
- Persistence across restarts

**Request/Response Transformation**:

- Modify request body (add system prompts)
- Filter response content (PII redaction)
- Format transformation (OpenAI → Anthropic)

### 10.2 Scalability Considerations

**Current Limitation**: Single process, single session (per daemon instance)

**Future Enhancement**: Multi-session support

- Session routing via header
- Per-session plugin context
- Shared cache across sessions

**Load Balancing**: Multiple upstream targets

- Round-robin routing
- Health checks
- Failover logic

**Distributed Tracing**: OpenTelemetry integration

- Trace ID propagation
- Span creation for plugin hooks
- Export to observability platforms

### 10.3 Plugin Marketplace

**Vision**: Community-contributed plugins

**Requirements**:

- Plugin validation (security, performance)
- Versioning and compatibility checks
- Documentation standards
- Distribution via npm

**Example Third-Party Plugins**:

- Advanced analytics with custom metrics
- Record/replay for debugging
- Security scanning for vulnerabilities
- Request/response transformation

---

**End of Document**
