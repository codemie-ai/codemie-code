DONE

# Task 1 report: what do EXPIRED credentials get back from the sync API / SSO proxy?

## Findings (all paths under src/providers/plugins/sso/)

1. No real capture of an expired-credential answer exists in the repo. `proxy/plugins/session-rejection.ts:21-25` says so explicitly ("REMAINING UNVERIFIED: no real capture of an expired-cookie 401 was available").
2. Expired/rejected SSO session, as far as the code knows:
   - Backend answers 401 with `{"error":{"message":"Authentication failed","details":...,"help":...}}` (`session-rejection.ts:8-14`, `isSessionRejection401` at :64-73; matched case-insensitively on `error.message`). Tests: `proxy/plugins/__tests__/session-rejection.test.ts:12` fixture, :37 (`{detail:'Authentication failed'}` is NOT a match).
   - The gateway in front (oauth2-proxy) may instead redirect 302/303 to `/oauth2/start` (`sso-session-expiry.plugin.ts:103-110`). Direct sync clients use `fetch`, which follows the redirect, so the SSO login page lands as a 2xx text/html (`conversations/apiClient.ts:27-34` `isLoginPage`; `metrics/metrics-api-client.ts:284-288`, Keycloak "HTTP 200 + login HTML"). The OTLP forwarder does not follow redirects and counts a raw 302 as auth (`otlp-spool/forwarder.ts:151-154`).
   - Other 401s with a different body can arrive with a VALID session (LiteLLM error relayed by the LLM proxy, `session-rejection.ts:11-14`). That is a proxy-path concern; sync clients treat every 401 as rejected credentials regardless of body (`bounded-request.ts:114-121` "A 401 is rejected credentials whatever its body"; `conversations/apiClient.ts:207`; `metrics-api-client.ts:215,223`).
3. 403: nothing in the code ties a 403 to expiry. `session-rejection.ts:27-29` says a 403 "means authenticated but not allowed, and signing in again cannot fix it". The sync clients treat 403 as a non-auth answer: conversations `NON_RETRYABLE_HTTP_CODES = [400,401,403,422]` (`conversations/constants.ts:39`) but `rejectCredentials` is only called for 401 (`apiClient.ts:207`); metrics `isAuthFailure` is 401 or 2xx-HTML only (`metrics-api-client.ts:215,223,288`); `isFailingServerAnswer` treats a non-JSON 403 as a failing server (WAF/proxy page) and a JSON 403 as the application's verdict (`bounded-request.ts:114-121`). A real JSON 403 exists as a fixture: `{"error":{"message":"Project access denied","details":"user is not a member"}}` (`conversations/__tests__/apiClient.test.ts:63-68`). The only place that calls 403 "auth" is the OTLP forwarder: `isAuthFailure = 401 || 403 || 302`, retried once, then `auth-expired` (`otlp-spool/forwarder.ts:151-154,212-214`; tests `forwarder.test.ts:209-222,664-669` use bare `{ok:false,status:403}` with no body).
4. Conclusion: the code CANNOT tell an expiry 403 from any other 403 by its body. There is no known expiry-403 body, and the one known JSON 403 body ("Project access denied") is an ordinary non-expiry 403. Therefore, for the exit-notice classification: **every 403 is "auth"** (consistent with the forwarder). Caveat to carry into the docs: this is deliberately broader than the metrics/conversations clients, so a project-access 403 will be reported as an auth/expired-credential symptom (false positive accepted; the alternative would drop real expiry 403s, which the forwarder already treats as expiry). Also: a 2xx HTML login page and a 302 are expiry answers too but carry no status 401/403; they are out of scope for a `(status, bodyIsJson, body)` predicate and must be handled by the caller (HTML-2xx check as in `isLoginPage`).

## Exact predicate

```ts
export function isExpiredCredentialAnswer(status: number, _bodyIsJson: boolean, _body: unknown): boolean {
  return status === 401 || status === 403;
}
```

Body and JSON-ness are deliberately ignored (kept in the signature so a body check can be added once an expiry 403 is captured). Do NOT require the "Authentication failed" message: that matcher is for the proxy path where a LiteLLM 401 can occur with a valid session; the sync clients already treat any 401 as rejected.

## Ready-to-paste JSDoc

```ts
/**
 * Whether a sync API answer means "the credentials are expired or rejected": any 401 or 403.
 *
 * A 401 is rejected credentials whatever its body, as the sync clients already treat it
 * (bounded-request.ts:114-121 isFailingServerAnswer, conversations/apiClient.ts:207,
 * metrics/metrics-api-client.ts:215,223). A 403 is counted too: no captured expired-credential
 * answer exists (proxy/plugins/session-rejection.ts:21-25), the one known JSON 403 body
 * ("Project access denied", conversations/__tests__/apiClient.test.ts:63-68) cannot be told from an
 * expiry 403 by its text, and the OTLP forwarder already treats 401, 403 and 302 alike as auth failure
 * (proxy/plugins/otlp-spool/forwarder.ts:151-154,212-214). So the body and `bodyIsJson` are not
 * consulted. This is broader than session-rejection.ts:27-29, which says a 403 is "authenticated but
 * not allowed": a project-access 403 is therefore reported as an auth problem (accepted false positive).
 * Not covered here: a 2xx HTML SSO login page and a 302 to /oauth2/start (they carry no 401/403 status;
 * see conversations/apiClient.ts:27-34 and sso-session-expiry.plugin.ts:103-110).
 */
```

## Fixtures

| Case | status | bodyIsJson | body | expected |
|---|---|---|---|---|
| expired 401 (backend, JSON) | 401 | true | `{"error":{"message":"Authentication failed","details":"...","help":"..."}}` | true |
| 401, other body | 401 | true | `{"error":{"message":"Invalid API key"}}` | true (any 401) |
| 401, non-JSON | 401 | false | `<html>...401...</html>` | true |
| expired 403, JSON (assumed shape; no capture exists) | 403 | true | `{"error":{"message":"Authentication failed"}}` | true |
| expired 403, non-JSON (as the forwarder tests: no body) | 403 | false | `Forbidden` / `` | true |
| ordinary non-expiry 403 (NOT distinguishable by body) | 403 | true | `{"error":{"message":"Project access denied","details":"user is not a member"}}` | true (known false positive) |
| non-auth | 404 / 429 / 500 / 200 | any | any | false |
