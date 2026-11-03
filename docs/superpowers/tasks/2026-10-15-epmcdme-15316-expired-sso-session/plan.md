# Expired SSO Session Detection + Re-auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the local SSO proxy's upstream response is the confirmed oauth2-proxy session-expiry redirect (302/303 to `/oauth2/start`) AND the proxy's own stored SSO credential is at/past its known expiry, replace the relayed response with a parseable 401 and feed PR #624's existing re-auth plumbing (`markAnalyticsAuthInvalid` + `startDetachedSsoLogin`) instead of letting Claude Code write a `<synthetic>` turn. Every other case (fresh credential, no redirect, generic 5xx) passes through unchanged.

**Architecture:** A new sibling `ProxyInterceptor` plugin (not a modification of `SSOAuthInterceptor`) implements `onUpstreamResponse`. It never touches `sso.auth-gate.ts`, `sso.detached-login.ts`, or `analytics-auth-status.ts` — it only calls their existing exported functions, reusing the shared lock file/marker those already own so this call site and the `UserPromptSubmit` hook's call site never race.

**Tech Stack:** TypeScript, Vitest, Node `http`/`stream`.

**Spec:** No spec document — requirements supplied inline by the caller (ticket EPMCDME-15316, Issue 1 only, combined with PR #624's re-auth plumbing). See Acceptance criteria below in place of a spec reference. Full research: `docs/superpowers/tasks/2026-10-15-epmcdme-15316-expired-sso-session/technical-analysis.md`.

## Global Constraints

- SSO-only: JWT-based profiles must be unaffected — guard via `'cookies' in context.credentials`, matching `sso-auth.plugin.ts`'s existing pattern.
- Never re-read credentials from disk/`CredentialStore` mid-session — compare only against the `expiresAt` already captured once at `createInterceptor()` time from `PluginContext.credentials`.
- Never spread the original 302's `headers` onto the synthesized 401 — build the 401's headers as a fresh object (no leaked `location`/`set-cookie`/`cache-control`).
- Only call `markAnalyticsAuthInvalid`/`startDetachedSsoLogin` on the confirmed-expired branch (redirect signature AND expired credential). Never call either on a fresh-credential redirect or on a non-redirect response, and never relabel either of those as "session expired" — this is the guard against misdiagnosing nginx 503 / Cloudflare 502 blips.
- Reason string passed to `markAnalyticsAuthInvalid` must name the `/oauth2/start` redirect specifically, not a generic phrase like `"session expired"`.
- Do not modify `sso-auth.plugin.ts`, `sso.auth-gate.ts`, `sso.detached-login.ts`, or `analytics-auth-status.ts` — call their existing exports only.
- No server-side (ingress/oauth2-proxy) changes; no changes to Root cause A, Root cause B, the claude-desktop filter issue, or the conversation-sync `<synthetic>`-leak follow-up.

## Review Focus

- An upstream `503`/`502` HTML blip with no `/oauth2/start` redirect must never be relabeled "session expired" or trigger `markAnalyticsAuthInvalid`/`startDetachedSsoLogin` — Task 1's passthrough test pins this.
- A `302`/`303` to `/oauth2/start` while the stored credential still looks fresh (not yet expired) must pass through unchanged and must not call either re-auth function — Task 1 pins this.
- `expiresAt === undefined` (never derived) must be treated as "not confirmed expired", not as expired — Task 1 pins this.
- The synthesized 401 must not leak the original response's `location`/`set-cookie`/`cache-control` headers — Task 1 asserts the returned headers object excludes them.
- A JWT-credentialed proxy (no `cookies` key) must get a no-op interceptor with `onUpstreamResponse` undefined — this logic can never fire for JWT profiles; Task 1 pins this.

negative-constraints: all covered above — no task violates them (Task 1 creates only the new plugin + its test; Task 2 only wires registration into `index.ts`; neither touches the three PR #624 modules or any server-side/root-cause-A/B/claude-desktop/conversation-sync code).

---

## Acceptance criteria

- [ ] A `302`/`303` upstream response with `Location` containing `/oauth2/start`, while the proxy's in-memory SSO credential `expiresAt` is at/past `Date.now()`, is replaced with a `401` whose body is `{"type":"error","error":{"type":"authentication_error","message":"<re-login hint>"}}` and whose headers are built fresh (no leaked `location`/`set-cookie`/`cache-control`).
- [ ] On that same confirmed-expired branch, `markAnalyticsAuthInvalid(reason, baseUrl)` is called once with a reason string naming the `/oauth2/start` redirect and `baseUrl === context.config.targetApiUrl`.
- [ ] On that same branch, `startDetachedSsoLogin(codeMieUrl)` is called once with `codeMieUrl === context.config.targetApiUrl`.
- [ ] The same redirect signature with a credential that is still fresh (`expiresAt` in the future, or undefined) passes through unchanged, and neither `markAnalyticsAuthInvalid` nor `startDetachedSsoLogin` is called.
- [ ] Any upstream response without the `302/303` + `/oauth2/start` signature (including `5xx` infra errors) passes through unchanged, keeping its real status code, and neither re-auth function is called.
- [ ] JWT-credentialed proxy instances get a no-op interceptor (`onUpstreamResponse` undefined) — this detection logic never fires for JWT profiles.
- [ ] The new plugin is registered in the core plugin list with priority 11 (directly after `SSOAuthPlugin`/`JWTAuthPlugin`, before every other `onUpstreamResponse` plugin).

---

### Task 1: `SSOSessionExpiryPlugin` — detect expired SSO session and trigger re-auth

**Files:**
- Create: `src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts`
- Create: `src/providers/plugins/sso/proxy/plugins/__tests__/sso-session-expiry.plugin.test.ts`

**Interfaces:**
- Consumes: `ProxyPlugin`, `PluginContext`, `ProxyInterceptor`, `UpstreamResponseTools` from `./types.js`; `ProxyContext` from `../proxy-types.js`; `SSOCredentials` from `../../../../core/types.js` (`{ cookies, apiUrl, expiresAt?: number }`); `markAnalyticsAuthInvalid` from `../../../../../utils/analytics-auth-status.js`; `startDetachedSsoLogin` and `describeLogin` from `../../sso.detached-login.js`.
- Produces: exported class `SSOSessionExpiryPlugin implements ProxyPlugin` with `id = '@codemie/proxy-sso-session-expiry'`, `priority = 11`. Task 2 imports this class by name.

Mirror `sso-auth.plugin.ts`'s guard (`!('cookies' in context.credentials)` → return a hookless no-op interceptor) and `copilot-encrypted-content-sanitizer.plugin.ts`'s `onUpstreamResponse` test fixtures (`response(statusCode)` via `Readable.from([]) as IncomingMessage`, `createTools()` with `vi.fn()` for `readBody`/`retry`/`fromBuffer`). Mock `startDetachedSsoLogin` the way `sso.auth-gate.test.ts` does, but spread the real module through `importOriginal()` so `describeLogin` stays the genuine implementation (the test needs the real one to build its expected message, not a stub): `vi.mock('@/providers/plugins/sso/sso.detached-login.js', async (importOriginal) => ({ ...(await importOriginal()), startDetachedSsoLogin: vi.fn() }))`. Add an equivalent `vi.mock('@/utils/analytics-auth-status.js', () => ({ markAnalyticsAuthInvalid: vi.fn() }))`. Never let either side-effecting function run for real.

- [ ] **Step 1: Write the failing test** in `__tests__/sso-session-expiry.plugin.test.ts`, covering:
  1. JWT credentials (no `cookies` key) → `createInterceptor` returns an interceptor with `onUpstreamResponse` undefined.
  2. `302` + `location: 'https://x/oauth2/start?rd=...'` + `expiresAt = Date.now() - 1000`, with `startDetachedSsoLogin` mocked to resolve `'started'` → result has `statusCode === 401`; the body's `error.message` equals `` `CodeMie SSO session expired. ${describeLogin('started')}` `` — import the real `describeLogin` in the test and build this expected string from it, never hardcode "run codemie profile login" or any other literal re-login text; `result.headers` contains only `content-type`/`content-length` (no `location`/`set-cookie`); `markAnalyticsAuthInvalid` was called once with a reason string containing `/oauth2/start` and `'https://api.example.com'` (the test's `targetApiUrl`); `startDetachedSsoLogin` was called once with `'https://api.example.com'`.
  3. Same redirect with `expiresAt = Date.now() + 60_000` → `result === response`; neither `markAnalyticsAuthInvalid` nor `startDetachedSsoLogin` called.
  4. Same redirect with `expiresAt` undefined → `result === response`; neither call made.
  5. `503` response with no `location` header, expired credential → `result === response`; neither call made (must not relabel an infra blip).
  6. `303` status with `location` matching `/oauth2/start` + expired credential (same `startDetachedSsoLogin` mock as case 2) → also triggers the 401 (covers the "303" half of the signature); may reuse case 2's `describeLogin('started')`-derived message expectation.

- [ ] **Step 2: Run it to verify it fails** — `npx vitest run src/providers/plugins/sso/proxy/plugins/__tests__/sso-session-expiry.plugin.test.ts` — expect failure: `Cannot find module '../sso-session-expiry.plugin.js'`.

- [ ] **Step 3: Implement the minimal code to make the test pass.**

```ts
import type { IncomingMessage } from 'http';
import { ProxyPlugin, PluginContext, ProxyInterceptor, UpstreamResponseTools } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { SSOCredentials } from '../../../../core/types.js';
import { markAnalyticsAuthInvalid } from '../../../../../utils/analytics-auth-status.js';
import { startDetachedSsoLogin, describeLogin } from '../../sso.detached-login.js';

const OAUTH2_START_MARKER = '/oauth2/start';
const EXPIRY_LEAD_IN = 'CodeMie SSO session expired.';

export class SSOSessionExpiryPlugin implements ProxyPlugin {
  id = '@codemie/proxy-sso-session-expiry';
  name = 'SSO Session Expiry Detector';
  version = '1.0.0';
  priority = 11;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    if (!context.credentials || !('cookies' in context.credentials)) {
      return { name: 'sso-session-expiry' }; // no onUpstreamResponse hook: JWT profiles unaffected
    }
    return new SSOSessionExpiryInterceptor(context.credentials as SSOCredentials, context.config.targetApiUrl);
  }
}

class SSOSessionExpiryInterceptor implements ProxyInterceptor {
  name = 'sso-session-expiry';
  constructor(private readonly credentials: SSOCredentials, private readonly targetApiUrl: string) {}

  async onUpstreamResponse(
    _context: ProxyContext,
    response: IncomingMessage,
    tools: UpstreamResponseTools
  ): Promise<IncomingMessage> {
    const location = response.headers['location'];
    const isOauthRedirect =
      (response.statusCode === 302 || response.statusCode === 303) &&
      typeof location === 'string' &&
      location.includes(OAUTH2_START_MARKER);
    if (!isOauthRedirect) return response;

    const expiresAt = this.credentials.expiresAt;
    const confirmedExpired = expiresAt !== undefined && Date.now() >= expiresAt;
    if (!confirmedExpired) return response;

    await tools.readBody(response); // drain the original 302 body; its content is discarded
    await markAnalyticsAuthInvalid(
      `oauth2-proxy redirected to ${OAUTH2_START_MARKER} (expired SSO session)`,
      this.targetApiUrl
    );
    const outcome = await startDetachedSsoLogin(this.targetApiUrl);

    const body = Buffer.from(JSON.stringify({
      type: 'error',
      error: { type: 'authentication_error', message: `${EXPIRY_LEAD_IN} ${describeLogin(outcome)}` },
    }), 'utf-8');
    const synthetic = tools.fromBuffer(response, body);
    synthetic.statusCode = 401;
    synthetic.statusMessage = 'Unauthorized';
    synthetic.headers = { 'content-type': 'application/json', 'content-length': String(body.length) };
    return synthetic;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass** — same command as Step 2 — expect all six cases PASS.

Test-first: yes — the six branch cases above (JWT no-op, redirect+expired→401 with marker+login calls, header isolation, and a message built from `describeLogin(outcome)` rather than a hardcoded string; redirect+fresh→passthrough with no calls; redirect+undefined-expiry→passthrough; no-redirect→passthrough; 303 variant→401), written and failing before `sso-session-expiry.plugin.ts` exists.

---

### Task 2: Register `SSOSessionExpiryPlugin` in the core plugin list

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/index.ts` (import block alongside `SSOAuthPlugin`; `registerCorePlugins()` right after `JWTAuthPlugin`'s registration; the `export { ... }` block)

**Interfaces:**
- Consumes: `SSOSessionExpiryPlugin` exported from Task 1's `./sso-session-expiry.plugin.js`.
- Produces: nothing new consumed by later tasks — this is the last task in the plan.

- [ ] **Step 1:** Add `import { SSOSessionExpiryPlugin } from './sso-session-expiry.plugin.js';` next to the existing `SSOAuthPlugin` import; add `registry.register(new SSOSessionExpiryPlugin()); // Priority 11 - relabels a confirmed expired-SSO-session oauth2 redirect as 401 and triggers re-auth before any other onUpstreamResponse plugin sees it` immediately after `registry.register(new JWTAuthPlugin());`; add `SSOSessionExpiryPlugin` to the `export { ... }` block alongside `JWTAuthPlugin`.

- [ ] **Step 2:** Run `npx vitest run src/providers/plugins/sso/proxy/plugins` — expect all existing plugin tests plus Task 1's new test file to PASS. Registration is wiring-only; it adds no new branch logic, so no new test is written for this task — Task 1's unit test already exercises the class this step wires in.

Test-first: no — this task only adds an import/registration/export triplet to `index.ts`; the behavior it wires in is already pinned by Task 1's tests, and there is no new logic here to pin with a separate test.

Commit per task using the repository's existing convention.
