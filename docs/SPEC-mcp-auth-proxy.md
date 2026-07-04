# Specification: MCP OAuth Rewriting Proxy (`codemie mcp-auth-proxy`)

Status: **Proposed**
Target repo: `codemie-code`
New CLI command: `codemie mcp-auth-proxy`
New module: `src/mcp/auth-proxy/`
Normative reference: [MCP Authorization specification, revision 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)

---

## Overview

A local, transparent HTTP proxy that sits between an MCP client (Claude Code CLI) and one or
more remote MCP servers that implement MCP Authorization (OAuth 2.1). The proxy forwards all
MCP and OAuth traffic unchanged **except** for two surgical rewrites:

1. **`client_name`** in the OAuth 2.0 Dynamic Client Registration (RFC 7591) request body.
2. **`scope`** everywhere the client's requested scopes appear (401 challenge, resource
   metadata, DCR body, authorization request, token request).

This lets Claude Code authenticate against MCP servers whose IdP rejects Claude Code's
default client identity (e.g. scope `claudeai`, client name `Claude Code`) — **without
modifying the MCP servers, without pre-registered clients, and while preserving Claude
Code's native lazy browser-based auth flow** (browser opens only on `/mcp` → authenticate,
never at CLI startup).

## Problem Statement

- We operate remote MCP servers (e.g. `https://mcp.epam.com/mcp/radar`) behind an enterprise
  IdP. They support MCP Authorization over streamable HTTP. **They cannot be modified.**
- Claude Code CLI, added via `claude mcp add --scope local --transport http epam-radar
  https://mcp.epam.com/mcp/radar`, fails OAuth with:
  `Insufficient Scope. The following scopes are not allowed by IDP: claudeai.`
- The IdP additionally rejects the `client_name` Claude Code sends during Dynamic Client
  Registration.
- **Pre-registered clients are not an option** — registration must remain fully dynamic
  (DCR against the real authorization server, per user/session).

### Rejected alternatives (context for future readers)

| Alternative | Why rejected |
|---|---|
| `oauth.scopes` / `oauth.client_id` in Claude Code config | Tested; does not work reliably (known Claude Code bugs: anthropics/claude-code#68853, #26675), and there is no `client_name` override at all. Pre-registration is disallowed anyway. |
| `mcp-remote` npm bridge (`--static-oauth-client-metadata`) | Runs as a stdio server → spawned at Claude Code startup → opens the auth browser tab eagerly on start. Unacceptable UX. |
| Existing `codemie mcp-proxy <url>` stdio bridge (`src/mcp/stdio-http-bridge.ts`) | Same eager-auth problem (auth runs on the first stdio message, i.e. at startup `initialize`), and tokens are memory-only (re-auth every session). |
| Modifying MCP servers / IdP | Out of our control. |

The transparent rewriting proxy is the only architecture that satisfies all constraints:
dynamic registration, untouched servers, rewritten `client_name` + `scope`, and Claude
Code's own on-demand OAuth UX (the proxy is passive; the browser opens only when Claude
Code itself initiates authorization).

## Hard Requirements

These are strict MUSTs; an implementation that violates any of them is incomplete:

1. **Multiple MCP servers concurrently.** A single proxy instance MUST serve two or more
   upstream MCP servers at the same time, each on its own route, usable simultaneously
   from the same Claude Code session. Single-server operation is a degenerate case, not
   the design target. Concretely:
   - per-route `clientName`/`scopes` overrides applied independently — a rewrite for one
     route MUST never leak into another;
   - per-route OAuth discovery, metadata cache, and `/as/<id>/*` endpoints fully isolated
     (route ids namespace every OAuth artifact);
   - concurrent traffic — including simultaneous SSE streams and interleaved OAuth flows
     on different routes — MUST NOT block or corrupt each other;
   - a degraded route (upstream down, discovery failed) MUST NOT affect the other routes.
2. **No server/IdP modification** and **no pre-registered clients** — registration stays
   fully dynamic (DCR) against the real authorization server.
3. **Lazy auth preserved** — the proxy never initiates authorization; a browser opens only
   when Claude Code's own authenticate flow runs.
4. **No token custody** — the proxy stores no tokens, codes, or client credentials.

## Normative Grounding — MCP Authorization spec (revision 2025-11-25)

Source: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>.
Facts the design relies on:

1. **Discovery chain.** Client gets `401` + `WWW-Authenticate: Bearer
   resource_metadata="…"`, fetches the Protected Resource Metadata (PRM, RFC 9728), reads
   `authorization_servers[]`, then fetches Authorization Server (AS) metadata trying
   well-known URLs **in a mandated priority order** (RFC 8414 path-insertion, then OIDC
   path-insertion, then OIDC path-appending). If the `WWW-Authenticate` header is absent,
   the client probes `<origin>/.well-known/oauth-protected-resource[/<mcp-path>]` itself.
2. **Scope selection strategy (client-side, normative).** Priority 1: the `scope` parameter
   in the `WWW-Authenticate` challenge — *"Clients MUST treat the scopes provided in the
   challenge as authoritative."* Priority 2: `scopes_supported` from the PRM. Otherwise:
   omit `scope`. ⇒ **The proxy can steer a compliant client's scope request by rewriting the
   challenge header and PRM** — the authorize/token rewrites below are a defensive backstop.
3. **Client registration priority.** Pre-registered → Client ID Metadata Documents (CIMD) →
   DCR. A client uses CIMD only if AS metadata advertises
   `client_id_metadata_document_supported: true`. With CIMD the AS fetches `client_name`
   from a **client-hosted HTTPS document** (Anthropic's), which we cannot rewrite. ⇒ **The
   proxy MUST strip this flag from the AS metadata it serves** to force the DCR path, where
   `client_name` is a plain JSON field passing through us.
4. **Resource indicators (RFC 8707).** The client MUST send
   `resource=<canonical MCP server URI>` in **both** authorization and token requests, and
   the MCP server MUST validate token audience against its own canonical URI. Since the
   client only knows the *proxy* URL, ⇒ **the proxy MUST rewrite `resource` back to the
   upstream canonical URI** on authorize and token requests, or every issued token is
   rejected upstream.
5. **PKCE.** The client MUST verify `code_challenge_methods_supported` exists in AS
   metadata and refuse to proceed otherwise. ⇒ the proxy MUST preserve this field.
   `code_challenge`/`code_verifier` originate in the client and pass through untouched.
6. **PRM `resource` field.** The client validates that the PRM's `resource` matches the
   server URL it is talking to. ⇒ the proxy's PRM must carry the **proxy** MCP URL, while
   the upstream's PRM `resource` value is what we use for the `resource`-parameter rewrite.
7. **Step-up / insufficient-scope handling.** `403` + `WWW-Authenticate:
   error="insufficient_scope", scope="…"` triggers client re-authorization with the
   challenged scopes. ⇒ the proxy applies the same header rewrite on 403 as on 401.

## Design

### Topology

```
Claude Code                      mcp-auth-proxy (127.0.0.1:<port>)              Upstream
-----------                      -----------------------------------            --------
http://127.0.0.1:42800/radar ──► route "radar" ── MCP pass-through ───────────► https://mcp.epam.com/mcp/radar
                                 /.well-known/oauth-protected-resource/radar    (RS + its real AS, untouched)
                                 /.well-known/oauth-authorization-server/as/radar
                                 /as/radar/register | /authorize | /token ────► real AS endpoints
Browser ───(302 via /as/radar/authorize)───────────────────────────────────────► real IdP consent page
IdP ───(redirect straight to Claude Code's localhost callback; NOT via proxy)──► Claude Code
```

- One proxy instance serves N upstream servers via first-path-segment routing
  (`/radar`, `/xyz`, …). Each route has its own PRM, AS metadata, and `/as/<id>/*` OAuth
  endpoints.
- The proxy is **stateless with respect to auth**: it stores no tokens, no codes, no client
  records. It only caches upstream *metadata* documents (with TTL). Claude Code remains the
  OAuth client of record; its token cache, refresh handling, and `/mcp` authenticate UX are
  untouched.
- The per-route AS issuer is `http://127.0.0.1:<port>/as/<id>` (a path-bearing issuer, so
  the client constructs the three well-known variants listed in Route Map rows 4–6).

### Route Map

| # | Proxy endpoint | Method | Action |
|---|---|---|---|
| 1 | `/<id>` (and any subpath) | ALL | Stream pass-through to upstream MCP URL. Rewrite `WWW-Authenticate` on 401/403 responses (see R1). |
| 2 | `/.well-known/oauth-protected-resource/<id>` | GET | Serve rewritten upstream PRM (see R2). |
| 3 | `/.well-known/oauth-protected-resource` | GET | Only when exactly one route is configured: alias of row 2. Otherwise 404. |
| 4 | `/.well-known/oauth-authorization-server/as/<id>` | GET | Serve rewritten upstream AS metadata (see R3). |
| 5 | `/.well-known/openid-configuration/as/<id>` | GET | Alias of row 4 (OIDC path-insertion variant). |
| 6 | `/as/<id>/.well-known/openid-configuration` | GET | Alias of row 4 (OIDC path-appending variant). |
| 7 | `/as/<id>/register` | POST | Rewrite DCR body (see R4), forward to upstream `registration_endpoint`, relay response verbatim. |
| 8 | `/as/<id>/authorize` | GET | Rewrite query (see R5), `302` to upstream `authorization_endpoint`. |
| 9 | `/as/<id>/token` | POST | Rewrite form body (see R6), forward to upstream `token_endpoint`, relay response verbatim. |
| 10 | `/as/<id>/revoke` | POST | Only if upstream advertises `revocation_endpoint`: forward verbatim. |
| 11 | anything else | ALL | `404` JSON error. |

### Rewrite Rules

**R1 — MCP pass-through (`/<id>`).**
- Forward method, path remainder, query, headers, and body to `<upstreamUrl>`; stream both
  directions **without buffering** (MCP streamable HTTP uses SSE responses and long-lived
  GET streams). Propagate client aborts upstream. Never apply body parsing or compression
  middleware on this route.
- Strip hop-by-hop headers (`Connection`, `Keep-Alive`, `Transfer-Encoding`, `TE`,
  `Upgrade`, `Proxy-*`); set `Host` to the upstream host. Pass `Authorization` and
  `Mcp-Session-Id` through untouched in both directions.
- On upstream `401`, and on `403` whose `WWW-Authenticate` contains
  `error="insufficient_scope"`: rewrite the `WWW-Authenticate` header —
  `resource_metadata` → `http://127.0.0.1:<port>/.well-known/oauth-protected-resource/<id>`;
  if `scopes` is configured for the route, set/inject `scope="<scopes space-joined>"`
  (this is the authoritative scope signal per spec fact 2). Preserve all other challenge
  parameters. If upstream sent no `WWW-Authenticate` at all on a 401, inject one
  (`Bearer resource_metadata="…"` + optional `scope`) so discovery always lands on the proxy.

**R2 — Protected Resource Metadata.**
- Obtain the upstream PRM once per route (probe
  `<upstream-origin>/.well-known/oauth-protected-resource/<upstream-path>`, then the root
  variant; also accept a `resource_metadata` URL captured from a live upstream 401). Cache
  (default TTL 300 s) plus the parsed upstream canonical `resource` value for R5/R6.
- Serve it with: `resource` → `http://127.0.0.1:<port>/<id>` (no trailing slash);
  `authorization_servers` → `["http://127.0.0.1:<port>/as/<id>"]`;
  `scopes_supported` → configured `scopes` (only if configured; else pass through).
  All other fields pass through.
- v1 limitation: if upstream PRM lists multiple authorization servers, use the first and
  log a warning.

**R3 — Authorization Server metadata.**
- Fetch upstream AS metadata from the upstream PRM's first `authorization_servers` issuer,
  trying the spec's well-known variants in priority order. Cache with TTL. Serve for all
  three proxy variants (route-map rows 4–6) with:
  - `issuer` → `http://127.0.0.1:<port>/as/<id>`
  - `authorization_endpoint` → `http://127.0.0.1:<port>/as/<id>/authorize`
  - `token_endpoint` → `http://127.0.0.1:<port>/as/<id>/token`
  - `registration_endpoint` → `http://127.0.0.1:<port>/as/<id>/register` (if upstream lacks
    one, fail route startup — DCR is mandatory for this proxy's purpose)
  - `revocation_endpoint` → `http://127.0.0.1:<port>/as/<id>/revoke` (only if present upstream)
  - **delete `client_id_metadata_document_supported`** (spec fact 3)
  - `scopes_supported` → configured `scopes` (only if configured)
  - `code_challenge_methods_supported` → pass through unchanged (MUST stay present)
  - everything else (grant types, auth methods, JWKS URI, etc.) passes through unchanged.
    Endpoints intentionally NOT proxied (e.g. `jwks_uri`, `userinfo_endpoint`) keep their
    real upstream URLs.

**R4 — Dynamic Client Registration (`POST /as/<id>/register`).**
- Parse the JSON body (limit 64 KB). Apply overrides:
  - `client_name` → configured `clientName` (if configured)
  - `scope` → configured `scopes` space-joined (if configured; inject if absent)
- Everything else (`redirect_uris` — Claude Code's dynamic localhost callback,
  `grant_types`, `response_types`, `token_endpoint_auth_method`, …) passes through
  untouched. Forward to the upstream `registration_endpoint`; relay status + JSON response
  verbatim — the upstream-issued `client_id` flows straight back to Claude Code
  (registration stays fully dynamic).

**R5 — Authorization redirect (`GET /as/<id>/authorize`).**
- Browser-facing. Take the incoming query string and rewrite:
  - `scope` → configured `scopes` space-joined (if configured)
  - `resource` → upstream canonical resource URI (from cached upstream PRM `resource`;
    fallback: configured `upstreamUrl` normalized without trailing slash)
- `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`,
  `response_type`, and unknown params pass through untouched. Respond `302` with
  `Location: <upstream authorization_endpoint>?<rewritten query>`. Never follow the
  redirect server-side; never log the full query (it is not secret, but codes/state later
  in the flow are — keep one uniform rule: query values are never logged).
- The IdP's post-consent redirect goes directly to Claude Code's `redirect_uri`
  (localhost) and never touches the proxy.

**R6 — Token exchange (`POST /as/<id>/token`).**
- Parse `application/x-www-form-urlencoded` body (limit 64 KB). For all grant types
  (`authorization_code`, `refresh_token`):
  - `resource` → upstream canonical resource URI (same source as R5)
  - `scope` → configured `scopes` space-joined (only if the field is present and `scopes`
    is configured)
- `code`, `code_verifier`, `client_id`, `redirect_uri`, `refresh_token` pass through
  untouched. Forward to upstream `token_endpoint`; relay status + body verbatim. **Never
  log request or response bodies on this route.**

### Why this preserves lazy auth

The proxy never initiates anything. The full OAuth choreography (401 → discovery → DCR →
browser → callback → token) is still driven by Claude Code exactly as natively, triggered by
the user's `/mcp` → authenticate action. The proxy is a pure request/response transformer.

## Configuration

File: `<codemieDir>/mcp-auth-proxy.json` (resolve via `getCodemiePath()` from
`src/utils/paths.ts` — never hardcode `~/.codemie`).

```json
{
  "port": 42800,
  "servers": {
    "radar": {
      "upstreamUrl": "https://mcp.epam.com/mcp/radar",
      "clientName": "EPAM Approved MCP Client",
      "scopes": ["openid", "profile", "mcp:access"]
    },
    "other": {
      "upstreamUrl": "https://mcp.epam.com/mcp/other",
      "clientName": "EPAM Approved MCP Client"
    }
  }
}
```

Semantics:
- `port` (optional, default `42800`) — listen port; bind host is always `127.0.0.1`
  (explicit IPv4 loopback, same rationale as `src/bin/proxy-daemon.ts`).
- Route id = object key; must match `^[a-z0-9][a-z0-9-]*$` and not collide with reserved
  prefixes (`as`, `.well-known`).
- `upstreamUrl` (required) — canonical upstream MCP endpoint, `https://` only.
- `clientName` (optional) — DCR `client_name` override. Absent ⇒ pass through.
- `scopes` (optional, non-empty string array) — scope override applied at every point
  listed in R1/R2/R3/R4/R5/R6. Absent ⇒ all scope values pass through untouched.

Validation errors must be reported at startup with the offending key path
(use the project's error classes from `src/utils/errors.ts`, not generic `Error`).

## CLI

```
codemie mcp-auth-proxy start [--config <path>] [--port <n>] [--foreground]
codemie mcp-auth-proxy stop
codemie mcp-auth-proxy status
```

- `start` — default detached daemon following the existing pattern
  (`src/cli/commands/proxy/daemon-manager.ts` + `src/bin/proxy-daemon.ts`): spawn a
  detached entry point `src/bin/mcp-auth-proxy-daemon.ts`, write a state file
  (`<codemieDir>/mcp-auth-proxy.state.json`: pid, port, routes, startedAt), handle
  SIGTERM/SIGINT cleanup. `--foreground` runs in-process (useful for debugging;
  `CODEMIE_DEBUG=true` for verbose logs).
- `status` — read the state file, verify the pid is alive and the port answers a
  `GET /healthz` (proxy serves `{"status":"ok","routes":[…]}`), print per-route upstream
  URL and the effective `claude mcp add` command for each route:
  `claude mcp add --scope local --transport http <id> http://127.0.0.1:<port>/<id>`
- `stop` — SIGTERM the daemon pid, remove the state file.
- On `start`, print the ready-to-copy `claude mcp add` line(s).

No self-healing watcher in v1 (unlike the SSO proxy) — the proxy holds no session state,
so a crash only requires a manual restart; Claude Code re-auth is unaffected because
tokens live in Claude Code.

## Architecture Placement & File Changes

Follows the 5-layer architecture (`.ai-run/guides/architecture/architecture.md`):
`CLI → module core → utils`, no layer skipping, ES modules with `.js` import extensions,
`logger` (never `console.log`), `sanitizeLogArgs()` for anything header/body-adjacent.

| File | Purpose |
|---|---|
| `src/mcp/auth-proxy/types.ts` | `AuthProxyConfig`, `RouteConfig`, cached-metadata types. Explicit exported types, no `any`. |
| `src/mcp/auth-proxy/config.ts` | Load + validate config file. |
| `src/mcp/auth-proxy/metadata-cache.ts` | Upstream PRM/AS-metadata discovery (well-known priority order), TTL cache, upstream canonical `resource` resolution. |
| `src/mcp/auth-proxy/rewrites.ts` | **Pure functions**: `rewriteChallengeHeader`, `rewritePrm`, `rewriteAsMetadata`, `rewriteRegistrationBody`, `rewriteAuthorizeQuery`, `rewriteTokenBody`. No I/O — this is the unit-testable core. |
| `src/mcp/auth-proxy/server.ts` | `McpAuthProxy` class: Node `http` server, route dispatch, streaming pass-through (use `undici`/native fetch with `duplex: 'half'`; no Express on the MCP route). `start(): Promise<{port,url}>`, `stop()`. |
| `src/bin/mcp-auth-proxy-daemon.ts` | Detached daemon entry (mirror `src/bin/proxy-daemon.ts`: parseArgs, state file, signal handling). |
| `src/cli/commands/mcp-auth-proxy.ts` | Commander command (`start`/`stop`/`status`), mirroring `src/cli/commands/mcp-proxy.ts` registration style. |
| `src/index.ts` / CLI registration point | Register the new command where `createMcpProxyCommand()` is registered. |
| `package.json` | Add the daemon bin to the build if entry points are enumerated. |

Naming note: the existing `codemie mcp-proxy` (stdio bridge) is a different tool and must
remain untouched. The new command is `mcp-auth-proxy`; keep the distinction clear in
`--help` texts.

## Error Handling & Logging

- Upstream unreachable / TLS failure on any proxied call → `502` with
  `{"error":"upstream_unreachable","route":"<id>"}`; log at `warn` with the upstream host
  only (no full URLs with queries).
- Unknown route → `404 {"error":"unknown_route"}`.
- Metadata discovery failure for a route → keep the proxy up, mark the route degraded in
  `/healthz`, return `502` on its endpoints; retry discovery on next request (respecting a
  short negative-cache, e.g. 10 s).
- **Never log**: `Authorization` headers, token endpoint bodies (either direction),
  authorization codes, `code_verifier`, query strings on `/as/*` routes. Debug logging must
  go through `logger.debug` + `sanitizeLogArgs`. What MAY be logged: method, route id,
  path, status, duration, and *names* of rewritten fields (e.g. `rewrote: client_name, scope`).

## Security Considerations

- Bind strictly to `127.0.0.1`. Refuse to start with a non-loopback bind (no config option
  for it in v1) — the proxy relays bearer tokens and must never be network-exposed.
- Plain HTTP is acceptable only because of the loopback bind (OAuth 2.1 loopback
  exemption). Claude Code accepts `http://127.0.0.1` MCP URLs.
- The proxy is not a token store: no tokens, codes, or client secrets are persisted or
  cached. Restarting it leaks/loses nothing.
- Body size limits (64 KB) on `/as/<id>/register` and `/as/<id>/token`; no limit on the
  streaming MCP route.
- The spec's confused-deputy warning targets proxies with a *static* downstream client_id;
  this proxy forwards DCR dynamically per client and user consent still happens at the
  real IdP, so it does not apply.
- Scope override is a *rewrite*, not an escalation: the IdP still enforces what it actually
  grants; consent UI shows the overridden client name — this is the intended, authorized
  behavior for our own servers/IdP (EPAM-internal use).

## Non-Goals (v1)

- CIMD support (deliberately disabled via metadata rewrite).
- Multiple `authorization_servers` per upstream (first one wins, warn).
- TLS termination / non-loopback exposure / multi-user or shared deployment.
- Token caching, refresh orchestration, or any OAuth client behavior in the proxy itself.
- Rewriting MCP JSON-RPC payloads (bodies on the MCP route are opaque).
- Self-healing watcher / auto-restart.
- Windows service installation (daemon uses the same detached-spawn approach as the
  existing proxy; platform quirks inherit whatever `daemon-manager.ts` already handles).

## Acceptance Criteria

1. `codemie mcp-auth-proxy start` with the example config; then
   `claude mcp add --scope local --transport http epam-radar http://127.0.0.1:42800/radar`.
2. Starting Claude Code does **not** open a browser.
3. `/mcp` → authenticate for `epam-radar` opens the IdP page: the consent screen shows the
   configured `clientName`, and the authorization request carries exactly the configured
   `scopes` and `resource=https://mcp.epam.com/mcp/radar` (verify via IdP logs or the
   browser URL bar).
4. DCR observed upstream contains the overridden `client_name`; the issued `client_id` is
   dynamic (different per registration).
5. After auth, MCP tools of the upstream server are listable and callable through the
   proxy, including SSE-streamed responses.
6. Token refresh (long session) succeeds through `/as/radar/token` without re-opening a
   browser; no 401 loops.
7. **Multi-server (hard requirement 1):** with at least two routes configured, both are
   added to the same Claude Code session, each authenticates independently (distinct DCR
   registrations, per-route `clientName`/`scopes` visible at the IdP), and tools on both
   are callable concurrently — including while one route's upstream is deliberately
   stopped, which must leave the other route fully functional.
8. `codemie mcp-auth-proxy status` reports healthy routes; `stop` terminates the daemon
   and removes the state file.
9. `CODEMIE_DEBUG=true` logs show rewritten field names but no tokens, codes, verifiers,
   or `/as/*` query strings.
10. `npm run lint`, `npm run typecheck`, `npm run build` pass (zero-warning policy).

## Verification Aids

- The pure functions in `rewrites.ts` are designed for direct unit testing (Vitest,
  per `.ai-run/guides/testing/testing-patterns.md`). Per repo policy, write tests only when
  explicitly requested in the implementation task.
- Manual OAuth-flow tracing: run the proxy in `--foreground` with `CODEMIE_DEBUG=true` and
  use MCP Inspector or Claude Code `/mcp` against `http://127.0.0.1:42800/radar`.
- A canned upstream for local testing can be faked with any MCP server + any OIDC provider
  supporting DCR (e.g. Keycloak dev realm) if the real EPAM upstream is unavailable.

## References

- MCP Authorization spec (2025-11-25): <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>
- RFC 9728 (Protected Resource Metadata), RFC 8414 (AS Metadata), RFC 7591 (DCR),
  RFC 8707 (Resource Indicators), OAuth 2.1 draft-13.
- Claude Code scope/client bugs motivating this work: anthropics/claude-code#7744, #12077,
  #68853, #26675; modelcontextprotocol/modelcontextprotocol#653 (`claudeai` scope).
- In-repo prior art: `src/mcp/stdio-http-bridge.ts` + `src/mcp/auth/mcp-oauth-provider.ts`
  (existing MCP OAuth client, eager-auth stdio bridge — the tool this proxy deliberately
  differs from), `src/bin/proxy-daemon.ts` + `src/cli/commands/proxy/daemon-manager.ts`
  (daemon/state-file pattern to mirror), `docs/ARCHITECTURE-PROXY.md` (SSO proxy design).
