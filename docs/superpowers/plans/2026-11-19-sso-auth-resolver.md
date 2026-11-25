# SSO Credential Resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SSO plugin the only place that decides between cookie and JWT credentials. It marks stored records with their type and hands every consumer a ready-to-use typed `SSOAuth` object.

**Architecture:** A new `src/providers/plugins/sso/auth/` module holds:
- a keytar-free selection core (marker precedence, headers, fingerprint), shared with the bundled statusline;
- one strategy per auth type (cookie, jwt) over the existing `CredentialStore` slots;
- a resolver that reuses today's URL-candidate logic.

All consumers switch to the resolver. The proxy merges its two auth interceptors into one that follows type changes live. The old helpers are deleted, and a lint rule stops the logic drifting back.

**Tech Stack:** TypeScript (ES modules, `.js` import suffix, `@/` alias), Node ≥ 20, Vitest, ESLint flat config (`eslint.config.mjs`), esbuild (statusline bundle).

**Spec:** `docs/superpowers/specs/2026-11-19-sso-auth-resolver-design.md`

**Code state:** updated 2026-11-20 — **implemented and test-verified**. Commit `05929518` ("feat(providers): resolve SSO cookie and JWT credentials in one place") landed the full plan and is now on `sso-jwt` (HEAD `c51d0947`, rebased onto `main` `40b53063`, plus two follow-up fixes below). `src/providers/plugins/sso/auth/` exists with `types.ts`, `selection.ts`, `strategies/{cookie,jwt}.strategy.ts`, `strategies/index.ts`, `resolver.ts`, `material.ts`, `index.ts`, plus `jwt-claims.ts` (not in the original file list — see *File Structure*). All 11 tasks below are done. `npm run typecheck`, `npm run lint` (zero warnings), `npm run build` (incl. the statusline esbuild bundle) and all three `npm test` Vitest projects (unit 648/648 files, cli 49/49, agent 18/18 — a handful of unrelated integration tests are flaky only under full-suite concurrency; isolated they pass) exit clean.

**Two real bugs surfaced by running the suite (both fixed, not in the original commit):**
1. `withVerifiedOwner` (`src/providers/core/credential-owner.ts`) dropped its old cookie-only guard with no replacement, so `otlp.plugin.ts`'s tick started probing `/v1/user` for the bearer-auth (`jwt` provider) profile's static, `source: 'explicit'` token too — a call that profile never made before and that the design doc's non-goals explicitly keep unchanged. Fixed by skipping the lookup when `auth.source === 'explicit'`. Caught by the pre-existing, untouched-by-this-branch `sso.proxy.client-gate.test.ts`.
2. Five test cases (one in `connect-orchestrator.test.ts`'s SSO-check test, three in its non-interactive `--yes` tests, four in `index.test.ts`'s "proxy start" suite) were migrated to construct a `cookieAuth`/`toSSOAuth` fixture but still tried to mock the removed `CodeMieSSO.getStoredCredentials` or assert on the removed `CodeMieSSO` class instead of the file's existing `storedCookies` (`CredentialStore.retrieveSSOCredentials`) hoisted mock that the resolver actually reads through. Fixed by switching those assertions/setup to `storedCookies`, matching the pattern every other test in both files already uses.

**Unrelated to this plan, not fixed (pre-existing on `main`, confirmed by reproducing with `main`'s own code/tests):** `client-attribution.plugin.test.ts` and `hook-stdout.test.ts`/`claude-analytics-disable.test.ts` are flaky only under full-suite concurrency (pass in isolation); `proxy-daemon-lifecycle.test.ts` has a benign unhandled-rejection race after a real SIGTERM (all 11 assertions still pass). Also: running this repo's tests from inside a live `codemie-claude`/`codemie-code` session leaks real `CODEMIE_*` env vars (notably `CODEMIE_BASE_URL`) into the child process — `launch-identity.test.ts`, `sso.auth-gate.integration.test.ts` and `config-per-profile-identity.test.ts` fail under that contamination but pass once those vars are cleared; this is a pre-existing gap in those tests' env-clearing list, not something this plan touches.

Historical note (from the pre-implementation revision): `AnalyticsAuth` with a `bearer` kind, `loadAnalyticsAuth`, `jwtToken` plumbing, per-tick cookie↔jwt switching in `sso.session-sync.plugin.ts`, and `getStoredPlatformAuthCredentials` were already present before this plan started and were reused rather than rebuilt; all of them are now superseded by the resolver API below.

## Global Constraints

- ES modules, `.js` suffix on every relative import, `@/` alias instead of deep `../../..`, explicit return types on exports, no `any`.
- Never log cookie values or tokens. Use `sanitizeLogArgs()`. Logging cookie *names* and counts is fine, as today.
- Storage is unchanged. Each write goes to the OS keychain (best effort) **and** always to an encrypted file. Cookie records stay in the SSO slot (`deriveUrlStorageKey`), JWT records in `jwt-<deriveUrlStorageKey>`. The only additions are the optional fields `authType: 'cookie' | 'jwt'` and `storedAt: number`.
- Callback rule: the callback has usable cookies → save **only** the cookie record. It has no usable cookies but a JWT → save the JWT record. The other type's slot for that URL is cleared either way.
- Read rule:
  1. newest marked usable, unexpired record (`storedAt`);
  2. else, with unmarked records only, usable cookies first, else JWT;
  3. an unmarked record coexisting with a marked record of the other type wins.
- A running proxy adopts a changed credential type on refresh, with no restart. Anything with `source: 'explicit'` is never re-read. That covers `--jwt-token`, `CODEMIE_JWT_TOKEN`, and the bearer-auth profile's stored token.
- No feature may switch itself off by credential type. Branching on `SSOAuth.type` is allowed only inside `src/providers/plugins/sso/auth/`.
- One Cookie header format everywhere: `buildCookieHeader` (`'; '`-joined, invalid entries dropped). This replaces the unfiltered `;`-joined headers in `buildAuthHeaders`, the statusline and the `config.js` fetch.
- Keep lazy `await import(...)` of SSO code in hook, statusline and other short-lived paths where it exists today.
- Repo policy (AGENTS.md): **tests are written or run only on the user's explicit request, and git operations likewise.** Tasks 1–10 verify with `npm run typecheck`, `npm run lint` and `npm run build`, and have no commit steps. Task 11 (tests) runs only on request.

## Behaviour changes, deliberately accepted

1. A JWT now gets the same lookup rules as cookies: the profile-origin filter, and a same-origin global-slot fallback. Today's JWT fallback has neither, so a JWT issued for another host is no longer used for a platform profile.
2. An SSO-issued JWT now gets an owner email (`withVerifiedOwner`), the `preferred_username` claim fallback, the analytics supersede check and session-expiry re-login. These were cookie-only before.
3. A bearer-auth profile's stored token is read once at proxy start and never re-read. `--jwt-token` / env tokens were already static.
4. The statusline now skips expired records and invalid cookie entries.
5. The Cookie header is `'; '`-joined everywhere (see Global Constraints).

## Review Focus

Runtime tests for these live in Task 11 (repo policy). Until then the reviewer checks them by reading the code.

1. **Upgrade with legacy, unmarked records.** A user with an old cookie or JWT record must resolve exactly as before, with no re-login. → `selection.test.ts › legacy unmarked cookie wins over unmarked jwt`.
2. **A new JWT-only login over old cookie records** (current key, legacy key, same-origin global slot). All three must be cleared. → `resolver.test.ts › jwt login clears every cookie key for the host`.
3. **Long-running proxy, re-login flips cookie → JWT.** The next request carries `authorization: Bearer …`, and session sync and the OTLP forwarder switch too. → `credential-refresh.test.ts › adopts a re-read of another type`.
4. **Session-expiry replay after a type flip.** The replayed request carries only the new type's header, with no stale `cookie` next to `authorization`. → `sso-session-expiry.plugin.test.ts › replay after type change sends only the new header`.
5. **A callback whose cookies are all invalid, plus a JWT.** The JWT is saved and `config.js` is fetched with Bearer. → `sso.auth.test.ts › unusable cookies fall back to jwt`.

---

## File Structure

New, in `src/providers/plugins/sso/auth/`:

| File | Responsibility |
|---|---|
| `types.ts` | `SSOAuth` union, `SSOAuthType`, `SSOAuthSource`, `StoredRecordOf<T>`, `SSOAuthStrategy` |
| `selection.ts` | **Keytar-free.** Pure functions: cookie-header helpers, `isRecordUsable`, `recordExpiresAt`, `selectRecord`, `recordFingerprint`, `toSSOAuth`. Imports only `node:crypto` and types. |
| `jwt-claims.ts` | **Built, not in the original plan.** Keytar-free, logger-free `decodeJwtExpiresAt(token)` — pure `exp`-claim decode, pulled out on its own so the esbuild-bundled statusline doesn't pull in anything beyond `selection.ts`'s consumers. Used by both strategies and `resolver.ts`. `cookie.strategy.ts` re-derives the old `deriveExpiresAt(cookies)` name on top of it and re-exports it from `sso.auth.ts` for `sso.auth.test.ts`. |
| `strategies/cookie.strategy.ts`, `strategies/jwt.strategy.ts`, `strategies/index.ts` | Per-type store access, and building records from the callback |
| `resolver.ts` | Public resolve/store/clear functions |
| `material.ts` | The bridges to existing call shapes: `authMaterial`, `toProcessingAuthFields`, `toSdkAuthOptions`, plus `describeAuthForLog` (not in the original plan — returns `AuthLogDescription`: `{ type }` for jwt, `{ type, cookieCount, cookieNames, droppedCookieNames }` for cookies, no secret values; used by `auth-injection.plugin.ts`, `sso.session-sync.plugin.ts` and `test-metrics.ts` instead of each building its own debug summary) |
| `index.ts` | Public exports |

Deleted: `sso/sso.expiry.ts`, `sso/proxy/plugins/sso-auth.plugin.ts` and `sso/proxy/plugins/jwt-auth.plugin.ts`. The two plugins are replaced by `sso/proxy/plugins/auth-injection.plugin.ts`.

**Status: all 11 tasks implemented** (commit `05929518`, rebased as `c51d0947`). Every checkbox below reflects the actual code, verified by reading the referenced files and by `grep`-sweeping for leftover references to the removed APIs (clean except the exempt files listed in Task 10). Task 11's "run the suite" step is left unchecked since this update did not run tests.

---

### Task 1: Types and the keytar-free selection core

**Files:**
- Create: `src/providers/plugins/sso/auth/types.ts`, `src/providers/plugins/sso/auth/selection.ts`
- Modify: `src/providers/core/types.ts` (`SSOCredentials` ≈ :463, `JWTCredentials` ≈ :473)
- Modify: `src/providers/plugins/sso/session/cookie-auth.ts`. Move the bodies of `hasUsableCookies` (:10), `droppedCookieKeys` (:18), `buildCookieHeader` (≈ :72) and the private `hasInvalidHeaderChars` out, and re-export the three public ones.

**Interfaces:**
- Produces (`auth/types.ts`):
  ```ts
  export type SSOAuthType = 'cookie' | 'jwt';
  export type SSOAuthSource = 'store' | 'explicit';
  interface SSOAuthBase {
    type: SSOAuthType; apiUrl: string; url: string; expiresAt?: number;
    headers: Readonly<Record<string, string>>;
    /** Value a request is sent with: the Cookie header, or the bare token. Used by supersede checks. */
    authValue: string;
    /** Stable, non-secret hash of the login. */
    fingerprint: string;
    identityToken?: string; email?: string; source: SSOAuthSource;
  }
  export interface CookieSSOAuth extends SSOAuthBase { type: 'cookie'; cookies: Record<string, string>; }
  export interface JwtSSOAuth extends SSOAuthBase { type: 'jwt'; token: string; }
  export type SSOAuth = CookieSSOAuth | JwtSSOAuth;
  export type StoredRecordOf<T extends SSOAuthType> = T extends 'cookie' ? SSOCredentials : JWTCredentials;
  export interface SSOAuthStrategy<T extends SSOAuthType = SSOAuthType> {
    readonly type: T;
    /** Includes expired records, so the resolver can clear them. */
    load(url: string): Promise<StoredRecordOf<T> | null>;
    loadGlobal(): Promise<StoredRecordOf<T> | null>;
    /** This type's record from a callback result; null when the payload has no usable material for it. */
    fromCallback(result: SSOAuthResult, storedAt: number): StoredRecordOf<T> | null;
    save(record: StoredRecordOf<T>, url: string): Promise<void>;
    /** Clears current key, legacy key, and the global slot when its apiUrl origin matches url's origin. */
    clear(url?: string): Promise<void>;
  }
  ```
- Produces (`auth/selection.ts`):
  ```ts
  export function buildCookieHeader(cookies: Record<string, string>): string;              // moved verbatim
  export function hasUsableCookies(cookies: unknown): cookies is Record<string, string>; // moved verbatim
  export function droppedCookieKeys(cookies: Record<string, string>): string[];          // moved verbatim
  export interface RecordCandidate { type: SSOAuthType; record: SSOCredentials | JWTCredentials; }
  export function isRecordUsable(c: RecordCandidate): boolean;
  export function recordExpiresAt(c: RecordCandidate): number | undefined;
  export function selectRecord(candidates: RecordCandidate[], now?: number): RecordCandidate | null;
  export function recordFingerprint(c: RecordCandidate): string;
  export function toSSOAuth(c: RecordCandidate, url: string, source?: SSOAuthSource): SSOAuth;
  ```
  The name `recordFingerprint` avoids a clash with the private `fingerprintOf` in `sso-session-expiry.plugin.ts:131`.

- [x] **Step 1: Add the optional marker fields** in `core/types.ts`: `authType?: 'cookie'` / `authType?: 'jwt'` and `storedAt?: number` on `SSOCredentials` / `JWTCredentials`. Each gets a doc comment saying it is absent on records written before 2026-11. Keep `isJWTCredentials` / `isSSOCredentials` for now; Task 10 restricts them.

- [x] **Step 2: Write `auth/types.ts`** as in the Interfaces block.

- [x] **Step 3: Write `auth/selection.ts`.**
  - Move the cookie helpers verbatim.
  - `isRecordUsable`: cookie → `buildCookieHeader(record.cookies) !== ''`; jwt → non-empty `token`.
  - `recordExpiresAt`: today's `effectiveExpiresAt` (`sso.expiry.ts`). Cookie → `expiresAt` only when a `codemie_access_token` cookie is present; jwt → `expiresAt`.
  - `selectRecord`: drop candidates that are unusable or expired at `now`. Then:
    1. If an unmarked candidate coexists with a marked candidate of the other type, return the unmarked one.
    2. Else, if any candidate is marked, return the one with the highest `storedAt`.
    3. Else return the first in `[cookie, jwt]` order.
  - `recordFingerprint`: cookie → `sha256(JSON.stringify([apiUrl, sortedCookieEntries]))`, which is **exactly today's `credentialFingerprint`** (`credential-owner.ts:31-34`), so owner and pending files on disk stay valid. jwt → `sha256(JSON.stringify([apiUrl, 'jwt', token]))`. Output is hex.
  - `toSSOAuth`:
    - cookie: `headers = { cookie: buildCookieHeader(cookies) }`, `authValue` = that header, `identityToken = cookies.codemie_access_token`, `email = record.email`.
    - jwt: `headers = { authorization: \`Bearer ${token}\` }`, `authValue = token`, `identityToken = token`. `JWTCredentials` has no `email`, so it's set later by `withVerifiedOwner`.
    - `expiresAt = recordExpiresAt(c)`. `source` defaults to `'store'`.
  - Imports: `node:crypto` and `import type` from `@/providers/core/types.js` only. No logger, no `security.js`.

- [x] **Step 4: Point `cookie-auth.ts` at the moved helpers:** `export { buildCookieHeader, hasUsableCookies, droppedCookieKeys } from '../auth/selection.js';`.

- [x] **Step 5: Verify**
  Run: `npm run typecheck && npm run lint`
  Expected: exit 0, zero warnings.

---

### Task 2: Strategies, resolver, bridges, fetch overloads

**Files:**
- Create: `auth/strategies/cookie.strategy.ts`, `auth/strategies/jwt.strategy.ts`, `auth/strategies/index.ts`, `auth/resolver.ts`, `auth/material.ts`, `auth/index.ts`
- Modify `src/utils/security.ts`:
  - `retrieveJWTCredentials(baseUrl?, opts?: { includeExpired?: boolean })`. Today it returns null for an expired JWT without clearing it (:607-657). Default behaviour is unchanged.
  - Add the legacy `jwt-<deriveLegacyUrlStorageKey>` read fallback, like the SSO read has.
  - `clearJWTCredentials` also deletes the legacy key, like `clearSSOCredentials` does.
- Modify `src/providers/core/codemie-auth-helpers.ts`: export `originOf` (:119), `isLoopbackUrl` (:131) and `platformSourceFromEnv` (:167), plus a new `getProfileOrigin(src: PlatformUrlSource): string | undefined` that holds the `profileOrigin` expression from `lookupStoredCredentials` (:204-207).
- Modify `src/providers/plugins/sso/sso.http-client.ts`: add a third, union overload `auth: Record<string, string> | string` to `fetchCodeMieLlmModels` (:298), `fetchCodeMieModels` (:341) and `fetchCodeMieIntegrations` (:455). Do the same in `codemie-auth-helpers.ts` for `fetchCodeMieUserInfo` (:337). The implementations already take the union.

**Interfaces:**
- Consumes: Task 1; `getPlatformUrlCandidates`, `getAnalyticsPlatformSource` (existing).
- Produces (re-exported from `auth/index.ts`):
  ```ts
  export function resolveSSOAuth(src: PlatformUrlSource): Promise<SSOAuth | null>;
  export function resolveSSOAuthFromEnv(env: NodeJS.ProcessEnv): Promise<SSOAuth | null>;
  export function resolveAnalyticsSSOAuth(ssoUrl: string | undefined, env?: NodeJS.ProcessEnv,
    overrides?: { provider?: string; baseUrl?: string }): Promise<SSOAuth | null>;
  export function resolveSSOAuthForUrl(url: string, opts?: { allowGlobalFallback?: boolean }): Promise<SSOAuth | null>;
  export function storeSSOAuth(result: SSOAuthResult, codeMieUrl: string): Promise<SSOAuth | null>;
  export function clearSSOAuth(url?: string): Promise<void>;
  export function explicitJwtAuth(token: string, apiUrl: string): JwtSSOAuth;
  export function authMaterial(auth: SSOAuth): Record<string, string> | string;
  export function toProcessingAuthFields(auth: SSOAuth): { cookies: string; jwtToken?: string };
  export function toSdkAuthOptions(auth: SSOAuth): { cookies: Record<string, string> } | { jwt_token: string };
  export type { SSOAuth, CookieSSOAuth, JwtSSOAuth, SSOAuthType } from './types.js';
  export { buildCookieHeader, hasUsableCookies, droppedCookieKeys } from './selection.js';
  ```

- [x] **Step 1: Write the strategies.**
  - The cookie strategy wraps `CredentialStore.{retrieve,store,clear}SSOCredentials`. The jwt strategy wraps `retrieveJWTCredentials(url, { includeExpired: true })` and its store/clear.
  - `fromCallback`:
    - cookie → a record only when `hasUsableCookies(result.cookies)` and `result.apiUrl`, with `expiresAt` from `codemie_access_token`'s `exp`.
    - jwt → a record when `result.jwt` and `result.apiUrl` are present, with `expiresAt` from the token's `exp`.
    - Both set `authType` and `storedAt`.
  - Move `decodeJwtExpiresAt` / `deriveExpiresAt` from `sso.auth.ts` (:48, :71) into `cookie.strategy.ts`. Only `sso.auth.test.ts` imports `deriveExpiresAt`.
  - `clear(url)`: current and legacy keys via the store, then the global slot when its record's `apiUrl` origin equals `originOf(url)`. `clear()` with no URL clears only the global slot.

- [x] **Step 2: Write `strategies/index.ts`:** `export const STRATEGIES: readonly SSOAuthStrategy[] = [cookieStrategy, jwtStrategy];`.

- [x] **Step 3: Write `resolver.ts`.**
  - **`resolveSSOAuthForUrl(url, { allowGlobalFallback = true })`:** for each strategy, `load(url)`. If that's null and fallback is allowed, use `loadGlobal()`, kept only when `originOf(record.apiUrl) === originOf(url)`. Call `strategy.clear(url)` for every expired candidate. Then `selectRecord` and `toSSOAuth(selected, url)`.
  - **`resolveSSOAuth(src)`:** today's `lookupStoredCredentials` loop (:200-229), applied to `resolveSSOAuthForUrl`, with the `getProfileOrigin` filter on `auth.apiUrl`. Return the first hit.
  - **`resolveSSOAuthFromEnv`** → `resolveSSOAuth(platformSourceFromEnv(env))`. **`resolveAnalyticsSSOAuth`** → `resolveSSOAuth(getAnalyticsPlatformSource(...))`.
  - **`storeSSOAuth`:**
    1. `storedAt = Date.now()`.
    2. Take the first strategy with a `fromCallback` record. If none has one, return null.
    3. `save(record, codeMieUrl)`, then `clear(codeMieUrl)` on every other strategy.
    4. Return `toSSOAuth`.
  - **`clearSSOAuth(url)`:** clear on all strategies.
  - **`explicitJwtAuth`:** `toSSOAuth({ type: 'jwt', record: { token, apiUrl } }, apiUrl, 'explicit')`.

- [x] **Step 4: Write `material.ts`.** Three exhaustive `switch (auth.type)` blocks with `never` defaults:
  - `authMaterial`: cookie → `auth.cookies`; jwt → `auth.token`.
  - `toProcessingAuthFields`: cookie → `{ cookies: auth.authValue }`; jwt → `{ cookies: '', jwtToken: auth.token }`.
  - `toSdkAuthOptions`: cookie → `{ cookies: auth.cookies }`; jwt → `{ jwt_token: auth.token }`. These are the SDK option names in `sdk-client.ts:99-101`.

- [x] **Step 5: Write `auth/index.ts`** with exactly those exports.

- [x] **Step 6: Verify**
  Run: `npm run typecheck && npm run lint`
  Expected: exit 0.

---

### Task 3: Identity and owner on `SSOAuth`

**Files:**
- Modify: `src/providers/core/credential-owner.ts`, `src/agents/core/identity-resolver.ts`, `src/agents/core/evidence/stamp.ts`, `src/agents/core/evidence/hook-identity.ts`, `src/agents/core/event-fields/identity-fields.ts`, `src/providers/plugins/sso/proxy/plugins/otlp-spool/owner-pending-replay.ts`, `src/agents/core/hook-credentials.ts`

**Interfaces:**
- Consumes: `SSOAuth`, `resolveSSOAuthForUrl`, `authMaterial`.
- Produces:
  - `withVerifiedOwner(auth: SSOAuth): Promise<SSOAuth>`. Today it's generic over the old union (:71).
  - `credentialFingerprint(auth: SSOAuth): string`, which returns `auth.fingerprint`.
  - `resolveEmailFromCredentials(auth: SSOAuth | null): string`.
  - `resolveIdentity(auth: SSOAuth | null, cwd)` (identity-resolver.ts:157).
  - `resolveHookCredentials(): Promise<SSOAuth | null>`.
  - `processPendingOwner(auth: SSOAuth | undefined, now?)`.

- [x] **Step 1: Update `credential-owner.ts`.** `withVerifiedOwner` drops the `isSSOCredentials` / cookie-count guard (:73). It runs for any `SSOAuth` with an `apiUrl` and calls `fetchCodeMieUserInfo(auth.apiUrl, authMaterial(auth), {...same options})`. The owner record key stays `auth.fingerprint`.

- [x] **Step 2: Update `identity-resolver.ts`.** `resolveEmailFromCredentials` decodes `auth.identityToken` (`email`, then `preferred_username`), then falls back to `auth.email`. Remove the type branches (:45-60). `resolveIdentity` takes `SSOAuth | null`.

- [x] **Step 3: Update `stamp.ts`, `owner-pending-replay.ts`, `hook-identity.ts` and `identity-fields.ts`.** Retype to `SSOAuth`. Replace the `isSSOCredentials` + cookie-count guards (`stamp.ts:73`, `owner-pending-replay.ts:138`) with `if (!auth) return …`. Key by `auth.fingerprint`.

- [x] **Step 4: Update `hook-credentials.ts`.** Swap `sso.getStoredCredentials(x)` for `resolveSSOAuthForUrl(x)`, same order (`syncCodeMieUrl`, then `targetUrl`). The return type becomes `SSOAuth | null`, and the doc comment should say JWT is now reachable.

- [x] **Step 5: Verify**
  Run: `npm run typecheck`
  Expected: no errors in this task's files. Errors in callers owned by later tasks are expected; list them in the task report.

---

### Task 4: Browser callback stores through the resolver

**Files:**
- Modify: `src/providers/plugins/sso/sso.auth.ts`, `src/providers/core/codemie-auth-helpers.ts` (`authenticateWithCodeMie`, :92-102)

**Interfaces:**
- Consumes: `storeSSOAuth`, `clearSSOAuth`, `hasUsableCookies`, `withVerifiedOwner(SSOAuth)`.
- Produces:
  - `export type SSOLoginResult = SSOAuthResult & { auth?: SSOAuth }` (in `auth/types.ts`).
  - `CodeMieSSO.authenticate(config): Promise<SSOLoginResult>` and `authenticateWithCodeMie(url, timeout): Promise<SSOLoginResult>`.
  - `CodeMieSSO.clearStoredCredentials(url?)` delegates to `clearSSOAuth`.
  - `CodeMieSSO.getStoredCredentials` is **removed**.
  - Other `authenticate` callers (`sso.setup-steps.ts:327`, `profile/auth.ts:78`, `bin/sso-login.ts:22`) still compile, because the result type only widens.

- [x] **Step 1: Replace step 5 of `authenticate()`.** Both storage branches (:149-182) become:
  ```ts
  const auth = result.success ? await storeSSOAuth(result, this.codeMieUrl) : null;
  if (auth) { auth.email = (await withVerifiedOwner(auth)).email; await clearAnalyticsAuthStatus(); }
  return { ...result, ...(auth ? { auth } : {}) };
  ```
  The JWT branch didn't call `withVerifiedOwner` before; now it does.

- [x] **Step 2: Fix `handleCallback`.**
  - Compute `hasCookies` with `hasUsableCookies(token.cookies)` (:396), so all-invalid cookies count as "no cookies" and the `config.js` fetch uses Bearer.
  - Build the cookie header there with `buildCookieHeader` (:416-418).
  - Return `cookies` only when usable.

- [x] **Step 3: Delete the old helpers.** Remove `getStoredCredentials` (:217-252), `normalizeToBase` if it's now unused, the moved JWT-decode helpers, and the `effectiveExpiresAt` re-export (:75). Keep a re-export of `deriveExpiresAt` from the cookie strategy for the test file.

- [x] **Step 4: Widen `authenticateWithCodeMie`'s return type** to `SSOLoginResult`.

- [x] **Step 5: Verify**
  Run: `npm run typecheck`
  Expected: the remaining errors are only callers of `getStoredCredentials` / `effectiveExpiresAt` that belong to Tasks 5–8.

---

### Task 5: Analytics and supersede checks are type-agnostic

This runs before the proxy tasks: `sso-session-expiry` and `session-sync` consume the renamed functions.

**Files:**
- Modify (under `src/providers/plugins/sso/session/`): `cookie-auth.ts`, `analytics-auth.ts`, `bearer-auth.ts` (delete if unused afterwards), `analytics-auth-marker.ts`
- Modify: `src/cli/commands/hook/analytics-auth.ts` (`loadAnalyticsAuth`, :15), `src/telemetry/runtime/DesktopSessionMetrics.ts` (`loadAuth`, :59-77)
- Delete: `src/providers/plugins/sso/sso.expiry.ts`, after moving its importers (`sso.health.ts` and others found by grepping `effectiveExpiresAt`) to `SSOAuth.expiresAt`.
- **No change needed:** `codex` / `opencode` / `pi` `*.incremental-sync.ts`, `hook.ts`, `hook/end-metric.ts`, `hook/processing-context.ts`. They use `readAnalyticsAuth` / `analyticsAuthFields` / `loadAnalyticsAuth`, whose signatures stay.

**Interfaces:**
- Consumes: `resolveAnalyticsSSOAuth`, `resolveSSOAuthForUrl`, `SSOAuth.authValue`.
- Produces:
  - `interface AuthSource { refreshNow(): Promise<SSOAuth | null> }` (replaces `CookieSource`).
  - `supersedingAuthValue(sent: string | undefined, source?: AuthSource): Promise<string | null>` (replaces `supersedingCookieHeader`).
  - `sentCredentialsSuperseded(sent, source?)` (parameter renamed).
  - `resolveAnalyticsAuth(read: () => Promise<SSOAuth | null>, opts?)`.
  - `CredentialsSupersededCheck` keeps the signature `(sentAuthValue: string) => Promise<boolean>`, and now takes a cookie header or a token.
  - `analyticsAuthFields` returns `credentialsSuperseded` for `bearer` too.

- [x] **Step 1: Update `cookie-auth.ts`.**
  - `CookieSet` / `CookieSource` → `AuthSource`.
  - `supersedingCookieHeader` → `supersedingAuthValue`, comparing `fresh.authValue` with `sent`.
  - `buildCookieAuth(first: CookieSSOAuth, source: AuthSource, readTimedOut)`.
  - Delete `cookieSourceOf` (:47).

- [x] **Step 2: Rework `resolveAnalyticsAuth`** with an exhaustive switch on `SSOAuth.type`:
  - cookie → `{ kind: 'cookies', ...buildCookieAuth(...) }`;
  - jwt → `{ kind: 'bearer', jwtToken: auth.token, readTimedOut, credentialsSuperseded: (s) => sentCredentialsSuperseded(s, source) }`.

  An `authValue` of `''` yields `none`. `readAnalyticsAuth` calls `resolveAnalyticsSSOAuth`. Fold `buildBearerAuth` in and delete `bearer-auth.ts` once nothing else imports it.

- [x] **Step 3: Update `analytics-auth-marker.ts`.** At :102 the supersede test runs when `(cookies || jwtToken) && credentialsSuperseded`, passing `cookies || jwtToken`.

- [x] **Step 4: Update `DesktopSessionMetrics.loadAuth`.** It becomes `resolveAnalyticsAuth(() => resolveSSOAuthForUrl(credentialsUrl), { deadlineMs: PROXY_STORE_READ_DEADLINE_MS })`, followed by the existing `analyticsAuthFields`. The `hasUsableCookies` / `retrieveJWTCredentials` block goes away.

- [x] **Step 5: Delete `sso.expiry.ts`.** Replace every `effectiveExpiresAt(creds)` with `auth.expiresAt`.

- [x] **Step 6: Verify**
  Run: `npm run typecheck && npm run lint`
  Expected: no errors under `sso/session/`, `cli/commands/hook/` or `telemetry/`. Errors in proxy plugins that use `supersedingCookieHeader` / `cookieSourceOf` are expected; they're fixed in Task 7.

---

### Task 6: Proxy core: one refresher type, one auth interceptor, live type switch

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/auth-injection.plugin.ts`
- Delete: `sso-auth.plugin.ts`, `jwt-auth.plugin.ts` (same directory)
- Modify: `proxy/plugins/index.ts` (:13-14 imports, :42-43 register, :69-70 exports), `proxy/plugins/types.ts` (`PluginContext`, :48-67), `proxy/proxy-types.ts` (`ProxyContext`), `proxy/plugins/credential-refresh.ts`, `proxy/sso.proxy.ts`
- Modify: `src/providers/plugins/jwt/jwt.utils.ts` (new helper), `src/cli/commands/doctor/checks/JWTAuthCheck.ts` (:39, :67)

**Interfaces:**
- Consumes: `SSOAuth`, `resolveSSOAuth`, `resolveSSOAuthForUrl`, `explicitJwtAuth`.
- Produces:
  - `PluginContext.credentials?: SSOAuth`, `syncCredentials?: SSOAuth`, `credentialRefresher?: CredentialRefresher`, `syncCredentialRefresher?: CredentialRefresher`.
  - `ProxyContext.sentAuth?: SSOAuth`: the credential the auth interceptor injected into this request, read by session-expiry in Task 7.
  - `class CredentialRefresher`, no longer generic: `constructor(initial: SSOAuth, params: CredentialRefreshParams)`, `get(): SSOAuth`, `refresh(): Promise<SSOAuth>`, `refreshNow(): Promise<SSOAuth | null>`.
  - `class AuthInjectionPlugin`: `id = '@codemie/proxy-auth'`, `priority = 10`, registered where `SSOAuthPlugin` is today, so its order relative to `OtlpPlugin` (also priority 10) is unchanged.
  - `loadStoredJwtToken(url: string): Promise<string | null>` in `jwt.utils.ts`, for the bearer-auth profile only.

- [x] **Step 1: Add `loadStoredJwtToken`.** Move the body of `CodeMieProxy.loadJWTFromStore()` (sso.proxy.ts:850) into `jwt.utils.ts`, use it in the `AuthMethod.JWT` branch and in both `JWTAuthCheck.ts` calls, and delete `loadJWTFromStore`.

- [x] **Step 2: Rework `CodeMieProxy.start()`.**
  - **JWT method:** `const token = explicitToken ?? await loadStoredJwtToken(targetApiUrl)`. If missing, throw today's `AuthenticationError`. Otherwise `credentials = explicitJwtAuth(token, targetApiUrl)`, which is `source: 'explicit'` and never re-read.
  - **SSO method:** keep the `provider.authType === 'sso'` gate (:91). Inside it, `credentials = await resolveSSOAuth({ provider, baseUrl: targetApiUrl, codeMieUrl: syncCodeMieUrl })`. The `hasUsableCookies` check and the JWT fallback (:95-113) go away.
  - **Sync:** `syncCredentials = syncCodeMieUrl ? await resolveSSOAuthForUrl(syncCodeMieUrl) : null` (:124-133).
  - **Sync source:** replace the `cookieSyncSource` selection (:150-155) with `syncSource = syncCredentials ?? credentials ?? null`. **Keep** `syncOnlyRefresherParams` (:162-165) and the "reuse `credentialRefresher` when `syncSource === credentials`" rule (:170-174) exactly as they are.

- [x] **Step 3: Rework `CredentialRefresher`.**
  - `T` becomes `SSOAuth`.
  - `readStoredCredentials()` (:219-236) calls `resolveSSOAuth(this.params)` and **returns whatever type it gets**. Delete the "another kind than the snapshot" rejection (:227-230).
  - When the adopted type differs from `current.type`, log once at `info`: `[credential-refresh] credential type changed: cookie -> jwt` (types only).
  - `staticCredentials` or `current.source === 'explicit'` means "never re-read".

- [x] **Step 4: Write `AuthInjectionPlugin`.**
  - `createInterceptor` returns a no-op when there is no `credentialRefresher`.
  - The interceptor's `onRequest`:
    1. `const auth = await refresher.refresh()`.
    2. If `auth.expiresAt` has passed → throw `AuthenticationError('Stored credentials expired. Run \`codemie profile login\` and reconnect the proxy.')`.
    3. For cookies with `droppedCookieKeys(auth.cookies).length > 0` → today's `logger.warn` from `SSOAuthInterceptor`.
    4. If `auth.authValue === ''` → today's "Stored SSO session cookies are invalid…" error.
    5. `Object.assign(context.headers, auth.headers)` and `context.sentAuth = auth`.
    6. Debug log: `type` and `cookieCount`, or the token's first 20 characters, as today.

- [x] **Step 5: Register only `AuthInjectionPlugin`** in `proxy/plugins/index.ts`, updating the imports, registration and exports.

- [x] **Step 6: Verify**
  Run: `npm run typecheck`
  Expected: no errors in this task's files. The remaining errors are in Task 7's files.

---

### Task 7: Proxy plugins and the OTLP chain read the current `SSOAuth`

**Files (under `src/providers/plugins/sso/proxy/plugins/`):**
- `sso-session-expiry.plugin.ts`, `sso.session-sync.plugin.ts`
- `claude-request-normalizer.plugin.ts` (:342), `codex-request-normalizer.plugin.ts` (:271), `desktop-models.plugin.ts` (:127)
- `otlp.plugin.ts` (:67, :158-173, :441)
- `otlp-spool/auth-state.ts`, `otlp-spool/classification.ts` (:37-38, :46, :139), `otlp-spool/tick-processor.ts`, `otlp-spool/forwarder.ts` (:65, :163, :388, :459, :499, :573), `otlp-spool/evidence-send.ts`, `otlp-spool/spool-evidence.ts` (:28)
- Also: `src/bin/proxy-daemon.ts`

**Interfaces:**
- Consumes: `CredentialRefresher`, `ProxyContext.sentAuth` (Task 6); `authMaterial`, `toProcessingAuthFields`, `resolveSSOAuth`, `resolveSSOAuthForUrl`; `supersedingAuthValue`, `AuthSource` (Task 5).
- Produces: `resolveFreshCredentials(config: ProxyConfig): Promise<SSOAuth | null>` (auth-state.ts); `authHeadersFor(auth: SSOAuth): Record<string, string>` (classification.ts). Every OTLP forwarder function that takes `SSOCredentials | JWTCredentials` takes `SSOAuth`.

- [x] **Step 1: Update `sso-session-expiry.plugin.ts`.**
  - `createInterceptor` drops the `'cookies' in` guard (:159). It enables whenever `credentialRefresher` exists and `context.config.authMethod !== AuthMethod.JWT`; the bearer-auth profile keeps today's no-op.
  - The loop guard and the supersede decision use `context.sentAuth` instead of hashing `context.headers['cookie']` (:189, :210). Record `sentAuth.fingerprint`. A request counts as superseded when the stored `SSOAuth`'s `fingerprint` differs from `sentAuth.fingerprint`.
  - `storedCookieHeader()` (:268) becomes `storedAuth(): Promise<SSOAuth | null>` (from `refreshNow()`, non-empty `authValue`).
  - The replay (:290) deletes **both** `cookie` and `authorization` from the replay headers, then assigns `stored.headers`, so a type flip never sends both.
  - Delete the private `fingerprintOf` (:131) and `RejectedCookies`, renaming the latter to `RejectedCredential`.
  - Update the header comment where "cookies" now means "credential".

- [x] **Step 2: Update `sso.session-sync.plugin.ts`.** Both the initial build (:171-172) and the per-tick refresh (:262-270) call `Object.assign(this.context, toProcessingAuthFields(auth))`. `buildSyncCookieHeader` (:283-292) is `buildCookieHeader` plus logging, so keep only its logging around the call. `credentialsSuperseded` uses `AuthSource` over `this.credentials` instead of `cookieSourceOf` (:182).

- [x] **Step 3: Update the two normalizers and `desktop-models.plugin.ts`.** They already call `context.credentialRefresher.refresh()`. Replace only the `'cookies' in credentials ? … : …` expressions with `fetchCodeMieLlmModels(apiUrl, authMaterial(auth), project)`.

- [x] **Step 4: Update the OTLP chain.**
  - Retype `otlp.plugin.ts`, `tick-processor.ts`, `forwarder.ts`, `evidence-send.ts`, `spool-evidence.ts` (`forwarderIdentity`) and `classification.ts` (`sessionPolicyState`, `resolveAnalyticsEndpoint`) from `SSOCredentials | JWTCredentials` to `SSOAuth`.
  - `authHeadersFor(auth)` = `buildAuthHeaders(authMaterial(auth))`, replacing the `isSSOCredentials` / `isJWTCredentials` lines (:37-38).
  - `otlp.plugin.ts` reads `context.syncCredentialRefresher ?? context.credentialRefresher` at forward time instead of `context.syncCredentials || context.credentials` captured at start, so a type flip reaches telemetry.

- [x] **Step 5: Update `otlp-spool/auth-state.ts`.** `resolveFreshCredentials` = `(config.syncCodeMieUrl ? await resolveSSOAuthForUrl(config.syncCodeMieUrl) : null) ?? await resolveSSOAuth({ provider: config.provider, baseUrl: config.targetApiUrl, codeMieUrl: config.syncCodeMieUrl })`. Delete the `hasUsableCookies` / `retrieveJWTCredentials` fallback (:54-69).

- [x] **Step 6: Update `proxy-daemon.ts`.** Replace its `getStoredPlatformAuthCredentials` / credential-shape use with `resolveSSOAuth`.

- [x] **Step 7: Verify**
  Run: `npm run typecheck && npm run lint`
  Expected: no errors under `sso/proxy/` or `src/bin/`.

---

### Task 8: SSO plugin internals, core helpers, other providers' setup, SDK and CLI

**Files:**
- SSO plugin: `sso.models.ts`, `sso.catalog.ts`, `sso.setup-steps.ts` (including `validateAuth` :247 and `getAuthStatus` :349, which back `codemie profile status` via `profile/index.ts`), `sso.health.ts`, `sso.auth-gate.ts` (:148-152)
- Core: `src/providers/core/codemie-auth-helpers.ts`, `src/providers/core/index.ts` (re-export :43), `src/providers/core/launch-project-prompt.ts`, `src/agents/core/launch-identity.ts` (:57, :127-137), `src/utils/sdk-client.ts`
- Other providers using `selectCodeMieProject`: `jwt/jwt.setup-steps.ts` (:41, :77), `anthropic-subscription/anthropic-subscription.setup-steps.ts` (:80), `moonshot-subscription/moonshot-subscription.setup-steps.ts` (:67)
- CLI: `profile/auth.ts`, `skills/lib/require-auth.ts`, `skills/lib/skills-search-client.ts` (:143-147), `skills/lib/skills-metrics.ts` (:373), `test-metrics.ts` (:99-114), `proxy/inspect-desktop.ts` (:127-142), `proxy/connectors/managed-mcp-remote.ts` (:134-153), `proxy/connect-orchestrator.ts` (:327-330)

**Interfaces:**
- Consumes: the resolver API, `authMaterial`, `toSdkAuthOptions`, `explicitJwtAuth`, `SSOLoginResult`.
- Produces:
  - `type ProjectListAuth = SSOAuth`, with `resolveProjectListAuth(config): Promise<SSOAuth | undefined>`.
  - `selectCodeMieProject(auth: SSOAuth): Promise<{ project: string; userEmail: string }>`, which replaces `SSOAuthResult | BearerProjectAuth`. `BearerProjectAuth` is deleted.
  - `LaunchProjectPromptDeps.selectIntegration?: (auth: SSOAuth, project: string) => Promise<CodeMieIntegrationInfo | undefined>`.

- [x] **Step 1: Update `codemie-auth-helpers.ts`.**
  - Delete `getStoredPlatformCredentials`, `getStoredPlatformAuthCredentials` and their `FromEnv` variants, `getStoredAnalyticsCredentials`, `getStoredAnalyticsAuthCredentials`, `lookupStoredCredentials`, `PlatformCredentials`, `PlatformAuthCredentials` and `BearerProjectAuth`.
  - `buildAuthHeaders` keeps its signature, but builds the cookie header with `buildCookieHeader`.
  - `resolveProjectListAuth`:
    - ai-run-sso → `resolveSSOAuth({ provider, baseUrl })` with `apiUrl` overridden to `ensureApiBase(baseUrl)`;
    - bearer-auth → `explicitJwtAuth(config.jwtToken, ensureApiBase(baseUrl))`;
    - other providers → `resolveSSOAuthForUrl(codeMieUrl)` with `apiUrl = ensureApiBase(auth.apiUrl || codeMieUrl)`.
  - `selectCodeMieProject` → `fetchCodeMieUserInfo(auth.apiUrl, authMaterial(auth))`.

- [x] **Step 2: Update the `selectCodeMieProject` callers.**
  - `sso`, `anthropic-subscription` and `moonshot-subscription` setup-steps pass `authResult.auth`; throw the existing `ConfigurationError` when it's missing.
  - `jwt.setup-steps.ts` passes `explicitJwtAuth(token, apiUrl)`, and its `deps.select` type follows.
  - Update the re-export in `core/index.ts`.

- [x] **Step 3: Update `launch-project-prompt.ts` and `launch-identity.ts`.**
  - `defaultFetchProjects` (:42-48) → `fetchCodeMieUserInfo(auth.apiUrl, authMaterial(auth), options)`.
  - Remove the `!('cookies' in input.auth)` gate (:139), so integration selection runs for JWT too.
  - `defaultSelectIntegration` / `selectIntegration` take `SSOAuth` and call `selectIntegrationForProject(auth.apiUrl, authMaterial(auth), project, …)`. That function already takes the union (sso.setup-steps.ts:58-61).
  - `launch-identity.ts` follows the new `ProjectListAuth`.

- [x] **Step 4: Update `sso.setup-steps.ts`.**
  - Use `authResult.auth` after login. Delete the `hasCookies ? cookies : jwt` branches (:150-210).
  - `validateAuth` and `getAuthStatus` use `resolveSSOAuth(config)` and `fetchCodeMieModels(auth.apiUrl, authMaterial(auth), undefined)`, replacing the type branches at :270-273.
  - Check what reads `additionalConfig.cookies` / `.jwt` (:192-209). If only `sso.models.ts` reads them, replace both with `additionalConfig.auth?: SSOAuth`.

- [x] **Step 5: Update `sso.models.ts`, `sso.catalog.ts` and `sso.health.ts`.** Each `getStoredPlatformAuthCredentials` + `isJWTCredentials ? token : cookies` becomes `resolveSSOAuth(...)` / `resolveSSOAuthFromEnv(env)` + `authMaterial(auth)`. `sso.catalog.ts` keeps its `CODEMIE_JWT_TOKEN` shortcut (:49-54), as `explicitJwtAuth`.

- [x] **Step 6: Update `sso.auth-gate.ts`.** `hasValidAuth = (await resolveAnalyticsSSOAuth(...same args as today's getStoredAnalyticsCredentials)) !== null`. Today this check is cookie-only, so a JWT login now counts.

- [x] **Step 7: Update `sdk-client.ts`.** `resolveSSOAuth(config)`, then pass `...toSdkAuthOptions(auth)` (:99-101). Debug logs use `auth.type`.

- [x] **Step 8: Update the CLI commands.**
  - `profile/auth.ts`: login, logout and refresh use `resolveSSOAuth(config)` for presence and `auth.url`. Logout calls `clearSSOAuth(auth?.url ?? getPlatformUrl(config))`.
  - `require-auth.ts`: presence check via `resolveSSOAuth`.
  - `skills-search-client.ts`, `skills-metrics.ts`, `test-metrics.ts`, `managed-mcp-remote.ts`: `buildAuthHeaders(authMaterial(auth))` and `auth.apiUrl`. The `test-metrics` printout reports `auth.type`, plus the cookie count for cookies.
  - `inspect-desktop.ts`: `hasCredentials: auth !== null` and a new `authType: auth?.type`. It mirrors `resolveHookCredentials`, so use the same `syncCodeMieUrl || targetUrl` order with `resolveSSOAuthForUrl`.
  - `connect-orchestrator.ts`: the resolver replaces its lookup.

- [x] **Step 9: Verify**
  Run: `npm run typecheck && npm run lint`
  Expected: exit 0 across `src/`.

---

### Task 9: Statusline shares the selection rules

**Files:**
- Modify: `src/agents/plugins/claude/plugin/statusline.ts` (`getAuthHeaders`, :67-80)

**Interfaces:**
- Consumes: `selectRecord`, `toSSOAuth` from `@/providers/plugins/sso/auth/selection.js`, which is keytar-free by Task 1's constraint.

- [x] **Step 1: Rework `getAuthHeaders(codeMieUrl)`.** Keep both `readStoredCredsFile('', url)` and `readStoredCredsFile('jwt-', url)` reads (file-only, no keychain). Build a `RecordCandidate` for each record present, run `selectRecord`, and return `toSSOAuth(selected, codeMieUrl).headers` or `null`. This adds expiry and invalid-cookie filtering (accepted behaviour change 4).

- [x] **Step 2: Verify the bundle still builds**
  Run: `npm run build`
  Expected: exit 0, and `bundle-statusline` emits with no "Could not resolve" errors. If esbuild pulls in `security.js` or keytar, fix the imports in `selection.ts`; don't add externals.

---

### Task 10: Guardrails: remove leftovers and block drift

**Files:**
- Modify: `eslint.config.mjs`, `src/providers/core/types.ts`, and any file still matching the grep below

- [x] **Step 1: Sweep for leftovers**
  Run: `grep -rnE "getStoredPlatform|getStoredAnalytics(Auth)?Credentials|getStoredCredentials\(|retrieve(SSO|JWT)Credentials|store(SSO|JWT)Credentials|clear(SSO|JWT)Credentials|isJWTCredentials|isSSOCredentials|'cookies' in|'token' in|'jwtToken' in|loadJWTFromStore|effectiveExpiresAt|cookieSourceOf|supersedingCookieHeader|BearerProjectAuth|SSOCredentials \| JWTCredentials" src --include='*.ts' | grep -v __tests__`
  Expected: matches only in `src/utils/security.ts`, `src/providers/plugins/sso/auth/**`, `src/providers/plugins/jwt/jwt.utils.ts`, `src/providers/core/types.ts` (definitions), and comments. Migrate anything else by the pattern of Tasks 3–8.

- [x] **Step 2: Add an ESLint flat-config block** for `src/**/*.ts`, with `ignores` for `src/utils/security.ts`, `src/providers/plugins/sso/auth/**`, `src/providers/plugins/jwt/**` and `**/__tests__/**`.
  - `no-restricted-syntax` selectors: `CallExpression[callee.property.name=/^(retrieve|store|clear)(SSO|JWT)Credentials$/]` and `BinaryExpression[operator='in'][left.value=/^(cookies|token|jwtToken)$/]`.
  - `no-restricted-imports`: `importNames: ['isJWTCredentials', 'isSSOCredentials']` for the `core/types.js` paths.
  - Message: `"Resolve SSO credentials via @/providers/plugins/sso/auth (resolveSSOAuth & co); do not inspect credential shape outside the SSO auth module."`

- [x] **Step 3: Verify**
  Run: `npm run lint && npm run typecheck && npm run build`
  Expected: all exit 0, zero warnings.

- [x] **Step 4: Report, and stop for the user.** *(Superseded: the user went on to request Task 11 too, so the pause-point this step describes never applied in practice.)*

---

### Task 11: Update tests (ONLY on the user's explicit request)

**Files:**
- Create: `src/providers/plugins/sso/auth/__tests__/selection.test.ts`, `resolver.test.ts`
- Modify: the files listed by
  `grep -rlE "getStoredPlatform|getStoredAnalytics|retrieveJWTCredentials|getStoredCredentials|isJWTCredentials|JWTAuthPlugin|SSOAuthPlugin|credentialFingerprint|hasUsableCookies|cookieSourceOf|supersedingCookieHeader|buildBearerAuth|deriveExpiresAt|effectiveExpiresAt|CredentialRefresher|proxy-sso-auth|proxy-jwt-auth|BearerProjectAuth" src tests --include='*.test.ts'` (≈ 62 files)
- Follow `.ai-run/guides/testing/testing-patterns.md` (Vitest, dynamic imports after `vi.mock`).

- [x] **Step 1: Write `selection.test.ts`.**
  - `legacy unmarked cookie wins over unmarked jwt`.
  - `newest marked record wins`: cookie `storedAt: 1`, jwt `storedAt: 2` → jwt.
  - `unmarked coexisting with marked other type wins`: marked cookie plus unmarked jwt → jwt.
  - `expired and unusable records are skipped`: jwt `expiresAt < now`; cookies `{ '': 'x' }`.
  - `cookie fingerprint matches the legacy credentialFingerprint formula`: for `{ b: '2', a: '1' }`, equals `sha256(JSON.stringify([apiUrl, [['a','1'],['b','2']]]))`.
  - `toSSOAuth headers`: cookie `{ a: '1', b: '2' }` → `{ cookie: 'a=1; b=2' }`; jwt → `{ authorization: 'Bearer t' }` with `authValue: 't'`.

- [x] **Step 2: Write `resolver.test.ts`** (in-memory `CredentialStore` mock):
  - `cookie callback saves only cookies and clears jwt`: `{ cookies: { a: '1' }, jwt: 't' }` → cookie record with `authType: 'cookie'`; `jwt-` empty.
  - `jwt login clears every cookie key for the host`: current key, legacy key and same-origin global slot cleared; a different-origin global record is untouched.
  - `expired jwt is cleared on read`.
  - `profile-origin filtering applies to jwt too`.

- [x] **Step 3: Add the proxy cases:**
  - `credential-refresh.test.ts › adopts a re-read of another type`;
  - `credential-refresh.test.ts › explicit source is never re-read`;
  - `sso-session-expiry.plugin.test.ts › replay after type change sends only the new header`;
  - `auth-injection.plugin.test.ts` (replacing `sso-auth.plugin.test.ts` and `jwt-auth.plugin.test.ts`): cookie → `cookie` header; jwt → `authorization`; `sentAuth` set; expired → `AuthenticationError`.

- [x] **Step 4: Add `sso.auth.test.ts › unusable cookies fall back to jwt`.**

- [x] **Step 5: Migrate the remaining listed tests** to the new APIs and plugin id `@codemie/proxy-auth`. Keep their behavioural assertions; change only how credentials are seeded and read. Where an assertion pins the old `;`-joined cookie header, update it to `'; '`.

- [x] **Step 6: Run** (only because the user asked)
  Run: `npm test`
  Expected: all three Vitest projects pass.
  Run on explicit request. Found and fixed two real bugs (see *Code state* above); all three projects now pass (unit 648/648, cli 49/49, agent 18/18), modulo pre-existing flakiness unrelated to this plan.
