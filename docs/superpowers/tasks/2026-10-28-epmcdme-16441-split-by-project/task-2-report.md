DONE
commit: 9f316f96
paths:
src/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.ts
src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/spool-io.test.ts
test_command: npx vitest run --project unit src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/spool-io.test.ts
notes:
- isSendAllowed: for stream 'hooks' with a send policy without onlyProject, any isSendableProjectName(project) is accepted. Sealed hooks and OTLP streams keep case-insensitive equality. Cursor, filtered and limit checks unchanged.
- PendingHookBatch.project doc comment updated.
- New test covers: bound session accepts sendable 'B', refuses unsendable 'Bé' and blank, stale cursor, wrong filtered, 'logs' with 'B'. Existing sealed-session test covers end > limit. RED seen (expected false to be true), then GREEN.
- spool-io.test.ts 33/33, whole otlp-spool dir 8 files / 151 tests green. Pre-commit hooks (eslint, vitest, typecheck, gitleaks) passed.
- The doc comment above isSendAllowed still says "under project" generically; left unchanged.
