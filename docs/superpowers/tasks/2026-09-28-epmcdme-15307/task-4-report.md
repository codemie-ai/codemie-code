DONE

Commit: 9168900
Changed paths:
- src/cli/commands/doctor/checks/NpmPrefixOverrideCheck.ts (new)
- src/cli/commands/doctor/checks/index.ts
- src/cli/commands/doctor/index.ts
- src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts

Test command:
npx vitest run src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts

RED/GREEN: RED confirmed first (`Cannot find module '.../NpmPrefixOverrideCheck.js'`, exit 1) after adding the three `NpmPrefixOverrideCheck` tests and mocking `@/utils/npm-prefix.js`'s `getUserNpmPrefix`; after implementing the check and wiring the export/registration, GREEN (34 passed, exit 0).

`npm run typecheck` passes clean.

Notes:
- Commit scope had to be `cli` (not `doctor`) — commitlint's scope-enum for this repo doesn't include `doctor`.
- Test design: for the legacy-match case, asserted the result has a `warn`-status detail AND some detail's message contains "npm config delete prefix --location user", rather than requiring both facts on the same object — this matches the brief's spec (warn message is the legacy-path notice; the four hints are separate `info` details) while still satisfying the literal test wording.
- ok-path message text ("npm prefix is not overridden") was not specified verbatim in the brief, so I chose it; tests assert `status: 'ok'` and `message: expect.any(String)`, not the exact wording.

Concerns: none.
