# EPMCDME-14072 — Structured OAuth config for managed MCP servers

**Status**: approved design
**Flow**: sdlc-standard · Stage 3
**Complexity**: L (21/36)
**Research**: [technical-analysis.md](./technical-analysis.md)

## Problem

The CodeMie backend's `GET /v1/mcp/managed-servers` is changing the `oauth` field on each managed
MCP entry from a flag into a structured object carrying the OAuth client configuration:

```json
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
}
```

The CLI cannot carry this today, and fails at it in two compounding ways:

1. **Silent auth downgrade.** `mapCanonicalToDesktop` computes `oauth: entry.auth === 'oauth'`
   (`desktop.ts:274`). The new payload has no `auth` key, so every org server is written to Claude
   Desktop with `oauth: false` — authentication silently off, no error, no failing test.
2. **Field stripped before it is reachable.** `pickCanonicalFields` (`managed-mcp-remote.ts:38`)
   rebuilds each entry from an allowlist of six known keys. Even if validation accepted an `oauth`
   object, it would never survive to the mapper.

## Resolved decisions

The first four were settled with the requester during brainstorming and are load-bearing for
everything below. The fifth was raised by code review (CR-007) and adjudicated at Stage 6.

| # | Question | Decision |
|---|---|---|
| 1 | Can Claude Desktop's `managedMcpServers` represent an oauth object? | **Yes — pass-through.** Desktop consumes the object and runs the flow. The CLI is a courier. |
| 2 | Which shapes must the CLI still accept? | **All three**: new `oauth` object, `oauth` boolean, legacy `auth: 'oauth'\|'none'` enum. |
| 3 | How strictly to validate the oauth object? | **Sanity-gate, forward whole object.** Require the essential fields; preserve unknown keys. |
| 4 | Backend entry vs bundled default on collision? | **Backend wins.** Invert today's dedup. |
| 5 | May the CLI raise a backend entry's auth to a colliding default's? | **No — forward as published, warn instead.** See §5. |

Decision 1 removes `McpOAuthProvider`, the callback server, the `callbackPort: 3118` collision and
the cross-origin auth-host allowlist from scope entirely. The CLI never performs the OAuth flow.

## Scope

**In scope** — four production files, two test files:

| File | Change |
|---|---|
| `src/cli/commands/proxy/connectors/managed-mcp-remote.ts` | `McpOAuthConfig` type, `isValidOAuthConfig`, widened `CanonicalMcpEntry`, extended `isValidCanonicalEntry`, oauth-aware `pickCanonicalFields`, empty-catalog mitigation |
| `src/cli/commands/proxy/connectors/desktop.ts` | Widened `ManagedMcpServerEntry`, `resolveDesktopOAuth`, `cloneManagedEntry`, dedup precedence flip |
| `src/cli/commands/proxy/index.ts` | Observability for oauth shape at the existing log site (455-474) |
| `src/cli/commands/proxy/connectors/desktop-managed-mcp-servers.json` | **No change** — `oauth: true` stays valid under the widened union |
| `connectors/__tests__/managed-mcp-remote.test.ts`, `connectors/__tests__/desktop.test.ts` | New coverage |

**Scope added during code review.** The dedup flip proved to have consequences the original table did
not anticipate, and the review rounds that found them added the following to `desktop.ts`. Recorded
here so the shipped scope and the spec agree:

| Addition | Why it exists |
|---|---|
| `mergeManagedMcpServers` + `sameManagedName` / `sameManagedEndpoint` / `collidesWithManagedEntry` | The flip's collision logic, extracted from `writeDesktopConfig` so it is testable and single-sourced (§5) |
| `selectDefaultsForFailedFetch` | CR-001: on a *failed* fetch, restoring a bundled default whose name or URL an existing entry already occupies made reconciliation treat that name as ours and evict the tenant's server. Narrows the seeded set instead. Guards AC6 |
| `parseManagedServerList` (and `parseJsonArray` rebuilt on it) | CR-005: `selectDefaultsForFailedFetch` must distinguish "the stored list is empty" from "the stored list is unreadable"; the latter must seed nothing |
| `summarizeManagedOauthShapes` + the second summary in `writeDesktopConfig` | CR-006: §8's breakdown over the org catalog does not reconcile with `managedMcpServerCount`, so the written list is summarized too |
| `ManagedOauthDowngrade` reporting | Decision 5 (§5) |
| `src/cli/commands/proxy/__tests__/index.test.ts` (third test file) | The `desktop.js` module mock in that suite needed the new `summarizeManagedOauthShapes` export to keep the §8 log-site test running |

**Out of scope** — the VS Code connector, `mcp-loader.ts` and `mcp-config.ts` were checked during
research and are provably off this code path. `McpOAuthProvider` / `mcp-auth.plugin.ts` are out of
scope by Decision 1.

## Design

### 1. Type model

`managed-mcp-remote.ts` owns the shared config type, since it is the client-neutral layer:

```ts
export interface McpOAuthConfig {
  clientId: string;
  authorizationUrl: string;
  tokenUrl: string;
  scope?: string;
  callbackHost?: string;
  callbackPort?: number;
  [key: string]: unknown;   // forward-compat: unknown backend keys survive
}

export interface CanonicalMcpEntry {
  name: string;
  transport: 'http' | 'sse' | 'stdio';
  url?: string;
  auth?: 'oauth' | 'none';            // legacy — retained for rollout
  oauth?: McpOAuthConfig | boolean;    // new
  description?: string;
  clients?: string[];
}
```

`desktop.ts` widens its client-specific type the same way:

```ts
export interface ManagedMcpServerEntry {
  name: string;
  url: string;
  transport?: 'http' | 'sse';
  oauth?: McpOAuthConfig | boolean;   // was: boolean
}
```

The two-layer split is deliberately **kept**. The new payload happens to resemble Desktop's shape,
but the canonical layer is client-neutral by design and is shared with other connectors; collapsing
it would couple the fetcher to one client.

### 2. Validation — sanity gate, not an allowlist

```
isValidOAuthConfig(value):
  value is a non-null, non-array object
  clientId, authorizationUrl, tokenUrl  -> non-empty strings   (required)
  scope, callbackHost                   -> strings if present   (optional)
  callbackPort                          -> integer in 1..65535 if present
  unknown keys                          -> ignored, never rejected
```

Extension to `isValidCanonicalEntry`, applied when `oauth` is present and not `null`:

- boolean → valid
- object → must pass `isValidOAuthConfig`, otherwise **the whole entry is invalid and is dropped**
- any other type → invalid

Consistent with the module's existing convention, backend-serialized `null` is treated as absent.

### 3. Field preservation

`pickCanonicalFields` copies the entire oauth value rather than reconstructing it from known keys:

```ts
if (e.oauth !== undefined && e.oauth !== null) {
  out.oauth = typeof e.oauth === 'object' ? { ...e.oauth } : e.oauth;
}
```

This is the direct fix for the stripping defect, and it is why a future backend field (`audience`,
`resource`, `pkce`, …) reaches Desktop without a CLI release.

### 4. Normalization — one precedence table

A single `resolveDesktopOAuth(entry)` in `desktop.ts`, called by `mapCanonicalToDesktop`:

| Condition | Result |
|---|---|
| `isValidOAuthConfig(entry.oauth)` | `{ ...entry.oauth }` |
| `entry.oauth === true` | `true` |
| `entry.oauth === false` | `false` |
| `entry.auth === 'oauth'` | `true` |
| `entry.auth === 'none'` | `false` |
| otherwise | `false` |

The final row preserves today's behavior for entries carrying neither field. This is the direct fix
for the silent auth downgrade.

### 5. Dedup precedence flip

`writeDesktopConfig` currently discards a backend entry that collides with a bundled default by name
or URL, keeping the static stub. The backend now wins, on **specificity, not secrecy**: its entry
names the authorization server, the client and the scopes for that tenant's endpoint, while the
bundled default carries only `oauth: true` — "this needs OAuth", with nothing about how. Note that
the object holds no secret material: a public `clientId`, scopes, a callback host/port and two
endpoint URLs. There is no client secret and no token, which is what makes Decision 1's
pass-through safe. So the filter inverts:

```ts
const orgNameSet = new Set(org.map(s => s.name.toLowerCase()));
const orgUrlSet  = new Set(org.map(s => s.url));
const defaultsDeduped = DEFAULT_MANAGED_MCP_SERVERS.filter(
  d => !orgNameSet.has(d.name.toLowerCase()) && !orgUrlSet.has(d.url),
);
const managedSet = [...defaultsDeduped, ...org];
```

Name comparison stays case-insensitive and URL comparison stays case-sensitive, matching the
existing convention. Bundled defaults keep leading the array when there is no collision.

**The backend entry is written exactly as published — including its auth** (Decision 5). A collision
*at the same endpoint* that lowers auth relative to the default it displaced is *reported*, never
corrected: one `logger.warn` naming the displaced default, the backend entry and the endpoint, at
most one record per backend entry.

The report is scoped to the endpoint because a bundled default's `oauth: true` asserts something
about **its URL**, not about its name. A tenant whose internal server merely reuses the name
`notion` at its own URL is the ordinary case, not a downgrade — warning there would bury the real
signal in noise on every run.

The rejected alternative, recorded so it is not reintroduced, is an **auth floor** — rewriting such
an entry to carry the displaced default's `oauth`. It was implemented, reviewed and removed. It
contradicts Decision 1 (the CLI stops being a courier) and Decision 4 (the backend stops winning),
and it makes §4's `resolveDesktopOAuth` no longer the single decider of the written value. The
security case for it does not survive contact with what the bundled defaults are: public
third-party SaaS endpoints. Writing `oauth: false` for one discloses nothing — the endpoint rejects
the client — whereas forcing `oauth: true` onto an endpoint the backend deliberately published as
unauthenticated breaks a server the CLI has no standing to override.

One consequence is binding, and it is a structural requirement rather than a naming preference:
**the two tests must not be independent predicates that can drift apart.** The removed floor keyed
on exact URL equality while the collision filter keyed on name-or-URL, so a trailing-slash or
host-case variant escaped it (CR-008). The predicate is therefore *decomposed*, not duplicated:

```
sameManagedEndpoint(a, b)      -> a.url === b.url                  (case-sensitive)
sameManagedName(a, b)          -> a.name.toLowerCase() === b.name.toLowerCase()
collidesWithManagedEntry(a, b) -> sameManagedName(a, b) || sameManagedEndpoint(a, b)
```

Displacement uses `collidesWithManagedEntry`; the downgrade report uses `sameManagedEndpoint`.
Because the wide test is defined as an OR containing the narrow one, a reported downgrade is a
strict subset of a displacement by construction — an endpoint collision can never displace a default
without also being reportable, which is exactly the property CR-008 demanded, and it cannot be lost
by editing one predicate and forgetting the other.

URL comparison stays unnormalized here. A trailing-slash or host-case variant of a default's URL is
the same effective endpoint but compares unequal, so it is displaced only if the names also collide.
That gap is pre-existing, tracked in `code-review-deferred.md`, and deliberately not fixed by this
task.

Because of it, a displaced default is not always a reported downgrade, so **displacement is reported
in its own right**: the write-time log names every bundled default an org entry dropped
(`displacedDefaults`, `displacedDefaultCount`), by either arm of the collision test. That is what
keeps an OAuth-bearing default disappearing from the config from being silent — an operator can
always reconcile `seededDefaultCount` against what was written.

### 6. Aliasing fix

`desktop.ts:327` and `:494` shallow-copy entries with `{ ...s }`. With a nested oauth object that
shares the object by reference with `DEFAULT_MANAGED_MCP_SERVERS` — a `readonly` module-level
constant imported from JSON and therefore a process-lifetime singleton. A `cloneManagedEntry()`
helper copies the nested oauth object too. Latent today (the bundled file uses a boolean), a live
corruption vector the moment anyone adds an oauth object to that file.

### 7. Empty-catalog mitigation

Entry-level dropping interacts dangerously with revocation. A backend bug emitting malformed oauth
would drop every entry, `fetchManagedMcpServers` would return `[]` — an *authoritative empty
catalog* — and `writeDesktopConfig` would revoke the tenant's org MCPs. The existing outage
protection does not engage, because this does not look like an outage.

Mitigation, in `fetchManagedMcpServers`:

> If the raw array was **non-empty** but **every** entry failed validation, return `null` (failure)
> instead of `[]`. Log the dropped count.

A genuinely empty catalog still returns `[]` and still revokes. This strengthens the existing
`null`-vs-`[]` contract rather than altering it.

### 8. Observability

The log site at `index.ts:455-474` already reports `canonicalCount`, `mappedCount` and `mappedNames`.
It gains a per-shape breakdown — how many entries resolved to an oauth object, a boolean `true`, or
no auth — so a downgrade or a mass drop is visible in the field. Routed through `sanitizeLogArgs`
like every other log call in this module.

## Error handling

| Condition | Behavior |
|---|---|
| No SSO credentials / network error / non-2xx / non-array body | `null` — unchanged |
| Some entries invalid, some valid | Valid subset returned; invalid dropped and counted |
| Raw array non-empty, all entries invalid | `null` (new — §7) |
| Backend returns `[]` | `[]` — authoritative empty catalog, revocation proceeds |
| `oauth` object present but fails the sanity gate | Entry dropped, visible in the log delta |
| `oauth` is `null` | Treated as absent, per existing convention |

The fail-soft guarantee is unchanged: a failed fetch never revokes.

## Testing

**TDD is mandatory for every implementation task — no exceptions.** Write the failing test first and
observe RED before writing any production code, then observe GREEN. A task whose test was written
after its implementation must be redone. This overrides the repository's default
"tests only on explicit request" policy for this task.

Coverage targets the blind spot research identified — no existing fixture omits `auth`, so today's
regression would keep CI green.

**`managed-mcp-remote.test.ts`**
- Entry with an `oauth` object survives validation with all six keys intact
- Unknown oauth keys are preserved through `pickCanonicalFields`
- Object missing `clientId` / `authorizationUrl` / `tokenUrl` → entry dropped
- `callbackPort` non-integer or out of range → entry dropped
- `oauth: true` / `oauth: false` / `oauth: null` handled
- Legacy `auth: 'oauth'` entry still accepted
- Mixed valid + invalid array → only valid returned
- Non-empty array, all entries invalid → `null`, not `[]`
- Genuinely empty array → `[]`

**`desktop.test.ts`**
- `resolveDesktopOAuth` precedence table, row by row
- Entry with neither field → `oauth: false` (no behavior change)
- oauth object reaches the written config JSON intact
- Backend entry beats a bundled default on name collision, and on URL collision
- Non-colliding bundled defaults still present and still ordered first
- Managed entries do not alias `DEFAULT_MANAGED_MCP_SERVERS` (mutating the output leaves the constant untouched)

## Acceptance criteria

1. A backend entry carrying the new `oauth` object is written into
   `configLibrary/<UUID>.json` → `managedMcpServers` with the object intact, all keys preserved.
2. No entry is written with `oauth: false` when the backend supplied OAuth configuration.
3. Entries using the legacy `auth: 'oauth'` enum continue to produce `oauth: true`.
4. Unknown keys inside the oauth object survive to the Desktop config.
5. A backend entry colliding with a bundled default replaces it.
6. A transient backend failure still never revokes previously-managed org entries.
7. A backend emitting only malformed oauth objects does not revoke the tenant's org MCPs.
8. `npm run lint`, `typecheck`, `build` and the full test suite pass.

## Non-goals

- The CLI performing the OAuth flow (Decision 1 — Desktop owns it)
- Changes to `McpOAuthProvider`, `mcp-auth.plugin.ts`, or the SSO proxy's origin allowlist
- Changes to the VS Code connector, `mcp-loader.ts`, or `mcp-config.ts`
- Extending the marker state file beyond `managedNames`. Research confirmed reconciliation rebuilds
  managed entries from the fresh fetch and filters stale copies by name, so a rotated `clientId`
  already propagates. Recorded here so it is not "fixed" later.
- Adding oauth objects to the bundled defaults file
