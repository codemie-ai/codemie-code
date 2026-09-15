DONE

Commit: `8fc166bd89c4d8baee1c48f6a834b4b655f9b40b`

Changed paths:

- `src/agents/core/session/BaseSessionAdapter.ts`
- `src/agents/plugins/claude/claude.session.ts`
- `src/agents/plugins/claude/session/__tests__/claude-session-family.test.ts`

Focused test command:

`npx vitest run src/agents/plugins/claude/session/__tests__/claude-session-family.test.ts > docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/test.local.log`

RED evidence: exit 1; the relationship test failed because parsed flat child/grandchild entries omitted `parentAgentId`, `spawnDepth`, `requestShape`, and `requestNonInteractive`. The degradation test passed. Full output is preserved in `task-1-red.local.log`.

GREEN evidence: exit 0; 1 test file passed, 2 tests passed. Full output is in `test.local.log`.

Interface additions: parsed subagents now optionally expose `parentAgentId?: string`, `spawnDepth?: number`, `requestShape?: string`, and `requestNonInteractive?: boolean`. Claude discovery accepts these fields only when companion metadata contains the corresponding runtime type, then preserves them during transcript parsing. No relationships are inferred. Missing or malformed metadata remains compatible, duplicate UUIDs retain the last record, and a damaged sibling transcript does not discard readable usage or lifecycle protocol rows from other files.

Commit hooks passed ESLint, related Vitest tests, TypeScript typecheck, and secrets validation. `git show --stat HEAD` lists exactly the three declared owned paths.
