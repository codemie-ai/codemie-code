---
schema: sdlc-factory/code-review@1
decision: approve
reviewed_head: 26c2da2839ba6529b5819082608001c1da5a065f
---

# Code review — 2026-10-28-epmcdme-16440-cli-classification-routing

**Decision:** approve (check round, confidence final low · check medium)
**Reviewed head:** `26c2da2` · **Rounds:** final → check

**Closed:** 3 fixed · 1 moot · 0 decided

Targeted check at head 9f89248d (fix-up from 26d74bb1): CR-001..CR-003 resolved on source (hook stamp retry with pending sessions plus visible evidence_loss, block emitted before stamping, routing proves empty/first-party/Bedrock/Vertex direct with path-prefix native match, OTLP drain in bounded windows with exact cursors); CR-004 superseded per the user's non-blocking disposition (squash title/footer at delivery, no fix_evidence mapped). User-added IR-CLI001/002/003 and the CR-002 wire case verified on source. Residuals: managed litellm/ollama with a foreign endpoint stays routing_unproven (Unknown, conservative); stamp losses no_credentials/no_owner/record_too_large collapse to stamp_invalid in lastLoss; an unreadable verdict plus a fresh non-Personal policy result proceeds (no legacy send); tests were not re-run by this verifier.

## Open — 0

## Coverage

Graded at the final round; the check round re-verified the findings, not these rows — Open and Closed above are current.

| Acceptance criterion | Status | Notes |
|---|---|---|
| 2 Positively direct route is routed=false and classifies normally | fail (final round) | carried forward from prior verdict; fix-up addresses it (routing.ts empty/first-party/Bedrock/Vertex proven direct) |
| 2 Native routing: scheme, host, port and path prefix comparison | partial (final round) | carried forward; fix-up adds origin + path-segment prefix match |
| 8 Lifetime: new sessions held evidence_capacity (visible) | partial (final round) | carried forward; fix-up evicts idle records and reports a visible loss |
| AC1 Routed/direct fixtures in both launch modes | partial (final round) | carried forward |
| AC18 Cap-forced evidence_capacity hold persisted | partial (final round) | carried forward; loss persisted as lastLoss, not a hold |
| AC13 #702 scopes and owner resolution unchanged | pending-stage-7 | proof is existing suites run by Stage 7 |
| Tracking scope user/project incl. folder outside allowlist | pending-stage-7 | matrix test run owned by Stage 7 |

Standards: commit-format fail (final round) · code-quality pass · security na
