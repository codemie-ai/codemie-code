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

## Fix-up record (consolidated from the removed `code-review-fixup.md`)

### Review round 1 fix-up, head `9f89248d` (from `26d74bb1`; commits `013c8ded`, `9f89248d`)

| Id | Change |
|---|---|
| CR-001 | The hook at the evidence cap retries `createOrRead` with `pendingSessionIds` so idle non-pending records are evicted immediately. A stamp failure that drops events is reported to the daemon as `evidence_loss` (`recordStampLoss` to `lastLoss`; `evidence_capacity`, `session_id_absent`, `stamp_invalid`); status-only loss records age out in the sweep. Block decisions already emit before stamping; no `no_credentials`/`no_owner` legacy fallback was added (it would violate provenance and fail-closed). |
| CR-002 | `routing.ts`: empty endpoint, first-party Anthropic, Bedrock and Vertex flags (no custom base) are proven direct; native match is origin plus path-segment prefix; foreign overrides stay unproven. The plugin reads user/project/local/managed settings layers. |
| CR-002 wire | The organization header is omitted when the basis is `routing_unproven`, so backend D7 (routed=false plus an organization = Personal) yields Unknown like the client. Test: forwarder test with a D7 simulation (unproven to unknown, proven to personal agree). |
| CR-003 | Bounded window snapshot (`snapshotPendingBytes(limit)` plus `more`); `proveRange(more)` cuts at entry boundaries; `forwardOtelStream` drains up to 8 windows per tick with exact cursors; a single entry over 5 MiB holds `otlp_entry_too_large`. |
| IR-CLI001 | `readBoundedBody` returns complete/truncated/failed; failed read is a retry (`response_read_failed`), oversize `response_too_large`, malformed JSON/protobuf `response_malformed`; empty OTLP and hooks `{}` stay ok; the policy probe uses the bounded read. |
| IR-CLI002 | `readVerdictState` distinguishes none/ok/unreadable; `classifySession` holds `verdict_unavailable` when a determinate Personal cannot be persisted, a replace fails, or the verdict is unreadable without policy; an unreadable verdict is treated as sticky Personal. |
| IR-CLI003 | `resolveAnalyticsEndpoint` resolved once per tick; the canonical identity (origin and base path) must equal the credentials' `api_identity` before any policy fetch or ingest. |
| CR-004 | Not rewritten; fix-up commits carry the ticket in the footer; the squash title and footer are prepared for delivery. |

RED honesty: for this fix-up the implementation was written before the new tests and no RED runs were observed; existing tests that encoded the old behaviour (absent endpoint = unproven, hooks `{ok,status}` mocks without body, null daemon state) failed after the source change and were updated, which is the only failing-first evidence. Residual risks recorded then: a daemon down turns a loss report into a hook warning only; policy-unavailable with a proven route still sends the organization (the backend is authoritative); managed-settings paths are best effort.

### Stage 7 QA fix, attempt 1 (`1167936c`): default-profile regression of IR-CLI003

Defect: the resolver used the raw bare-host `syncCodeMieUrl` (`connect-orchestrator.ts:440-441, 481-482`) against `credentials.apiUrl = ensureApiBase(codeMieUrl)` (`sso.auth.ts:363`) or the discovered `VITE_API_URL` (`sso.auth.ts:375-378`); the identities differed, so nothing was fetched or sent on the ordinary SSO profile, while the baseline delivered through `targetUrl`. Fix: with a sync URL present the candidates are `[syncApiUrl, ensureApiBase(syncCodeMieUrl)]`, otherwise `[targetUrl ?? url]`; the first candidate whose `apiIdentity` equals the credentials' `api_identity` is used; none = no fetch or send; the model gateway is never a candidate next to a sync URL; the identity check is not weakened to origin only. Tests: `tick-processor.test.ts` "IR-CLI003: real profile shapes" (bare host, trailing slash, explicit and stale `syncApiUrl`, legacy `targetUrl`, separate gateway, cross-host, cross-base-path, gateway-only, bare target fails closed); RED on `9f89248d` failed on its own assertion for the bare-host case.

### Stage 7 QA fix, attempt 2 (`26c2da28`): canonical analytics base

Finding: attempt 1 returned the raw matched candidate, so a `syncApiUrl` with a trailing or repeated slash validated but was POSTed to `.../code-assistant-api//v1/...` (the forwarder concatenates slash-prefixed constants; the policy fetch strips slashes). Fix: the returned `baseUrl` is the canonical identity itself (scheme, lowercased host, non-default port, slash-normalized path, no userinfo/query/fragment), so the policy fetch and every hooks/OTLP URL use the exact validated destination. Tests: `forwarder.test.ts` asserts the actual fetch URLs (hooks, logs, metrics, traces) for slash variants, bare-host `syncCodeMieUrl` and localhost, plus mismatches (127.0.0.1 vs localhost, localhost vs API host, with vs without `/code-assistant-api`) sending nothing; RED against the attempt-1 behaviour failed exactly these two tests on their own assertions. Checks: `tsc` 0; `eslint --max-warnings 0` on the changed files 0; `otlp-spool` directory 15 files / 305 tests pass.

### Baseline failure identities (exact baseline `fd7d2ace`, same host and ambient `CODEMIE_*` environment), 7 tests

1. `sso.auth-gate.test.ts` > `ensureCodeMieSsoAuth` > starts a detached sign-in without awaiting authenticate when credentials are missing
2. `sso.auth-gate.test.ts` > `ensureCodeMieSsoAuth` > blocks without starting a sign-in when the provider is SSO but no url is configured
3. `AgentCLI-model-source.test.ts` > sets `CODEMIE_MODEL_SOURCE=default` when `--model` is not passed (implicit/profile-sourced model)
4. `codex.incremental-sync.test.ts` > calls `SessionSyncer.sync()` on tick when ssoUrl/syncApiUrl set and credentials available
5. `opencode.incremental-sync.test.ts` > upload > uploads via SessionSyncer as `codemie-opencode` when sync URLs and credentials are set
6. `pi.incremental-sync.test.ts` > upload > uploads as `codemie-pi` once per tick when credentials are available
7. `codex-desktop.test.ts` > `findCodexDesktopApp` > returns null when no candidate path exists (the Codex desktop app is installed on this host; reproduced on the exact baseline, 1 failed / 35 passed)

The cause of 1-4 is the ambient `CODEMIE_*` environment (verified); the cause of 5 and 6 is UNVERIFIED beyond the baseline reproduction. An earlier fix-up statement that the `sso.auth-gate` failures were "environmental" was made before this baseline run and is superseded by the verified result above. Integration limitations: no combined claim with #707/#710/#711/#667/!4652.
