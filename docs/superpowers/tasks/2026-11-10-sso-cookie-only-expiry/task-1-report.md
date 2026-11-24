DONE

Changed paths (uncommitted by ruling):
- src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts (new, AC2)
- src/utils/__tests__/sdk-client.test.ts (added AC4 case; mock of sso.auth.js now delegates to the real CodeMieSSO when `useRealSso` is set; CredentialStore mocked via partial mock of ../security.js)

Test command: node node_modules/vitest/vitest.mjs run src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts src/utils/__tests__/sdk-client.test.ts
(node_modules/.bin is missing, so npx vitest is unavailable; invoke vitest.mjs directly.)
Result: EXIT=1, 2 failed | 3 passed (the 3 pre-existing sdk-client tests still pass). ESLint on both files: clean.

Failing (expected reason, pre-fix code):
- sso.auth-gate.integration > passes without sign-in or deletion for a cookie-only credential...: expected { ok: true }, got { ok: false, reason: "no valid CodeMie SSO credentials found", loginOutcome: "started" } (getStoredCredentials deleted the stale credential).
- sdk-client > creates the client for a stale cookie-only credential without clearing it: ConfigurationError "SSO authentication required" (No valid SSO credentials found).

Note: the gate test's waitForDetachedSsoLogin is stubbed to {status:'timeout'} so pre-fix code fails on the assertion rather than a TypeError.
Commit sha: none (uncommitted by ruling)
