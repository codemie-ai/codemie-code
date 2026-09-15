# Technical Research

**Task**: analytics session subagents cost
**Generated**: 2026-09-15
**Research path**: codegraph

---

## 1. Original Context

[$sdlc-factory:sdlc-autonomous](/Users/Vadym_Vlasenko/.codex/plugins/cache/sdlc-factory/sdlc-factory/0.10.3/skills/sdlc-autonomous/SKILL.md) let's analyse my last current claude code session: "db7ad8f6-061d-4e9a-a7e9-b02b44b5d76a" and then analyse "codemie analytics --report ..." functionality which runs report analytics, seems on Sessions tab it's not correctly calculating "**Timeline**
click a step for cost, token & timing details · positioned across the session" and traces, total cost is also not fully right.
seems there is a bug of subagents in subagents for calculation.
you can see this report file:///Users/Vadym_Vlasenko/AI/projects/delivery/ai-hyperfactory-app/codemie-analytics-vadym-vlasenko-epam-com-2026-09-15.html just in case.

we need fully fix this functionality and make it totally correct. let's do and validate

---

## 2. Codebase Findings

### Existing Implementations

- src/cli/commands/analytics/index.ts: runAnalytics loads native/tracked session facts, separately enriches native costs, aggregates, then builds HTML/JSON. The native session report is a local transcript estimate; it does not fetch provider billing. OTEL is a separate source and can supply authoritative source costs.
- src/agents/plugins/claude/claude.session.ts: parseSessionFile deduplicates repeated UUIDs, extracts metrics from only root messages, and reads all flat agent-*.jsonl files under the root session's subagents directory. findSubagentFiles reads toolUseId and agentType from companion metadata but discards parentAgentId, spawnDepth, requestShape and requestNonInteractive. The real reference session stores all three descendant depths flat in that directory: recursive filesystem traversal alone would not fix this case.
- src/agents/core/session/BaseSessionAdapter.ts: ParsedSession.subagents is a flat array carrying agentId, filePath, messages, toolUseId and agentType. The contract currently has no parent identity or lifecycle fields.
- src/cli/commands/analytics/cost/usage-readers.ts: extractClaudeUsageRecords already combines root and all discovered descendants. It collapses progressive streaming copies by message.id::requestId, choosing greatest total-token usage and latest timestamp on ties. It chronologically sorts fully timed records. gatherDedupedUsageRecords applies cross-session ownership through a shared seen set.
- src/cli/commands/analytics/cost/cost-enricher.ts: session totals and cumulative series use the same deduplicated records. enrichDispatchCosts joins toolUseId to one child and prices only that child's own messages, without descendants. A fresh seen set per dispatch may also attribute replayed history that the report session did not own. Skills use a wall-clock filter over all session records, even though comments call them the session's own records, so overlapping descendant usage is not distinguished.
- src/cli/commands/analytics/cost/dispatch-extractor.ts: intentionally extracts only parsed.messages and skips every isSidechain=true row. It never visits linked child messages. It treats the matching tool_result timestamp as completion, including structured isAsync:true / status:async_launched responses. It slices to MAX_DISPATCHES=60 without exposing omitted counts. Internal toolUseId is stripped from public records, leaving no stable public trace identity.
- src/cli/commands/analytics/native-loader.ts: synthesizeRawSession computes root bounds and turn count from root messages alone. Child activity after the root becomes idle is absent from session duration. The source is parsed once for native facts and again for cost enrichment; active files can grow between the reads.
- src/cli/commands/analytics/report/client/app.js: timelineEl renders a flat chronological Gantt; no tree, parent row, own/inclusive label, running/unknown status or truncation indication exists. The session span unions tracked duration with dispatch bounds, but the incorrect async bounds never reach real descendants. Dispatch counters derive from the truncated array. No separate trace representation exists beyond these dispatches. The cost view already calls totals API-equivalent estimates, while session and step details use the shorter Cost label.
- src/utils/pricing.json: Sonnet 5 entry remains 3/15/0.3/3.75/6 USD per million input/output/cache-read/5m-write/1h-write tokens. Official current rates are 2/10/0.2/2.5/4. Opus 5 is absent; src/utils/pricing.ts silently uses the latest same-tier Opus entry. Its resulting 5/25/0.5/6.25/10 rate happens to match official Opus 5 pricing.

### Architecture and Layers Affected

CLI analytics orchestration, Claude plugin transcript adapter, shared core parsed-session contract, report enrichment/payload/browser rendering, and shared pricing utility data. Existing pure extractors and injected EnricherDeps isolate computations from filesystem access. No provider request routing or billing submission change is implicated.

### Integration Points

- Native discovery uses agent adapters through registry, with a documented Claude Desktop adapter exception.
- ReportPayload carries DispatchEvent arrays and SessionCost aggregates to an embedded browser client and JSON exports.
- Claude completion signals in this real dataset: structured launch results have isAsync, status, agentId; queue-operation/enqueue content starts with task-notification and includes task-id, status, sometimes tool-use-id. The same notification is copied into later remove/attachment/user rows, so first authoritative completion must be deduplicated. Some completed notifications omit tool-use-id but retain task-id.
- Every child metadata parentAgentId matches the unique transcript owning its toolUseId. This provides exact hierarchy evidence; no timing-derived parent assumption is needed.
- Nested child messages are all isSidechain=true. A helper reused on a child must know that these are its own messages, not exclude them as foreign sidechains.

### Patterns and Conventions

Use existing model normalization, TTL-aware cache pricing, defensive per-file failure handling, bounded parallel I/O and typed additive data contracts. Keep session totals based on deduplicated usage, and keep dispatch attribution a view over that same usage rather than another amount added to totals. API responses repeated as streaming rows are one billable record. Full ancestry need not be a recursively nested JSON representation: current adapter storage is flat. Do not infer cost, parents or completed status solely from temporal overlap.

---

## 3. Documentation Findings

### Guides and Architecture Docs

Loaded .ai-run/guides/architecture/architecture.md, integration/external-integrations.md, development/development-practices.md and usage/project-config.md before source investigation. The five codegraph research dimensions returned analytics/core/plugin symbols and existing tests. Guides explain architecture and remote metrics pipelines but do not describe the newer nested Claude metadata or local report dispatch semantics. Some example paths and LangGraph claims are stale; source and AGENTS.md resolve factual disagreement.

### Architectural Decisions

The local report is deliberately generated without remote billing access. Its existing cost page explicitly describes subscription values as metered API equivalents. Session ownership dedup across replayed/forked logs is intentional. Cost-series endpoint equality is explicitly documented and covered. Dispatch own-only attribution and sidechain exclusion are explicit prior decisions that conflict with the requested nested trace behavior.

### Derived Conventions

The real session uses background dispatch semantics even without run_in_background in Agent input. Structured result status and matching transcript/lifecycle metadata are more reliable than that request option. A child can emit end_turn while waiting for descendants, so last assistant stop_reason=end_turn is insufficient evidence that its work tree finished.

---

## 4. Testing Landscape

### Existing Coverage

- cost/__tests__/usage-readers.test.ts covers progressive dedup, root/child merging, cross-file duplicates, timestamp ordering and cache TTL fields.
- cost/__tests__/cost-enricher.test.ts covers aggregate/series equality, replay dedup, child own-cost attribution, unknown logs, mixed models and skill time-window attribution.
- cost/__tests__/dispatch-extractor.test.ts covers synchronous result duration, unmatched zero markers, cap at 60 and explicitly expects sidechains to be ignored.
- report/__tests__/payload-builder.test.ts covers session payload rollups and projections.
- analytics/__tests__/native-loader.test.ts covers native synthesis/discovery; Pi-specific coverage is separate.
- Claude named-invocation and metrics-processor tests cover root tool and invocation metrics; tests/integration/agent-task-session.test.ts covers agent task sessions.
- Shared pricing lookup/calculator tests cover family fallback and TTL calculations. Existing Sonnet 5 expected values may encode stale prices.

### Testing Framework and Patterns

Vitest, injected dependencies, pure fixture-based extractors, inline typed records and temporary native JSONL fixtures. Research performed no tests and changed no implementation. Executable verification belongs to subsequent stages.

### Coverage Gaps

No located coverage asserts a root-child-grandchild hierarchy with async acknowledgement, actual completion notifications, child work continuing after root idle, own versus inclusive cost reconciliation, consistent live snapshot bounds, cycle/missing-meta handling, or visible nested hierarchy in the browser. Existing cap and sidechain tests encode the defects. Cross-session replay attribution can exceed session-owned spend because dispatch pricing uses an independent seen set.

---

## 5. Configuration and Environment

### Environment Variables

Claude metadata.dataPaths.home determines the native project directory; CodeMie paths use getCodemiePath. No additional credentials are needed for the local reference analysis or report rendering.

### Configuration Files

The reference native session is external to CodeMie tracking, provider native-external. Reproduction through the CLI therefore requires --include-external with --session db7ad8f6-061d-4e9a-a7e9-b02b44b5d76a. --report-format both provides directly comparable HTML/JSON. Pricing is vendored in src/utils/pricing.json. package.json provides Node >=20 and npm commands.

### Feature Flags and Deployment Concerns

--no-scan-native omits discovery; --include-external controls visibility. Old exported reports contain no parent/status fields; additive fields and tolerant client fallbacks preserve readability. The target session remains live: the provided report is a historical snapshot, while raw files already contain later work.

---

## 6. Risk Indicators

- Double counting: nested tokens already belong to session totals; inclusive trace costs overlap by design.
- Async lifecycle: launch acknowledgement is not completion; end_turn may mean waiting for children.
- Live input and missing/replayed metadata require bounded, deduplicated handling and explicit unknown states.
- Shared pricing affects every report consumer; historical source invoices are unavailable.
- Speculative: additive hierarchy fields, snapshot bounds and allocation provenance can keep compatibility while correcting the UI.

---

## 7. Summary for Complexity Assessment

The correction crosses the Claude adapter/core contract, analytics enrichment and browser report, plus a bounded pricing-data update. The implementation pattern already exists; the missing work is preserving exact hierarchy and lifecycle evidence, allocating own/inclusive costs consistently, and extending activity bounds through descendants. Core usage dedup already works.

The fixed historical token invariant is 61,193,817 across 528 responses. Existing rates reproduce $45.17095180 exactly; official Sonnet 5 pricing instead yields $35.73558280. The report omits 13 nested agents and gives 24 background launches one-second durations. Focused synthetic hierarchy/async/replay checks and browser interaction should validate the correction; preserve unknowns and avoid summing overlapping inclusive allocations.

---

## 8. External References

Resolved the user HTML report and the Claude JSONL path under ~/.claude/projects/-Users-Vadym-Vlasenko-AI-projects-delivery-booking-app/. At the report endpoint, 37 agents span depths 1/2/3 (24/12/1). Root activity ends 10:24:53.384Z; descendants reach 10:32:10.546Z. A requirements-reader launch reports 1,424 ms; exact completion notification gives 412,438 ms. Numeric evidence and per-agent reconciliation are in session-reconciliation.json; no private prompts are copied.

[Official Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing), checked 2026-09-15, confirms Sonnet 5's planned price increase was cancelled and Opus 5 standard rates. Values are API-equivalent estimates, not invoices.
