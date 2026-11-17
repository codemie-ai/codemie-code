# Spec: Cookie-only SSO credentials must not expire locally (EPMCDME-17014)

## Problem
A cookie-only SSO sign-in (only `_oauth2_proxy`, no `codemie_access_token`) gets a client-invented `expiresAt = now + 24h` (`sso.auth.ts:46-64`). `getStoredCredentials` (`sso.auth.ts:214-217`) then deletes the credential and returns null after that time, although the server session lasts longer. The user is sent through a pointless browser sign-in, and agents report "No valid SSO credentials found".

## Behavior
1. `deriveExpiresAt` returns a time only when a `codemie_access_token` JWT with a decodable `exp` is present. Otherwise the credential is stored without `expiresAt` (absent already means "unknown/never", `sso.auth.ts:215`).
2. One exported helper next to `deriveExpiresAt` (working name `effectiveExpiresAt(credentials)`) owns the rule. It returns the stored `expiresAt` only when the cookies contain `codemie_access_token`, and `undefined` otherwise. It therefore also neutralises the synthetic 24h value already on disk. No migration.
3. Readers of the stored credential's `expiresAt`:
   - `getStoredCredentials` (`sso.auth.ts:214-218`) calls the helper; delete-on-expiry for JWT credentials stays there.
   - `sso.health.ts:87-110` calls the helper.
   - `sso.setup-steps.ts` calls the helper at both places where `authStatus` is built (`validateAuth` ~:284, `getAuthStatus` ~:360). `utils/profile.ts` and `profile/display.ts` only receive `authStatus.expiresAt` (no cookies), so they need no change and stay correct.
   - `src/agents/plugins/claude/plugin/skills/codemie-analytics/scripts/analytics-cli.js:261` checks `credentials.expiresAt` on the raw credentials file. It is plain JS and cannot import the TS helper, so it mirrors the rule in one line: no `codemie_access_token` cookie means ignore the stored `expiresAt`.
   Cookie-only credentials are never expired, never deleted and show no remaining time. JWT-bearing credentials behave as today.
4. Server rejection is the only expiry signal for cookie-only credentials. The redirect to `/oauth2/start` stays the confirmed signature. A 401 is acted on only through one named function (working name `isSessionRejection401(response)`), placed in a small module that the metrics and OTLP classifiers can call later. `sso-session-expiry.plugin.ts` calls it. On a match it writes the marker, starts one detached sign-in (existing lock and cooldown unchanged) and returns its existing synthetic response. The hook gate stays local-only and reacts through the marker (`sso.auth-gate.ts:146-174`).
5. Loop guard. If a sign-in started by a 401 stores cookies identical to the rejected ones, the credential was not the cause. Later 401s that carried those same cookies do not write the marker or start a sign-in. The guard clears when the stored cookies change or a redirect rejection is seen. Redirect handling is unaffected. The guard's state lives in the interceptor's in-memory state, so a proxy daemon restart resets it (accepted: at worst one extra sign-in, bounded by the lock and cooldown).
6. 403 is not treated as session rejection (see Non-goals).

## Acceptance criteria
- AC1 (unit, `sso.auth`): a cookie-only credential signed in 24h+1min ago is returned by `getStoredCredentials`, `clearSSOCredentials` is not called, and no earlier expiry is invented.
- AC2 (integration, gate with a real `getStoredCredentials` and mocked store/API): the same credential with no rejection marker gives `ensureCodeMieSsoAuthOrWait` ok, with `startDetachedSsoLogin` and the browser not called. The API answer reaches the gate only through the marker; the harness adapts to this.
- AC3 (integration): an API oauth2 sign-in redirect, or a session-shaped 401, makes the proxy plugin write the marker and the gate start exactly one detached sign-in. After success the prompt proceeds with no second browser launch.
- AC4 (integration, `sdk-client` and assistants-chat credential load, mocked API): a cookie-only credential 24h+1min old reaches the API and succeeds, with no "No valid SSO credentials found" and no deletion.
- AC5 (unit): a callback returning only `_oauth2_proxy` stores a credential with no `expiresAt`. The two 24h-fallback cases in `sso/__tests__/sso.auth.test.ts:24-42` are replaced.
- AC6 (unit): `effectiveExpiresAt` returns undefined for a cookie-only credential, including one with a legacy synthetic `expiresAt`, and the stored value for a JWT-bearing one. `getStoredCredentials`, `sso.health.ts` and both `sso.setup-steps.ts` spots use it, so `authStatus.expiresAt` is undefined for cookie-only credentials and the profile display shows no expired or remaining-time state. JWT credentials still expire and are deleted as before.
- AC6b (unit): `analytics-cli.js` accepts a cookie-only credentials file whose stored `expiresAt` is in the past, and still rejects a JWT-bearing one that is past.
- AC7 (unit): a session-shaped 401 in the session-expiry plugin triggers the same recovery as the redirect, once, with replay semantics unchanged.
- AC8 (unit/integration): a 401 that is not session-shaped, or that repeats after a sign-in returned identical cookies, writes no marker and starts no sign-in, and the original response reaches the caller.
- AC9 (unit): a 403 starts no sign-in.

## Non-goals
- Concurrent duplicate sign-ins (EPMCDME-16737).
- The loopback-key storage issue.
- Separating EPAM Assistant credentials from proxy credentials.
- Migrating or rewriting stored credentials.
- Making the metrics and OTLP classifiers call the new 401 function. The function is placed so they can later. Follow-up owner: to be named at the spec gate.
- A network probe in the hook gate.
- Triggering sign-in from the `codemie assistants chat` / sdk-client path on a 401/403 from the API. Its error text (`codemie setup`) versus the health hint (`profile login`) is left as is.
- Treating 403 as session rejection. In the stack a 403 normally means "authenticated but not allowed", and signing in again cannot fix it.
- Persisting the loop guard across proxy daemon restarts.
- Changing JWT-type credentials (`jwt-auth.plugin.ts`, `security.ts` JWT retrieval).

## Decisions
- Ignore the stored `expiresAt` when `codemie_access_token` is absent, instead of migrating stored data or fixing only new writes. This answers how to treat credentials already on disk with a synthetic expiry. — user
- Handle a plain 401 in the proxy session-expiry plugin, instead of leaving the known gap or also covering assistants chat / sdk-client. This answers how a rejected cookie-only session is detected. — user
- Gate the 401 behind one named function plus an identical-credential loop guard, instead of treating every 401 as a dead session. This answers what happens on a 401 with another cause, which is unverified (see Risks).
- Keep the loop guard in the interceptor's in-memory state, instead of persisting it. A daemon restart resets it.
- Leave 403 out of session rejection, instead of treating it like 401.
- Omit `expiresAt` for cookie-only credentials, instead of choosing a longer fixed TTL such as 144h. This answers what a credential with an unknown expiry stores.
- Put the cookie-only rule in one helper called by the TS readers (applied in `sso.setup-steps.ts` where `authStatus` is built, so display code is untouched), with a one-line mirror in plain-JS `analytics-cli.js`, instead of repeating the rule in every reader or adding a flag to `SSOCredentials`.
- Keep the hook gate local-only and marker-driven, instead of adding a network probe. This follows the existing design (`sso.auth-gate.ts:119-127`).

## Risks
- Unverified: whether the gateway returns 401 for causes other than a dead SSO session (denied model, relayed upstream failure), and whether a session 401 differs by body or header. Until that is known, `isSessionRejection401` may match every 401 and the loop guard is the only bound, together with the existing lock and cooldown.
- The `analytics-cli.js` mirror is a second copy of the rule; a later change to the rule must edit both (AC6b guards it).
- A revoked cookie-only session persists until the first proxy rejection writes the marker. On the assistants-chat / sdk-client path it has no local bound and no automatic recovery.
- That the Production session lasts 144 h and has no `codemie_access_token` is unverified in the repo.

## Plan notes
- First plan step, before writing `isSessionRejection401`: capture a real expired-cookie 401 and a non-session 401 (denied model or relayed upstream failure) from the gateway, and base the function's predicate on the observed difference. If none exists, keep the status-only predicate and the loop guard, and leave the assumption in Risks.
- Write the 401 check as a named function in a small module, not inline in the plugin, so a later unification moves callers only.
