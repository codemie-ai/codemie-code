DONE
Commit: 750f3483
Changed: src/cli/completion/fish.ts, src/cli/completion/__tests__/fish.test.ts, src/cli/completion/__tests__/__snapshots__/fish.test.ts.snap, tests/integration/completion/fish.test.ts
Test command: npx vitest run src/cli/completion tests/integration/completion (EXIT=0, 91 passed); integration: npx vitest run --project cli tests/integration/completion
Notes: RED seen (module missing) then GREEN. Fish only offers options when the typed word starts with '-', so integration tests assert options at '-' and subcommands at empty token. Choices/names go through -a which re-tokenizes, so they are backslash-escaped (e.g. 'two words').
