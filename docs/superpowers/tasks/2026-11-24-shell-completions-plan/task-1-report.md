BLOCKED

Commit sha: none. `git commit` failed with "Author identity unknown / empty ident name"; no git user.name/user.email is configured in this environment. I did not invent an identity. Changes are implemented and staged (git add), uncommitted.

Changed paths (staged):
- A src/cli/hidden.ts
- A src/cli/__tests__/hidden.test.ts
- M src/cli/deprecation.ts (hide() now calls markHidden)
- M src/cli/related-commands.ts (isHidden -> isHiddenCommand)
- M src/cli/__tests__/related-commands.test.ts (uses isHiddenCommand)
- M src/utils/tips-validator.ts (uses isHiddenOption)

Test command: npx vitest run --project unit src/cli/__tests__/hidden.test.ts src/cli/__tests__/related-commands.test.ts src/cli/__tests__/deprecation.test.ts src/utils/__tests__/tips-validator.test.ts
Result: RED confirmed (hidden.ts absent -> suite fails), GREEN after: 4 files, 38 tests passed (EXIT=0).

Notes:
- node_modules was missing; ran `npm install` (install scripts skipped by npm; tests ran fine).
- Interfaces: isHiddenCommand(cmd), isHiddenOption(opt), markHidden(cmd) in src/cli/hidden.ts; the only `_hidden` access in the repo.
- Did not verify tsc/eslint output (output was huge/noisy from lint of a bundled asset); pre-commit hooks will run on commit.
- To finish: set git identity (or supply env GIT_AUTHOR_*/GIT_COMMITTER_*) and run the commit with message
  "refactor(cli): EPMCDME-17673 add shared hidden-ness helper (shell-completions-plan task 1)" plus the Generated with AI trailer.
