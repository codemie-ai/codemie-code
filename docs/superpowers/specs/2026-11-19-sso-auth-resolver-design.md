# SSO credential resolver: one place decides cookie vs JWT

Date: 2026-11-19 · Branch: `sso-jwt` · Status: draft for approval

## Intent

The SSO browser callback can yield either cookies or (when a reverse proxy strips cookies) a JWT
bearer token from the payload's `authorization` field. Today the callback stores whichever it got
in one of two credential-store slots, and then ~30 files each re-derive "usable cookies, else JWT"
on their own — some via `isJWTCredentials()`, some via `hasUsableCookies()`, some via
`'cookies' in creds`, and some (e.g. `hook-credentials.ts`, `managed-mcp-remote.ts`,
`test-metrics.ts`, `skills-metrics.ts`) only know about cookies and silently miss JWT logins.
`statusline.ts` has its own third copy of the cookie-then-JWT rule.

Why rework: **stop that logic drifting across files, and make it possible to extend SSO auth
(a new credential type, refresh behaviour, new metadata) without editing every consumer.**

## Goals

1. On callback, credentials are stored the way they are now (cookie record in the SSO slot, JWT
   record in the `jwt-<host>` slot), but each record is **marked with its auth type**, so later
   sessions and other components know which one is authoritative without guessing.
2. Every SSO consumer — the agent wrappers (claude, pi, kimi, copilot, gemini, opencode, codex),
   the Claude Desktop / proxy daemon path, and CLI commands (`codemie setup`, `codemie doctor`,
   `codemie profile login|logout|refresh|status`, `codemie skills`, `codemie proxy …`) — gets
   credentials **only from the SSO plugin**.
3. The SSO plugin returns a **ready-to-use typed object** (`SSOAuth`). Consumers do not resolve
   the credential type themselves.

## Non-goals

- Changing the bearer-auth (`jwt` provider) profile flow: `--jwt-token` / `CODEMIE_JWT_TOKEN`
  remain as they are. (The proxy wraps that token in the same `SSOAuth` shape so interceptors
  see one type — see *Proxy* below — but how the token is obtained does not change.)
- Changing the on-disk storage layout, encryption, keychain/file fallback, or URL key derivation
  (`deriveUrlStorageKey`).
- Changing the backend callback contract.
- Adding token refresh. (The design must make it addable as a strategy concern later.)

## Anti-goals (failure even if it "works")

- Any consumer outside the SSO plugin still choosing between cookies and JWT by inspecting
  stored records (`hasUsableCookies`, `isJWTCredentials`, `'cookies' in`, `retrieveJWTCredentials`).
- Existing users being forced to log in again after upgrade.
- A compatibility shim layer that keeps the old helper functions alive alongside the new API
  (that recreates two ways of doing it).

## Approaches considered

- **A. Single resolver function, typed result.** Simple, but adding a type means editing one big
  function's lookup/expiry/clear/header code. Rejected: weaker extensibility.
- **B. Typed result backed by one strategy per auth type.** ← **Chosen.** Public API identical to
  A; internally each auth type is a strategy with the same small interface; the marker picks the
  strategy. A new type = one strategy file + one union member; TypeScript's exhaustive `switch`
  flags the few consumers that legitimately branch on `type`.
- **C. Merge both shapes into one stored record.** Rejected: changes how credentials are saved
  (explicitly out of scope) and needs a migration.

## Design

### Location

New module directory `src/providers/plugins/sso/auth/`:

```
auth/
  types.ts              SSOAuth union, SSOAuthType, SSOAuthStrategy interface
  strategies/
    cookie.strategy.ts  load/isUsable/expiresAt/headers/clear/store for cookie records
    jwt.strategy.ts     same for SSO-issued JWT records
    index.ts            ordered strategy registry
  resolver.ts           public resolve*/store/clear functions
  index.ts              public exports
```

`sso.auth.ts` (`CodeMieSSO`) keeps the browser/callback mechanics and delegates storing,
reading and clearing to `auth/`. `codemie-auth-helpers.ts` keeps URL-candidate logic
(`getPlatformUrlCandidates`, profile-origin filtering, loopback exemption, env parsing) — the
resolver uses it — but its credential-returning functions move behind the resolver.

### Public types

```ts
export type SSOAuthType = 'cookie' | 'jwt';

interface SSOAuthBase {
  type: SSOAuthType;
  /** API base the credential was issued for (resolved from config.js at login). */
  apiUrl: string;
  /** Platform URL the credential was found under (credential-store key source). */
  url: string;
  expiresAt?: number;
  /** Ready-to-send auth headers: { cookie } or { authorization: 'Bearer …' }. */
  headers: Readonly<Record<string, string>>;
  /** JWT whose claims identify the user, if any (codemie_access_token cookie / the token). */
  identityToken?: string;
  /** Backend-verified email (withVerifiedOwner), when established. */
  email?: string;
  /** 'store' = SSO login; 'explicit' = --jwt-token / CODEMIE_JWT_TOKEN (never re-read). */
  source: 'store' | 'explicit';
}
export interface CookieSSOAuth extends SSOAuthBase { type: 'cookie'; cookies: Record<string, string>; }
export interface JwtSSOAuth   extends SSOAuthBase { type: 'jwt';    token: string; }
export type SSOAuth = CookieSSOAuth | JwtSSOAuth;
```

Rule for consumers: **use `headers`, `apiUrl`, `identityToken`, `email`.** Branching on
`type` is allowed only where an argument or header shape is inherently type-specific. Examples
are the SDK client constructor, which takes `cookies` or `jwtToken`, and the session-sync
cookie-name filtering. It must be an exhaustive `switch` with a `never` default. **No feature
may switch itself off by type.** Every feature works for both types (see *Cookie-only features
must support JWT*).

### Strategy interface

```ts
interface SSOAuthStrategy<R> {
  type: SSOAuthType;
  /** Read this strategy's slot for a URL; null when absent/undecryptable. */
  load(url: string): Promise<R | null>;
  /** e.g. cookies that build a non-empty header; a non-empty token. */
  isUsable(record: R): boolean;
  expiresAt(record: R): number | undefined;     // absorbs sso.expiry.ts logic
  toAuth(record: R, url: string): SSOAuth;      // builds headers/identityToken
  store(result: SSOAuthResult, codeMieUrl: string): Promise<boolean>; // false = not applicable
  clear(url?: string): Promise<void>;
}
```

### The marker

- Stored records gain `authType: 'cookie' | 'jwt'` and `storedAt: number` (epoch ms).
  `SSOCredentials` / `JWTCredentials` in `core/types.ts` get these as optional fields (old
  records lack them).
- On a successful callback **exactly one record is saved**, chosen in strategy order
  (cookie first, then jwt):
  - **The callback contains cookies → only the cookie record is saved.** Any JWT in the payload
    is ignored. This is the backward-compatible behaviour.
  - **Revised 2026-11-20: when the callback contains both, the cookies are checked once.** A
    reverse proxy (seen on an Envoy deployment) can deliver cookies in the callback yet strip
    them from API requests, so they get a 302 to the IdP while the JWT gets 200. Before choosing,
    the cookie strategy calls `/v1/user` with the cookies: 2xx → cookies are saved as above; a
    rejection (non-2xx, redirect, non-JSON page) → the JWT is saved instead. A network failure
    keeps the cookies. A callback with only one credential type is stored without a check.
  - **The callback contains no cookies but a JWT → the JWT record is saved.** A server that
    strips authentication cookies never delivers them in the callback, so the JWT is the only
    credential.
  - Every other strategy's slot for that URL is **cleared**, so after any login exactly one
    marked record exists per host and no earlier login survives next to it.
- On read, per candidate URL the resolver loads all strategies' records and picks:
  1. the marked record with the newest `storedAt` that is usable and not expired;
  2. else (legacy, unmarked records) the old order: usable cookies first, else JWT.
- **Exception to rule 1:** if an unmarked record coexists with a marked record of the other
  type, the unmarked one wins. A current CLI always clears the other slot on login, so a
  coexisting unmarked record can only have been written later, by an older CLI (stale daemon,
  another installed version). A debug log notes the choice.
- Expired records are cleared on read, as `getStoredCredentials` does today.

**Clearing scope.** "Clear the other slots" (on login) and `clearSSOAuth(url)` remove, for each
strategy: the current key for the URL, the legacy raw-URL key (`deriveLegacyUrlStorageKey`),
and the global slot (`sso` / `jwt-credentials`) when its record's `apiUrl` origin matches the
URL's origin. That is every key the read path can resolve for that host. Both strategies get
the same global-slot fallback with origin check on read.

**Keytar-free core.** Record parsing, marker precedence (the rules above) and header building
live in `auth/selection.ts`, which must not import `security.js`/keytar — only
`credential-crypto.js`-level code. The strategies use it; so does
`agents/plugins/claude/plugin/statusline.ts`, which is esbuild-bundled standalone and reads the
credential files directly (it already handles JWT). The statusline keeps its own file reading
but delegates *selection* to this module, so the precedence rules exist in one place.

No re-login is needed after upgrade: unmarked records resolve via rule 2.

### Proxy: live credential-type switching

Claude Desktop (and every wrapped agent) talks to the local CodeMie proxy with static local
credentials; the proxy owns the real platform auth. When the proxy's credential refresh finds
that the stored credential's **type changed** (e.g. the user re-logged in and the reverse proxy
now strips cookies → JWT), the proxy **adopts the new credential immediately, with no restart.**

- `CredentialRefresher` becomes non-generic over `SSOAuth` and accepts a re-read of a different
  `type` (today it rejects it). Only `source: 'explicit'` snapshots are never re-read.
- `sso-auth.plugin.ts` and `jwt-auth.plugin.ts` merge into one auth interceptor that, per
  request, takes `credentialRefresher` current `SSOAuth` and applies its `headers` to the
  outgoing request. Headers are per request, so nothing from a previous type carries over. Plugin registration no
  longer selects an interceptor by credential kind at start.
- Every proxy component that cached a type-specific value at start — `sso.session-sync.plugin.ts`
  (cookie header / jwt token in its context), `sso-session-expiry.plugin.ts` (cookie-only
  check), the model-catalogue fetches in the request normalizers and `desktop-models.plugin.ts`,
  `otlp-spool` auth-state/classification — reads the current `SSOAuth` from the refresher at use
  time instead of from `PluginContext.credentials` captured at start. Features that today work
  only with cookies are made to work with JWT too (next section), so nothing is lost after a
  switch either way.
- The main and sync refreshers stay separate as today (one per credential source); each may
  switch type independently.

### Public resolver API (`auth/index.ts`)

| Function | Replaces |
|---|---|
| `resolveSSOAuth(src: PlatformUrlSource): Promise<SSOAuth \| null>` | `getStoredPlatformCredentials`, `getStoredPlatformAuthCredentials`, `CodeMieProxy.loadJWTFromStore` (SSO path) |
| `resolveSSOAuthFromEnv(env)` | `getStoredPlatformCredentialsFromEnv`, `getStoredPlatformAuthCredentialsFromEnv` |
| `resolveAnalyticsSSOAuth(ssoUrl, env?, overrides?)` | `getStoredAnalyticsCredentials`, `getStoredAnalyticsAuthCredentials` |
| `resolveSSOAuthForUrl(url, { allowGlobalFallback? })` | direct `CodeMieSSO.getStoredCredentials(url)` callers (sync URL, daemon state URLs) |
| `storeSSOAuth(result, codeMieUrl)` | storage branches in `CodeMieSSO.authenticate()` |
| `clearSSOAuth(url?)` | `CodeMieSSO.clearStoredCredentials` |
| `explicitJwtAuth(token, apiUrl)` | ad-hoc `{ token, apiUrl }` in `sso.proxy.ts` JWT path |

All lookups keep today's semantics: candidate order (profile `baseUrl` then workspace
`codeMieUrl`), profile-origin filtering, loopback exemption, global-slot fallback with origin
check. These rules now apply to JWT records too. Today's JWT fallback skips the origin filter,
so a JWT issued for another host is no longer used for a platform profile.

`withVerifiedOwner` (credential-owner.ts) accepts `SSOAuth` and works for both types
(`fetchCodeMieUserInfo` already supports a token).

### Cookie-only features must support JWT

Several features run only when the credential has cookies and do nothing (or fail) for an
SSO-issued JWT. All of them must work for both types, through the strategy rather than by
branching in the feature:

| Feature | Today | With JWT |
|---|---|---|
| Session-expiry detection + detached re-login (`sso-session-expiry.plugin.ts`) | No-op unless `'cookies' in credentials` | Enabled for both. It already acts on the server's rejection (oauth2 redirect / session-shaped 401). The loop guard and the "superseded by a newer sign-in" replay compare credential **fingerprints** instead of Cookie-header hashes. The replay re-sends with the current `headers`. |
| Superseded-credential check for analytics/session sync (`cookie-auth.ts` `credentialsSuperseded`, `cookieSourceOf`, `analytics-auth.ts`) | Cookies only; a JWT reads as "never superseded" | A re-login replaces an SSO JWT just as it replaces cookies, so the check compares the fingerprint that was sent with the stored one, for both types. `AnalyticsAuth` is built from `SSOAuth`, and `credentialsSuperseded` is present for both kinds. (An explicit `--jwt-token` stays static.) |
| Owner email (`credential-owner.ts` `withVerifiedOwner`, `credentialFingerprint`) | Cookies only | Looks up `/v1/user` with the credential's `headers`. The fingerprint comes from the strategy (sorted cookies / the token). |
| Evidence stamping + pending-owner replay (`evidence/stamp.ts` `pendingFor`, `otlp-spool/owner-pending-replay.ts`) | `isSSOCredentials` only | Both types, keyed by the strategy fingerprint. |
| Identity / email from claims (`identity-resolver.ts`) | Per-type branches | Reads `identityToken` (cookie: `codemie_access_token`; jwt: the token), then `email`. |
| Integration selection at launch (`launch-project-prompt.ts`, `sso.setup-steps.ts` `selectIntegrationForProject`) | Requires cookies | Takes `SSOAuth` and sends its `headers`. |
| Auth gate (`sso.auth-gate.ts` `hasValidAuth`) | `found.credentials.cookies` | `resolveSSOAuth(...) !== null`. |
| Managed MCP remote connector, `test-metrics`, `skills-metrics`, `proxy inspect-desktop`, `hook-credentials.ts` | Cookies only | Use `SSOAuth.headers` / `apiUrl`. |

For this, the strategy interface gains `fingerprint(record): string`, a stable non-secret hash
used for supersede checks, loop guards and owner/pending keys. It also gains `identityToken`,
exposed on `SSOAuth`. Branching on `type` stays limited to the places listed under *Public
types*.

### Consumers to migrate

Proxy / daemon (Claude Desktop, all wrappers go through this):
`sso.proxy.ts` (start + sync source selection; delete `loadJWTFromStore` SSO fallback),
`plugins/types.ts` (`PluginContext.credentials`/`syncCredentials` become `SSOAuth`),
`credential-refresh.ts` (generic over `SSOAuth`; "kind changed" check becomes `type` compare),
`sso-auth.plugin.ts`, `jwt-auth.plugin.ts`, `sso-session-expiry.plugin.ts`,
`sso.session-sync.plugin.ts`, `claude-request-normalizer.plugin.ts`,
`codex-request-normalizer.plugin.ts`, `desktop-models.plugin.ts`,
`otlp-spool/auth-state.ts`, `otlp-spool/classification.ts`, `otlp-spool/owner-pending-replay.ts`,
`src/bin/proxy-daemon.ts`.

Analytics / hooks / identity:
`session/analytics-auth.ts`, `session/cookie-auth.ts` (`cookieSourceOf`),
`cli/commands/hook/analytics-auth.ts`, `hook/processing-context.ts`,
`agents/core/hook-credentials.ts` (gains JWT support), `agents/core/identity-resolver.ts`
(uses `identityToken`), `agents/core/evidence/stamp.ts`, `providers/core/credential-owner.ts`,
`telemetry/runtime/DesktopSessionMetrics.ts`, `agents/plugins/claude/plugin/statusline.ts`.

SSO plugin / core:
`sso.auth.ts`, `sso.models.ts`, `sso.catalog.ts`, `sso.setup-steps.ts`, `sso.health.ts`,
`sso.auth-gate.ts`, `sso.expiry.ts` (folded into strategies, then removed),
`core/codemie-auth-helpers.ts` (`resolveProjectListAuth`, `selectCodeMieProject`),
`core/launch-project-prompt.ts`, `utils/sdk-client.ts`.

CLI:
`profile/auth.ts`, `skills/lib/require-auth.ts`, `skills/lib/skills-search-client.ts`,
`skills/lib/skills-metrics.ts`, `test-metrics.ts`, `proxy/inspect-desktop.ts`,
`proxy/connectors/managed-mcp-remote.ts`, `proxy/connect-orchestrator.ts`.

`codemie doctor`: the SSO side goes through `sso.health.ts` (migrated above).

Bearer-auth (`AuthMethod.JWT`) store read: stays behaviourally unchanged. `CodeMieProxy.loadJWTFromStore()`
(JWT-method branch) and `JWTAuthCheck.ts` both move to one helper in the jwt provider
(`providers/plugins/jwt/jwt.utils.ts`, e.g. `loadStoredJwtToken(url)`), which is exempt from
the lint rule. Only the SSO login writes the `jwt-<host>` slot, so clearing it on a cookie login
loses nothing the bearer-auth profile wrote itself.

After migration, removed: `getStoredPlatformCredentials*`, `getStoredPlatformAuthCredentials*`,
`getStoredAnalyticsCredentials`, `getStoredAnalyticsAuthCredentials`, `PlatformCredentials`,
`PlatformAuthCredentials`, `CodeMieSSO.getStoredCredentials`, `hasUsableCookies` export outside
the SSO plugin, `isJWTCredentials`/`isSSOCredentials` uses outside `auth/` and the bearer-auth
provider. An ESLint `no-restricted-imports` rule (or equivalent) blocks `CredentialStore`
`retrieve/store/clear{SSO,JWT}Credentials` outside `sso/auth/` and the jwt provider, so the
drift cannot come back.

### Constraints

- ES modules, `.js` import suffixes, `@/` alias, explicit return types, no `any`.
- Never log tokens/cookie values; use `sanitizeLogArgs()`.
- Keep the existing lazy `import()` of SSO code in hot paths (hooks, statusline) — those
  processes are short-lived and startup-sensitive.
- Proxy store reads keep their deadlines (`STORE_READ_DEADLINE_MS`, `PROXY_STORE_READ_DEADLINE_MS`).
- Tests only on explicit request (repo policy); existing tests that reference removed helpers
  will need updating as part of this work when tests are requested.

## Decided in conversation

- Approach B (strategies behind a typed result).
- Consumers receive a typed object, not just headers.
- If the callback contains cookies, only the cookies are saved and used. Cookies in the callback
  mean the server doesn't strip them, and this keeps backward compatibility. The JWT is saved
  only when the callback has no cookies, because a cookie-stripping server never delivers them.
- Features that today work only with cookies (session-expiry re-login, supersede checks, owner
  email, evidence stamping, integration selection, MCP connector, metrics commands) must
  support JWT.
- A running proxy that sees the credential type change on refresh adopts the new type with no
  restart (Claude Desktop sends requests and telemetry with static local credentials).

## Calls made by the author (check these)

1. **Keep the SSO JWT in the existing `jwt-<host>` slot** (earlier I suggested a new
   `sso-jwt-<host>` slot). On a closer look, nothing in the bearer-auth provider writes that
   slot — only the SSO callback does; the bearer-auth path only reads it. So there is no real
   overwrite collision, and keeping it matches "saved the same way as now". The marker is
   enough to tell an SSO-issued record apart.
2. A callback with cookies but none usable (all with empty names or control characters, so no
   header can be built) counts as "no cookies", and the JWT is saved if one is present. Cookies
   that are really there always win.
3. `storedAt` orders logins against each other if both slots are ever marked (e.g. two CLI
   versions racing).
4. The explicit `--jwt-token` path is wrapped as `SSOAuth` with `source: 'explicit'` so the proxy
   has a single credential type; the refresher never re-reads it (as today's `staticCredentials`).
5. Removed helpers are deleted, not deprecated.
6. An unmarked record coexisting with a marked one of the other type wins (it must be newer).
7. Clearing covers current key, legacy key and same-origin global slot, for both types.
8. Marker/selection rules live in a keytar-free `auth/selection.ts` shared with the statusline.
9. Bearer-auth store reads move into one jwt-provider helper, exempt from the lint rule.
10. The cookie and bearer proxy interceptors merge into one that applies the current `headers`.

## Left to the builder

- Exact file split inside `auth/`, naming of internal helpers.
- Order of migration (suggested: auth module → sso.auth.ts → proxy → analytics/hooks → CLI →
  delete old helpers → lint rule).
- Whether `headers` also carries the CLI identification headers from `buildAuthHeaders` or stays
  auth-only (keep `buildAuthHeaders` as the merge point either way).
