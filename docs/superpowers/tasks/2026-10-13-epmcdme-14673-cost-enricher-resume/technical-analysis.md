# Technical Research

**Task**: cost-enricher enrichCosts session resume claude log
**Generated**: 2026-10-13
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-14673 "Wrong analytics stats after using resume command in codemie claude". After /resume, CodeMie creates a new session but it uses the same Claude log file as the old one. The report then gives all the cost to the old session and $0 to the new one. Repro: old session 6400b01b-e6f3-4cad-b877-b844ea506286 got 158,263 tokens ($0.1588), including a message written 51 seconds after it ended. New session 17aaebb0-17de-4b6c-b124-4c533d66e958 got 0 tokens and $0, despite 3 turns. Cause: enrichCosts() in cost-enricher processes sessions in start order with one shared seen set, so the first session on a log claims every message in it. On the reporter's machine this affects 12 sessions. (Fix should attribute messages to sessions by time window / session boundaries rather than first-come claim; consider other callers sharing the same logic.)

---

## 2. Codebase Findings

### Existing Implementations
- `src/cli/commands/analytics/cost/cost-enricher.ts` — `enrichCosts(sessions, deps=realDeps)` (line 402). Phase 1 `parseOne` parses each session's native log concurrently (`ParsedEntry` has `sessionId, filePath, parsed, startTime`, optional `observedStart/observedEnd` only for captured families). Phase 2 (line 412-413) sorts entries by `startTime` and creates ONE `seen = new Set<string>()`. Per entry, `gatherDedupedUsageRecords(agentName, parsed, seen)` (line 433) or fallback `gatherUsageDeduped` (line 446). First session on a log claims every record key; later sessions sharing that file get nothing. This is the reported bug.
- `src/cli/commands/analytics/cost/usage-readers.ts` — `takeUnseenRecords(records, seen)` (line 143) is the claim mechanism (key = message.id+requestId). Used by `gatherDedupedUsageRecords` (l.906, claude/codex/pi branches) and `gatherUsageDeduped` (l.859, pi l.880, claude l.891). `UsageRecord` has `key`, `ts` (epoch ms or null), `usage`, `model`, `ownerAgentId`. `extractClaudeUsageRecords` (l.167) returns chronological records. Comment l.140 documents "EARLIEST session owns a response that several transcripts replay" — intentional for Claude replay into resumed/forked logs (genuine duplicate messages across DIFFERENT files), but wrong for same-file sessions.
- `RawSessionData` (`src/cli/commands/analytics/data-loader.ts:120`) carries `startEvent.data.startTime`, `endEvent.data.endTime` (only when status=completed), `agentSessionFile`.
- `loadAgentSessionFile` (cost-enricher.ts:63) reads `~/.codemie/sessions/{id}.json` `correlation.agentSessionFile`; two sessions pointing at the same path is the resume scenario. `ParsedEntry.filePath` already exposes the path, so grouping by file needs no new data.
- Claude-specific post-processing consumes `records`: `buildCostSeries`, `buildModelTimeline`, classifier/routing cost, `enrichClaudeDispatchCosts(dispatches, entry.parsed, records, cost)` (l.519), `enrichSkillDispatchCost` (time-window attribution within records). Dispatch extraction uses `entry.parsed` (the whole log), not the filtered records, so dispatches for the shared log may still be listed under both sessions or one.
- `claude-ownership.ts` (`buildClaudeOwnership`) resolves per-response ownership between root and subagent transcripts within ONE family; unrelated to cross-session claim.

### Architecture and Layers Affected
Analytics cost layer only (`src/cli/commands/analytics/cost/`): cost-enricher.ts, usage-readers.ts. No CLI/registry/plugin change evident.

### Integration Points (all callers of `enrichCosts` share the logic)
- `src/cli/commands/analytics/index.ts:154` — `runAnalytics` over many sessions (batch; reporter's scenario).
- `src/cli/commands/analytics/report/session-report.ts:39` — `generateSessionReport` loads ONLY `filter:{sessionId}` (line 32-34) then calls `enrichCosts(rawSessions)`. Here the seen-set holds one session, so a resumed new session would claim the ENTIRE shared log, including the old session's messages (inverse over-attribution on exit report). A fix confined to the multi-session loop in enrichCosts would not fix this; the session window must be derivable for a lone session (needs sibling sessions on the same file, or the session's own start/end bound).
- `SourceResult.cost` from OtelSource bypasses enrichCosts (`index.ts:150`).
- Tests also call it from `native-loader.test.ts:204` and `pi.linked-transcripts.test.ts:190`.
- Native-discovered sessions (`native-loader.ts`) also set `agentSessionFile`; one-session-per-file there.

### Patterns and Conventions
- DI via `EnricherDeps` (resolveAgentName, loadAgentSessionFile, parseNative); pure logic unit tested without fs.
- ES modules, `.js` import extensions, `@/` alias, `logger.debug` for non-fatal failures (errors per session are caught, not fatal).
- Time bounds available: `startTime` always (`?? 0`); `endTime` only for completed sessions. The 51-second-after-end message shows `endTime` is not a reliable upper bound (message written after session end, e.g. session ended while Claude kept writing, or resume flushing); next-session-start on the same file is a better boundary. Speculative: this is a design call for the spec.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, testing, quality-gates, etc.); none specific to cost-enricher. Prior task analyses under `docs/superpowers/tasks/2026-06-23-codex-analytics-report/`, `2026-07-08-cost-price-completed-prefixed-sessions/`, `2026-09-26-unify-analytics-cost-command/` describe the enricher (report-time re-parse of native logs; dispatch costs are allocation of session totals, not additive).

### Architectural Decisions
- Header comment cost-enricher.ts:409-411 and usage-readers.ts:140: earliest session owns replayed responses (dedup across files because Claude replays prior turns into resumed/forked logs). Must be preserved for distinct files.
- Dispatch comment l.327-328: do not add to `seen` in dispatch enrichment.

### Derived Conventions
Dedup key `message.id:requestId`; records ordered chronologically; `ts` per record is the natural handle for window attribution.

---

## 4. Testing Landscape

### Existing Coverage
- `cost/__tests__/cost-enricher.test.ts` (large; includes cross-session dedup cases around lines 212-250, 400-412 using multiple raws with `baseDeps`), `claude-review-regressions.test.ts` (CR-012 at l.129-137: 'earlier' + 'root' sessions with shared usage via different files, expects replay excluded), `usage-readers.test.ts`, `native-loader.test.ts`, `pi.linked-transcripts.test.ts`, `tests/integration/agent-analytics-report-shape.test.ts`.
### Testing Framework and Patterns
Vitest; injected `EnricherDeps` stubs with synthetic `ParsedSession`; no fs.
### Coverage Gaps
No test where two sessions share the SAME `loadAgentSessionFile` path (the resume case) and no test for `session-report` single-session over a shared log. Per repo policy tests are written only on explicit request.

---

## 5. Configuration and Environment

No env vars, flags or deployment config involved. Session metadata under `~/.codemie/sessions/{id}.json` via `getCodemiePath`.

---

## 6. Risk Indicators

- Dedup-by-claim is intentionally relied on by existing tests (CR-012, cross-session dedup) for replay across DIFFERENT files; same-file handling must not break that.
- `session-report.ts` single-session path has the opposite failure (new session takes everything); fix must cover it or the exit report stays wrong.
- `endTime` absent for non-completed sessions and unreliable (message 51 s after end); boundary choice (next session start vs end) affects tail messages.
- Records with `ts === null` or `key === null` (unkeyable, always counted) cannot be window-assigned; fallback behavior needed.
- Non-Claude paths (codex, pi, kimi) share `takeUnseenRecords`; changes must be agent-agnostic or scoped to same-file sessions.
- Dispatch/skill enrichment and `buildClaudeOwnership` operate on `entry.parsed` (whole log), so filtering only `records` may leave dispatches/subagent costs attributed to both or wrong session (`enrichClaudeDispatchCosts` takes `records` and `cost`).
- Speculative: fix may require sibling-session lookup (sessions by shared file path) in `generateSessionReport`, since it loads only one session.

---

## 7. Summary for Complexity Assessment

Layers: a single analytics cost layer. Core change sits in `cost-enricher.ts` (`enrichCosts` phase 2 loop) and `usage-readers.ts` (`takeUnseenRecords`/gather functions), with `session-report.ts` as a second caller to verify. Likely 2-4 source files plus tests; no config, schema or plugin changes.

Technical novelty is moderate: replacing first-come claim with time-window attribution for sessions sharing a log file, while keeping cross-file replay dedup. Design choices (window upper bound, null-ts handling, per-agent scope, how a lone-session caller learns sibling boundaries) are non-trivial.

Test posture: good unit coverage via DI for the enricher with synthetic sessions, but no same-file case. Main risks: regressions in existing dedup semantics, dispatch attribution on the shared parsed log, and the single-session report path.

---

## 8. External References

None named by the task.
