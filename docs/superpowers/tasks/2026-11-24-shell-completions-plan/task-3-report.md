DONE
Commit: 933ef3dd
Changed: src/cli/completion/escape.ts, src/cli/completion/__tests__/escape.test.ts
Test: npx vitest run --project unit src/cli/completion/__tests__/escape.test.ts (40 passed; RED seen first with missing module). eslint + tsc clean.
Tests really embed + syntax-check (bash -n, zsh -n, fish --no-execute) + run each shell; missing shell skips locally, FAILS when CI is set.

All functions: collapse \r\n/\r/\n to one space; output goes INSIDE quotes you supply.
- escapeBash(s): inside bash SINGLE quotes: `'${escapeBash(s)}'`. Only ' -> '\''. Not for double quotes.
- escapeZshDescribe(s): description part (after first colon) of a _describe element in SINGLE quotes: `'name:${escapeZshDescribe(d)}'`. Only ' -> '\''; ':', '\', '%', '[', ']' left literal. Name part is NOT handled (a ':' in a name must be written '\:' by the caller).
- escapeFish(s): inside fish SINGLE quotes: `'${escapeFish(s)}'`. \ -> \\ and ' -> \'.
