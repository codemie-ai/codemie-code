---
schema: sdlc-factory/code-review@1
decision: request-changes
reviewed_head: 355d747415d189861f5d494eecf955d899bd18ab
---

# Code review — 2026-10-22-epmcdme-16154-subagent-output-tokens

**Decision:** request-changes (final round, confidence low)  
**Reviewed head:** `355d747` · **Rounds:** final

Acceptance not run (no spec), so confidence is low; reachability of the isApiError path was not confirmed against real transcripts. 2 edge-case items dismissed (in-flight speculation, per-group partial token split is a design enhancement); 0 deferred.

## Open — 1

### CR-001 · code · major — API-error rows wrongly flagged output_tokens_partial

`src/agents/plugins/claude-code-otlp/transcript/usage-request.ts:194` · not re-checked

**Problem:** isOutputTokensPartial returns !req.stopReason, so any request with an empty stop_reason is flagged partial, including API-error/synthetic rows that legitimately carry no stop_reason and zero output_tokens. OpenUsageRequest already carries isApiError.

**Impact:** Final error requests are reported as partial and mark whole subagent groups partial via OR aggregation, polluting the signal the backend uses to distrust totals. Reachability unconfirmed: the transcript parser has no documented source field for isApiError.

**Recommendation:** Exclude error rows: return !req.stopReason && !req.isApiError; (widen the Pick type to include isApiError).

## Coverage

Standards: commit-format na · code-quality na · security na
