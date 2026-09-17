# EPMCDME-14072 — Structured OAuth config for managed MCP servers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Carry the backend's new structured `oauth` object end-to-end from `GET /v1/mcp/managed-servers` into Claude Desktop's `managedMcpServers`, without downgrading auth, stripping fields, or revoking a tenant's MCP servers on malformed input.

**Architecture:** The CLI stays a courier — Claude Desktop performs the OAuth flow (spec Decision 1). `managed-mcp-remote.ts` (client-neutral layer) owns the `McpOAuthConfig` type, a sanity-gate validator, and the field-preserving projection. `desktop.ts` (client-specific layer) widens its wire type, normalizes all three accepted shapes through one precedence function, deep-clones managed entries so nested oauth objects are never shared with the module-level bundled defaults, and flips dedup precedence so the backend beats a bundled stub. The two-layer split is deliberately kept.

**Tech Stack:** TypeScript (ES modules, `NodeNext`), Node >= 20, Vitest (`unit` project), ESLint (`--max-warnings=0`), npm.

## Global Constraints

- **TDD is mandatory for every task.** Write the failing test, run it, observe RED, then write the minimal production code and observe GREEN. A task whose test was written after its implementation must be redone. This overrides the repository's default "tests only on explicit request" policy for this task only.
- Branch: `EPMCDME-14072_managed-mcp-oauth-config`.
- ES modules only. Every relative/alias import carries the `.js` extension. Use the `@/` alias instead of deep relative paths (`../../..`); same-directory relative imports like `./managed-mcp-remote.js` stay as they are.
- Explicit return types on every exported function. No `any` in production code (`as any` in test files matches existing test style and is acceptable).
- Logging goes through `logger.info` / `logger.warn` with `...sanitizeLogArgs({...})`. Never `console.log` for diagnostics.
- Test files live in `__tests__/` beside the code and start with the `@group unit` docblock header.
- `src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json` **must not change** — `oauth: true` stays valid under the widened union. Do not add oauth objects to it.
- Out of scope, do not touch: `McpOAuthProvider` (`src/mcp/auth/mcp-oauth-provider.ts`), `mcp-auth.plugin.ts`, the SSO proxy origin allowlist, the VS Code connector, `mcp-loader.ts`, `mcp-config.ts`, and the marker state schema (`{ managedNames: string[] }` stays as-is).
- Commit format: `<type>(<scope>): <subject>` with scope `proxy`. The ticket key goes in the commit **body footer**, not the subject (`commitlint.config.cjs` enforces the scope enum).

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` | Client-neutral remote contract: fetch, validate, project | Task 1 (type, `isValidOAuthConfig`, widened `CanonicalMcpEntry`, validation, `pickCanonicalFields`), Task 2 (all-invalid → `null`) |
| `src/cli/commands/proxy/connectors/desktop.ts` | Claude Desktop wire shape, mapping, reconciliation, config write | Task 3 (`ManagedMcpServerEntry`, `resolveDesktopOAuth`), Task 4 (`cloneManagedEntry`), Task 5 (dedup flip), Task 6 (`summarizeManagedOauthShapes`) |
| `src/cli/commands/proxy/index.ts` | CLI wiring + structured logging at the single call site | Task 6 (log the oauth-shape breakdown) |
| `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts` | Fetch/validation coverage | Tasks 1, 2 |
| `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` | Mapping / reconcile / write coverage | Tasks 3, 4, 5, 6 |

**Task order and dependencies:** Task 1 → Task 2 (same module; the drop-count semantics depend on the widened validator). Task 1 → Task 3 (`desktop.ts` imports `McpOAuthConfig` and `isValidOAuthConfig`). Task 3 → Task 4 → Task 5 → Task 6. Tasks 2, 4, 5 and 6 are independent of each other in behavior but are sequenced to avoid edit collisions in the same two files.

**Running tests:** the unit project globs `src/**/*.test.ts`.

```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
```

Add `-t "<test name substring>"` to run a single case.

---

### Task 1: Accept and preserve the structured oauth object in the canonical layer

Widen `CanonicalMcpEntry` with `oauth?: McpOAuthConfig | boolean`, add the exported `isValidOAuthConfig` sanity gate, extend `isValidCanonicalEntry` to enforce it, and make `pickCanonicalFields` copy the whole oauth value instead of dropping it. This is the direct fix for the stripping defect (spec §1–§3).

**Files:**
- Modify: `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:11-45`
- Test: `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `export interface McpOAuthConfig { clientId: string; authorizationUrl: string; tokenUrl: string; scope?: string; callbackHost?: string; callbackPort?: number; [key: string]: unknown; }`
  - `export function isValidOAuthConfig(value: unknown): value is McpOAuthConfig`
  - `CanonicalMcpEntry.oauth?: McpOAuthConfig | boolean`
  - Task 3 imports `McpOAuthConfig` and `isValidOAuthConfig` from `./managed-mcp-remote.js`.

**Test-first: yes** — `managed-mcp-remote.test.ts` › "keeps a structured oauth object intact, including unknown keys" fails RED because `pickCanonicalFields` rebuilds each entry from a six-key allowlist and drops `oauth` entirely, so the returned entry has no `oauth` property.

- [ ] **Step 1: Write the failing tests**

Append these cases inside the existing `describe('fetchManagedMcpServers', ...)` block in `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`, just before its closing `});`:

```ts
  const OAUTH = {
    clientId: 'codemie-mcp-proxy',
    scope: 'openid profile email',
    callbackHost: 'localhost',
    callbackPort: 3118,
    authorizationUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login',
    tokenUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/token',
  };

  it('keeps a structured oauth object intact, including unknown keys', async () => {
    getRawMock.mockResolvedValue(rawOk([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH, audience: 'onehub', pkce: true },
      },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result).toEqual([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH, audience: 'onehub', pkce: true },
      },
    ]);
  });

  it('copies the oauth object rather than aliasing the parsed payload', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');

    expect(result?.[0].oauth).toEqual(OAUTH);
    expect(result?.[0].oauth).not.toBe(OAUTH);
  });

  it('drops entries whose oauth object is missing a required field', async () => {
    const { clientId: _dropClientId, ...noClientId } = OAUTH;
    const { authorizationUrl: _dropAuthUrl, ...noAuthUrl } = OAUTH;
    const { tokenUrl: _dropTokenUrl, ...noTokenUrl } = OAUTH;
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'noclient', transport: 'http', url: 'https://a', oauth: noClientId },
      { name: 'noauthurl', transport: 'http', url: 'https://b', oauth: noAuthUrl },
      { name: 'notokenurl', transport: 'http', url: 'https://c', oauth: noTokenUrl },
      { name: 'blankclient', transport: 'http', url: 'https://d', oauth: { ...OAUTH, clientId: '   ' } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries whose optional oauth fields have the wrong type', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'badport', transport: 'http', url: 'https://a', oauth: { ...OAUTH, callbackPort: 3118.5 } },
      { name: 'zeroport', transport: 'http', url: 'https://b', oauth: { ...OAUTH, callbackPort: 0 } },
      { name: 'hugeport', transport: 'http', url: 'https://c', oauth: { ...OAUTH, callbackPort: 70000 } },
      { name: 'strport', transport: 'http', url: 'https://d', oauth: { ...OAUTH, callbackPort: '3118' } },
      { name: 'badscope', transport: 'http', url: 'https://e', oauth: { ...OAUTH, scope: 42 } },
      { name: 'badhost', transport: 'http', url: 'https://f', oauth: { ...OAUTH, callbackHost: [] } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('drops entries whose oauth is an array or a non-object scalar', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'ok', transport: 'http', url: 'https://ok', oauth: OAUTH },
      { name: 'arr', transport: 'http', url: 'https://a', oauth: [OAUTH] },
      { name: 'str', transport: 'http', url: 'https://b', oauth: 'oauth' },
      { name: 'num', transport: 'http', url: 'https://c', oauth: 1 },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result?.map((e) => e.name)).toEqual(['ok']);
  });

  it('accepts the boolean oauth shape and treats oauth: null as absent', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'flagtrue', transport: 'http', url: 'https://a', oauth: true },
      { name: 'flagfalse', transport: 'http', url: 'https://b', oauth: false },
      { name: 'nulled', transport: 'http', url: 'https://c', oauth: null },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([
      { name: 'flagtrue', transport: 'http', url: 'https://a', oauth: true },
      { name: 'flagfalse', transport: 'http', url: 'https://b', oauth: false },
      { name: 'nulled', transport: 'http', url: 'https://c' },
    ]);
  });

  it('still accepts the legacy auth enum alongside the new shape', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'legacy', transport: 'http', url: 'https://a', auth: 'oauth' },
      { name: 'modern', transport: 'http', url: 'https://b', oauth: OAUTH },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([
      { name: 'legacy', transport: 'http', url: 'https://a', auth: 'oauth' },
      { name: 'modern', transport: 'http', url: 'https://b', oauth: OAUTH },
    ]);
  });
```

Add a direct unit block for the validator at the end of the file, after the closing `});` of `describe('fetchManagedMcpServers', ...)`:

```ts
describe('isValidOAuthConfig', () => {
  const VALID = {
    clientId: 'codemie-mcp-proxy',
    authorizationUrl: 'https://auth.codemie.test/auth',
    tokenUrl: 'https://auth.codemie.test/token',
  };

  it('accepts the minimal required set', () => {
    expect(isValidOAuthConfig(VALID)).toBe(true);
  });

  it('accepts optional fields with correct types and unknown extra keys', () => {
    expect(isValidOAuthConfig({
      ...VALID,
      scope: 'openid profile email',
      callbackHost: 'localhost',
      callbackPort: 3118,
      somethingNew: { nested: true },
    })).toBe(true);
  });

  it('rejects null, arrays, scalars and booleans', () => {
    expect(isValidOAuthConfig(null)).toBe(false);
    expect(isValidOAuthConfig([VALID])).toBe(false);
    expect(isValidOAuthConfig('oauth')).toBe(false);
    expect(isValidOAuthConfig(true)).toBe(false);
    expect(isValidOAuthConfig(undefined)).toBe(false);
  });

  it('rejects a callbackPort outside 1..65535 or non-integer', () => {
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 0 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 65536 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 3118.5 })).toBe(false);
    expect(isValidOAuthConfig({ ...VALID, callbackPort: 3118 })).toBe(true);
  });
});
```

Extend the import at the top of the file (line 8) so the new symbol is available:

```ts
import { fetchManagedMcpServers, isValidOAuthConfig } from '../managed-mcp-remote.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
```
Expected: FAIL. `isValidOAuthConfig` is `undefined` (`TypeError: isValidOAuthConfig is not a function`) and the "keeps a structured oauth object intact" case fails with the received entry missing its `oauth` key.

- [ ] **Step 3: Write the minimal implementation**

In `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`, replace lines 11–45 (the `CanonicalMcpEntry` interface, `isValidCanonicalEntry` and `pickCanonicalFields`) with:

```ts
/**
 * OAuth client configuration supplied by the backend for a managed MCP server.
 *
 * The CLI never performs the OAuth flow itself — it forwards this object to the
 * client (Claude Desktop), which owns the flow. The index signature is
 * deliberate: unknown backend keys (a future `audience`, `resource`, `pkce`, …)
 * must survive to the client without a CLI release.
 */
export interface McpOAuthConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope?: string;
  callbackHost?: string;
  callbackPort?: number;
  [key: string]: unknown;
}

/** Client-neutral MCP entry returned by GET /v1/mcp/managed-servers. */
export interface CanonicalMcpEntry {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  /** Legacy flag retained for the rollout window; superseded by `oauth`. */
  auth?: 'oauth' | 'none';
  oauth?: McpOAuthConfig | boolean;
  description?: string;
  clients?: string[];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Sanity-gate an oauth object: require the fields the client cannot run a flow
 * without, type-check the optional ones, and let every unknown key through
 * untouched. This is deliberately not an allowlist.
 */
export function isValidOAuthConfig(value: unknown): value is McpOAuthConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  if (!isNonEmptyString(o.clientId)) return false;
  if (!isNonEmptyString(o.authorizationUrl)) return false;
  if (!isNonEmptyString(o.tokenUrl)) return false;
  if (o.scope !== undefined && o.scope !== null && typeof o.scope !== 'string') return false;
  if (o.callbackHost !== undefined && o.callbackHost !== null && typeof o.callbackHost !== 'string') return false;
  if (o.callbackPort !== undefined && o.callbackPort !== null) {
    if (typeof o.callbackPort !== 'number' || !Number.isInteger(o.callbackPort)) return false;
    if (o.callbackPort < 1 || o.callbackPort > 65535) return false;
  }
  return true;
}

function isValidCanonicalEntry(value: unknown): value is CanonicalMcpEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  if (typeof e.name !== 'string' || !VALID_NAME.test(e.name)) return false;
  if (typeof e.transport !== 'string' || !CANONICAL_TRANSPORTS.has(e.transport)) return false;
  if (typeof e.url !== 'string') return false;
  // Optional fields: the backend (FastAPI response_model) serializes unset
  // optionals as `null`, so treat null the same as undefined ("absent").
  if (e.auth !== undefined && e.auth !== null && (typeof e.auth !== 'string' || !CANONICAL_AUTH.has(e.auth))) return false;
  // `oauth` accepts a boolean flag or a structured config object. A malformed
  // object invalidates the WHOLE entry: forwarding half a client configuration
  // would make the client fail the flow with no diagnosis.
  if (e.oauth !== undefined && e.oauth !== null) {
    if (typeof e.oauth === 'object') {
      if (!isValidOAuthConfig(e.oauth)) return false;
    } else if (typeof e.oauth !== 'boolean') {
      return false;
    }
  }
  if (e.description !== undefined && e.description !== null && typeof e.description !== 'string') return false;
  if (
    e.clients !== undefined && e.clients !== null &&
    (!Array.isArray(e.clients) || !e.clients.every((c) => typeof c === 'string'))
  ) return false;
  return true;
}

function pickCanonicalFields(e: CanonicalMcpEntry): CanonicalMcpEntry {
  const out: CanonicalMcpEntry = { name: e.name, transport: e.transport };
  if (e.url !== undefined && e.url !== null) out.url = e.url;
  if (e.auth !== undefined && e.auth !== null) out.auth = e.auth;
  // Copy the oauth value wholesale instead of rebuilding it from known keys:
  // that is what lets a future backend field reach the client without a CLI
  // release. The shallow copy detaches it from the parsed response payload.
  if (e.oauth !== undefined && e.oauth !== null) {
    out.oauth = typeof e.oauth === 'object' ? { ...e.oauth } : e.oauth;
  }
  if (e.description !== undefined && e.description !== null) out.description = e.description;
  if (Array.isArray(e.clients)) out.clients = e.clients;
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
npm run typecheck
```
Expected: all tests PASS (including the 11 pre-existing cases) and `typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/managed-mcp-remote.ts \
        src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
git commit -m "feat(proxy): accept and preserve structured MCP oauth config

Widen CanonicalMcpEntry.oauth to McpOAuthConfig | boolean, add the
isValidOAuthConfig sanity gate and stop pickCanonicalFields from
stripping the object. Unknown oauth keys now survive to the client.

Refs: EPMCDME-14072"
```

---

### Task 2: Never revoke on an all-invalid catalog

A backend bug emitting malformed oauth objects would drop every entry and make `fetchManagedMcpServers` return `[]` — which `writeDesktopConfig` reads as an authoritative empty catalog and uses to revoke the tenant's org MCPs. Return `null` (failure) instead when the raw array was non-empty but nothing survived validation, and log the drop count (spec §7).

**Files:**
- Modify: `src/cli/commands/proxy/connectors/managed-mcp-remote.ts:98` (the `return json.filter(...).map(...)` line inside `fetchManagedMcpServers`)
- Test: `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`

**Interfaces:**
- Consumes: `isValidCanonicalEntry` / `pickCanonicalFields` behavior from Task 1.
- Produces: no new exports. `fetchManagedMcpServers` keeps its signature `(client: string, codeMieUrl: string) => Promise<CanonicalMcpEntry[] | null>`; only the all-invalid case changes from `[]` to `null`.

**Test-first: yes** — `managed-mcp-remote.test.ts` › "returns null when the backend sent entries but none survived validation" fails RED because today `json.filter(isValidCanonicalEntry)` yields `[]` and that `[]` is returned verbatim.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('fetchManagedMcpServers', ...)` in `src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts`:

```ts
  it('returns null when the backend sent entries but none survived validation', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'broken1', transport: 'http', url: 'https://a', oauth: { clientId: 'x' } },
      { name: 'broken2', transport: 'http', url: 'https://b', oauth: { clientId: 'y' } },
    ]));

    // An authoritative "[]" would revoke the tenant's org MCP servers; a backend
    // bug must look like a failure instead.
    expect(await fetchManagedMcpServers('claude-desktop', 'https://codemie.test')).toBeNull();
  });

  it('returns the valid subset when only some entries are invalid', async () => {
    getRawMock.mockResolvedValue(rawOk([
      { name: 'good', transport: 'http', url: 'https://good', oauth: true },
      { name: 'broken', transport: 'http', url: 'https://bad', oauth: { clientId: 'x' } },
    ]));

    const result = await fetchManagedMcpServers('claude-desktop', 'https://codemie.test');
    expect(result).toEqual([{ name: 'good', transport: 'http', url: 'https://good', oauth: true }]);
  });
```

The pre-existing case "returns an empty array (not null) on a successful empty response" (line 126) already pins the genuinely-empty contract — do not modify it.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts -t "none survived validation"
```
Expected: FAIL with `expected [] to be null`.

- [ ] **Step 3: Write the minimal implementation**

In `src/cli/commands/proxy/connectors/managed-mcp-remote.ts`, replace line 98 (`return json.filter(isValidCanonicalEntry).map(pickCanonicalFields);`) with:

```ts
    const valid = json.filter(isValidCanonicalEntry).map(pickCanonicalFields);
    const dropped = json.length - valid.length;
    if (dropped > 0) {
      logger.warn(
        '[proxy] Managed MCP entries dropped by validation',
        ...sanitizeLogArgs({ received: json.length, kept: valid.length, dropped }),
      );
    }
    // A non-empty payload where NOTHING survived is a backend contract failure,
    // not an authoritative empty catalog. Returning [] here would make
    // writeDesktopConfig revoke every org MCP server the tenant has.
    if (json.length > 0 && valid.length === 0) return null;
    return valid;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
```
Expected: all cases PASS, including "returns an empty array (not null) on a successful empty response".

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/managed-mcp-remote.ts \
        src/cli/commands/proxy/connectors/__tests__/managed-mcp-remote.test.ts
git commit -m "fix(proxy): treat an all-invalid MCP catalog as a fetch failure

A non-empty payload where every entry fails validation now returns null
instead of [], so a backend serialization bug can no longer revoke a
tenant's managed MCP servers. Drop counts are logged.

Refs: EPMCDME-14072"
```

---

### Task 3: Resolve every accepted oauth shape into the Desktop entry

Widen `ManagedMcpServerEntry.oauth` and route `mapCanonicalToDesktop` through a single `resolveDesktopOAuth` precedence function, so an entry carrying the new object is forwarded intact and a legacy `auth: 'oauth'` entry still yields `true`. This is the direct fix for the silent auth downgrade (spec §4, acceptance criteria 1–4).

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:11` (import), `:24-29` (`ManagedMcpServerEntry`), `:260-278` (`mapCanonicalToDesktop`)
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- Consumes: `McpOAuthConfig` (type) and `isValidOAuthConfig` (value) from `./managed-mcp-remote.js` (Task 1).
- Produces:
  - `ManagedMcpServerEntry.oauth?: McpOAuthConfig | boolean`
  - `export function resolveDesktopOAuth(entry: CanonicalMcpEntry): McpOAuthConfig | boolean` — used by `mapCanonicalToDesktop` and exercised directly by tests.

**Test-first: yes** — `desktop.test.ts` › "forwards a structured oauth object to the Desktop entry" fails RED because `mapCanonicalToDesktop` computes `oauth: entry.auth === 'oauth'`, so an entry with no `auth` key resolves to `oauth: false` and the object is lost.

- [ ] **Step 1: Write the failing tests**

Add the shared fixture near the top of `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`, right after the `MODEL_LIST_RESPONSE` constant (line 40):

```ts
// Mirrors the backend's structured oauth payload for EPMCDME-14072.
const OAUTH_CONFIG = {
  clientId: 'codemie-mcp-proxy',
  scope: 'openid profile email',
  callbackHost: 'localhost',
  callbackPort: 3118,
  authorizationUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/auth?kc_idp_hint=epam-oidc&prompt=login',
  tokenUrl: 'https://auth.codemie.test/realms/codemie-prod/protocol/openid-connect/token',
};
```

Add the precedence-table block after the existing `describe('mapCanonicalToDesktop', ...)` block (which ends at line 537):

```ts
describe('resolveDesktopOAuth', () => {
  it('forwards a valid oauth object as a copy', () => {
    const entry = { name: 'onehub_core', transport: 'http' as const, url: 'https://x', oauth: OAUTH_CONFIG };
    const resolved = resolveDesktopOAuth(entry);
    expect(resolved).toEqual(OAUTH_CONFIG);
    expect(resolved).not.toBe(OAUTH_CONFIG);
  });

  it('preserves unknown keys inside the oauth object', () => {
    const oauth = { ...OAUTH_CONFIG, audience: 'onehub', pkce: true };
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth })).toEqual(oauth);
  });

  it('passes the boolean shapes through unchanged', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: true })).toBe(true);
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', oauth: false })).toBe(false);
  });

  it('falls back to the legacy auth enum', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', auth: 'oauth' })).toBe(true);
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x', auth: 'none' })).toBe(false);
  });

  it('prefers the oauth object over the legacy enum when both are present', () => {
    expect(resolveDesktopOAuth({
      name: 'a', transport: 'http', url: 'https://x', auth: 'none', oauth: OAUTH_CONFIG,
    })).toEqual(OAUTH_CONFIG);
  });

  it('returns false when the entry carries neither field (unchanged behavior)', () => {
    expect(resolveDesktopOAuth({ name: 'a', transport: 'http', url: 'https://x' })).toBe(false);
  });
});
```

Add these cases inside the existing `describe('mapCanonicalToDesktop', ...)` block (before its closing `});` at line 537):

```ts
  it('forwards a structured oauth object to the Desktop entry', () => {
    const result = mapCanonicalToDesktop([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH_CONFIG },
    ]);
    expect(result).toEqual([
      {
        name: 'onehub_core',
        url: 'https://mcp.example.com/mcp/onehub_core',
        transport: 'http',
        oauth: OAUTH_CONFIG,
      },
    ]);
  });

  it('never writes oauth: false for an entry that supplied oauth config', () => {
    const [mapped] = mapCanonicalToDesktop([
      { name: 'onehub_core', transport: 'http', url: 'https://mcp.example.com/mcp/onehub_core', oauth: OAUTH_CONFIG },
    ]);
    expect(mapped.oauth).not.toBe(false);
  });
```

Add the end-to-end write assertion inside `describe('writeDesktopConfig', ...)` (before its closing `});` at line 514):

```ts
  it('writes a structured oauth object into managedMcpServers intact', async () => {
    const org = mapCanonicalToDesktop([
      {
        name: 'onehub_core',
        transport: 'http',
        url: 'https://mcp.example.com/mcp/onehub_core',
        oauth: { ...OAUTH_CONFIG, audience: 'onehub' },
      },
    ]);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const onehub = servers.find((s: any) => s.name === 'onehub_core');
    expect(onehub.oauth).toEqual({ ...OAUTH_CONFIG, audience: 'onehub' });
  });

  it('writes oauth: true for a legacy auth enum entry', async () => {
    const org = mapCanonicalToDesktop([
      { name: 'legacy', transport: 'http', url: 'https://mcp.example.com/mcp/legacy', auth: 'oauth' },
    ]);
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.find((s: any) => s.name === 'legacy').oauth).toBe(true);
  });
```

Extend the import block at the top of the test file (lines 11–22) to include the new export:

```ts
import {
  buildGatewayConfig,
  fetchClaudeModels,
  getDesktopBaseDir,
  getDesktopConfigPath,
  getManagedMcpStatePath,
  mapCanonicalToDesktop,
  reconcileManagedMcpServers,
  resolveDesktopOAuth,
  selectDesktopClaudeModels,
  selectPreferredClaudeModels,
  writeDesktopConfig,
} from '../desktop.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
```
Expected: FAIL. `resolveDesktopOAuth is not a function` in the new describe block, and "forwards a structured oauth object to the Desktop entry" reports the received entry as `oauth: false`.

- [ ] **Step 3: Write the minimal implementation**

3a. In `src/cli/commands/proxy/connectors/desktop.ts`, replace the type-only import on line 11 with a value+type import:

```ts
import { isValidOAuthConfig, type CanonicalMcpEntry, type McpOAuthConfig } from './managed-mcp-remote.js';
```

3b. Replace `ManagedMcpServerEntry` (lines 24–29) with:

```ts
export interface ManagedMcpServerEntry {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  /**
   * `true`/`false` is the legacy flag Claude Desktop already understood; an
   * {@link McpOAuthConfig} is the structured client configuration the backend
   * now supplies. The CLI forwards it verbatim — Desktop runs the flow.
   */
  oauth?: McpOAuthConfig | boolean;
}
```

3c. Replace `mapCanonicalToDesktop` (lines 260–278) with the resolver plus the updated mapper:

```ts
/**
 * Normalize the three accepted auth shapes into what Claude Desktop consumes.
 *
 * Precedence: a valid oauth object wins, then the oauth boolean, then the
 * legacy `auth` enum, then `false`. The final fallback preserves the behavior
 * of entries carrying neither field.
 */
export function resolveDesktopOAuth(entry: CanonicalMcpEntry): McpOAuthConfig | boolean {
  if (isValidOAuthConfig(entry.oauth)) return { ...entry.oauth };
  if (entry.oauth === true) return true;
  if (entry.oauth === false) return false;
  if (entry.auth === 'oauth') return true;
  if (entry.auth === 'none') return false;
  return false;
}

/**
 * Map client-neutral canonical entries to Claude Desktop's managedMcpServers
 * shape. Drops entries Desktop cannot represent (non-http/sse transports,
 * missing URL, or invalid name).
 */
export function mapCanonicalToDesktop(entries: CanonicalMcpEntry[]): ManagedMcpServerEntry[] {
  const result: ManagedMcpServerEntry[] = [];
  for (const entry of entries) {
    if (!DESKTOP_SUPPORTED_TRANSPORTS.has(entry.transport)) continue;
    if (!entry.url || !isValidMcpServerName(entry.name)) continue;
    result.push({
      name: entry.name,
      url: entry.url,
      transport: entry.transport as 'http' | 'sse',
      oauth: resolveDesktopOAuth(entry),
    });
  }
  return result;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
npm run typecheck
```
Expected: all cases PASS — including the pre-existing "maps remote oauth/none entries and sets the oauth boolean" — and `typecheck` exits 0 (the bundled JSON's `oauth: true` still satisfies the widened union).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/desktop.ts \
        src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
git commit -m "fix(proxy): stop downgrading managed MCP auth to oauth: false

mapCanonicalToDesktop now resolves the structured oauth object, the
oauth boolean and the legacy auth enum through one precedence function,
so a backend entry carrying OAuth config reaches Claude Desktop intact.

Refs: EPMCDME-14072"
```

---

### Task 4: Deep-clone managed entries so nested oauth objects are never shared

`{ ...s }` is a shallow copy, so a nested oauth object would be shared by reference with `DEFAULT_MANAGED_MCP_SERVERS` — a module-level, process-lifetime constant. Add `cloneManagedEntry` and use it at both copy sites (spec §6).

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:327` (inside `reconcileManagedMcpServers`), `:494` (the `managedSet` construction in `writeDesktopConfig`)
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- Consumes: `ManagedMcpServerEntry.oauth?: McpOAuthConfig | boolean` (Task 3).
- Produces: `export function cloneManagedEntry(entry: ManagedMcpServerEntry): ManagedMcpServerEntry` — Task 5 reuses it when rebuilding `managedSet`.

**Test-first: yes** — `desktop.test.ts` › "does not alias the nested oauth object of a managed entry" fails RED because `reconcileManagedMcpServers` copies with `{ ...s }`, so mutating `servers[0].oauth.clientId` also mutates the input entry's oauth object.

- [ ] **Step 1: Write the failing tests**

Add to the existing `describe('reconcileManagedMcpServers', ...)` block in `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (before its closing `});`):

```ts
  it('does not alias the nested oauth object of a managed entry', () => {
    const managed = [
      { name: 'onehub_core', url: 'https://mcp.example.com/mcp/onehub_core', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const { servers } = reconcileManagedMcpServers([], managed);

    (servers[0] as any).oauth.clientId = 'mutated';

    // DEFAULT_MANAGED_MCP_SERVERS is a process-lifetime constant; sharing a
    // nested object with it would corrupt every later run in the process.
    expect(managed[0].oauth.clientId).toBe('codemie-mcp-proxy');
  });
```

Add a direct block for the helper after the `describe('reconcileManagedMcpServers', ...)` block:

```ts
describe('cloneManagedEntry', () => {
  it('copies the nested oauth object rather than sharing it', () => {
    const entry = { name: 'a', url: 'https://x', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } };
    const copy = cloneManagedEntry(entry);

    expect(copy).toEqual(entry);
    expect(copy.oauth).not.toBe(entry.oauth);
  });

  it('leaves a boolean oauth flag as-is', () => {
    const entry = { name: 'Notion', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: true };
    expect(cloneManagedEntry(entry)).toEqual(entry);
  });

  it('handles an entry with no oauth field', () => {
    const entry = { name: 'a', url: 'https://x' };
    const copy = cloneManagedEntry(entry);
    expect(copy).toEqual(entry);
    expect(copy).not.toBe(entry);
  });
});
```

Add `cloneManagedEntry` to the import block at the top of the test file (alphabetically, after `buildGatewayConfig`):

```ts
import {
  buildGatewayConfig,
  cloneManagedEntry,
  fetchClaudeModels,
  getDesktopBaseDir,
  getDesktopConfigPath,
  getManagedMcpStatePath,
  mapCanonicalToDesktop,
  reconcileManagedMcpServers,
  resolveDesktopOAuth,
  selectDesktopClaudeModels,
  selectPreferredClaudeModels,
  writeDesktopConfig,
} from '../desktop.js';
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t "alias"
```
Expected: FAIL with `expected 'mutated' to be 'codemie-mcp-proxy'`, plus `cloneManagedEntry is not a function` in the new describe block.

- [ ] **Step 3: Write the minimal implementation**

3a. In `src/cli/commands/proxy/connectors/desktop.ts`, add the helper immediately after `mapCanonicalToDesktop` (before `export interface ReconcileResult`):

```ts
/**
 * Copy a managed entry, including its nested oauth object.
 *
 * A shallow `{ ...entry }` would share the oauth object with
 * DEFAULT_MANAGED_MCP_SERVERS — a readonly module-level constant that lives for
 * the whole process — so a later mutation of the written config would corrupt
 * the bundled defaults for every subsequent run.
 */
export function cloneManagedEntry(entry: ManagedMcpServerEntry): ManagedMcpServerEntry {
  const copy: ManagedMcpServerEntry = { ...entry };
  if (entry.oauth !== undefined && typeof entry.oauth === 'object') {
    copy.oauth = { ...entry.oauth };
  }
  return copy;
}
```

3b. In `reconcileManagedMcpServers`, replace line 327 (`servers: [...managed.map((s) => ({ ...s })), ...filtered],`) with:

```ts
    servers: [...managed.map(cloneManagedEntry), ...filtered],
```

3c. In `writeDesktopConfig`, replace line 494 (`const managedSet = [...DEFAULT_MANAGED_MCP_SERVERS.map((s) => ({ ...s })), ...orgDeduped];`) with:

```ts
  const managedSet = [...DEFAULT_MANAGED_MCP_SERVERS.map(cloneManagedEntry), ...orgDeduped];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
```
Expected: all cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/desktop.ts \
        src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
git commit -m "fix(proxy): deep-copy managed MCP entries with nested oauth config

cloneManagedEntry replaces the two shallow spreads so a structured oauth
object is never shared by reference with the process-lifetime bundled
defaults constant.

Refs: EPMCDME-14072"
```

---

### Task 5: Let the backend entry win a collision with a bundled default

Today a backend entry colliding with a bundled default by name or URL is discarded and the static stub survives — which now means a real OAuth client configuration loses to `oauth: true`. Invert the filter so the defaults are deduped against the backend catalog (spec §5, acceptance criterion 5).

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts:486-494` (the dedup block inside `writeDesktopConfig`)
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- Consumes: `cloneManagedEntry` (Task 4), `ManagedMcpServerEntry` (Task 3).
- Produces: no new exports. `writeDesktopConfig` keeps its signature `(proxyUrl: string, gatewayKey: string, baseDir?: string, orgMcpServers?: ManagedMcpServerEntry[] | null, managedStatePath?: string) => Promise<string>`.

**Test-first: yes** — `desktop.test.ts` › "lets a backend entry replace the bundled default it collides with by name" fails RED because the current filter drops the backend `Notion` entry and writes the bundled stub's `oauth: true` and `https://mcp.notion.com/mcp` URL.

- [ ] **Step 1: Write the failing tests**

Add inside `describe('writeDesktopConfig', ...)` in `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts` (before its closing `});`):

```ts
  it('lets a backend entry replace the bundled default it collides with by name', async () => {
    const org = [
      { name: 'notion', url: 'https://mcp.internal.test/mcp/notion', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const notion = servers.filter((s: any) => s.name.toLowerCase() === 'notion');
    expect(notion).toHaveLength(1);
    expect(notion[0].url).toBe('https://mcp.internal.test/mcp/notion');
    expect(notion[0].oauth).toEqual(OAUTH_CONFIG);
  });

  it('lets a backend entry replace the bundled default it collides with by url', async () => {
    const org = [
      { name: 'notion_internal', url: 'https://mcp.notion.com/mcp', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    expect(servers.filter((s: any) => s.url === 'https://mcp.notion.com/mcp')).toHaveLength(1);
    expect(servers.some((s: any) => s.name === 'Notion')).toBe(false);
    expect(servers.find((s: any) => s.name === 'notion_internal').oauth).toEqual(OAUTH_CONFIG);
  });

  it('keeps non-colliding bundled defaults, still ordered before org entries', async () => {
    const org = [
      { name: 'onehub_core', url: 'https://mcp.internal.test/mcp/onehub_core', transport: 'http' as const, oauth: { ...OAUTH_CONFIG } },
    ];
    const configPath = await writeDesktopConfig('http://127.0.0.1:4001', 'codemie-proxy', baseDir, org, statePath);

    const written = JSON.parse(await readFile(configPath, 'utf-8'));
    const servers = JSON.parse(written.managedMcpServers);
    const names = servers.map((s: any) => s.name);
    expect(names.slice(0, 7)).toEqual(['Notion', 'Linear', 'Box', 'Canva', 'Vercel', 'Netlify', 'Miro']);
    expect(names[7]).toBe('onehub_core');
  });
```

The pre-existing case "does not duplicate a public default echoed by the org catalog" (line 505) must keep passing unchanged — after the flip the surviving single `Notion` entry is the backend's rather than the bundled one, and that test only asserts the count.

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t "collides with"
```
Expected: FAIL — the name-collision case reports `url` as `https://mcp.notion.com/mcp` and `oauth` as `true`; the url-collision case finds the bundled `Notion` still present.

- [ ] **Step 3: Write the minimal implementation**

In `src/cli/commands/proxy/connectors/desktop.ts`, replace the dedup block at lines 486–494 (from the `// Dedup the org catalog...` comment through the `const managedSet = ...` line) with:

```ts
  // Dedup bundled public defaults against the org catalog so an entry the
  // backend also publishes is written once. The BACKEND wins the collision: it
  // is authoritative and now carries real OAuth client configuration, while the
  // bundled default only holds `oauth: true`.
  const org = orgMcpServers ?? [];
  const orgNameSet = new Set(org.map((s) => s.name.toLowerCase()));
  // URL comparison is intentionally case-sensitive (matching
  // reconcileManagedMcpServers); name comparison is case-insensitive.
  const orgUrlSet = new Set(org.map((s) => s.url));
  const defaultsDeduped = DEFAULT_MANAGED_MCP_SERVERS.filter(
    (d) => !orgNameSet.has(d.name.toLowerCase()) && !orgUrlSet.has(d.url),
  );

  const managedSet = [...defaultsDeduped.map(cloneManagedEntry), ...org.map(cloneManagedEntry)];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
```
Expected: all cases PASS, including the pre-existing revocation, null-fetch and echoed-default cases.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/desktop.ts \
        src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
git commit -m "fix(proxy): let a backend managed MCP entry beat a bundled default

The dedup filter is inverted: bundled defaults are now filtered against
the org catalog, so a backend entry carrying real OAuth client config
replaces the static oauth: true stub on a name or URL collision.

Refs: EPMCDME-14072"
```

---

### Task 6: Log the resolved oauth-shape breakdown at the call site

The existing log line reports `canonicalCount`, `mappedCount` and `mappedNames`. Add a per-shape breakdown so a downgrade or a mass drop is visible in the field (spec §8). The counting lives in an exported pure helper in `desktop.ts` — that keeps it testable and keeps `ManagedMcpServerEntry` knowledge in the connector layer.

**Files:**
- Modify: `src/cli/commands/proxy/connectors/desktop.ts` (add `summarizeManagedOauthShapes` after `cloneManagedEntry`), `src/cli/commands/proxy/index.ts:21` (import) and `:459-468` (the log call)
- Test: `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`

**Interfaces:**
- Consumes: `ManagedMcpServerEntry` (Task 3).
- Produces: `export function summarizeManagedOauthShapes(entries: ManagedMcpServerEntry[] | null): { oauthConfigured: number; oauthFlagged: number; noAuth: number }`.

**Test-first: yes** — `desktop.test.ts` › "counts object, boolean and absent oauth shapes" fails RED because `summarizeManagedOauthShapes` does not exist (`TypeError: summarizeManagedOauthShapes is not a function`).

- [ ] **Step 1: Write the failing test**

Add a new block at the end of `src/cli/commands/proxy/connectors/__tests__/desktop.test.ts`:

```ts
describe('summarizeManagedOauthShapes', () => {
  it('counts object, boolean and absent oauth shapes', () => {
    expect(summarizeManagedOauthShapes([
      { name: 'obj', url: 'https://a', oauth: { ...OAUTH_CONFIG } },
      { name: 'flag', url: 'https://b', oauth: true },
      { name: 'off', url: 'https://c', oauth: false },
      { name: 'absent', url: 'https://d' },
    ])).toEqual({ oauthConfigured: 1, oauthFlagged: 1, noAuth: 2 });
  });

  it('returns zeroes for a failed fetch (null) and for an empty list', () => {
    expect(summarizeManagedOauthShapes(null)).toEqual({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 });
    expect(summarizeManagedOauthShapes([])).toEqual({ oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 });
  });
});
```

Add `summarizeManagedOauthShapes` to the test file's import block (after `selectPreferredClaudeModels`):

```ts
import {
  buildGatewayConfig,
  cloneManagedEntry,
  fetchClaudeModels,
  getDesktopBaseDir,
  getDesktopConfigPath,
  getManagedMcpStatePath,
  mapCanonicalToDesktop,
  reconcileManagedMcpServers,
  resolveDesktopOAuth,
  selectDesktopClaudeModels,
  selectPreferredClaudeModels,
  summarizeManagedOauthShapes,
  writeDesktopConfig,
} from '../desktop.js';
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts -t "summarizeManagedOauthShapes"
```
Expected: FAIL with `summarizeManagedOauthShapes is not a function`.

- [ ] **Step 3: Write the minimal implementation**

3a. In `src/cli/commands/proxy/connectors/desktop.ts`, add after `cloneManagedEntry`:

```ts
export interface ManagedOauthShapeSummary {
  /** Entries forwarding a structured OAuth client configuration. */
  oauthConfigured: number;
  /** Entries carrying only the legacy `oauth: true` flag. */
  oauthFlagged: number;
  /** Entries with `oauth: false` or no auth information at all. */
  noAuth: number;
}

/**
 * Count the resolved oauth shapes so a silent downgrade (every entry landing on
 * `false`) or a mass validation drop is visible in the daemon log.
 */
export function summarizeManagedOauthShapes(
  entries: ManagedMcpServerEntry[] | null,
): ManagedOauthShapeSummary {
  const summary: ManagedOauthShapeSummary = { oauthConfigured: 0, oauthFlagged: 0, noAuth: 0 };
  for (const entry of entries ?? []) {
    if (entry.oauth !== undefined && typeof entry.oauth === 'object') summary.oauthConfigured += 1;
    else if (entry.oauth === true) summary.oauthFlagged += 1;
    else summary.noAuth += 1;
  }
  return summary;
}
```

3b. In `src/cli/commands/proxy/index.ts`, extend the import on line 21:

```ts
import { writeDesktopConfig, getDesktopBaseDir, mapCanonicalToDesktop, summarizeManagedOauthShapes } from './connectors/desktop.js';
```

3c. Replace the log call at lines 459–468 with:

```ts
        const oauthShapes = summarizeManagedOauthShapes(orgMcpServers);
        logger.info(
          '[proxy] Resolved managed MCP servers for Claude Desktop',
          ...sanitizeLogArgs({
            codeMieUrl: state!.syncCodeMieUrl,
            fetchSucceeded: canonical !== null,
            canonicalCount: canonical?.length ?? 0,
            mappedCount: orgMcpServers?.length ?? 0,
            mappedNames: orgMcpServers?.map((s) => s.name) ?? [],
            oauthConfiguredCount: oauthShapes.oauthConfigured,
            oauthFlaggedCount: oauthShapes.oauthFlagged,
            noAuthCount: oauthShapes.noAuth,
          })
        );
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
npx vitest run --project unit src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
npx vitest run --project unit src/cli/commands/proxy/__tests__/index.test.ts
npm run typecheck
```
Expected: all PASS, `typecheck` exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/desktop.ts \
        src/cli/commands/proxy/index.ts \
        src/cli/commands/proxy/connectors/__tests__/desktop.test.ts
git commit -m "feat(proxy): log the managed MCP oauth shape breakdown

The daemon now reports how many managed entries resolved to a structured
OAuth config, to the legacy boolean flag, or to no auth, so a downgrade
or a mass validation drop is visible in the field.

Refs: EPMCDME-14072"
```

---

### Task 7: Full quality gate

Confirm the whole repository is green before handing the branch over (acceptance criterion 8).

**Files:**
- Modify: none (fix-forward only if a gate fails).
- Test: the full unit suite.

**Interfaces:**
- Consumes: every change from Tasks 1–6.
- Produces: a branch that passes `lint`, `typecheck`, `build` and the unit suite.

**Test-first: no** — this task runs the already-written tests as a gate; it adds no new behavior and therefore has no test of its own. Any failure it surfaces is fixed by returning to the owning task and adding the missing case there, test-first.

- [ ] **Step 1: Run the gates**

```bash
npm run lint
npm run typecheck
npm run build
npm run test:unit
```
Expected: `lint` exits 0 with zero warnings, `typecheck` exits 0, `build` completes, `test:unit` reports all suites passing.

- [ ] **Step 2: Verify the untouched-file constraint**

```bash
git diff --stat main...HEAD
```
Expected: exactly five files changed — `managed-mcp-remote.ts`, `desktop.ts`, `index.ts`, `managed-mcp-remote.test.ts`, `desktop.test.ts`. `desktop-managed-mcp-servers.json` must **not** appear.

- [ ] **Step 3: Commit any gate fixes**

Only if a gate required a change:

```bash
git add -A
git commit -m "chore(proxy): satisfy lint and typecheck for managed MCP oauth config

Refs: EPMCDME-14072"
```

---

## Acceptance criteria coverage

| # | Criterion | Covered by |
|---|---|---|
| 1 | New oauth object written into `configLibrary/<UUID>.json` intact | Task 3 — "writes a structured oauth object into managedMcpServers intact" |
| 2 | No `oauth: false` when the backend supplied OAuth configuration | Task 3 — "never writes oauth: false for an entry that supplied oauth config" + `resolveDesktopOAuth` precedence block |
| 3 | Legacy `auth: 'oauth'` still produces `oauth: true` | Task 3 — "falls back to the legacy auth enum", "writes oauth: true for a legacy auth enum entry" |
| 4 | Unknown oauth keys survive to the Desktop config | Task 1 — "keeps a structured oauth object intact, including unknown keys"; Task 3 — "preserves unknown keys inside the oauth object" and the end-to-end write test with `audience` |
| 5 | Backend entry replaces a colliding bundled default | Task 5 — name-collision and url-collision cases |
| 6 | A transient backend failure never revokes | Pre-existing "preserves existing org entries and leaves marker state untouched when the fetch failed (null)", re-run green in Tasks 5 and 7 |
| 7 | A backend emitting only malformed oauth does not revoke | Task 2 — "returns null when the backend sent entries but none survived validation" |
| 8 | `lint`, `typecheck`, `build` and the test suite pass | Task 7 |
