DONE bb32842

Changed paths:
- src/cli/commands/analytics/cost/types.ts
- src/cli/commands/analytics/cost/dispatch-extractor.ts
- src/cli/commands/analytics/cost/claude-trace.ts
- src/cli/commands/analytics/cost/__tests__/dispatch-extractor.test.ts

Command:
`npx vitest run src/cli/commands/analytics/cost/__tests__/dispatch-extractor.test.ts > docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/test.local.log 2>&1; echo "EXIT=$?"; tail -25 docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/test.local.log`

RED: `task-3-red.local.log` records EXIT=1 because the required `claude-trace` normalization API did not exist. A later focused cycle/duplicate-link RED was also observed before implementing duplicate-link conflict handling.

GREEN: EXIT=0, 1 test file passed, 7 tests passed. Commit hooks also passed ESLint, affected analytics tests, `tsc --noEmit`, and Gitleaks validation.

Shared API details:
- `buildClaudeTraceIndex(parsed)` exposes canonical `rootOwnerId`, every physical transcript owner, exact first-owner `toolOwners`, normalized `agents`, and `childAgentsByOwner` for descendant traversal.
- `normalizeClaudeTrace(events, parsed, index?)` applies metadata/structured agent identity, guarded ancestry, subtree observation, and authoritative completion/failure evidence.
- `DispatchEvent` additively exposes stable identity, owner/agent/parent/depth/relationship fields and separate acknowledgement, observation, completion, elapsed, and lifecycle status fields while preserving `durationMs`.

Behavior:
- Scans root and all flat sidechain transcripts, retains more than 60 native Claude steps, and keeps Codex extraction unchanged.
- Uses exact tool ownership and metadata relationships; replay copies are ignored, repeated names retain distinct tool IDs, and missing/conflicting/cyclic links stay unresolved.
- Accepts first root protocol task notification (including task-ID-only queue enqueue), rejects quoted text, and does not interpret async acknowledgement or `end_turn` as completion.
- Incomplete elapsed time extends through reachable descendant activity; authoritative completion/failure overrides observation.

Concerns:
- Lifecycle parsing intentionally recognizes preserved `system/task-notification` rows and root `queue-operation` enqueue XML. If a future Claude version changes that top-level protocol schema, it will remain incomplete/unknown rather than infer completion.
- `MAX_DISPATCHES` remains exported for existing non-native consumers, but native Claude extraction no longer applies it.
