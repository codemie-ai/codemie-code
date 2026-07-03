# Design: `codemie mcp-auth-proxy` — MCP OAuth Rewriting Proxy

Date: 2026-07-03
Run: 20260703-1845-mcp-auth-proxy
Status: Proposed (pending `spec.approved` gate)

`docs/SPEC-mcp-auth-proxy.md` is the **authoritative functional spec** (route map, rewrite
rules R1–R6, config semantics, CLI surface, security rules, acceptance criteria). This
design does not restate it; it binds the spec to this repository: concrete modules,
interfaces, in-repo templates to mirror, and the resolved open decisions. Where this doc
and the spec diverge, the divergence is listed in "Resolved decisions" below — everything
else defers to the spec.

## Resolved decisions

| # | Decision | Resolution | Rationale |
|---|---|---|---|
| D1 | Streaming pass-through mechanism | **Raw `node:http`/`node:https` client + `stream/promises` `pipeline`** — not undici / fetch `duplex:'half'` | Gate `spec.clarification` verdict (decisions.jsonl 2026-07-03): the spec's R1 MUSTs (unbuffered bidirectional streaming, abort propagation, no body-parsing middleware) are mechanism-agnostic; the undici mention is a parenthetical hint; undici is not a dependency and the repo's proven SSE-proxy template is `src/providers/plugins/sso/proxy/proxy-http-client.ts`. **Deliberate deviation from the spec's hint — do not flag as drift in review.** |
| D2 | Error classes | Config validation → `ConfigurationError` (with offending key path); daemon lifecycle → `ToolExecutionError`; per-request forwarding failures → HTTP JSON error responses (`502 upstream_unreachable`, `404 unknown_route`), no thrown cross-layer errors | Spec mandates `src/utils/errors.ts` classes; importing `src/providers/plugins/sso/proxy/proxy-errors.ts` into `src/mcp/` would cross a plugin boundary (technical-analysis §6). |
| D3 | Corporate proxy env | Upstream requests honor `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY` via the existing `https-proxy-agent`/`http-proxy-agent` dependencies, mirroring the SSO proxy outbound client | Enterprise upstreams (`mcp.epam.com`) sit behind corporate proxies; repo convention already does this; zero new dependencies. |
| D4 | Daemon spawn target | Git-tracked ESM wrapper `bin/mcp-auth-proxy-daemon.js` → `import('../dist/bin/mcp-auth-proxy-daemon.js')`; spawn by file path via `spawnDetached` | Repo ADR: daemons spawn by file path to `bin/*.js` wrappers (`daemon-manager.ts`); tsc compiles all of `src/`, no build config change. |
| D5 | Shared daemon runtime | New `src/mcp/auth-proxy/runtime.ts` with `runAuthProxyDaemon(opts)` used by both the bin entry and CLI `--foreground` | `--foreground` has no repo precedent; a shared runtime avoids duplicating config-load/start/state-write/signal-handling between the bin entry and the CLI. |
| D6 | Reserved route ids | `as`, `.well-known` (spec) **plus `healthz`** | The proxy serves `GET /healthz`; a route named `healthz` would shadow it. Spec gap, fixed here. |
| D7 | Port conflict | Pinned port: `EADDRINUSE` → fail start with `ConfigurationError`-style message (no auto-increment) | Client MCP URLs embed the port; silently moving it would break every registered `claude mcp add` URL. (SSO proxy auto-retries only for unpinned ports.) |
| D8 | State-file helpers | New `src/mcp/auth-proxy/state.ts` (read/write/clear + `isProcessAlive`), consumed by CLI and runtime | Existing `daemon-manager.ts` is typed to the SSO proxy's `DaemonState` (profile, gatewayKey); the new state schema `{pid, port, routes, startedAt}` differs. Mirror the pattern (atomic tmp+rename, defensive parse → null), not the code. |

## Architecture

Fits the 5-layer architecture: CLI (`src/cli/commands/mcp-auth-proxy.ts`) → core module
(`src/mcp/auth-proxy/`) → utils (`paths`, `errors`, `logger`, `security`, `processes`).
No registry/plugin surface. Existing `codemie mcp-proxy` stdio bridge is untouched.

### Files

| File | Kind | Responsibility |
|---|---|---|
| `src/mcp/auth-proxy/types.ts` | new | `AuthProxyConfig`, `RouteConfig`, `AuthProxyDaemonState`, `UpstreamMetadata`, `RouteRuntime` (status ok/degraded), rewrite-option types. Explicit exported types, no `any`. |
| `src/mcp/auth-proxy/config.ts` | new | `loadAuthProxyConfig(path?): AuthProxyConfig` — read JSON (default `getCodemiePath('mcp-auth-proxy.json')`), validate with manual guards, throw `ConfigurationError` with offending key path (`servers.radar.upstreamUrl`, …). Rules: `port` optional int 1–65535 (default 42800); route id `^[a-z0-9][a-z0-9-]*$`, not in {`as`, `.well-known`, `healthz`}; `upstreamUrl` required `https://` URL; `clientName` optional non-empty string; `scopes` optional non-empty `string[]`. |
| `src/mcp/auth-proxy/rewrites.ts` | new | **Pure functions, no I/O** (unit-test core): `rewriteChallengeHeader`, `rewritePrm`, `rewriteAsMetadata`, `rewriteRegistrationBody`, `rewriteAuthorizeQuery`, `rewriteTokenBody` — exactly the six rules R1–R6 of the spec, each taking explicit inputs (upstream document/header/query + `{proxyOrigin, routeId, scopes?, clientName?, upstreamResource?}`) and returning the rewritten value plus the list of rewritten field names (for safe logging). |
| `src/mcp/auth-proxy/metadata-cache.ts` | new | `MetadataCache` — per-route upstream discovery + TTL cache. Discovery: probe upstream PRM (`<origin>/.well-known/oauth-protected-resource/<path>`, then root variant; additionally accept a `resource_metadata` URL captured from a live upstream 401 via `notePrmUrl(routeId, url)` called by the pass-through handler, per R2), then AS metadata from PRM's first `authorization_servers` issuer using the spec's well-known priority order (RFC 8414 path-insertion → OIDC path-insertion → OIDC path-appending). Extracts upstream canonical `resource`, `registration_endpoint` (missing ⇒ route startup failure per R3), `authorization_endpoint`, `token_endpoint`, `revocation_endpoint?`. Positive TTL 300 s, negative cache 10 s, per-route isolation (failure of one route never touches another). Multiple `authorization_servers` ⇒ first + `logger.warn`. |
| `src/mcp/auth-proxy/server.ts` | new | `McpAuthProxy` class: `start(): Promise<{port, url}>`, `stop(): Promise<void>`. `node:http` server bound to literal `'127.0.0.1'` (repo ADR). Route dispatch per the spec's route map (rows 1–11) incl. single-route root-PRM alias and `/healthz`. MCP pass-through per R1 via `node:http`/`node:https` client + `pipeline` (D1): hop-by-hop header strip, `Host` set to upstream, `Authorization`/`Mcp-Session-Id` passed through, client-abort propagation (`req.on('close')` → upstream `.destroy()`), timeout 0 + keep-alive agents for SSE, `WWW-Authenticate` rewrite/injection on 401 and `insufficient_scope` 403. OAuth endpoints: 64 KB body limit on register/token, forward + relay verbatim, `302` for authorize. Degraded routes → `502 {"error":"upstream_unreachable","route":"<id>"}` and `/healthz` marks `degraded`. Uniform log rule: method, route id, path, status, duration, rewritten-field *names* only; never bodies/queries/headers on `/as/*`. |
| `src/mcp/auth-proxy/state.ts` | new | `AuthProxyDaemonState {pid, port, routes: string[], startedAt}`; `readAuthProxyState`/`writeAuthProxyState` (atomic tmp+rename)/`clearAuthProxyState`/`isProcessAlive` — pattern-mirror of `daemon-manager.ts`. State file `getCodemiePath('mcp-auth-proxy.state.json')`. |
| `src/mcp/auth-proxy/runtime.ts` | new | `runAuthProxyDaemon({configPath?, port?, stateFile?}): Promise<{proxy, stop}>` — load config, apply port override, start `McpAuthProxy`, write state, install SIGTERM/SIGINT cleanup (stop server, unlink state). Used by the bin entry and CLI `--foreground` (D5). **No watcher** (spec non-goal). |
| `src/bin/mcp-auth-proxy-daemon.ts` | new | Thin detached entry: `parseArgs` (`--config`, `--port`, `--state-file`) → `runAuthProxyDaemon`. Start failure → stderr + `exit(1)`. Mirrors `src/bin/proxy-daemon.ts` minus watcher. |
| `bin/mcp-auth-proxy-daemon.js` | new | Git-tracked ESM wrapper importing `../dist/bin/mcp-auth-proxy-daemon.js` (D4). |
| `src/cli/commands/mcp-auth-proxy.ts` | new | `createMcpAuthProxyCommand()` — `new Command('mcp-auth-proxy')` with `start [--config <path>] [--port <n>] [--foreground]`, `stop`, `status`, mirroring `src/cli/commands/proxy/index.ts` (port parse helper → `ConfigurationError`; `chalk` output). `start`: validate config first (fail fast with key path), then detached `spawnDetached(process.execPath, [wrapper, ...args])` + 5 s state/pid poll (`ToolExecutionError` on timeout), or `--foreground` → `runAuthProxyDaemon` in-process; on success print per-route `claude mcp add --scope local --transport http <id> http://127.0.0.1:<port>/<id>` lines. `status`: read state, pid liveness, `GET /healthz`, print per-route upstream + add-command; clear stale state. `stop`: SIGTERM + poll, SIGKILL escalation, clear state. |
| `src/cli/index.ts` | edit | Import + `program.addCommand(createMcpAuthProxyCommand())` next to `createMcpProxyCommand()` (line ~98). |
| `package.json` | edit | Optional `bin` entry `"codemie-mcp-auth-proxy-daemon": "bin/mcp-auth-proxy-daemon.js"` for consistency; `files` already ships `bin/` + `dist/`. No build changes (tsc compiles `src/**/*`). |
| `docs/COMMANDS.md` | edit | Document the new command surface (repo review checklist: public docs updated when behavior changes). |

Every new `src/**/*.ts` file carries the Apache-2.0 license header (license gate).

### Rewrite function signatures (the unit-test core)

```ts
interface RewriteContext { proxyOrigin: string; routeId: string; scopes?: string[] }

rewriteChallengeHeader(header: string | undefined, ctx: RewriteContext): { value: string; rewrote: string[] }
rewritePrm(prm: JsonObject, ctx: RewriteContext): { value: JsonObject; rewrote: string[] }
rewriteAsMetadata(as: JsonObject, ctx: RewriteContext & { upstreamHasRevocation: boolean }): { value: JsonObject; rewrote: string[] }
rewriteRegistrationBody(body: JsonObject, ctx: { clientName?: string; scopes?: string[] }): { value: JsonObject; rewrote: string[] }
rewriteAuthorizeQuery(query: URLSearchParams, ctx: { scopes?: string[]; upstreamResource: string }): { value: URLSearchParams; rewrote: string[] }
rewriteTokenBody(form: URLSearchParams, ctx: { scopes?: string[]; upstreamResource: string }): { value: URLSearchParams; rewrote: string[] }
```

Behavior is exactly R1–R6 (including: challenge injection when upstream sent none;
`client_id_metadata_document_supported` deletion; `code_challenge_methods_supported`
preservation; `scope` rewritten in token body only when the field is present; unknown
params/fields pass through). `rewrote` feeds the names-only debug log line.

## Data flow

1. **MCP call**: Claude Code → `/:id/...` → stream pass-through → upstream MCP URL.
   Upstream 401/403(`insufficient_scope`) → challenge header rewritten to point at the
   proxy's PRM (+ configured scope) → Claude Code starts its native discovery.
2. **Discovery**: client fetches proxy PRM (row 2/3) and AS metadata (rows 4–6) — both are
   the cached upstream documents rewritten by `rewritePrm`/`rewriteAsMetadata` (issuer =
   `http://127.0.0.1:<port>/as/<id>`; CIMD flag stripped ⇒ client takes the DCR path).
3. **DCR**: `POST /as/<id>/register` → body rewritten (`client_name`, `scope`) → upstream
   `registration_endpoint` → response relayed verbatim (dynamic `client_id` to client).
4. **Authorize**: `GET /as/<id>/authorize` → query rewritten (`scope`, `resource` → upstream
   canonical) → `302` to upstream `authorization_endpoint`. IdP consent → redirect straight
   to Claude Code's localhost callback (never via proxy).
5. **Token/refresh**: `POST /as/<id>/token` → form rewritten (`resource`, conditional
   `scope`) → upstream `token_endpoint` → relayed verbatim. Proxy stores nothing.

## Error handling

- Config invalid → `ConfigurationError` with key path at startup (CLI prints and exits 1).
- Route discovery failure → route marked `degraded` (negative-cached 10 s), proxy stays up,
  `502` on that route's endpoints, retry on next request. Other routes unaffected.
- Upstream unreachable/TLS failure mid-request → `502 {"error":"upstream_unreachable","route":"<id>"}`;
  `logger.warn` with upstream host only.
- Unknown route/path → `404 {"error":"unknown_route"}`.
- Daemon spawn/stop timeouts → `ToolExecutionError('mcp-auth-proxy-daemon', …)`.
- Body over 64 KB on register/token → `413 {"error":"payload_too_large"}`.

## Testing strategy

Tests are explicitly requested as plan tasks (repo policy satisfied): Vitest, co-located
`src/mcp/auth-proxy/__tests__/`, TDD per task.

- `rewrites.test.ts` — table-driven cases per rule: scope configured/absent, challenge
  present/absent/insufficient_scope, CIMD flag deletion, PKCE field preservation, resource
  restoration, pass-through of unknown fields. Pure functions — no mocks.
- `config.test.ts` — valid example config; each validation failure asserts the offending
  key path in the error message.
- `state.test.ts` — atomic write/read/clear + stale-pid handling (mirror
  `daemon-manager.test.ts`, mocking `getCodemieHome` to a tmpdir).
- `metadata-cache.test.ts` — discovery priority order, TTL + negative cache, first-AS
  warning, missing `registration_endpoint` failure (local `node:http` fixture server).
- `server.test.ts` — route dispatch against a local fake upstream (`node:http`): MCP
  pass-through incl. SSE streaming + abort, 401 challenge rewrite/injection, per-route
  isolation with one degraded upstream (acceptance criterion 7 locally), 64 KB limit,
  `/healthz`, single-route root-PRM alias, loopback-only bind.

## Acceptance mapping

- Criteria 1, 8, 10 — verified in this run (CLI start/status/stop against local config;
  quality gates in Phase 8).
- Criteria 3–7, 9 — logic verified in this run at unit/integration level against fake
  upstream + fixture AS documents (rewrite correctness, isolation, degraded-route
  independence, no-secret logging); full end-to-end against the live EPAM IdP/Claude Code
  session is a manual post-merge step (spec Verification Aids).
- Criterion 2 — structural: the proxy never initiates auth (no browser-open code exists in
  the module; nothing runs at Claude Code startup).

## Non-goals

Unchanged from the spec (CIMD, multi-AS, TLS/non-loopback, token caching, JSON-RPC
rewriting, watcher, Windows service). Additionally out of scope here: changes to the SSO
proxy, `mcp-proxy` stdio bridge, or `daemon-manager.ts`.
