DONE
Commit: 42a591f1 fix(cli): EPMCDME-16969 report PATH shadow in doctor agents check (T7)
Changed:
- src/cli/commands/doctor/checks/AgentsCheck.ts
- src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts
Test: npx vitest run src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts -> EXIT=0, 51 passed (RED seen first: 4 failed). tsc and eslint clean. Pre-commit hook passed.
