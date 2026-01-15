# CodeMie Proxy Architecture

**Version**: 1.0
**Date**: 2025-12-11
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

- **SSO Authentication**: Automatic cookie injection for enterprise SSO
- **Header Management**: CodeMie-specific header injection for traceability
- **Observability**: Detailed logging and metrics collection
- **Metrics Sync**: Background sync of session metrics to CodeMie API
- **Extensibility**: Plugin architecture for future features

### 1.2 Key Design Principles

* ✅ **KISS (Keep It Simple)**: Core does ONE thing - forwards HTTP with streaming
* ✅ **SOLID**: Single Responsibility, Open/Closed via plugins, Dependency Injection
* ✅ **Zero Buffering**: True HTTP streaming with no body buffering
* ✅ **Plugin-Based**: Core is stable, features added via plugins
* ✅ **Fail-Safe**: Plugin failures don't break proxy flow

---

## 2. Architecture Overview

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         AI Coding Agent                         │
│                    (claude, codex, gemini, etc.)                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP Request
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       CodeMie Proxy                             │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │               Plugin System (Priority-Based)               │ │
│  │                                                            │ │
│  │  [10]  SSO Auth Plugin      → Inject cookies               │ │
│  │  [20]  Header Injection     → Add X-CodeMie headers        │ │
│  │  [50]  Logging Plugin       → Log requests/responses       │ │
│  │  [100] Metrics Sync Plugin  → Background metrics sync      │ │
│  └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                  HTTP Streaming Core                       │ │
│  │  • Build context                                           │ │
│  │  • Run onRequest hooks                                     │ │
│  │  • Forward to upstream (no buffering)                      │ │
│  │  • Run onResponseHeaders hooks                             │ │
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
│  • SSL/TLS handling                                             │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1 CodeMieProxy

**Location**: `src/utils/codemie-proxy.ts`

**Responsibilities**:
- HTTP server lifecycle (start/stop)
- Request routing to plugins
- Error handling and recovery
- Port management (dynamic allocation)

**Key Operations**:
- Initialize plugins and start server
- Graceful shutdown with plugin cleanup
- Main request handler
- Streaming response handler

**Configuration Parameters**:
- Target API URL (upstream endpoint)
- Local port (0 = dynamic allocation)
- Client type (agent identifier)
- Timeout duration
- Profile name, provider, model
- Session ID

### 3.2 PluginRegistry

**Location**: `src/proxy/plugins/registry.ts`

**Responsibilities**:
- Plugin registration and storage
- Dependency resolution
- Priority-based sorting (0-1000)
- Lifecycle hook invocation

**Key Operations**:
- Register plugins at startup
- Initialize plugins with context
- Enable/disable plugins at runtime
- Retrieve plugin configurations

**Plugin Priority Levels**:
- **0-10**: Authentication and security (SSO Auth: 10)
- **11-50**: Header manipulation (Header Injection: 20)
- **51-100**: Observability (Logging: 50, Metrics Sync: 100)
- **101-500**: Business logic (rate limiting, caching)
- **501-1000**: Post-processing (analytics, reporting)

### 3.3 ProxyHTTPClient

**Location**: `src/proxy/http-client.ts`

**Responsibilities**:
- HTTP/HTTPS forwarding with streaming
- Connection pooling
- Timeout management
- SSL/TLS certificate handling

**Features**:
- Zero buffering (streams directly)
- Async iteration over response chunks
- Custom SSL/TLS options (self-signed certs)
- Configurable timeouts

### 3.4 ProxyContext

**Location**: `src/proxy/types.ts`

**Purpose**: Shared state across all plugin hooks for a single request

**Context Attributes**:
- **Identity**: Request ID, Session ID, Agent name
- **Traceability**: Profile, Provider, Model
- **Request Details**: Method, URL, Headers, Body
- **Timing**: Request start time
- **Upstream**: Target URL
- **Extensibility**: Metadata dictionary for plugin-specific data

---

## 4. Plugin System

### 4.1 Plugin Architecture

**Design Pattern**: Chain of Responsibility + Observer

**Plugin Interface**:
- **Metadata**: ID, name, version, priority, dependencies
- **Factory Method**: Creates interceptor instance with context
- **Lifecycle Hooks**: Install, uninstall, enable, disable

**Interceptor Interface**:
- **Proxy Lifecycle**: onProxyStart, onProxyStop
- **Request Lifecycle**: onRequest, onResponseHeaders, onResponseChunk, onResponseComplete, onError

### 4.2 Plugin Lifecycle

```
┌──────────────────────────────────────────────────────────────┐
│  Application Startup                                         │
│  ├─ Import: src/proxy/plugins/index.ts                       │
│  ├─ Auto-register: registerCorePlugins()                     │
│  └─ Plugins registered in PluginRegistry                     │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Proxy Start (per session)                                   │
│  ├─ CodeMieProxy.start() called                              │
│  ├─ Build PluginContext (config, credentials)                │
│  ├─ PluginRegistry.initialize(context)                       │
│  │   ├─ Filter enabled plugins                               │
│  │   ├─ Sort by priority                                     │
│  │   ├─ Call createInterceptor() for each                    │
│  │   └─ Return sorted interceptor list                       │
│  └─ Call onProxyStart() on all interceptors                  │
└──────────────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────────────┐
│  Request Handling (per request)                              │
│  ├─ Build ProxyContext                                       │
│  ├─ onRequest() hooks (all interceptors)                     │
│  ├─ Forward to upstream                                      │
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
│  └─ Cleanup resources                                        │
└──────────────────────────────────────────────────────────────┘
```

### 4.3 Plugin Registration Pattern

**Auto-Registration**:
- Plugins register themselves on module import
- Core plugins registered in central index file
- Registry maintains plugin instances and configurations

**Manual Registration**:
- Runtime registration for conditional plugins
- Used for feature flags or environment-specific plugins

### 4.4 Error Handling

**Fail-Safe Design**: Plugin errors don't break proxy flow

**Error Handling Strategy**:
- Try-catch wrapper around all plugin hooks
- Errors logged for debugging
- Execution continues with remaining interceptors
- Graceful degradation ensures proxy availability

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
   ├─ Build ProxyContext (requestId, sessionId, headers, body)
   ├─ Run onRequest() hooks (priority order)
   │   ├─ SSOAuthPlugin: Inject cookies
   │   ├─ HeaderInjectionPlugin: Add X-CodeMie headers
   │   └─ LoggingPlugin: Log request
   ├─ Build target URL (targetApiUrl + request path)
   └─ Forward to upstream via ProxyHTTPClient

3. Upstream responds
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
   │   └─ MetricsSyncPlugin: No-op (runs on timer)
   └─ Close connection
```

### 5.2 Error Flow

```
Client → Proxy → Error → Proxy → Client

Error Handling:
1. Error occurs (network, timeout, upstream error)

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

Benefits:
- ~90% less memory usage (no buffering)
- Constant memory regardless of response size
- True streaming for SSE and long responses
- Real-time data delivery
```

---

## 6. Plugin Implementations

### 6.1 SSO Auth Plugin

**Priority**: 10 (must run first)
**File**: `src/proxy/plugins/sso-auth.plugin.ts`

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

### 6.2 Header Injection Plugin

**Priority**: 20
**File**: `src/proxy/plugins/header-injection.plugin.ts`

**Purpose**: Add CodeMie-specific headers for traceability

**Headers Injected**:

**Always Injected:**
- `X-CodeMie-CLI`: CLI wrapper and version (e.g., `codemie-cli/0.0.16`)
- `X-CodeMie-Client`: Agent identifier (e.g., `codemie-claude`, `codemie-codex`, `codemie-code`)
- `X-CodeMie-Request-ID`: Request UUID for traceability
- `X-CodeMie-Session-ID`: Session UUID for correlation

**Conditionally Injected:**
- `X-CodeMie-Integration`: Integration ID (only when provider requires integration via `requiresIntegration` flag)
- `X-CodeMie-CLI-Model`: Model name from config (if configured)
- `X-CodeMie-CLI-Timeout`: Timeout value from config (if configured)

**Architecture**:
- Reads values from PluginContext and ProxyContext
- Adds headers to outgoing request
- Executes in onRequest() hook
- Fails gracefully if values are missing (optional headers)

### 6.3 Logging Plugin

**Priority**: 50
**File**: `src/proxy/plugins/logging.plugin.ts`

**Purpose**: Log detailed proxy activity

**Log Destinations**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Log Level**: DEBUG (file only, console when CODEMIE_DEBUG=1)

**Lifecycle Hooks**:
- **onRequest**: Log request details (method, URL, headers, body size)
- **onResponseHeaders**: Log response headers (content-type, encoding)
- **onResponseChunk**: Log streaming progress (every 10th chunk)
- **onResponseComplete**: Log final stats (status, duration, bytes sent)
- **onError**: Log error details (type, message, stack trace)

**Architecture**:
- Stateless within single request
- Maintains chunk counter for sampling
- No impact on proxy performance (async logging)

### 6.4 Metrics Sync Plugin

**Priority**: 100
**File**: `src/proxy/plugins/metrics-sync.plugin.ts`

**Purpose**: Background sync of session metrics to CodeMie API

#### 6.4.1 Overview

**Design Decisions**:
- ✅ **Aggregation over Granularity**: Multiple deltas aggregated into single metric per sync
- ✅ **Single Metric Sync**: API receives one aggregated metric object, not array
- ✅ **Session-Level Sync**: Plugin is session-scoped (syncs only current session)
- ✅ **In-Place Marking**: Sync status tracked directly in JSONL file
- ✅ **SSO-Only Operation**: Only runs when provider is `ai-run-sso`
- ✅ **Cookie Authentication**: Uses SSO cookies from proxy context

#### 6.4.2 Architecture

**Lifecycle**:
```
Proxy Start
  └─ onProxyStart()
      ├─ Initialize MetricsApiClient
      ├─ Start background timer (every 5 minutes)
      └─ Log: "Starting metrics sync"

Background Timer (every 5 minutes)
  └─ syncMetrics()
      ├─ Read {sessionId}_metrics.jsonl
      ├─ Filter deltas with syncStatus='pending'
      ├─ Load session metadata
      ├─ Aggregate deltas → single metric
      ├─ POST ${apiUrl}/metrics
      ├─ On success: Mark deltas as 'synced' in JSONL
      └─ Log: "Synced N deltas"

Proxy Stop
  └─ onProxyStop()
      ├─ Stop background timer
      ├─ Final sync (ensures all pending deltas sent)
      └─ Log: "Final sync completed"
```

**Components**:
- MetricsSyncPlugin: Plugin registration and initialization
- MetricsSyncInterceptor: Interceptor with timer and sync logic
- MetricsApiClient: HTTP client for API communication
- Aggregation Logic: Combines deltas into session metric
- JSONL Utilities: Atomic file operations

#### 6.4.3 API Contract

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

#### 6.4.4 Data Flow

**Local Metrics Storage**: `~/.codemie/sessions/`
- `{sessionId}.json`: Session metadata
- `{sessionId}_metrics.jsonl`: Delta records (one per line)

**Delta Lifecycle**:
1. MetricsOrchestrator writes delta with syncStatus='pending'
2. MetricsSyncPlugin reads all pending deltas periodically (every 5 minutes)
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

#### 6.4.5 Configuration

**Priority**: Environment Variables > Profile Config > Default (true)

**Environment Variables**:
- `CODEMIE_METRICS_SYNC_ENABLED`: Enable/disable sync (default: true for SSO)
- `CODEMIE_METRICS_SYNC_INTERVAL`: Sync interval in milliseconds (default: 300000)
- `CODEMIE_METRICS_MAX_RETRIES`: Max retry attempts (default: 3)

**Profile Configuration**:
- Location: `~/.codemie/codemie-cli.config.json`
- Path: `profiles[name].metrics.sync`
- Properties: enabled, interval, maxRetries

**Opt-Out Options**:
- Single session: Set env var to false
- Profile-wide: Disable in profile config

#### 6.4.6 Error Handling

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

#### 6.4.7 Performance

**Memory**: ~5MB for plugin (within proxy process)
**Disk I/O**: O(1) - single session file read/write
**Network**: ~1KB per sync (single aggregated metric)
**CPU**: Minimal (simple arithmetic aggregation)

**Scalability**:
- Session-scoped: Only syncs current session
- No cross-session interference
- Timer-based: Predictable resource usage

#### 6.4.8 Monitoring

**Log Location**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Log Events**:
- Starting metrics sync (with interval)
- Syncing N pending deltas
- Successfully synced N deltas
- Stopping metrics sync
- Final sync completed
- Sync failures with error details

**Troubleshooting**:
- Check syncStatus in JSONL file (pending/synced)
- Verify SSO cookies valid
- Check network connectivity to API
- Enable debug logging

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
- HTTP server closes gracefully

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
src/proxy/
├── errors.ts                # Error types
├── http-client.ts           # HTTP forwarding
├── types.ts                 # Core types
└── plugins/
    ├── index.ts             # Plugin registration
    ├── registry.ts          # Plugin management
    ├── types.ts             # Plugin interfaces
    ├── sso-auth.plugin.ts
    ├── header-injection.plugin.ts
    ├── logging.plugin.ts
    └── metrics-sync.plugin.ts
```

### 7.4 Security

**Authentication**: SSO cookie handling
- Cookies never logged (sanitized)
- Secure credential storage (CredentialStore)
- Encrypted at rest

**TLS/SSL**: Support for self-signed certs
- rejectUnauthorized option configurable
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
- **onRequest**: Request modification, authentication, validation
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
1. Agent CLI starts
   └─ codemie-claude "implement feature" --provider ai-run-sso

2. Agent detects SSO provider
   └─ Checks if proxy is needed

3. Agent spawns proxy
   ├─ Create ProxyConfig (targetApiUrl, sessionId, etc.)
   ├─ new CodeMieProxy(config)
   └─ await proxy.start()
       ├─ Load SSO credentials
       ├─ Initialize plugins
       ├─ Call onProxyStart() hooks
       └─ Bind to dynamic port

4. Proxy returns URL
   └─ http://localhost:54321

5. Agent uses proxy URL
   └─ Set environment variable: ANTHROPIC_BASE_URL=http://localhost:54321

6. Agent runs normally
   └─ All API requests go through proxy
```

### 9.2 Shutdown Flow

```
1. User exits agent (Ctrl+C or normal exit)

2. Agent cleanup
   ├─ Signal proxy to stop
   └─ await proxy.stop()
       ├─ Call onProxyStop() hooks
       │   └─ MetricsSyncPlugin: Final sync
       ├─ Close HTTP server
       └─ Cleanup HTTP client

3. Agent exits
```

### 9.3 Configuration

**Programmatic Configuration**:
- Target API URL
- Port (0 = dynamic)
- Client type
- Session ID
- Profile, provider, model

**Environment Variables** (plugin-specific):
- CODEMIE_METRICS_SYNC_ENABLED
- CODEMIE_METRICS_SYNC_INTERVAL
- CODEMIE_DEBUG

**Profile Configuration** (plugin-specific):
- Location: ~/.codemie/codemie-cli.config.json
- Provider-specific settings
- Metrics sync configuration

**Priority**: Environment variables > Profile config > Defaults

### 9.4 Monitoring

**Log Files**: `~/.codemie/logs/debug-YYYY-MM-DD.log`

**Log Levels**:
- ERROR: Plugin failures, network errors
- WARN: Retry attempts, deprecated features
- INFO: Plugin initialization, sync operations
- DEBUG: All proxy activity (file only)

**Metrics** (via Metrics Sync Plugin):
- Request count per session
- Token usage
- Tool calls
- File operations
- Session duration

**Health Indicators**:
- Proxy responds to requests
- Plugins loaded successfully
- No critical errors in logs

### 9.5 Troubleshooting

**Problem**: Proxy not starting
**Diagnosis**: Check logs for port binding errors
**Solution**: Use dynamic port (port: 0)

**Problem**: SSO auth failing
**Diagnosis**: Check if credentials exist
**Solution**: Re-authenticate with auth command

**Problem**: Metrics not syncing
**Diagnosis**: Check plugin enabled in config
**Solution**: Enable in profile or env var

**Problem**: Plugin error breaking proxy
**Diagnosis**: Check logs for plugin name
**Solution**: Plugins are fail-safe - verify implementation

---

## 10. Future Extensions

### 10.1 Planned Features

**Request Caching** (Priority: 90):
- LRU cache for identical requests
- TTL-based expiration
- Cache invalidation API

**Rate Limiting** (Priority: 15):
- Per-session rate limits
- Token bucket algorithm
- Configurable limits per profile

**Request Replay** (Priority: 110):
- Store failed requests
- Automatic retry on recovery
- Persistence across restarts

**Request/Response Transformation** (Priority: 25):
- Modify request body (add system prompts)
- Filter response content (PII redaction)
- Format transformation (OpenAI → Anthropic)

### 10.2 Scalability Considerations

**Current Limitation**: Single process, single session

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
