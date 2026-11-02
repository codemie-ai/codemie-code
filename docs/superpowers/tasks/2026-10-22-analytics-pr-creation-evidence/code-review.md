---
schema: sdlc-factory/code-review@1
decision: approve
reviewed_head: ba14a1c9a41b65b405f42734779aa71d333946de
---

# Code review — 2026-10-22-analytics-pr-creation-evidence

**Decision:** approve (check round, confidence final high · check high)  
**Reviewed head:** `ba14a1c` · **Rounds:** final → check

**Closed:** 7 fixed · 0 moot · 0 decided

All seven prior blocking code findings are resolved against current HEAD e4c60601fd92f43a36401317012e6804b5bbd67f. Source and focused regression fixtures were inspected without running tests; prior business and standards rows are carried forward unchanged, with no targeted verification gaps.

## Open — 0

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| Add optional shared changeRequestCreation contract without modifying existing costs | pass | cost/types.ts and report/types.ts add optional evidence; payload-builder.ts projectSnapshot uses bounded allowlist. |
| Preserve provider, host, project-local number, result time and owner provenance | pass | Extractor parseUrl and final event construction preserve canonical provider identity, result timestamp and subagent ownerId. |
| Coverage reports unresolved, malformed or truncated recognized candidate evidence as partial | partial (final round) | Extractor collection skips every block without id/tool_use_id before recognizing creation; a recognized create missing its id yields available empty evidence. |
| Bound events to 100 and identity strings to 256; reject invalid identities without truncating | pass | Extractor MAX_EVENTS/identity and projectCreation enforce bounds and partial on overflow. |
| Canonical HTTPS identities reject credentials, separators, dots and unsafe numbers | pass | Extractor parseUrl performs raw path and authority validation and positive safe-integer validation. |
| Every supplied host/project identity agrees across recognized invocation and response | partial (final round) | verifiedResult validates host/hostname only on payload/envelope, not each collected representation; a secondary text JSON identity with a conflicting host is accepted when its URL/number agree. |
| Require recognized invocation and uniquely paired successful result | pass | Extractor verifies recognized invocation, unique call/result sets, error markers, timestamps and positive provider URL result. |
| Support direct gh/glab commands with ordinary literal quoted arguments | partial (final round) | invocation scans every token for --help/--web etc and cliMatches scans every token as a selector, including title/body values; gh pr create --title "--help" --body "text" is wrongly rejected. |
| Explicit GitHub and archived GitLab MCP contracts; other aliases unsupported | pass | Exact names in invocation; verifiedResult checks GitHub URL/number and GitLab iid plus numeric/path project_id. |
| Reuse session/root/subagent ownership; deduplicate replay without cross-session attribution | pass | buildClaudeTraceIndex, conflictingTools, launch ancestry and window checks; enrichment seenCreations and shared sibling boundaries. |
| Isolate extraction failure per session without network discovery | pass | cost-enricher.ts wraps independent extraction and sets partial; extractor is local-only. |
| AC1: successful gh/glab canonical events including quoted arguments | partial (final round) | Positive fixture coverage exists but flag-looking literal title/body values are rejected as command modes/selectors. |
| AC2: both MCP contracts including subagents and numeric/path iid matching | pass | Synthetic extractor fixtures cover GitHub text JSON, GitLab path/encoded/numeric project selectors, iid and linked child ownership. |
| AC3: no false creation for errors/conflicts/unsupported compounds or identity mismatches | partial (final round) | Most negative paths are tested; conflicting host in secondary MCP representation bypasses host checks. |
| AC4: replay/shared-file/duplicate IDs and ownership cannot duplicate or misattribute | pass | Extractor and enrichment regression tests cover replay, conflicting tool IDs, child launch windows, shared file siblings and different project/host IDs. |
| AC5: missing logs/providers/malformed candidates/event limits give correct statuses | partial (final round) | Missing logs and unsupported providers handled; recognized calls missing IDs are silently skipped instead of partial. |
| AC6: shared reports expose only bounded allowlisted metadata | pass | projectCreation uses pickDefined; payload-builder/report-generator/session-report tests assert raw secret sentinel absence and identical shared payload. |
| AC7: no priced usage required and existing report semantics retained | pass | Extraction follows priceUsage independently; enrichment test verifies creation with priced=false and costUSD=0. |
| AC8: add and run focused fixtures and existing enrichment/export/typecheck/lint/build | pending-stage-7 | Focused and existing regression tests updated in frozen diff; execution/typecheck/lint/build proof belongs to Stage 7 and was not executed by this lens. |
| AC9: document schema/support/limits and creation versus comprehensive attribution | pass | ANALYTICS-REPORT.md added observed creation section, statuses, command/MCP coverage, bounds and no monetary attribution caveat. |
| Non-goals: no Collector/Control Plane/Jira allocation/API/dependencies/config/UI or expanded providers | pass | Frozen diff confined to analytics extraction/enrichment/types/projection/tests/documentation; no changes to listed non-goals. |

Standards: commit-format pass · code-quality partial (final round) · security pass
