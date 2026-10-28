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

The generated grades below were assigned at the final round on `26d74bb1`; the check round re-verified findings, not these rows. They are kept as history. The "Current (artifact reconciliation)" column was reconciled afterwards from the recorded evidence only; no new review or test run was done for it.

| Acceptance criterion | Final round (`26d74bb1`, historical) | Current (artifact reconciliation) |
|---|---|---|
| 2 Positively direct route is routed=false and classifies normally | fail | Addressed by fix-up (`routing.ts`: empty, first-party, Bedrock and Vertex proven direct). Check round and the user's independent review of `9f89248d..26c2da28` closed CR-002. Test evidence: routing tests inside the otlp-spool/agents-core sets (`9f89248d`, `26c2da28`). Managed litellm/ollama with a foreign endpoint stays `routing_unproven` (Unknown) by design. |
| 2 Native routing: scheme, host, port and path prefix comparison | partial | Origin plus path-segment prefix match added; closed with CR-002 as above. |
| 8 Lifetime: new sessions held evidence_capacity (visible) | partial | Idle non-pending records are evicted at once; a stamp failure that drops events is reported as a visible loss. Closed as CR-001 by the independent review. Residual: loss kinds `no_credentials`/`no_owner`/`record_too_large` collapse to `stamp_invalid` in `lastLoss`. |
| AC1 Routed/direct fixtures in both launch modes | partial | Fixtures extended in the fix-up (empty endpoint, Bedrock/Vertex direct routes, per the fix-up report); not re-graded. |
| AC18 Cap-forced evidence_capacity hold persisted | partial | Still partial by design: the cap case persists a loss (`lastLoss`), not a hold. The independent review accepted this as CR-001 closure; not re-graded here. |
| AC13 #702 scopes and owner resolution unchanged | pending-stage-7 | Pass: ran inside the affected unit set at `9f89248d` with no failure there; the later delta (`9f89248d..26c2da28`, three files in `otlp-spool`) does not touch #702 scope or owner resolution. |
| Tracking scope user/project incl. folder outside allowlist | pending-stage-7 | Pass: matrix test ran inside the same affected set at `9f89248d`, same attribution as above. |

Standards: commit-format fail at the final round, CR-004 dispositioned non-blocking by the user (squash title and ticket footer at delivery, no history rewrite) · code-quality pass · security na (no security-patterns guide). The `9f89248d..26c2da28` delta was independently reviewed by the user: CR-001..003 and IR-CLI001..003 closed on this revision, no new blocking finding.
