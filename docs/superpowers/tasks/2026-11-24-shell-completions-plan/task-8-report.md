DONE
Commit: e041e5aa
Changed: bin/codemie.js, src/utils/invocation-context.ts, src/utils/__tests__/invocation-context.test.ts, tests/integration/completion/stdout-purity.test.ts
Test command: npx vitest run --project cli tests/integration/completion src/utils/__tests__/invocation-context.test.ts (EXIT=0, 53 passed; run npm run build first)
Notes: Added `completion` flag (argv[2]==='completion'); `silent` unchanged. bin nulls the logger console stream, skips migrations, update check and what's-new for it. RED was genuine (stdout polluted with migration output; bash -n failed) before the fix. Covers bash/zsh/fish. Commit header shortened to satisfy the 100-char commitlint limit.
