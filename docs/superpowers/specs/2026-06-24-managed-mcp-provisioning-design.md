# Managed MCP Provisioning for Agent Clients — Design

Date: 2026-06-24
Status: Draft (design approved in brainstorm; pending spec review)
Repos touched: `codemie-code` (CLI, this repo) + `codemie` (backend, Apache-licensed)

## 1. Problem

`codemie proxy connect desktop` configures Claude Desktop (3P) to use the local
CodeMie gateway proxy and writes a `managedMcpServers` list into Desktop's
`configLibrary/<appliedId>.json`. Today that list is a **hardcoded** bundle of
public OAuth MCPs (`src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json`:
Notion, Linear, Box, …).

Internal EPAM MCPs (e.g. `radar` → `https://mcp.epam.com/mcp/radar`) currently
only exist because the user hand-edited their local config. We want internal
MCPs provisioned automatically on connect, **without committing their URLs into
the open-source repositories**, and the mechanism should generalize to other
agent clients (Codex, future) — not just Claude Desktop.

Reference — the real hand-added entry observed in the live config:

```json
{ "transport": "http", "name": "radar", "url": "https://mcp.epam.com/mcp/radar", "oauth": true }
```

Auth is OAuth: Claude Desktop runs the OAuth flow with `mcp.epam.com` itself, so
**no secret/token is written to disk**.

## 2. Goals / Non-goals

Goals:
- Provision internal MCPs into agent clients during `connect`, fetched at runtime
  from CodeMie.
- Internal MCP URLs live only in the deployment (K8s ConfigMap), never in either
  open-source repo.
- A **client-neutral** API so a future Codex connector reuses it with zero
  backend change.
- Best-effort: CodeMie unreachable must not break `connect`.

Non-goals (v1):
- Native Claude Desktop "Bootstrap config URL" (collides with the per-machine
  local-proxy architecture — see §9).
- DB-backed / per-project / per-user entitlement (static config first).
- `stdio` MCPs, and `headers`/`headersHelper` token auth (remote + OAuth only).
- Building the Codex connector (only the extensible contract is in scope).

## 3. Decisions (from brainstorm)

| # | Decision |
|---|---|
| D1 | Delivery: **fetch + merge during `connect`** (not native Bootstrap URL). |
| D2 | Ownership: backend serves **internal-only**; public defaults stay bundled in the CLI repo as offline fallback. Final list = public defaults ∪ fetched internal ∪ surviving user entries. |
| D3 | Backend source: **static config**, not DB. |
| D4 | Storage: **dedicated `managed-mcp-servers.yaml`** file, a new key in the existing `codemie-customer-config` ConfigMap, with its own loader. |
| D5 | API generalization: **canonical list + client-side mapping**. Backend returns client-neutral entries; each CLI connector maps to its client's config format. `?client=` is for targeting/filtering only. |
| D6 | Revocation: **supported in v1** via a managed-entry marker (see §7). Reconciliation strips previously-managed entries each run. |

## 4. Architecture & data flow

```
codemie proxy connect desktop
  ├─ start/verify local proxy daemon (localhost:4001)         [unchanged]
  ├─ getCodemieClient()  → resolves codeMieUrl + SSO token (auto-refresh)
  ├─ GET /v1/mcp/managed-servers?client=claude-desktop        (Bearer SSO)
  │     200 → canonical: [{ name, transport, url, auth, clients? }]
  │     any error / non-200 → [] (logged, NON-FATAL)
  ├─ map canonical → Claude Desktop shape  { name, url, transport, oauth:true }
  └─ writeDesktopConfig(...): reconcile + merge into managedMcpServers,
        then write configLibrary/<appliedId>.json
```

Backend:

```
ConfigMap codemie-customer-config  →  mounted /app/config/customer/
  ├ customer-config.yaml            [existing]
  └ managed-mcp-servers.yaml        [NEW — only in the cluster, not in repo]

GET /v1/mcp/managed-servers?client=<id>   (Depends(authenticate))
  → load + parse managed-mcp-servers.yaml  (→ [] if absent)
  → filter by client (entry.clients includes <id>, or clients omitted = all)
  → return canonical entries
```

## 5. Canonical schema (client-neutral)

```yaml
# managed-mcp-servers.yaml — lives in the codemie-customer-config ConfigMap
servers:
  - name: radar                       # required; [a-zA-Z0-9_-]+
    transport: http                   # http | sse   (stdio: future)
    url: https://mcp.epam.com/mcp/radar
    auth: oauth                       # oauth | none  (header/token: future)
    description: EPAM Radar            # optional
    clients: [claude-desktop, codex]  # optional targeting; omitted = all clients
```

**Remote-only in v1.** The schema (`transport` ∈ {http, sse}, `auth` ∈
{oauth, none}) is shaped for remote OAuth servers — exactly what Claude Desktop
consumes. `stdio` (command/args/env) is a deliberate future schema addition.
Because of this, each connector **filters to the transports its client supports**;
the mapping is not just "reformat" but also "skip what this client can't
represent" (e.g. Codex is historically stdio-first and may not express a remote
HTTP+OAuth server without an `mcp-remote`-style shim). The "client-neutral" claim
is therefore scoped to remote/OAuth servers for v1.

`?client=` filtering is intentionally minimal in v1: accept the param, filter on
the optional `clients` array if present, default to all. No server-side per-client
capability matrix (YAGNI).

## 6. Backend design (`codemie` repo)

The loader/endpoint **code** is committed (Apache-licensed); the **data file**
(`managed-mcp-servers.yaml` with EPAM URLs) exists only in the ConfigMap. Repo may
ship a documented `managed-mcp-servers.example.yaml`.

- **Loader** `src/codemie/configs/managed_mcp_config.py` (new), modeled on
  `customer_config.py` (`src/codemie/configs/customer_config.py`) but with one
  critical difference: **resilient to a missing file** — returns `[]`, never
  raises (unlike `CustomerConfig._validate_components` which requires its file).
  Reads/parses on each request (file is tiny) so ConfigMap edits apply without a
  pod restart. Pydantic model validates entries; malformed entries are dropped +
  logged.
- **Path resolution**: reuse `config.CUSTOMER_CONFIG_DIR`
  (`src/codemie/configs/config.py:81`, default `config/customer`, mounted at
  `/app/config/customer`) → `CUSTOMER_CONFIG_DIR / "managed-mcp-servers.yaml"`.
- **Endpoint** `src/codemie/rest_api/routers/mcp_managed.py` (new), mirroring the
  existing router pattern (`src/codemie/rest_api/routers/metrics.py:28`):
  `APIRouter(prefix="/v1/mcp", tags=["MCP"], dependencies=[Depends(authenticate)])`
  with `GET /managed-servers?client=<id>`. Authenticated so internal URLs are not
  publicly exposed. Register in app startup beside the other routers.

Deployment: no new infra — `extraVolumes`/`extraVolumeMounts` already mount
`codemie-customer-config` at `/app/config/customer`
(`deploy-templates/values.yaml:358-373`). Operators add the new key to the
existing ConfigMap.

## 7. CLI design (`codemie-code` repo)

- **New** `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`:
  - `fetchManagedMcpServers(client: string): Promise<CanonicalMcpEntry[]>`.
  - Auth + base URL + token refresh via **`getCodemieClient()`**
    (`src/utils/sdk-client.ts`) — the same authenticated path
    `syncRegisteredSkills` uses (`src/cli/commands/skills/setup/sync.ts:36`). Do
    **not** hand-roll `fetch` + `getStoredCredentials`. (The SDK call is either a
    new thin `codemie-sdk` resource method or the SDK's generic authenticated
    request — resolved in the plan.)
  - Validates each entry (`name` pattern via `isValidMcpServerName`, allowed
    `transport`/`auth`); drops malformed; returns `[]` on **any** error (logged,
    non-fatal).
- **`desktop.ts`** — `mapCanonicalToDesktop(entry)` →
  `{ name, url, transport, oauth: entry.auth === 'oauth' }`, skipping entries
  whose `transport` Claude Desktop can't use. `writeDesktopConfig` gains an
  `orgMcpServers` (canonical) parameter.
- **`index.ts`** (`connect desktop` action) — after resolving the SSO profile,
  `const org = await fetchManagedMcpServers('claude-desktop')`, map, pass to
  `writeDesktopConfig`.

### Merge + reconciliation (supports revocation — D6)

Today `mergeManagedMcpServers` (`desktop.ts:209`) preserves any existing entry
that doesn't collide (by name/url) with the current managed set. That preserves
user-added MCPs **but also means a managed entry removed from the backend is
never retracted** — it becomes indistinguishable from a user entry and persists
forever. For an internal-MCP security surface, "cannot revoke a compromised MCP"
is unacceptable.

v1 therefore **reconciles by marker**:

1. Tag every CodeMie-written entry with a distinct marker.
2. Each run, strip **all previously-managed** entries (current managed set ∪
   last-applied managed set), then apply the current managed set. User-added
   entries (no marker) are preserved untouched.

Result: additions, updates, **and removals** all propagate; personal MCPs survive.

Marker mechanism — to confirm empirically during implementation (the live config
shows Desktop persists a `"source"` field, but it is unknown whether Desktop
preserves a **custom** value like `"source": "codemie"`):
- **Preferred**: a custom field on the entry (e.g. `source: "codemie"`) if Desktop
  round-trips it unchanged.
- **Fallback** (robust regardless of Desktop's field handling): a CLI-side record
  of last-applied managed names in the daemon state / a sidecar next to the
  config; strip those each run.

### Migration

Once the backend serves `radar`, the user's hand-added `radar` collides on
name/url with the managed entry and is replaced by the managed one — the manual
hack can be deleted.

### Failure behavior

CodeMie unreachable / 401 / timeout ⇒ `fetchManagedMcpServers` returns `[]`;
`connect` still succeeds with **public defaults + user entries**. Only the
internal MCPs are absent until the next successful connect. (Optional future:
cache last-good internal list on disk so internal MCPs survive offline too.)

## 8. Security

- Endpoint is authenticated (`Depends(authenticate)`) so internal MCP URLs are
  not public.
- v1 is OAuth/`none` only — **no tokens written to disk**; Desktop performs the
  OAuth flow. (Static `headers` tokens are out of scope precisely to avoid
  secrets-on-disk; `headersHelper` is the documented future path.)
- Sanitize logs (`sanitizeLogArgs`) for any URL/identifier logging on the CLI
  side, consistent with the existing connector.

## 9. Why not native Bootstrap config URL

Claude Desktop's Bootstrap URL fetches a per-user JSON overlay that **overrides
local settings and becomes read-only**. It can't supply the per-machine local
proxy settings (`inferenceGatewayBaseUrl=http://127.0.0.1:4001`,
`inferenceGatewayApiKey`=per-daemon key) that the CodeMie architecture depends
on, and would lock out user-added MCPs. It also abandons the proxy's telemetry/
conversation capture. Revisit only for an org-wide MDM-managed fleet rollout.

## 10. File-level change list

`codemie` (backend):
- NEW `src/codemie/configs/managed_mcp_config.py` — loader + pydantic models (missing-file-safe).
- NEW `src/codemie/rest_api/routers/mcp_managed.py` — `GET /v1/mcp/managed-servers`.
- Register the router in app startup.
- NEW (docs/example only) `managed-mcp-servers.example.yaml`; real file lives in the ConfigMap.

`codemie-code` (CLI):
- NEW `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` — SDK-based fetch + validation.
- EDIT `src/cli/commands/proxy/connectors/desktop.ts` — canonical→Desktop mapper; reconcile+merge with marker; `orgMcpServers` param on `writeDesktopConfig`.
- EDIT `src/cli/commands/proxy/index.ts` — fetch org list in `connect desktop`, pass through.
- Keep `desktop-managed-mcp-servers.json` (public defaults / offline fallback).

## 11. Open items to verify in implementation

1. Does Claude Desktop round-trip a custom `source` value (marker preferred path)
   or strip it (sidecar fallback)? Determines the §7 marker mechanism.
2. SDK call surface: add a thin `codemie-sdk` resource method vs. a generic
   authenticated request through `getCodemieClient()`.
3. Confirm `?client=` value string for Claude Desktop (`claude-desktop`) and the
   exact router registration site in the backend app.

## 12. Future (out of scope)

- Codex connector (`connect codex`) — maps canonical → `config.toml`
  `[mcp_servers]`; needs `stdio` schema + possibly an `mcp-remote` shim for
  remote servers. No backend change.
- `stdio` transport and `headers`/`headersHelper` token auth in the canonical
  schema.
- Per-project / per-user entitlement and a DB/admin-managed source.
- Offline disk caching of the last-good internal list.
