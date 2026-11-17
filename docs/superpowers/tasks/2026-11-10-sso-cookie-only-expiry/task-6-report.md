DONE
Commit: 77f69163
Changed: src/providers/plugins/sso/__tests__/sso.auth-gate.integration.test.ts (only file)
Test command: node node_modules/vitest/vitest.mjs run src/providers/plugins/sso  (EXIT=0, 89 files / 1368 tests passed)
Disable-401 check: with isSessionRejection401 removed from isRejection in the plugin, the 401 case failed (redirect case passed); plugin restored via git checkout, git diff empty.
Notes: real plugin interceptor + real gate + real marker file; store/detached-login/browser mocked. startDetachedSsoLogin mock cleared between plugin step and gate step, then asserted exactly 1 call.
