# Managed MCP Provisioning — Implementation Summary

Date: 2026-06-24
Branches: `feat/managed-mcp-provisioning` in **both** repos, both off `main` — CLI: `/Users/Vadym_Vlasenko/AI/projects/codemie-code`; backend: `/Users/Vadym_Vlasenko/AI/projects/codemie`.
Commits: none (per repo owner preference — single summary, commit on explicit request).
Spec: `docs/superpowers/specs/2026-06-24-managed-mcp-provisioning-design.md`
Plan: `docs/superpowers/plans/2026-06-24-managed-mcp-provisioning.md`

## What this delivers

`codemie proxy connect desktop` now provisions internal EPAM MCP servers (e.g. `radar`) into Claude Desktop, fetched at runtime from a client-neutral CodeMie backend endpoint. The internal MCP URLs live only in a K8s ConfigMap — never committed to either open-source repo. Public OAuth defaults stay bundled in the CLI as an offline fallback. The mechanism is client-neutral so a future Codex connector reuses the same endpoint with no backend change.

End-to-end flow:

```
connect desktop
  ├─ getCodemiePath/state.syncCodeMieUrl → CodeMie API URL
  ├─ fetchManagedMcpServers('claude-desktop', url)   (cookie SSO; [] on any error — non-fatal)
  │     GET /v1/mcp/managed-servers?client=claude-desktop → canonical entries
  ├─ mapCanonicalToDesktop(...)  → Desktop shape, drops unsupported transports
  └─ writeDesktopConfig(..., orgMcpServers)
        managedSet = public defaults ∪ org internal
        reconcile(existing, managedSet, previouslyManagedNames)  ← revocation
        persist managed-state sidecar BEFORE config write
```

## Cross-repo contract (verified coherent)

Backend `ManagedMcpServer` ⇄ CLI `CanonicalMcpEntry`:
- `name`, `url`, `description`, `clients[]` — identical.
- `transport`: backend emits `http|sse`; CLI accepts `http|sse|stdio` (superset, forward-compat; stdio dropped at the map layer).
- `auth`: `oauth|none` on both. CLI maps `auth === 'oauth'` → Desktop `oauth: true`.

## Backend changes (`codemie` repo)

- `src/codemie/configs/managed_mcp_config.py` (new) — `ManagedMcpServer` pydantic model + `load_managed_mcp_servers(client, base_dir)`. Missing/unreadable/corrupt file → `[]` (never raises; catches `yaml.YAMLError, OSError, UnicodeDecodeError`). Per-entry validation failures skipped. Client filter: no `clients` = all.
- `src/codemie/rest_api/routers/mcp_managed.py` (new) — `GET /v1/mcp/managed-servers?client=` , `dependencies=[Depends(authenticate)]`, `response_model=List[ManagedMcpServer]`.
- `src/codemie/rest_api/main.py` — registered `mcp_managed` in the router import block + `app.include_router(mcp_managed.router)`.
- `config/customer/managed-mcp-servers.example.yaml` (new) — documentation only; the real file is a ConfigMap key, never committed.
- Tests: `tests/codemie/configs/test_managed_mcp_config.py` (12 tests, incl. resilience + example validity), `tests/codemie/rest_api/routers/test_mcp_managed.py` (2 tests).

## CLI changes (`codemie-code` repo)

- `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` (new) — `CanonicalMcpEntry` + `fetchManagedMcpServers(client, codeMieUrl)`. Cookie-based SSO auth via `CodeMieSSO.getStoredCredentials`. Best-effort: returns **`null` on failure** (missing creds / non-ok / throw / non-array / bad JSON) and **`[]` only on a successful empty response** — the two are deliberately distinct (see Revocation). Validates + whitelists fields (incl. `description`/`clients` element types).
- `src/cli/commands/proxy/connectors/desktop.ts` — added `mapCanonicalToDesktop`; replaced `mergeManagedMcpServers` with `reconcileManagedMcpServers` (returns `{servers, managedNames}`); added managed-state sidecar helpers (`getManagedMcpStatePath`, `readManagedMcpState`, `writeManagedMcpState`); `writeDesktopConfig` gained `orgMcpServers` + `managedStatePath` params and now persists the sidecar **before** the config write.
- `src/cli/commands/proxy/index.ts` — `connect desktop` action fetches + maps the org list (guarded on `state.syncCodeMieUrl`) and passes it to `writeDesktopConfig`.
- Tests: `__tests__/managed-mcp-remote.test.ts` (9, incl. null-on-failure vs empty-on-success), extended `__tests__/desktop.test.ts` (35 total — mapper, reconcile incl. revocation/url-collision/nameless-url, writeDesktopConfig org+sidecar+corrupt-state+outage-null+dedup), updated `__tests__/index.test.ts` mocks.

## Revocation mechanism (security-relevant)

A CLI-owned sidecar `~/.codemie/proxy/desktop-managed-mcp-state.json` records the names CodeMie wrote each run. `reconcileManagedMcpServers` drops any existing entry whose name (case-insensitive) is in `previouslyManagedNames ∪ currentManagedNames`, or whose URL matches a managed URL (including nameless entries) — so an MCP removed from the backend is revoked even after Claude Desktop re-stamps it `source: "user"`. Genuine user-added MCPs are preserved. The sidecar is written **before** the Desktop config to avoid an unrevocable-orphan window if the process dies mid-write.

**Outage resilience.** Revocation only happens on a *successful* fetch. `fetchManagedMcpServers` returns `null` on failure vs `[]` on a confirmed-empty catalog; `writeDesktopConfig` receives `orgMcpServers: ManagedMcpServerEntry[] | null`. On `null` (fetch failed / no CodeMie URL) it skips revocation **and** skips the sidecar write, so existing internal MCPs survive a transient CodeMie outage and a later successful run can still revoke. The org list is also de-duplicated against the public defaults before merge, so a backend entry echoing a default name/URL is never written twice.

## Verification status

| Gate | Result |
|---|---|
| CLI `npm run typecheck` | clean |
| CLI `npm run lint` (`{src,tests}/**/*.ts --max-warnings=0`) | clean |
| CLI `npm run build` | success |
| CLI `npx vitest run src/cli/commands/proxy` | 72 passed |
| Backend `pytest tests/codemie/configs/test_managed_mcp_config.py` | 11 passed |
| Backend `pytest tests/codemie/rest_api/routers/test_mcp_managed.py` | 2 passed |

Both backend test files pass in the project's working poetry env (`codemie-MwrrFDvB-py3.12`, codemie editable-installed from `projects/codemie/src`). The router test fully imports `codemie.rest_api.main`, so endpoint registration + auth + serialization are verified end-to-end in the real app (correct 200s, `load_managed_mcp_servers(client=...)` call args, `description: null, clients: null`).

## Operator step (deployment)

Add a `managed-mcp-servers.yaml` key to the existing `codemie-customer-config` ConfigMap (mounted at `/app/config/customer/`). Format = `config/customer/managed-mcp-servers.example.yaml`. No new infra (volume/mount already wired in `deploy-templates/values.yaml`).

## Remaining manual verification (not yet performed)

1. Run `codemie proxy connect desktop --verbose` against a backend serving the endpoint; confirm `managedMcpServers` includes the internal entries + public defaults, and `~/.codemie/proxy/desktop-managed-mcp-state.json` lists the managed names.
2. Restart Claude Desktop and confirm whether it re-stamps managed entries with `source: "user"` (spec §11 open item). The sidecar-based revocation does not depend on a custom field surviving, so it is robust either way — but record the observed behavior.
3. Revocation pass: remove an internal MCP from the ConfigMap, re-run connect, confirm it disappears from the Desktop config.

## Known minor follow-ups (deferred, non-blocking)

- `writeDesktopConfig` now has 5 positional params; consider an options object if it grows.
- `mapCanonicalToDesktop` does not defensively re-filter by `clients` (the backend already filters via `?client=`); a client-side check would harden against backend misconfiguration.
- `CanonicalMcpEntry.url` is typed optional but the validator requires it (forward-compat for a future stdio shape); documented at the validator.
