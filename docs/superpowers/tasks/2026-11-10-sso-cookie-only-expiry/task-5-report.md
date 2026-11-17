DONE

Commit: df205d039f9bfad35010db29cbd4f710c73f3160
feat(proxy): recover from session-shaped 401 for cookie-only SSO sessions (sso-cookie-only-expiry, task 5)

Changed paths (4, matches `git show --stat HEAD`):
- src/providers/plugins/sso/proxy/plugins/session-rejection.ts (new)
- src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts
- src/providers/plugins/sso/proxy/plugins/__tests__/session-rejection.test.ts (new)
- src/providers/plugins/sso/proxy/plugins/__tests__/sso-session-expiry.plugin.test.ts

Tests:
- RED: `node node_modules/vitest/vitest.mjs run src/providers/plugins/sso/proxy/plugins/__tests__/session-rejection.test.ts src/providers/plugins/sso/proxy/plugins/__tests__/sso-session-expiry.plugin.test.ts` -> EXIT=1 (missing module + 8 new plugin cases failing, 24 existing passing).
- GREEN: same command -> EXIT=0, 38/38.
- `node node_modules/vitest/vitest.mjs run src/providers/plugins/sso/proxy` -> EXIT=0, 57 files / 987 tests.
- tsc --noEmit and eslint --max-warnings=0 on the 4 files: clean. Husky hooks passed.

Step 0: no real gateway captures available; predicate is status-only (`statusCode === 401`) by assumption, recorded in the session-rejection.ts header with the spec Risk as the reason; assumed shapes encoded as fixtures in session-rejection.test.ts.

Rulings (not settled by the plan):
- Fingerprint = SHA-256 hex of the Cookie header the rejected request was sent with (`context.headers.cookie`, after any replay), never raw values. Compared against SHA-256 of `buildCookieHeader(stored cookies)` read via `credentialRefresher.refreshNow()`.
- The guard is re-recorded (new fingerprint + timestamp) every time the plugin acts on a 401, not only the first time.
- "Sign-in completed since" = `getLastSignInAt({ codeMieUrl: targetApiUrl }) > recordedAt` (strict). The lock URL is the `targetApiUrl` passed to `startDetachedSsoLogin`, so the source resolves to that URL.
- The stored cookies are only read for the guard when a guard is set, so the common path pays no extra store read. An unreadable/empty store, a missing refresher or a null sign-in time never suppress (fail-open to recovery).
- Guard clearing is lazy: checked on the next 401 (cleared when the stored hash differs) and eagerly on any redirect rejection (original or replayed).
- Order: superseded-cookie replay runs before the guard check, the same as for the redirect. A replayed 401 goes to the guard check and then recovery; never a second retry.
- Marker reason text for the 401 path: `CodeMie API answered 401 (rejected SSO session)`; synthetic response body/messages unchanged.
- KNOWN GAP header rewritten: the plain-401 gap is closed; the HTML-200 gap and the not-yet-unified metrics/OTLP classifiers remain stated.
