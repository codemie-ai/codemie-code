DONE

Commit: `864b5f23f0ae590691b08202e7bafa0770fa6b9d`

Changed paths:

- `src/cli/commands/analytics/data-loader.ts`
- `src/cli/commands/analytics/native-loader.ts`
- `src/cli/commands/analytics/cost/cost-enricher.ts`
- `src/cli/commands/analytics/__tests__/native-loader.test.ts`
- `src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts`

Test command:

`npx vitest run src/cli/commands/analytics/__tests__/native-loader.test.ts src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts src/cli/commands/analytics/__tests__/native-loader-pi.test.ts`

RED: EXIT=1, 4 expected failures covering missing capture reuse, missing internal capture interface, and missing descendant family bounds. Full output: `task-2-red.local.log`.

GREEN: EXIT=0, 3 files passed and 81 tests passed. Latest output: `test.local.log`.

Interface additions:

- `INTERNAL_PARSED_FAMILY`: symbol-keyed internal hand-off on `RawSessionData`; symbol keys are excluded from JSON serialization so captured transcript messages are not exported.
- `InternalParsedFamilyCapture`: contains the single `ParsedSession` snapshot and its `capturedAt` epoch time.
- `RawSessionData[INTERNAL_PARSED_FAMILY]`: optional capture reused by cost enrichment instead of reparsing a growing native log.

Behavior status:

- One parsed native family now supplies discovery facts and cost enrichment facts.
- Claude root elapsed time uses the observed root-plus-descendant timestamp envelope, including descendant activity after root completion and overlapping parallel descendants without summing their durations.
- Empty family timestamps fall back to descriptor bounds; failed/corrupt parses remain safely omitted or unpriced.
- Root-only context derivation and non-Claude synthesis behavior are preserved.
- Focused test command passed; commit hooks also passed ESLint, related analytics tests, TypeScript typecheck, and secret validation.
