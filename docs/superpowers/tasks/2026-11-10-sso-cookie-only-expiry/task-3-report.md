DONE

Commit: acf147b1
Changed: src/providers/plugins/sso/sso.health.ts, src/providers/plugins/sso/sso.setup-steps.ts, src/providers/plugins/sso/__tests__/sso.health.test.ts, src/providers/plugins/sso/__tests__/sso.setup-steps.test.ts
Test: node node_modules/vitest/vitest.mjs run src/providers/plugins/sso/__tests__/sso.health.test.ts src/providers/plugins/sso/__tests__/sso.setup-steps.test.ts (RED 3 failed, GREEN 16 passed)
Notes: test mocks of ../sso.auth.js gained a local effectiveExpiresAt stub; setup-steps test fixture creds now carry codemie_access_token so the existing expiresAt:123 assertions still hold. Typecheck not run (npx tsc resolved wrong binary); husky hooks passed.
