# Technical Research

**Task**: omp pi analytics subagents
**Generated**: 2026-10-21
**Research path**: filesystem

---

## 1. Original Context

"~/Sites/codemie-code/OH_MY_PI_ANALYTICS_PLAN.md" — that file IS the full requirements (Oh My Pi (omp) analytics parity with Claude Code; Steps 0-10, decisions already made, verification). Read it fully.

Assignment clarification: Verify the file/line anchors the requirements cite still match the code (pi.session.ts loadSubagentRuns, usage-readers.ts extractPiUsageRecords, native-loader.ts synthesizePiRawSession/piConversationLines/piLineTimestamp, pi-file-operations.ts, pi.metrics-processor.ts, pi-named-invocations.ts, session-source-detector.ts + its test, dispatch-extractor.ts, cost-enricher.ts, claude-dispatch-allocation.ts, codex-dispatch-extractor.ts, report/client/app.js). Write technical-analysis.md (with 'Codebase Findings' and 'Risk Indicators' sections) and return a ≤400-word digest.

The requirements source was read completely, lines 1–328. Its corpus measurements are user-supplied evidence, not newly measured results. Research only: no implementation, builds, tests, lint, report generation, or browser checks were performed.

---

## 2. Codebase Findings

### Existing Implementations

The checkout is the ESM TypeScript package `@codemieai/code` 0.15.9, requiring Node >=20. Top-level areas include `src/`, `tests/`, `bin/`, `scripts/`, `docs/`, `openwiki/`, `install/`, `assets/`, `examples/`, and `.ai-run/`. `package.json` declares Commander 11, Zod 4, Vitest 4.1.5, TypeScript ^5.3.3, ESLint 9, and `tsc-alias`; the researched transcript/cost path principally uses Node filesystem/path APIs and internal types rather than a Pi SDK.

All source paths below are relative to `/Users/gokhan_ozdemir/Sites/codemie-code`. Anchors were checked against the working-tree files, not the older MCP index (whose reported indexing date was September 9).

| File and verified anchor | Existing behavior / anchor status |
|---|---|
| `src/agents/plugins/pi/pi.session.ts:28-43` | Exports `PI_SUBAGENT_RUN`, `PI_FORKED_CONTINUATION`, and `piForkedContinuations`; continuations are distinguished from delegated runs. |
| `src/agents/plugins/pi/pi.session.ts:204-242` | `loadSubagentRuns` still walks exactly `<agentDir>/<runDir>/session.jsonl`, assigns `agentId = agentDir/runDir`, and omits `toolUseId`. The cited anchor matches. No recursive omp `<TaskId>.jsonl` linking exists here. |
| `src/agents/plugins/pi/pi.session.ts:249-273` | Existing `readSessionHeader` skips leading `title` records, then validates the first non-title record. It reads at most 65,536 bytes and returns undefined for malformed/unreadable headers. |
| `src/agents/plugins/pi/pi.session.ts:362-410` | `discoverSessions` and `listTranscripts` match the cited region. Discovery enumerates top-level `.jsonl` files, not delegated descendants. |
| `src/cli/commands/analytics/cost/usage-readers.ts:700-719,792-841` | `PiUsageEntry` has `modelId`, not envelope `model`. `extractPiUsageRecords` walks all linked message arrays and handles assistant, toolResult, compaction, and branch_summary usage. It does not handle `model_usage` or set Pi `ownerAgentId`. Cited starts 700/792 match. |
| `src/cli/commands/analytics/native-loader.ts:489-508,510-517` | Private `piConversationLines` merges own entries and forked continuations, deduplicating IDs. `piLineTimestamp` prefers finite message timestamps over parsed envelope timestamps. Both cited ranges match exactly; the timestamp helper currently assumes an object. |
| `src/cli/commands/analytics/native-loader.ts:576-614` | `synthesizePiRawSession` derives tools and named invocations from the fork-family only. Its metrics spread ends with `...parsed.metrics`, preserving adapter precedence. It synthesizes no file operations. Cited range matches. |
| `src/agents/plugins/pi/session/pi-file-operations.ts:9-31,36-50,53-109` | Single-operation extractor `extractPiFileOperation` starts at 68; `countPiDiffLines` starts at 36. Mapping supports read/edit/write/grep/ls/find, not omp glob. Paths are copied without normalization; there is no perFileResults, resolvedPath priority, selector stripping, internal-URI/session-local exclusion, or edit-delete interpretation. |
| `src/agents/plugins/pi/session/processors/pi.metrics-processor.ts:32,41,222,409,670-673` | All cited managed cutover anchors match. This is the only production consumer found for the singular extractor, including its return-type alias and wrapper. Successful matched results carry fileOperations; failed results do not. |
| `src/agents/plugins/pi/session/pi-named-invocations.ts:295-343` | Existing count-only walk matches the cited anchor: omp skill-prompt, user skill wrappers, subagent/task calls, successful skill reads, and promptedThisTurn suppression. No timestamped list or count-summing export exists. |
| `src/cli/commands/analytics/report/session-source-detector.ts:49-76` | `SDLC_FACTORY_COMMANDS` has six names; five ordered detectors exist: sdlc-factory, superpowers, openspec, speckit, bmad. First match wins over lowercased skill/agent/command names. |
| `src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts:67` | Exact five-name order assertion still exists on the cited line. |
| `src/cli/commands/analytics/cost/dispatch-extractor.ts:136-145` | Codex branches at 138; every other agent falls through to Claude trace indexing. There is no Pi branch. |
| `src/cli/commands/analytics/cost/cost-enricher.ts:478-548,685-699` | Both cited regions match. Generic dispatch costing joins `sub.toolUseId` to `_toolUseId`, reads usage as Codex or Claude, and counts Codex/Claude tool shapes only. Claude has a separate enrichment branch. Raw internal IDs are stripped when storing public dispatches. |
| `src/cli/commands/analytics/cost/claude-dispatch-allocation.ts:1-128` | Existing reference exports `enrichClaudeDispatchCosts`, not `allocateClaudeUsage`. It uses Claude ownership/trace indexing and prices own/inclusive allocations. Pi cannot reuse its ownership assumptions directly. |
| `src/agents/plugins/codex/session/codex-dispatch-extractor.ts:1-96` | Existing model for agent-specific extraction: spawn/wait pairing, timed skill reads, chronological sort, MAX_DISPATCHES cap. |
| `src/cli/commands/analytics/report/client/app.js:33,1587,1592-1609,1613-1617,1742-1749,1801` | Labels, Commands, allocation guard, code-change card, Timeline, and project net-lines anchors match. Sessions net-lines rendering is at 1079, not the plan's 1069. |

The other cited UI metric regions match their described components: Overview 330/376/383/391/414–422, Agents 451/482/490–496, Frameworks 515–526, Projects 562–573, Efficiency 725–731/769–790/795–807. The slash-command chart definition is at 177.

### Architecture and Layers Affected

- **Transcript adapter**: `PiSessionAdapter` reads native logs and exposes linked transcripts through `ParsedSession.subagents`.
- **Shared Pi domain extraction**: `pi.types.ts` defines message guards and tool-call extraction; session helpers extract file effects and named invocations.
- **Managed metrics**: `PiMetricsProcessor` correlates calls/results, persists metric deltas, and uses CodeMie run boundaries and invocation ledgers.
- **Native analytics synthesis**: `native-loader.ts` builds unmanaged Pi/omp session events and metrics; fork families are folded here rather than in the adapter.
- **Cost and dispatch enrichment**: usage readers normalize and deduplicate spend; dispatch extraction and allocation feed `SessionCost`.
- **Report payload and UI**: `payload-builder.ts`, source detection, and plain-JavaScript `app.js` consume normalized metrics and costs.

### Integration Points

- Adapter → `ParsedSession` → native synthesis and cost readers. `BaseSessionAdapter.ts:39-49` already includes `agentType`, `agentId`, `parentAgentId`, `spawnDepth`, messages, file path, and tool-use identity; no missing linked-transcript field was discovered.
- Pi message tooling → successful result correlation → `FileOperation` → existing analytics aggregation. `extractFormat` and `detectLanguage` are shared utilities in `src/utils/file-operations.ts`.
- `UsageRecord` already supports ownership for other agents. Shared `dispatch-allocation.ts:40-52` exports `priceAllocation`, normalizes model names, prices through `lookupPrice`, and sums accepted token records.
- `cost/types.ts:119-122` already defines `_taskId`, `_toolUseId`, and `MAX_DISPATCHES = 60`. `SessionCost` already exposes root/unlinked allocation fields.
- `report/payload-builder.ts:127-129` uses dispatch-derived invocation counts only when `dispatchesComplete` is true; otherwise named invocation metrics remain authoritative.
- `report/types.ts:128-130`, `docs/ANALYTICS-REPORT.md:240-250`, and `analytics-output-writes.test.ts:59-62` establish a flat exported `{meta, sessions}` ReportPayload. The aggregate input has projects/branches, but that is not the JSON export shape.
- All relevant source integration is local filesystem/report processing. No new network service, database model, ORM, migration, credential, or remote-ingestion dependency was discovered in this scope.

### Patterns and Conventions

- Stable entry/response IDs deduplicate replayed fork history; transcript-local model state resets at each message-array boundary. Usage records are chronologically sorted only when all have timestamps.
- Missing/unreadable child directories and malformed JSONL lines degrade without aborting the report; identity is not inferred from mtime or timing.
- Tool names are case-sensitive. The file-operation helper counts write-content lines after stripping one trailing newline; diff counters count +/- lines excluding headers.
- Named invocation extraction qualifies plugin skills using resolved SKILL.md paths; omp task arguments support array, encoded JSON, and flat forms.
- Framework detectors are ordered data, not a branching classifier. Generic skill names are deliberately ambiguous; the plan's exclusions are explicit requirements.
- Raw dispatch correlation keys stay internal; the public payload explicitly projects supported dispatch/allocation fields.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/project.md` records project identity, GitHub/Jira adapters, and lifecycle conventions; it is not an analytics design guide.
- `.ai-run/guides/quality-gates.md` documents typecheck/lint/build/Vitest gates and Windows CI concerns. Its abbreviated build command omits today's `bundle-statusline`; current `package.json` is authoritative.
- `docs/ANALYTICS-REPORT.md` describes views, native discovery/provenance, report payloads, offline HTML, and output targeting. It explicitly calls `{meta, sessions}` the only JSON export schema.
- `CHANGELOG.md` Unreleased already records omp discovery, plugin-qualified skill naming, and native tool/skill/task counts. These are earlier changes, not evidence that file/child-spend parity is complete.
- `.github/instructions/commit.instructions.md` applies to Markdown and specifies Conventional Commits; no commit is part of this assignment.

### Architectural Decisions

- `pi.session.ts:192-200` and `pi.linked-transcripts.test.ts` explain why fork continuations must not be attached by the general adapter: doing so misbills later managed runs to earlier sessions.
- `native-loader.ts:566-574` intentionally avoids fabricating git branches for native Pi transcripts; current working-tree branch is not historical evidence.
- `dispatch-allocation.ts:7-14` treats dispatch cost as allocation of accepted session usage, not additional session spend. Zero-duration skill events remain without cost/tokens.
- The task source fixes scope: descendants contribute files/lines/languages and skill/agent names; parent turns/tool counts remain unchanged; Claude-specific gaps and unknown vendor rates are excluded.

### Derived Conventions

- Keep Pi-format handling shared between upstream Pi and omp while routing using existing Pi-family predicates.
- Use filesystem fixtures and explicit timestamps rather than historical branch guesses or external network dependencies.
- Existing report cards already consume file metrics, dispatches, and allocation fields; their absence is primarily a missing producer issue, not missing view infrastructure.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/pi/__tests__/pi.linked-transcripts.test.ts:86-198`: Pi nested run identity/order, omitted toolUseId, absent runs, exclusion of fork siblings, tracked fork billing.
- `src/agents/plugins/pi/__tests__/pi.named-invocations.test.ts:97-306`: skill wrappers; subagent management/deferred/workflow cases; omp prompts, skill reads, duplicate suppression, namespace recovery, task argument forms.
- `src/agents/plugins/pi/__tests__/pi.metrics-processor.test.ts`: incremental run boundaries, persisted invocation ledgers, re-entrancy, successful matched write effects at 551, and unresolved calls.
- `src/cli/commands/analytics/__tests__/native-loader-pi.test.ts`: Pi synthesis, prompt counts, timestamps, models, metrics precedence, tools/outcomes, fork replay deduplication, native loading and fork families.
- `src/cli/commands/analytics/cost/__tests__/usage-readers.test.ts:704-929`: Pi field mapping, model attribution for auxiliary summaries/tool results, transcript isolation, linked usage inclusion, record ordering, response/entry identity and fork replay.
- `src/cli/commands/analytics/report/__tests__/session-source-detector.test.ts`: existing namespaced/bare signals, precedence, case folding, fallback, and exact detector order.
- Adjacent suites: `cost/__tests__/dispatch-extractor.test.ts`, `cost-enricher.test.ts`, `claude-review-regressions.test.ts`, and report payload/view/generator tests. Their presence is not a claim of Pi parity coverage.

### Testing Framework and Patterns

Vitest ^4.1.5 with Node environment and unit/cli/agent projects (`vitest.config.ts`). Unit tests live under src; CLI integration under tests/integration; agent integration requires real auth/network. Tests use deterministic object builders, temporary JSONL trees, `vi.mock` logger/dependencies, and injected enricher/native-loader dependencies. Test homes are isolated through CODEMIE_HOME. No tests were run for this research.

### Coverage Gaps

No direct imports/tests of `extractPiFileOperation` or `countPiDiffLines` were found in searches of src/tests/unit. Inspected existing tests do not cover recursive omp child layout, model_usage ownership, normalized multi-file/URI effects, timestamped invocation lists, Pi dispatch progress timing, or Pi root/unlinked allocation. The plan authorizes only the detector-order assertion change and says tests run only on request; this is an explicit constraint, not permission to silently expand test changes.

---

## 5. Configuration and Environment

### Environment Variables

- `PI_CODING_AGENT_SESSION_DIR` overrides session-directory selection (`pi.paths.ts:129-131`).
- `PI_CODING_AGENT_DIR` controls effective Pi settings root (`pi.paths.ts:133`).
- `CODEMIE_MODEL` supplies a managed processor fallback (`pi.metrics-processor.ts:239`).
- `CODEMIE_HOME` isolates test storage; `CI_AGENT_MAX_WORKERS` controls real-agent test concurrency (`vitest.config.ts`).

### Configuration Files

- `package.json`: typecheck is `tsc --noEmit`; lint enforces zero warnings; build compiles, rewrites aliases, copies plugins, and bundles statusline.
- `src/utils/pricing.json`: local model prices. No `claude-haiku-5-5` match was found; the task explicitly forbids inventing a rate.
- `.pi/settings.json` and effective agent settings supply optional sessionDir overrides through `pi.paths.ts`.
- `vitest.config.ts`: project selection, timeouts, isolation, temporary CodeMie home, and coverage exclusions.

### Feature Flags and Deployment Concerns

`--include-external` includes directly launched Pi/omp and Claude sessions; otherwise discovery alone does not include them in the report. `--last 90d`, export format, and explicit output targeting define the requested corpus comparison. The local omp/Claude source directories both exist; their contents and counts were not re-measured. The HTML is portable/offline. No feature flag or secrets provisioning is specified for parity. Current `npm run lint` targets TypeScript plus Pi extension JS, not report/client/app.js, so that UI file is outside the named lint command's coverage.

---

## 6. Risk Indicators

- Export-shape mismatch: Verification 4 expects projects/branches; actual JSON is `{meta, sessions}`. Apply hygiene assertions to exported sessions.
- Fork ownership regression: shared ID deduplication and continuation-to-root ownership protect managed billing.
- Path contamination: URI writes, selectors, duplicated per-file diffs, and session-local artifacts currently lack filtering.
- Allocation boundaries: 60-event capping can leave usage unlinked; child-own costs and zero-duration skill costs are distinct.
- Coverage constraint: only detector-order test changes are authorized; new Pi extraction/allocation behavior lacks dedicated coverage.
- Corpus-sensitive evidence: thresholds are supplied measurements; no baseline/report checks ran here, and unknown Haiku rates remain excluded.

---

## 7. Summary for Complexity Assessment

The change crosses transcript discovery, shared Pi extraction, managed metrics, native synthesis, cost/dispatch allocation, framework classification, and report UI. Named source anchors match, except Sessions net-lines rendering moved from 1069 to 1079. Existing types, allocation pricing, payload fields, and cards are reusable; two Pi-specific modules are absent as described.

Existing tests protect Pi layouts, fork billing, invocation recognition, and usage deduplication, but not the requested omp pipeline. Decisions are already fixed in the source plan. The main execution caveat is its outdated JSON hygiene traversal. Build/lint/typecheck, before/after report comparisons, hygiene assertions, and manual UI verification remain main-agent work; tests require explicit request.

---

## 8. External References

- `/Users/gokhan_ozdemir/Sites/codemie-code/OH_MY_PI_ANALYTICS_PLAN.md`: resolved; all 328 lines read. Authoritative Steps 0–10 specify child linking, auxiliary usage, helpers, file operations, invocations, framework bundles, dispatch allocation, and unrecorded Commands. Acceptance includes ≥100 changed-file omp sessions, ≥50 dispatch sessions, increased spend/tokens, Pure chat <512, and unchanged Claude totals.
- `/Users/gokhan_ozdemir/.claude/plugins/cache/sdlc-factory/sdlc-factory/0.10.3/{skills,agents}`: resolved inventories corroborate Step 8's non-generic names.
- `/Users/gokhan_ozdemir/.agents/.skill-lock.json`: resolved; mattpocock/skills entries corroborate the requested exact-name list after exclusions.
- `/Users/gokhan_ozdemir/.claude/plugins/cache/sdlc-factory/secops/0.3.2/{skills,agents}`: resolved inventories corroborate SecOps names/exclusions.
- `/Users/gokhan_ozdemir/.omp/agent/sessions` and `/Users/gokhan_ozdemir/.claude/projects`: present directories; corpus counts and monetary measurements remain task-provided, not rerun.
