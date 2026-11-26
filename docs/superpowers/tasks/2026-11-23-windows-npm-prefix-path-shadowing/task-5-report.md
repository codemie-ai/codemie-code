BLOCKED
commit: none (changes staged, not committed)
files: src/cli/commands/install.ts, src/cli/commands/__tests__/install.path-shadow.test.ts (both staged)
test_command: npx vitest run src/cli/commands/__tests__/install.path-shadow.test.ts src/cli/commands/__tests__/install.version-selection.test.ts  (EXIT=0, 12 passed); tsc and eslint clean
notes:
- RED seen (4 failed) before implementation, GREEN after.
- Added printPathShadowAdvice(agent) in install.ts: calls checkPathShadow({resolvePrefix:true}) after spinner succeed/warn and after both "already installed" messages; prints formatShadowWarning / formatNotOnPathHint lines in chalk.yellow for shadowed / missing-on-path only; swallows errors (logger.debug). Exit code unchanged.
- No resetPathMatches added: nothing queries getPathMatches before install in the same process (only checkPathShadow calls it, and install calls it once), so the memo is fresh.
- BLOCKER: pre-commit hook (lint-staged) runs vitest on ALL of src/cli/commands/__tests__/ and hangs indefinitely (tried twice, >5 min, killed). Running the whole dir manually also stalls after ~186 tests; the stalled file is among hook.session-delivery / self-update / whatsnew / hook.not-managed (pre-existing, not touched by this task). Did not use --no-verify. A "lint-staged automatic backup" stash entry may remain in git stash list from the aborted hooks.
