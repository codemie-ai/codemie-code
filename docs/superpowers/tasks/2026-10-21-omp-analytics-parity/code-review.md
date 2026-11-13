---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: 5093707d8f3616a39f8a481a41cbef52be219c45
---

# Code review — 2026-10-21-omp-analytics-parity

**Decision:** request-changes (final round, confidence low)  
**Reviewed head:** `5093707` · **Rounds:** final

Acceptance skipped (no spec), so confidence is low. 3 blocking: Pi-layout sub-agent spend misreported as unlinked, nested omp grandchild spend counted as linked yet missing from dispatch cost, and untested Pi dispatch/allocation paths. 0 deferred; 18 dismissed as noise, speculative or already handled (e.g. header window, undefined owner: agentId always set).

## Open — 3

### CR-001 · code · major — Nested omp grandchild spend missing from dispatch cost

`src/cli/commands/analytics/cost/cost-enricher.ts:491` · not re-checked

**Problem:** enrichDispatchCosts keys Pi children by exact agentId and looks up dispatch._taskId, so a nested child A/A.B is never folded into dispatch A's cost; allocatePiUsage meanwhile treats A/A.B as linked via its first segment.

**Impact:** Grandchild tokens are excluded from unlinked spend and attributed to no dispatch, so per-dispatch cost under-reports and session totals do not reconcile.

**Recommendation:** When enriching dispatch A, gather messages of every sub whose agentId === key or startsWith(key + '/').

### CR-002 · code · major — Pi-layout sub-agent spend always reported unlinked

`src/cli/commands/analytics/cost/pi-dispatch-allocation.ts:20` · not re-checked

**Problem:** allocatePiUsage links only dispatches carrying _taskId, which only omp progress[] events set; Pi subagent runs (agentId 'agent/run') never match, and enrichDispatchCosts likewise never enriches Pi dispatches.

**Impact:** All plain-Pi sub-agent spend is shown as unlinked and Pi dispatch costs stay empty in the report.

**Recommendation:** Link Pi-layout runs to their dispatch (e.g. by subagent name matching agentId's first segment) or exclude Pi-layout owners from unlinked when a matching agent dispatch exists.

### CR-003 · code · major — New Pi dispatch and allocation paths untested

`src/cli/commands/analytics/cost/pi-dispatch-allocation.ts` · not re-checked

**Problem:** extractPiDispatchEvents, allocatePiUsage, Pi keying in enrichDispatchCosts, extractPiFileOperations, omp model_usage records and the recursive omp child-transcript walk have no tests (grep of __tests__ found none).

**Impact:** Regressions in omp/Pi dispatch cost, file stats and sub-agent linking, the headline features of this change, would ship without a failing test.

**Recommendation:** Add focused tests: omp progress[] dispatch extraction with _taskId, allocatePiUsage root/linked/unlinked split incl. nested A/A.B, extractPiFileOperations perFileResults/delete/URI drop, and the omp nested transcript walk.

## Coverage

Standards: commit-format pass · code-quality pass · security na
