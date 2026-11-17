DONE

Commit: 1607b910
Changed: src/providers/plugins/sso/sso.auth.ts, src/providers/plugins/sso/__tests__/sso.auth.test.ts, src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts, src/utils/__tests__/sdk-client.test.ts
Test: node node_modules/vitest/vitest.mjs run src/providers/plugins/sso/__tests__/sso.auth.test.ts src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts src/utils/__tests__/sdk-client.test.ts (13 passed; RED seen first)
Symbols: DEFAULT_TTL removed (local const in deriveExpiresAt, no other call sites). deriveExpiresAt now returns number | undefined (only caller: authenticate in sso.auth.ts). New export effectiveExpiresAt used in getStoredCredentials.
