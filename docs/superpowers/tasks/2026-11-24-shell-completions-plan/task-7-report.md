DONE
Commit: 8708b8fb
Changed: src/cli/completion/index.ts, src/cli/commands/completion.ts, src/cli/program.ts, src/cli/commands/__tests__/completion.test.ts
Test command: npx vitest run --project unit src/cli src/utils (254 files, 5530 passed); eslint and tsc clean; build OK; bash -n / zsh -n / fish --no-execute pass on generated scripts.
Notes: No full-list tests needed updating. Commander's .choices error for invalid shell lists allowed choices; a MISSING argument does not, so added showHelpAfterError('(allowed shells: ...)') to stderr. Tests set exitOverride on the completion command (not inherited via addCommand). Root found via parent chain; version read from package.json in completion/index.ts.
