# Technical Research

**Task**: analytics session PR evidence
**Generated**: 2026-10-22
**Research path**: filesystem

## 1. Original Context

User requests a PR in codemie-ai/codemie-code to export confirmed GitHub PR creation evidence from Claude native session tool_use/tool_result pairs. Need conservative support for successful gh pr create and recognized GitHub MCP create_pull_request calls, structured bounded evidence with session linkage, URL/repo/PR number/time/tool identity; command attempt, failed tool, generic mention/link/read must not count. Additive report schema; no raw transcript/tool arguments exported, no network lookups or monetary allocation; Collector and Control Plane untouched. Existing conversation established JSON ReportPayload generator and dispatch extractor, but investigate exact source flow to avoid duplicating parsing. Read relevant repo guides first. User authorizes branch/commit/push/PR, not tests explicitly; repo AGENTS forbids writing/running tests absent explicit request: note verification policy and test recommendations without executing tests.

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/analytics/cost/cost-enricher.ts`: `parseOne` obtains native ParsedSession once; `enrichCosts` parses concurrently, then processes entries in start-time order. It already has per-session observed bounds, shared-native-file sibling bounds and cross-session usage deduplication. Parsed logs remain available even when no priced usage exists. Dispatch extraction occurs near lines 685–699 in an isolated failure handler.
- `src/agents/core/session/BaseSessionAdapter.ts`: ParsedSession supplies sessionId, unknown[] messages, and linked subagent transcripts.
- `cost/claude-native.ts`: minimal structural helpers `claudeBlocks` and `claudeTimestamp`; current block input typing includes only skill/subagent/name, and omits tool result content. Missing timestamp produces undefined, never invented timing.
- `cost/claude-trace.ts` and `claude-ownership.ts`: existing native ownership index identifies root/subagent owners, replayed messages, unresolved tools and conflicting identities. `buildClaudeTraceIndex` combines these with linked transcript metadata.
- `cost/dispatch-extractor.ts`: private tool-occurrence index joins use/result by tool ID, selects preferred physical owner, checks block and acknowledgement errors. Only Agent/Task/Skill and slash-commands become dispatch events. This is not a generic PR extractor.
- `cost/types.ts`: SessionCost is the transient metadata/cost carrier, stored in SessionCostIndex. DispatchEvent is specifically agent/skill/command, not a general-purpose event union.
- `report/types.ts`: ReportSessionRecord has sessionId, branch, title and optional dispatch metadata; no PR evidence field.
- `report/payload-builder.ts`: one shared ReportPayload projection, explicit allowlist functions prevent arbitrary internal transcript fields entering exports. It deduplicates session records by sessionId.
- `report/report-generator.ts`: JSON writes shared payload directly; HTML escapes `<` when embedding JSON. Per-session reporting uses the same report machinery.

### Architecture and Layers Affected

Existing analytics layer combines native adapter parsing, report-time enrichment, and public report projection. No database or migration sits in this path. Root project is Node >=20, TypeScript ES modules, npm; CLI uses Commander and existing adapters for external agent histories.

### Integration Points

ParsedSession → enrichCosts → SessionCostIndex → buildReportPayload → JSON/HTML outputs. Existing parsing is reusable without new filesystem discovery, authentication or service calls. `claude`, `claude-acp`, and `claude-desktop` are the current Claude-family condition in cost enrichment. OTEL reporting has an independent authoritative-cost source without native tool pairs.

### Patterns and Conventions

Explicit exported return types, interfaces, `.js` imports and alias imports. Error isolation preserves the rest of a report when one native log is malformed. Export projection uses field allowlists. Native ownership and usage replay handling are separate from financial pricing.

## 3. Documentation Findings

### Guides and Architecture Docs

Read root AGENTS.md, `.ai-run/guides/architecture/architecture.md`, `.ai-run/guides/security/security-practices.md`, and `docs/ANALYTICS-REPORT.md`. `docs/AGENTS.md` is agent product documentation rather than a nested workflow policy.

### Architectural Decisions

`docs/ANALYTICS-REPORT.md` establishes `{ meta, sessions }` as the sole JSON schema, shared with HTML and per-session reports. Native logs are required for enrichment; rotated/missing logs cause unavailable coverage. Sessions launched outside CodeMie are excluded unless `--include-external` is passed. Security guide prohibits raw secret logging and makes outbound attribution-header changes security-review critical; this scoped export work does not alter those headers.

### Derived Conventions

Keep evidence independent from whether tokens can be priced. Respect absence of native logs rather than synthesizing events from title/branch text. Existing per-session report semantics are partial snapshots, so later snapshots can contain additional native events.

## 4. Testing Landscape

### Existing Coverage

Co-located `cost/__tests__/dispatch-extractor.test.ts`, `claude-review-regressions.test.ts`, and `cost-enricher.test.ts` cover tool/result timing, root/subagent ownership, conflicts, native replay and cost integration. `report/__tests__/payload-builder.test.ts`, `report-generator.test.ts`, and `session-report.test.ts` cover public projections/export paths.

### Testing Framework and Patterns

Vitest, synthetic native rows and dependency injection via EnricherDeps. Native messages are represented with assistant tool_use and user tool_result blocks and optional toolUseResult acknowledgements. No tests were written or executed during research. Root policy prohibits writing, running or suggesting tests without explicit user request; authorization is pending upstream.

### Coverage Gaps

No PR-creation extractor or PR-specific coverage exists. Existing dispatch success handling does not establish shell command semantics or validate GitHub URLs and cannot alone prove PR creation.

## 5. Configuration and Environment

### Environment Variables

No process.env references found in the inspected analytics cost modules. Native discovery and existing session configuration supply paths; no new credentials are implicated by this local extraction scope.

### Configuration Files

package.json defines typecheck, lint, build and Vitest scripts; pre-commit runs typecheck and lint. tsconfig.json handles TypeScript; Vitest config exists. No PR evidence feature configuration currently exists.

### Feature Flags and Deployment Concerns

`--include-external` controls inclusion of externally launched native sessions. JSON/HTML schema is shared; additive session metadata reaches both. OTEL and non-Claude sources lack this specific native evidence format.

## 6. Risk Indicators

- Speculative: substring matching `gh pr create` accepts quoted examples, echo commands, comments and failed compound commands; restrict executable grammar and require matching successful output.
- Speculative: tool_result can contain arrays, nested MCP JSON, isError/is_error and failure text. Require a recognized create operation, unambiguous validated GitHub PR URL, and no failure indicators; do not treat generic URL mentions as creation.
- Speculative: shared native files, replayed/forked history and duplicate tool IDs can falsely attach creation to later sessions. Apply session timing/ownership and deterministic deduplication; ambiguous owners should be omitted.
- Speculative: retain only bounded allowlisted identities and canonical PR URL without credentials/query/fragment; avoid exporting commands, PR body, raw output or transcript data.
- Speculative: missing timestamp/result, contradictory results and malformed blocks must fail closed without aborting the report. Unknown or truncated coverage must not mean that no PR was created.
- Speculative: new metadata should remain independent from dispatch cost allocation, so a PR event never implicitly allocates an entire session's spend or implies Jira linkage.

## 7. Summary for Complexity Assessment

The change fits the existing native parsing → enrichment → public report projection pipeline. ParsedSession already exposes tool messages, and Claude ownership helpers already distinguish root/subagent traces. The likely surface is a focused extractor, additive type fields, enrichment integration, public allowlist projection and analytics documentation; no adapter rewrite, schema migration, remote service or UI is implied.

The main complexity is correctness of evidence, not plumbing: shell/MCP success identification, malformed data, ownership and replay can create false links that consumers might later use for money attribution. Existing synthetic native fixtures and export coverage provide nearby patterns, but no PR-specific implementation exists. Research did not write or run tests; repository policy requires explicit user authorization.

## 8. External References

None named by the task.
