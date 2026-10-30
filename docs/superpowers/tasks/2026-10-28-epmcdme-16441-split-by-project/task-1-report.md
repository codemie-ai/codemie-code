DONE
commit: 9d299fc9
paths:
src/providers/plugins/sso/proxy/plugins/otlp-spool/session-project.ts
src/providers/plugins/sso/proxy/plugins/otlp-spool/session-status.ts
src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/session-project.test.ts
test_command: npx vitest run --project unit src/providers/plugins/sso/proxy/plugins/otlp-spool

Notes:
- hookEventProjectNames now returns only the top-level string codemie_project_name; raw is ignored. hookRecordIsProject follows through it (blank/missing stays unprovable). otlp.plugin.ts needed no edit.
- normalizeStatus no longer pins project from an all-sendable stored projectConflict; conflict and valid seal are kept as stored.
- RED was seen first for 3 tests (raw ignored, stored conflict kept, record proof by top-level name), all for the expected reason.
- spool-io.test.ts and tick-processor.test.ts needed no changes (no raw names or migration cases); they pass unchanged. spool-io.ts does not read raw.
- Whole otlp-spool dir: 8 files, 150 tests pass. tsc --noEmit clean. Pre-commit hooks passed.
