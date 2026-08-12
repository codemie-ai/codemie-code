# Technical Research

**Task**: managed-mcp oauth proxy claude-desktop
**Generated**: 2026-08-11
**Research path**: codegraph

---

## 1. Original Context

This is the new structure of the managed mcp configurations that will be returned by the CodeMie backend.
We need to extend the existing implementation to support this extended structure.
```
[
  {
    "name": "onehub_core",
    "url": "https://codemie.lab.epam.com/mcp/mcp-proxy/onehub_core",
    "transport": "http",
    "oauth": {
      "clientId": "codemie-mcp-proxy",
      "scope": "openid profile email",
      "callbackHost": "localhost",
      "callbackPort": 3118,
      "authorizationUrl": "https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login",
      "tokenUrl": "https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/token"
    }
  },
  {
    "name": "radar",
    "url": "https://codemie.lab.epam.com/mcp/mcp-proxy/radar",
    "transport": "http",
    "oauth": {
      "clientId": "codemie-mcp-proxy",
      "scope": "openid profile email",
      "callbackHost": "localhost",
      "callbackPort": 3118,
      "authorizationUrl": "https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login",
      "tokenUrl": "https://auth.codemie.lab.epam.com/realms/codemie-prod/protocol/openid-connect/token"
    }
  }
]
```
This is your Jira story number: EPMCDME-14072

Known starting points (verified this session): the endpoint is fetched by fetchManagedMcpServers() in src/cli/commands/proxy/connectors/managed-mcp-remote.ts (CanonicalMcpEntry interface + isValidCanonicalEntry + pickCanonicalFields), mapped by mapCanonicalToDesktop() and written by writeDesktopConfig()/reconcileManagedMcpServers() in src/cli/commands/proxy/connectors/desktop.ts, and consumed from src/cli/commands/proxy/index.ts:455-474. Today auth is the enum 'oauth' | 'none' on the canonical entry and a boolean `oauth` on ManagedMcpServerEntry. Research must cover how the extended oauth object should flow through validation, mapping, dedup/reconciliation, the bundled desktop-managed-mcp-servers.json defaults, existing tests, and any other consumer of managed MCP config (e.g. vscode connector, mcp-config utils, mcp-loader) that may need the same treatment.

---

## 2. Codebase Findings

### Existing Implementations

**Fetch + validation (the entry gate for the new shape)**

- `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` — the whole remote contract lives here, 106 lines.
  - `CanonicalMcpEntry` (:12) — `{ name, transport: 'http'|'sse'|'stdio', url?, auth?: 'oauth'|'none', description?, clients? }`.
  - `VALID_NAME` (:7) `/^[a-zA-Z0-9_-]+$/`; `CANONICAL_TRANSPORTS` (:8) `http|sse|stdio`; `CANONICAL_AUTH` (:9) `oauth|none`.
  - `isValidCanonicalEntry` (:21) — type guard. Requires `name` (regex), `transport` (in set), and `url` to be a string (note: `url` is declared optional on the interface but validation *requires* it). Optionals are `null`-tolerant because the FastAPI backend serializes unset optionals as `null`. Unknown keys are **not** rejected, so the new `oauth` object passes validation untouched.
  - `pickCanonicalFields` (:38) — an explicit allowlist projection. It rebuilds the object from `name`/`transport`/`url`/`auth`/`description`/`clients` only, so **the new `oauth` object is silently dropped here today**.
  - `fetchManagedMcpServers` (:56) — `GET {creds.apiUrl}/v1/mcp/managed-servers?client=<client>` via `HTTPClient` (`timeout: 10000`, `maxRetries: 3`, `rejectUnauthorized: false`) with `buildAuthHeaders(creds.cookies)`. Returns `null` on any failure (no creds / non-2xx / throw / non-array body) and `[]` only on an authoritative empty catalog — a distinction the whole revocation design depends on.

**Mapping + write (the exit gate)**

- `src/cli/commands/proxy/connectors/desktop.ts` — 579 lines; the managed-MCP logic is lines 24–29 and 254–578.
  - `ManagedMcpServerEntry` (:24) — `{ name, url, transport?: 'http'|'sse', oauth?: boolean }`. This is the Claude Desktop wire shape.
  - `DESKTOP_SUPPORTED_TRANSPORTS` (:258) — `http|sse` only.
  - `mapCanonicalToDesktop` (:265) — drops non-http/sse transports, missing `url`, invalid names; sets `oauth: entry.auth === 'oauth'`. **With the new payload (no `auth` key at all) this evaluates to `false` for every server.**
  - `reconcileManagedMcpServers` (:298) — identity is name (lower-cased) plus URL (deliberately case-sensitive). Managed entries first, surviving user entries after. Nameless entries are kept unless their URL collides with a managed URL. Entries are shallow-copied via `{ ...s }`.
  - `writeDesktopConfig` (:429) — orchestrator. Dedups the org catalog against the bundled defaults by lower-cased name and exact URL (:488–492), builds `managedSet = defaults + orgDeduped` (:494), does a write-ahead marker union (:510–513), deletes `managedMcpServers`/`coworkEgressAllowedHosts`/`inferenceModels`/`INFERENCE_KEYS` from the existing config, then writes `managedMcpServers: JSON.stringify(managedMcpServers)` (:544) and narrows the marker afterwards (:563–565).
  - `getManagedMcpStatePath` (:337), `readManagedMcpState` (:341), `writeManagedMcpState` (:353) — atomic tmp+rename marker holding **only `managedNames: string[]`**.
  - `getDesktopConfigPath` (:408) / `_meta.json` `appliedId` — the config lives at `configLibrary/<uuid>.json`.
- `src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json` — 7 bundled public defaults (Notion, Linear, Box, Canva, Vercel, Netlify, Miro), each `{"name","url","transport":"http","oauth":true}`. Imported at `desktop.ts:10` with a JSON import attribute and cast to `readonly ManagedMcpServerEntry[]` at `desktop.ts:63`, so **any change to `ManagedMcpServerEntry` immediately type-checks against this file**.

**Consumer**

- `src/cli/commands/proxy/index.ts:455-474` — the only call site. `fetchManagedMcpServers('claude-desktop', state.syncCodeMieUrl)` → `mapCanonicalToDesktop` → `writeDesktopConfig(url, gatewayKey, getDesktopBaseDir(), orgMcpServers)`. Logs `fetchSucceeded`, `canonicalCount`, `mappedCount`, `mappedNames` through `sanitizeLogArgs`. Imports at :21–:22.

**Adjacent MCP code that is NOT on this path (checked, no change required)**

- `src/cli/commands/proxy/connectors/vscode.ts` — VS Code BYOK language-model providers only (`VsCodeManagedModel`, `writeVsCodeLanguageModelsConfig`). No MCP concept at all.
- `src/plugins/loaders/mcp-loader.ts` + `src/plugins/core/types.ts:33` — plugin-supplied MCP servers are stdio-only (`McpServerConfig = { command, args?, env?, cwd? }`). No `url`, no auth.
- `src/utils/mcp-config.ts` (`getMCPConfigSummary`, `readMCPFromSource`, `extractServerNames`) — read-only reporting over agent MCP config files; consumes names, not auth.

**Adjacent MCP OAuth machinery (relevant if the CLI itself must honour the new fields)**

- `src/mcp/auth/mcp-oauth-provider.ts` — `McpOAuthProvider` with `redirectUrl`, `clientMetadata`, `ensureCallbackServer`, `saveClientInformation`, `waitForAuthorizationCode`. Today it relies on dynamic client registration and RFC 8414 discovery — the opposite of the statically-supplied `clientId`/`authorizationUrl`/`tokenUrl`/`callbackPort` in the new payload.
- `src/mcp/stdio-http-bridge.ts` — `StdioHttpBridge` wires that provider into `StreamableHTTPClientTransport`, handling 401 → `finishAuth(code)`.
- `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts` — proxy-side relay (`/mcp_auth`, `/mcp_relay/<root>/<relay>/...`, RFC 8414 well-known rewriting) with a per-flow origin allowlist, TTL sweep, `MAX_MCP_SERVER_ORIGINS` cap and private/loopback SSRF rejection.

### Architecture and Layers Affected

Following the plugin-based 5-layer model in `.ai-run/guides/architecture/architecture.md`:

1. **CLI layer** — `src/cli/commands/proxy/index.ts` (command wiring, the single consumer, structured logging).
2. **Connector layer** — `src/cli/commands/proxy/connectors/desktop.ts` (mapping, dedup, reconciliation, config write) and `managed-mcp-remote.ts` (remote contract + validation). This is where the bulk of the change lands.
3. **Static asset layer** — `desktop-managed-mcp-servers.json`, type-bound to `ManagedMcpServerEntry`.
4. **Local state layer** — `~/.codemie/proxy/desktop-managed-mcp-state.json` via `getCodemiePath` and the Claude Desktop `configLibrary/` tree.
5. **Provider/proxy layer (adjacent)** — `src/providers/plugins/sso/*` for credentials (`CodeMieSSO.getStoredCredentials`, `buildAuthHeaders`, `HTTPClient`) and `mcp-auth.plugin.ts` if managed OAuth traffic ever routes through the local proxy.

### Integration Points

- **CodeMie backend**: `GET {apiUrl}/v1/mcp/managed-servers?client=claude-desktop`. `apiUrl` comes from stored SSO credentials, base path preserved (e.g. `/code-assistant-api`).
- **SSO**: `CodeMieSSO.getStoredCredentials(codeMieUrl)` where `codeMieUrl = daemonState.syncCodeMieUrl`.
- **Shared HTTP**: `HTTPClient.getRaw` + `buildAuthHeaders` (self-signed cert tolerance is deliberate for on-prem).
- **Claude Desktop app**: `configLibrary/<uuid>.json` + `_meta.json` under `Claude-3p` (macOS `~/Library/Application Support`, Windows `%LOCALAPPDATA%`). `managedMcpServers` is written as a **JSON string**, not a nested array.
- **External identity provider** in the new payload: `auth.codemie.lab.epam.com` — a different origin from the MCP server host `codemie.lab.epam.com`.

### Patterns and Conventions

- **Two-stage validation**: structural type guard (`isValidCanonicalEntry`) then allowlist projection (`pickCanonicalFields`). Both must be extended together; extending only the guard leaves the field stripped.
- **Null-tolerant optionals** — backend `null` is treated as absent.
- **Fail-soft fetch** — `null` means "unknown, do not revoke"; `[]` means "authoritatively empty, revoke".
- **Crash-safe marker protocol** — write union before config, narrow after; atomic tmp+rename.
- **Managed vs user ownership** — name/URL collision supersedes user entries; the marker enables later revocation.
- **`@/` path alias, `.js` import extensions, ES modules, explicit export return types, no `any`** (`.ai-run/guides/standards/code-quality.md`).
- **Logging via `logger.info/warn` with `sanitizeLogArgs`**, never raw secrets (`.ai-run/guides/security/security-practices.md`).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer model, `src/mcp/` role (`auth/` = OAuth provider & callback server, `stdio-http-bridge.ts`).
- `.ai-run/guides/integration/external-integrations.md` — provider plugins, SSO, proxy plugins (P1 for this task).
- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions, dynamic-import mocking.
- `.ai-run/guides/security/security-practices.md` — credential handling and log sanitization.
- `.ai-run/guides/standards/code-quality.md`, `.ai-run/guides/quality-gates.md`, `.ai-run/guides/project.md` (Jira EPM-CDME).
- **No guide covers managed MCP servers.** The only MCP doc in `docs/` is `docs/SPEC-mcp-session-metrics.md`, which is about session metrics and unrelated.

### Architectural Decisions

Recorded only as inline comments in the code (there is no ADR directory for this area):

- `managed-mcp-remote.ts:27-28` — backend serializes unset optionals as `null`; treat as absent.
- `managed-mcp-remote.ts:95-96` — a non-array body is a contract violation → `null`, never mistaken for an empty catalog.
- `desktop.ts:307-309` — URL comparison is intentionally case-sensitive because managed entries come from controlled sources.
- `desktop.ts:479-483` — `null` org list must not revoke; a transient backend outage must never strip internal MCPs.
- `desktop.ts:502-509` — write-ahead marker union rationale; `desktop.ts:358-361` — atomic write rationale.

### Derived Conventions

- The canonical (client-neutral) shape and the Desktop (client-specific) shape are deliberately separate types; new backend fields belong on `CanonicalMcpEntry` first and are translated per client in `mapCanonicalToDesktop`.
- Anything Claude Desktop cannot represent is dropped in the mapper, not in the fetcher.
- Bundled defaults and backend entries must remain a single homogeneous array type — the JSON asset is cast to `ManagedMcpServerEntry[]`.

---

## 4. Testing Landscape

### Existing Coverage

- `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts` (130 lines, 11 cases) — endpoint URL + CLI auth headers, `null` optionals accepted, API base-path preservation, missing creds → `null`, non-2xx → `null`, throw → `null`, non-array body → `null`, invalid `auth` value drops the entry, non-string `description`/`clients` drop the entry, malformed JSON → `null`, empty array ≠ `null`.
- `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (634 lines) — `writeDesktopConfig` (config library + `_meta.json` creation, `appliedId` reuse, key preservation, model curation, org MCP write + marker persistence, revocation on the next run, corrupt marker tolerance, `null`-fetch preservation, no duplicate of an echoed public default), `mapCanonicalToDesktop` (2 cases asserting `oauth: true` / `oauth: false`), `reconcileManagedMcpServers` (7 cases, every fixture carries `oauth: true`).
- `src/cli/commands/proxy/__tests__/index.test.ts`, `daemon-manager.test.ts`, `health-check.test.ts`, `watcher.test.ts`, `connectors/__tests__/vscode.test.ts` — adjacent, none exercise the managed-MCP path.
- `src/utils/__tests__/mcp-config.test.ts` — covers `getMCPConfigSummary` (unrelated surface).

### Testing Framework and Patterns

- **Vitest**, `@group unit` docblock header on each file.
- Prototype spies for network/credential seams: `vi.spyOn(CodeMieSSO.prototype, 'getStoredCredentials')`, `vi.spyOn(HTTPClient.prototype, 'getRaw')`, with `vi.restoreAllMocks()` in `afterEach`.
- `globalThis.fetch` stubbed/restored for the gateway model-discovery path.
- `writeDesktopConfig` tests use a **real temp filesystem** (`tmpdir()` + `rm/mkdir/readFile`) and inject `baseDir` and `statePath` as explicit parameters — the seams already exist for new cases.
- `tests/helpers/temp-workspace.ts` (`TempWorkspace`, `createTempWorkspace`) is available for broader fixtures.

### Coverage Gaps

- **No test asserts the new-shape payload at all** — no fixture without an `auth` key, so the silent `oauth: false` downgrade is currently invisible to CI.
- **No test on `src/cli/commands/proxy/index.ts:455-474`** — the fetch → map → write wiring is untested.
- **No schema test for `desktop-managed-mcp-servers.json`** — the bundled defaults are only type-checked, never asserted at runtime.
- Codegraph reports **no covering tests** for `ManagedMcpServerEntry`, `readManagedMcpState`, `writeManagedMcpState` (exercised only indirectly), `mcp-auth.plugin.ts` (`MCPAuthPlugin`/`MCPAuthInterceptor`) and `src/mcp/auth/mcp-oauth-provider.ts` (`McpOAuthProvider`).
- No test covers deep-copy semantics of managed entries (relevant once `oauth` becomes an object).

---

## 5. Configuration and Environment

### Environment Variables

- No env var governs managed MCP. `CODEMIE_DEBUG=true` enables `logger.debug` output.
- `LOCALAPPDATA` / `APPDATA` are read indirectly through `getClaudeDesktopBaseDir()` for the Windows Desktop config path.
- SSO credentials are resolved from the stored credential store keyed by `codeMieUrl`, not from env.

### Configuration Files

- `src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json` — bundled public defaults, `oauth: true` boolean form.
- `~/.codemie/proxy/desktop-managed-mcp-state.json` — CLI-owned marker, `{ managedNames: string[] }` only.
- Claude Desktop `Claude-3p/configLibrary/_meta.json` (`appliedId`, `entries`) and `Claude-3p/configLibrary/<uuid>.json` (holds `managedMcpServers` as a serialized JSON string alongside `inferenceProvider`, `inferenceGateway*`, `inferenceModels`, `coworkEgressAllowedHosts`).
- Daemon state supplies `syncCodeMieUrl`, `syncApiUrl`, `gatewayKey`, `url`; `DEFAULT_DAEMON_PORT = 4001` (`index.ts:28`).

### Feature Flags and Deployment Concerns

- No feature flag exists. Rollout safety depends entirely on validation accepting both the old (`auth`) and the new (`oauth` object) shapes simultaneously.
- The new payload pins `callbackHost: localhost` and `callbackPort: 3118` — a fixed local port the CLI does not currently reserve anywhere (the daemon uses 4001; `McpOAuthProvider.ensureCallbackServer` allocates its own callback server).
- The payload references a pre-registered `clientId` (`codemie-mcp-proxy`) and explicit Keycloak `authorizationUrl`/`tokenUrl`, bypassing dynamic client registration and RFC 8414 discovery.
- Secrets: the new fields are non-secret (public client id, scopes, URLs), but they still pass through `sanitizeLogArgs`-guarded log statements and are persisted to a user-readable Desktop config file.

---

## 6. Risk Indicators

- **Silent auth downgrade (highest severity)**: the new payload has no `auth` key, so `mapCanonicalToDesktop` (`desktop.ts:274`) writes `oauth: false` for every org server. No test catches it.
- **Allowlist strips the new field**: `pickCanonicalFields` (`managed-mcp-remote.ts:38`) rebuilds entries from six known keys, so `oauth` never reaches the mapper even though `isValidCanonicalEntry` accepts it.
- **Unknown target schema**: nothing in the repo documents whether Claude Desktop's `managedMcpServers` accepts an oauth object or only a boolean. Must be verified before choosing the `ManagedMcpServerEntry` shape.
- **Dual-shape rollout**: backend may emit `auth` or `oauth` during transition; `desktop-managed-mcp-servers.json` still uses `oauth: true`.
- **Shallow copies**: `desktop.ts:327` and `:494` use `{ ...s }`, so a nested oauth object would be shared by reference with the `readonly` bundled defaults.
- **Identity is name+URL only**: reconciliation and the `managedNames`-only marker cannot detect an oauth-config-only change (`desktop.ts:298`, `:341`).
- **Cross-origin auth host**: `auth.codemie.lab.epam.com` differs from the MCP origin; `mcp-auth.plugin.ts` only allows origins discovered through the flow, and it has no covering tests.
- **Fixed `callbackPort: 3118`** is unowned by any current code path and may collide with `McpOAuthProvider`'s callback server.
- **Untested wiring**: `index.ts:455-474` and the bundled defaults JSON have no runtime assertions.

---

## 7. Summary for Complexity Assessment

The change is narrow in surface but sharp in behaviour. Exactly four production files carry it — `managed-mcp-remote.ts` (interface, `isValidCanonicalEntry`, `pickCanonicalFields`), `desktop.ts` (`ManagedMcpServerEntry`, `mapCanonicalToDesktop`, `reconcileManagedMcpServers`, `writeDesktopConfig`), the bundled `desktop-managed-mcp-servers.json`, and the logging in `index.ts:455-474` — plus two test files. The VS Code connector, `mcp-loader.ts` and `mcp-config.ts` were checked and are provably off this path, which contains the blast radius to the proxy connector layer.

Technical novelty is moderate. The two-stage validate-then-project pattern and the fail-soft `null`-vs-`[]` contract are already established; the new work is widening a boolean into a structured object across a client-neutral type and a client-specific type, while accepting both the old `auth` enum and the new `oauth` object during rollout. The genuinely open question is external: whether Claude Desktop's `managedMcpServers` schema can represent an oauth object at all, or whether the CLI must instead consume `clientId`/`authorizationUrl`/`tokenUrl`/`callbackPort` itself through `McpOAuthProvider` — which today does dynamic registration and discovery rather than static configuration. That answer changes the design materially and cannot be resolved from this repository.

Test posture is good on the fetcher and reconciler but blind exactly where the regression lives: no fixture omits `auth`, so today's code would silently emit `oauth: false` for every server in the new payload and CI would stay green. Seams for new tests already exist (prototype spies, injectable `baseDir`/`statePath`, temp filesystem). Key risks are the silent auth downgrade, the allowlist that strips unknown fields, shallow-copy aliasing of a nested object against `readonly` bundled defaults, a reconciliation identity that cannot see oauth-only changes, and a cross-origin Keycloak host against the proxy's discovery-scoped origin allowlist.
