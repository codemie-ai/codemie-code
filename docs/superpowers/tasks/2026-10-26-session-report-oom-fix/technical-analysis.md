# Technical Research

**Task**: analytics session-report native-loader sessions-source transcript-loading
**Generated**: 2026-10-26
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16400 — [CLI Analytics] [Session Analytics] Node.js OOM crash during session report generation due to loading all Claude transcripts.

`codemie-claude` crashes with a Node.js Out of Memory error during end-of-session analytics report generation. This happens after Claude's response has already been displayed. The report should process a single session, but the current implementation loads all Claude transcripts from the last 30 days before filtering. With large transcript histories, this exceeds the Node.js heap limit.

Steps to reproduce:
1. Have a large volume of Claude transcripts from the last 30 days (6.1 GB in the reported case).
2. Start a session using `codemie-claude`.
3. Execute a prompt and let Claude complete its response.
4. Exit the session, which triggers `BaseAgentAdapter.maybeWriteSessionReport()`.
5. Observe the Node.js process and check whether the session report is generated.

Actual result:
- Claude completes and displays the final response.
- CodeMie performs the final sync.
- Node.js reaches about 4,061 MB and crashes with OOM.
- The session analytics report is not generated.
- No error is logged in CodeMie's debug log because the process terminates.

Expected result:
- Only the relevant session transcript is processed for the session analytics report.
- Report generation stays memory-efficient regardless of total historical transcript volume.
- The session report is generated successfully.
- If report generation fails, CodeMie logs the error and terminates gracefully without crashing the CLI process.

Additional diagnostic details from a user comment (not in Jira's own comment list, from a screenshot):
- The debug log ends with a successful final sync, with no error line because the process was killed (OOM kill, not a caught exception).
- The next step, `BaseAgentAdapter.maybeWriteSessionReport`, never wrote the report because the output directory (`docs/codemie/`) doesn't exist yet.
- The crashed process was Node (not the Claude Code native binary, which is not the cause).
- The root cause is that `sessions-source.js` → `loadNativeSessions` in `native-loader.js` loads every Claude transcript from the last 30 days before filtering down to the current session. The user's transcripts totaled 6.1 GB. Node's default heap limit is around 4 GB, and the crash hit ~4,061 MB while reading a file.
- A related, already-fixed sibling bug is EPMCDME-16316 (doubled invocation/tool counts, fork_agent_id handling in the Claude Code OTLP plugin) — this ticket "clones" that one, so the same general subsystem (Claude Code session/analytics ingestion) was recently touched there.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/core/BaseAgentAdapter.ts:69-109` — `maybeWriteSessionReport(env)`: reads `CODEMIE_SESSION_ID` from env, lazy-imports `generateSessionReport`, wraps the call in a try/catch that only `logger.warn`s "(non-fatal)". Called at line 927, right after the agent's spawned process exits and before `renderSessionEnd()`. This try/catch is **structurally incapable of catching an OOM kill** — the process is killed before any catch block or pending promise runs.
- `src/cli/commands/analytics/report/session-report.ts` — `generateSessionReport({ sessionId, userEmail })`: builds `filter: { sessionId }` — **no `fromDate`/`toDate`** — and calls `new SessionsSource().load({ filter })`. Default output path: `join(process.cwd(), 'docs', 'codemie', 'analytics', 'codemie-analytics-[email-]<sessionId>.json')`.
- `src/cli/commands/analytics/sources/sessions-source.ts` — `SessionsSource.load()`: loads tracked sessions via `MetricsDataLoader.loadSessions(filter)`, then dynamically imports and calls `loadNativeSessions(opts.filter)` with the same sessionId-only filter, and only **after** it returns applies `.filter(s => loader.sessionMatchesFilter(s, opts.filter))`. The sessionId filter is applied post-hoc to already-fully-parsed data.
- `src/cli/commands/analytics/native-loader.ts`:
  - `loadNativeSessions()` (lines 717-785): calls `deps.discover(windowDays(filter))`, then in the main loop (750-784) calls `deps.parse(agentName, descriptor.filePath, descriptor.sessionId)` → `adapter.parseSessionFile()` for **every** discovered file, unconditionally, before checking whether it matches the requested sessionId. No sessionId short-circuit exists anywhere in this module.
  - `windowDays(filter)` (lines 604-611): if `filter.fromDate` is absent — which is always true for the session-report call path — returns `3650` days ("effectively all time"), which is **worse than the ticket's stated 30-day assumption**. This is the literal root cause.
- `src/agents/plugins/claude/claude.session.ts` — `discoverSessions()` (92-160): lists every `projects/<encoded-cwd>/*.jsonl`, `stat()`s each, keeps those with `mtime >= cutoffMs` where `cutoffMs = Date.now() - (options?.maxAgeDays ?? 30) * 86_400_000`. The adapter's own 30-day default is overridden by the `3650` passed down from `windowDays`. `parseSessionFile()` (188+) does `await readJSONL<ClaudeMessage>(filePath)` — a full in-memory read — for every qualifying file, plus every discovered sub-agent file (~line 262).
- `src/agents/core/session/utils/jsonl-reader.ts` — `readJSONL<T>()` (57-74) and `readJSONLTolerant<T>()` (19-48): both do `await readFile(filePath, 'utf8')` then `.split('\n').map(JSON.parse)` — **whole file in memory, no streaming, no size cap**. This is the shared primitive that actually causes the OOM: summed across an effectively-unbounded window, transcript volume (6.1 GB reported) is read into heap.
- `src/cli/commands/analytics/report/report-generator.ts` — `generateReportJson()`/`generateReport()` already call `mkdirSync(dirname(outputPath), { recursive: true })` (lines 49-50, 59-61) before `writeFileSync`, and `writeReportWithFallback()` (line 107) retries under `homedir()`/`tmpdir()` on `EPERM/EACCES/EROFS` — but only when `allowFallback` is true. `generateSessionReport()` calls it with `allowFallback = false` (session-report.ts line 71), so write failures for the auto session-end report propagate without a fallback. **Note**: this contradicts the ticket's stated diagnostic that the missing `docs/codemie/` directory itself blocked the write — directory creation is already handled; the OOM happens upstream of the write step, during `loadNativeSessions`, so the directory-creation code never gets reached, not because it's missing.
- `src/agents/core/session/discovery-types.ts` — `SessionDiscoveryOptions.maxAgeDays?: number` — the only lever controlling the discovery window, passed straight through from `native-loader.ts`.

### Architecture and Layers Affected

- **Agent lifecycle / orchestration**: `BaseAgentAdapter.run()` → `maybeWriteSessionReport` (session-exit hook, in-process, synchronous with the main CLI process — not a spawned child or worker, so an OOM here kills the whole agent run, not an isolated subprocess).
- **Report-generation service**: `session-report.ts` (`generateSessionReport`).
- **Source/aggregation layer**: `sessions-source.ts` (`SessionsSource`), `data-loader.ts` (`MetricsDataLoader`).
- **Discovery/native-ingestion layer**: `native-loader.ts` (`loadNativeSessions`, synthesis functions) — this is where the fix is centered.
- **Per-agent session adapters (parsing)**: `claude.session.ts`, `codex.session.ts`, `pi.session.ts`, `copilot-cli.session.ts`, `gemini.session-adapter.ts`, `opencode.session.ts` — all default `maxAgeDays ?? 30` but all get overridden by the `3650` passed in.
- **Shared file I/O utility**: `jsonl-reader.ts` — the actual memory-blowup point.

### Integration Points

- `agents/core/BaseAgentAdapter.ts` → `cli/commands/analytics/report/session-report.ts` (dynamic import)
- `session-report.ts` → `sessions-source.ts`, `cost/cost-enricher.ts`, `aggregator.ts`, `report/payload-builder.ts`, `report/report-generator.ts`
- `sessions-source.ts` → `data-loader.ts` (`MetricsDataLoader`), `native-loader.ts` (dynamic import)
- `native-loader.ts` → `agents/registry.ts` (`AgentRegistry`), `agents/core/session/BaseSessionAdapter.ts`/`discovery-types.ts` types, per-agent plugin helpers
- `agents/plugins/claude/claude.session.ts` → `jsonl-reader.ts` (`readJSONL`)
- No reverse dependency: `jsonl-reader.ts` and `native-loader.ts` are leaf-ward; nothing in `agents/` imports back from `cli/commands/analytics/`.
- Related sibling fix EPMCDME-16316 landed as commit `1da8b851` ("fix(analytics): skip api-request-blob lines, attribute skills, add fork_agent_id (#685)"). It touched `claude.session.ts` (added `isCountedTranscriptLine`/`keepFirstAcrossCompaction`/`conversationMessages`), `OtlpAgentAdapter.ts`, `BaseSessionAdapter.ts`, and the `claude-code-otlp` plugin tree — but **did not** touch `native-loader.ts`, `sessions-source.ts`, `BaseAgentAdapter.maybeWriteSessionReport`, or `jsonl-reader.ts`. It addressed OTLP line-counting correctness only, not memory usage, and `readJSONL` is still called the same full-read way after that fix.

### Patterns and Conventions

- **Adapter/registry pattern**: `AgentRegistry.getAgent(agentName).getSessionAdapter()` resolves a per-agent `SessionAdapter` implementing a common interface (`discoverSessions`, `parseSessionFile`).
- **Dependency-injection seam for testability**: `NativeLoaderDeps` interface in `native-loader.ts` injects `discover`/`parse`/`trackedLogPaths`/`realPath`/`hasOwnershipMarker`, used throughout `native-loader.test.ts` to avoid real fs I/O.
- **"Non-fatal, log and continue" convention** repeated at every layer (`SessionsSource.load`'s try/catch around native discovery, `maybeWriteSessionReport`'s try/catch, individual try/catch in `realNativeDeps.parse`/`discover`) — all catch only synchronous throws/rejected promises; **none guard against an OOM kill**.
- **Bounded-read precedent already exists in this exact module**: `hasOwnershipMarker()` in `native-loader.ts` uses `openSync`/`readSync` to read only the first 4096 bytes / first 10 lines — proving a size-limited-read idiom is already an established pattern in this codebase, just not applied to the main transcript-parse path. This is also documented as a prior OOM-avoidance decision: code review `CR-002` (EPMCDME-12992, `docs/superpowers/reviews/2026-07-01-EPMCDME-12992/code-review-final.json`) explicitly adopted the bounded 4KB scan "to avoid OOM on huge transcripts."
- **Streaming read pattern already exists elsewhere**: `src/cli/commands/log/reader.ts` `LogReader.readLogFile()` uses `createReadStream` + `readline.createInterface`, processing line-by-line via `for await (const line of rl)` with per-line filtering. This is a directly reusable pattern that `jsonl-reader.ts`/`native-loader.ts` do not currently use.
- **Second OOM-safe precedent elsewhere in the codebase**: `docs/superpowers/tasks/2026-08-05-epmcdme-13885-codex-file-attachments/actual-complexity.json` records a two-pass JSONL extraction + arithmetic size estimation (instead of full `Buffer` allocation) for Codex image attachments — another "avoid loading full file into memory" precedent.
- **Lazy caching singletons** (`ownershipIndexCache`) scoped to process lifetime.
- `windowDays()` deriving "all time" when `fromDate` is absent is a latent anti-pattern — session-scoped filters never set `fromDate`, so this path is always unbounded.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — defines the 5-layer plugin architecture (CLI → Registry → Plugin → Core → Utils); names the OTLP ingestion adapter pattern. No direct coverage of the session-report/native-loader OOM path, but establishes layering conventions a fix must respect.
- `.ai-run/guides/integration/external-integrations.md` — documents "Claude Session Processing" (`ConversationsProcessor`, drain loop, per-iteration sync checkpoint) and OTLP hook-event ingestion. Covers the live-hook ingestion path, not the retrospective `codemie analytics` session-report loader investigated here — useful for distinguishing the two pipelines.
- `.ai-run/guides/development/development-practices.md` — error-handling hierarchy (`CodeMieError` etc.), logging conventions, process execution (`exec()`, no `execSync`), TypeScript/testing patterns (dynamic imports for `vi.spyOn`). General conventions applicable to any fix touching `sessions-source.ts`/`native-loader.ts`.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — confirms the OTLP ingestion pipeline (live hook streaming to backend) is architecturally separate from the native-loader/session-report path (retrospective local transcript discovery). This is why EPMCDME-16316's fix did not touch any of the files relevant to EPMCDME-16400 — they are different subsystems despite "Claude Code session/analytics" being a shared umbrella.
- `docs/ANALYTICS-REPORT.md`, `docs/superpowers/specs/2026-07-09-session-exit-analytics-report-design.md`, `docs/superpowers/tasks/2026-07-21-analytics-metadata-json-session-reports/*`, `docs/superpowers/tasks/2026-07-27-analytics-report-always-populate-fields/*` — design/history docs for the session-report feature itself; useful background on intended behavior.

### Architectural Decisions

- `docs/superpowers/reviews/2026-07-01-EPMCDME-12992/code-review-final.json` (CR-002) — adopted the bounded 4KB/10-line transcript scan specifically "to avoid OOM on huge transcripts" for `hasOwnershipMarker` checks in `native-loader.ts`. This is the established precedent pattern (bounded/streaming reads over full-file loads) that this fix should extend to the main parse path.
- Same review (CR-003) — index-first ownership check must precede transcript-marker scan.
- Same review (CR-006/CR-007) — ownership marker moved to a sidecar file instead of appending to the live transcript, to avoid `appendFileSync` races.
- `docs/superpowers/reviews/2026-07-01-EPMCDME-12992-2/code-review-final.json` (CR-R-002) — `_metrics.json` filtering must use `.endsWith('_metrics.json')` not `.includes('_metrics')`, consistently between `native-loader.ts` and `session-ownership.ts` — relevant if the fix touches filename matching in the same module.
- No CHANGELOG/HISTORY entries yet mention EPMCDME-16316, EPMCDME-16400, "native-loader", "session report", or "OOM".

### Derived Conventions

- No NOTE:/HACK:/TODO:/ADR:/DECISION: marker comments exist in `sessions-source.ts`, `native-loader.ts`, or `BaseAgentAdapter.ts` — guidance in these files is prose/JSDoc, not tagged markers. Load-bearing comments: `sessions-source.ts:72` ("Returns true when the transcript at filePath contains a codemie_session_start marker (first 10 lines)"); `sessions-source.ts:201` ("CR-002: bounded transcript scan (4 KB) for legacy sessions without sidecar").

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/BaseAgentAdapter-session-report.test.ts` — tests `maybeWriteSessionReport` but mocks `generateSessionReport` entirely; only tests env/flag gating, missing-session-id handling, userEmail extraction, and non-fatal error swallowing. Does not exercise real transcript loading.
- `src/cli/commands/analytics/sources/__tests__/sessions-source.test.ts` — tests `SessionsSource.load()` but mocks both `MetricsDataLoader` and `native-loader.js` entirely. Never calls the real `loadNativeSessions`, so the "load everything then filter" cost is invisible.
- `src/cli/commands/analytics/__tests__/native-loader.test.ts` — the main native-loader suite. Uses the `NativeLoaderDeps` DI seam so no real fs/30-day-window scanning ever happens; fixtures are tiny hand-built in-memory objects. Covers synthesizeRawSession mapping, dedup, ownership labeling, codex turn counting — but not window/sessionId filtering cost.
- `src/cli/commands/analytics/__tests__/native-loader-pi.test.ts`, `native-family-bounds.test.ts` — same DI pattern, unrelated concerns (Pi-specific resolution, family bounds), not perf-related.
- `src/cli/commands/analytics/report/__tests__/session-report.test.ts` — mocks `SessionsSource.load`, `enrichCosts`, `AnalyticsAggregator.aggregate`, `buildPayload`, `report-generator` entirely. Confirms the call contract `{ filter: { sessionId: 's1' } }` with **no `fromDate`** — but never exercises the real loader, so the unbounded-load cost path has zero coverage.
- `src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts`, `usage-readers.test.ts` — small fixtures only, no large-file or memory-pressure scenarios.

### Testing Framework and Patterns

- Vitest `^4.1.5` (`@vitest/ui ^4.1.5`); `package.json` test script splits into `--project unit`, `--project cli`, `--project agent`.
- Dependency injection over fs mocking is the dominant pattern (`NativeLoaderDeps`).
- `vi.mock(...)` + dynamic `await import(...)` inside each `it` (not top-level) to get fresh module state per test.
- Inline fixture objects cast `as never` rather than factory functions, with small named helper factories (`makeSession`, `makeDeps`) per describe block.
- Only one test touches real disk I/O (`realNativeDeps.hasOwnershipMarker`, tiny tmpdir fixtures) — no size/volume testing anywhere in the suite.

### Coverage Gaps

- **No test exercises the real `windowDays(filter)` function when `fromDate` is unset** — exactly the case for `generateSessionReport({ sessionId })` — so the `3650`-day "all time" fallback has zero direct unit coverage.
- **No test covers `SessionsSource.load()` calling the real `loadNativeSessions`** — fully mocked, so there's no test proving/disproving the load-all-then-filter mechanism.
- **No large-file/many-session/high-volume fixture or helper exists anywhere** in the analytics test suite — nothing simulates 30 days of transcripts, large JSONL files, or memory pressure.
- **No test verifies per-session filtering at discovery/parse time** — current tests only check post-hoc array `.filter()`, never that discovery/parsing is skipped for non-matching sessions.
- **No streaming-read test for transcript parsing** — `usage-readers.ts` has streaming-read-adjacent comments but tests use small fixtures only.
- **`BaseAgentAdapter.maybeWriteSessionReport` tests never touch real `generateSessionReport`** — the whole chain down to native-loader is mocked, so coverage is siloed per layer, not end-to-end for the "single session + huge backlog" scenario this ticket is about.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_SESSION_ANALYTICS_REPORT` — kill switch; `'0'` suppresses the auto session-end report entirely (`BaseAgentAdapter.ts:71`), mapped from CLI flag `--no-analytics-report`. This is the de facto feature flag for the whole OOM-prone path and could serve as an immediate mitigation/toggle.
- `CODEMIE_SESSION_ID` — the session id the report is scoped to; required; if absent the report step is skipped.
- `CODEMIE_PROFILE_CONFIG` — JSON blob parsed for `userEmail`, falls back to `ConfigLoader.loadMultiProviderConfig()`.
- **No `NODE_OPTIONS`, `--max-old-space-size`, or any heap-size env var exists anywhere in the repo** (confirmed via repo-wide grep across `package.json`, `bin/*.js`, CI workflows, source). All `bin/codemie-*.js` entry points use a plain `#!/usr/bin/env node` shebang with no memory flags — the process runs on Node's default heap (~4GB on 64-bit), consistent with the reported crash ceiling.

### Configuration Files

- No dedicated config file governs the discovery window or transcript loading limits; the `30`-day default is hardcoded per-adapter (`claude.session.ts:99`, `codex.session.ts:120`, `pi.session.ts:343` all use `?? 30`) and is silently overridden whenever `native-loader.ts` passes an explicit `maxAgeDays`.

### Feature Flags and Deployment Concerns

- `CODEMIE_SESSION_ANALYTICS_REPORT` / `--no-analytics-report` — only toggle guarding the OOM-prone path.
- `metadata.sessionAnalyticsReport` (per-agent-plugin boolean) — opt-in at the plugin level; `maybeWriteSessionReport` no-ops if unset.
- No Dockerfiles relevant to this path; this is a locally-installed CLI, so there is no central place to inject `NODE_OPTIONS` other than editing every `bin/codemie-*.js` shebang script or the user's shell profile — a heap-bump mitigation (as opposed to loading less data) would require new infrastructure.
- The report-generation step runs synchronously in-process during session finalization (not off-loaded to a worker/child process), so any heap blow-up takes down the parent CLI/agent process rather than failing in isolation.
- **Output directory handling is already correct**: both `generateReportJson()` and `generateReport()` call `mkdirSync(dirname(outputPath), { recursive: true })` immediately before `writeFileSync` — a missing `docs/codemie/analytics/` directory is created automatically. This means the ticket's diagnostic detail about the missing directory "blocking" the write is describing a symptom (the report never got that far because the process died during `loadNativeSessions`), not an independent bug in directory creation.

---

## 6. Risk Indicators

- **Root cause confirmed and precisely located**: `windowDays()` in `native-loader.ts:604-611` returns `3650` (not even 30 days, as the ticket assumed) whenever `filter.fromDate` is unset — which is always true for session-scoped report generation. This is passed as `maxAgeDays` to every agent adapter's `discoverSessions()`, overriding each adapter's own 30-day default.
- **No per-file or per-line short-circuit by session id exists anywhere** in the discovery/native-loader path — both the date-window check and the sessionId check happen strictly after full-content loading of every discovered file.
- **The actual OOM point is `readJSONL`/`readJSONLTolerant` in `jsonl-reader.ts`** (`await readFile(filePath, 'utf8')` then `.split('\n').map(JSON.parse)`) — a full-buffer, non-streaming read with no size cap, called once per discovered file across an effectively unbounded window.
- **Existing try/catch error handling is structurally incapable of addressing this failure mode**: no `process.on('uncaughtException'/'unhandledRejection')` exists anywhere in `src` (confirmed via repo-wide grep); all safety nets are per-call try/catch around synchronous throws/rejected promises, none of which fire on an OOM kill. The ticket's "expected result" (log and terminate gracefully without crashing) cannot be satisfied by exception handling alone — it requires either reducing peak memory (primary fix) or externalizing report generation to a subprocess that can be killed/monitored independently (secondary/complementary option, not currently supported by any infra in this repo).
- **No large-volume/high-memory test fixtures exist anywhere in the analytics suite** — any fix will need new test infrastructure (synthetic large-file or many-file fixtures) to actually prove the OOM is resolved; existing tests mock the loader too aggressively to catch regressions in this exact failure mode.
- **Coverage is siloed per layer**: `BaseAgentAdapter` tests mock `generateSessionReport`; `session-report.ts` tests mock `SessionsSource`; `sessions-source.ts` tests mock `native-loader.js`. No existing test exercises the full chain, so an end-to-end regression test is needed in addition to unit-level fixes.
- **Streaming read primitive already exists in the codebase** (`LogReader.readLogFile()` in `src/cli/commands/log/reader.ts`, using `createReadStream` + `readline.createInterface`) but is not reused by the transcript-parsing path — adopting it (or a similar streaming JSONL reader) is a natural, pattern-consistent fix rather than a novel approach.
- **Bounded-read precedent already exists in the same module** (`hasOwnershipMarker`'s 4KB/10-line read, explicitly adopted in a prior code review — CR-002 — "to avoid OOM on huge transcripts") — reinforces that the team has already recognized and partially addressed this class of risk, just not for the main parse path.
- **Sibling ticket EPMCDME-16316's fix did not touch any of the files relevant to this OOM path** (`native-loader.ts`, `sessions-source.ts`, `BaseAgentAdapter.maybeWriteSessionReport`, `jsonl-reader.ts`) — despite both being filed under "Claude Code session/analytics," they are architecturally separate subsystems (live OTLP hook ingestion vs. retrospective native transcript discovery). No conflict risk, but also no reusable fix from that ticket.
- **No mechanism exists today to bump Node's heap limit** (no `NODE_OPTIONS`/`--max-old-space-size` anywhere in the repo) — if memory-reduction alone is judged insufficient, a heap-limit increase would require new infra across all `bin/codemie-*.js` entry points, which is a larger, cross-cutting change outside this ticket's apparent scope.
- **Directory-creation diagnostic in the ticket is a red herring, not a separate bug**: `mkdirSync({ recursive: true })` already runs before every write; the report never reaches that step because the process is OOM-killed earlier, during `loadNativeSessions`. This should be clarified in the fix's scope so effort isn't spent on a non-issue.

---

## 7. Summary for Complexity Assessment

This fix is tightly scoped to a well-understood, precisely located root cause: `windowDays()` in `src/cli/commands/analytics/native-loader.ts` (lines 604-611) returns a 3650-day ("all time") window whenever a filter lacks `fromDate` — which is always the case for the session-scoped report path (`generateSessionReport({ sessionId })` → `SessionsSource.load({ filter: { sessionId } })` → `loadNativeSessions(filter)`). Combined with `jsonl-reader.ts`'s non-streaming, full-buffer `readJSONL`/`readJSONLTolerant` (no size cap, no line-by-line processing) and the absence of any sessionId short-circuit in `loadNativeSessions`'s discover-then-parse loop, every historical transcript across the (effectively unbounded) window gets fully loaded into heap before the single relevant session is filtered out. The primary change surface is 2-4 files: `native-loader.ts` (bound the window and/or short-circuit by sessionId during discovery/parse rather than after), `jsonl-reader.ts` or a new streaming reader (replace full-buffer reads with line-by-line/streaming processing, reusing the existing pattern already present in `src/cli/commands/log/reader.ts`), and possibly `sessions-source.ts` (push the sessionId filter earlier in the pipeline). No database/migration layer is touched; this is purely CLI/service-layer logic within the `cli/commands/analytics/` and `agents/core/session/` directories.

Technical novelty is low — the codebase already contains two directly relevant precedents for exactly this class of fix: a bounded 4KB/10-line read (`hasOwnershipMarker` in the same `native-loader.ts` file, adopted via a prior code review specifically to avoid transcript OOM) and a full streaming line-by-line reader (`LogReader.readLogFile` using `createReadStream`/`readline`). The fix should extend these existing, team-endorsed patterns rather than invent a new approach. The secondary requirement — "log the error and terminate gracefully without crashing" — is architecturally harder: no `process.on('uncaughtException'/'unhandledRejection')` handler exists anywhere in the repo, and existing try/catch blocks at every layer (`BaseAgentAdapter.maybeWriteSessionReport`, `SessionsSource.load`) only catch synchronous throws, not OOM kills. Satisfying the ticket's graceful-degradation expectation may require either accepting that memory-reduction alone prevents the crash (making graceful-failure moot in practice) or considering process isolation (not currently supported by any infra in this repo, and likely out of scope given the ticket's framing).

Test coverage posture is a significant risk factor: every existing unit test in this subsystem (`sessions-source.test.ts`, `native-loader.test.ts`, `session-report.test.ts`, `BaseAgentAdapter-session-report.test.ts`) mocks its immediate dependency, so none exercise the real discover→parse→filter chain, and none simulate large/many transcript files or memory pressure. A credible fix will need new test infrastructure (synthetic large-file or many-descriptor fixtures, and/or an assertion on the `maxAgeDays`/window value actually passed to `discover()` when no `fromDate` is set) to prove the regression is closed, in addition to the production code change. Complexity should weight moderately-high on "test infrastructure gap" even though the production code change itself is narrow and well-precedented.
