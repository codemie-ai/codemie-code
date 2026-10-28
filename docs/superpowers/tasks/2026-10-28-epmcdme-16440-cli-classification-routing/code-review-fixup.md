# Fix-up report (review round 1) - head 9f89248d (from 26d74bb1)

Commits: 013c8ded fix(agents) CR001/CR002 hook side; 9f89248d fix(proxy) CR002-wire/CR003/IR-CLI001-003. Ticket in footer. No history rewrite, no push.

Verification (final revision): tsc 0; eslint --max-warnings 0 on all changed .ts 0; vitest unit on src/providers/plugins/sso, src/agents/core, claude-code-otlp, copilot-*-otlp, otlp-forward, hook.analytics-wiring, processes-git: 1842 pass / 2 fail (sso.auth-gate.test.ts, untouched file, fails on ambient CODEMIE_URL config; not caused by this change). Pre-commit hook suite passed on both commits.

RED honesty: implementation was written before the new tests; I did not observe RED runs (no stash allowed). Existing tests that encoded the old behavior (absent endpoint => unproven, hooks `{ok,status}` mocks with no body, daemon null state) failed after the source change and were updated; that is the only failing-first evidence.

| Id | Change | Tests |
|---|---|---|
| CR001 | Hook at evidence cap now retries createOrRead with pendingSessionIds (sweep.pendingSpoolSessionIds) so idle non-pending records are evicted immediately. Stamp failure that drops events (no finalize cursor) is reported via evidence_loss to the daemon (recordStampLoss -> lastLoss, mapped evidence_capacity/session_id_absent/stamp_invalid); status-only loss records age out in sweep. Block decisions already emit before stamping; no no_credentials legacy fallback added. | OtlpAgentAdapter (block-before-stamp, cap eviction, finalize retry, loss report), record-store pendingSessionIds, spool-io recordStampLoss, plugin evidence_loss, otlp-forward |
| CR002 | routing.ts: empty endpoint, first-party Anthropic, Bedrock/Vertex flags (no custom base) are proven direct; native match is origin + path-segment prefix; foreign overrides unproven. Plugin reads user/project/local/managed settings layers. | routing.test, claude-evidence-inputs |
| CR002-wire | Organization header omitted when basis is routing_unproven, so backend D7 (routed=false + org => Personal) yields Unknown like the client. | forwarder.test with a D7 simulation (unproven -> unknown; proven -> personal agree) |
| CR003 | snapshotPendingBytes(limit) bounded window + `more`; proveRange(more) cuts at entry boundaries (windowCut, not a hold); forwardOtelStream drains up to 8 windows per tick with exact cursors; single entry > 5 MiB holds otlp_entry_too_large. | otlp-reader windows, spool-io limit, forwarder drain |
| IR-CLI001 | readBoundedBody returns complete/truncated/failed; decodeResponse: failed read -> retry response_read_failed, oversize -> response_too_large, malformed JSON/protobuf/field types -> response_malformed; empty OTLP and hooks {} stay ok; policy probe uses the bounded read. | response.test (probe cases), forwarder cursor kept, policy-cache endless/broken body |
| IR-CLI002 | readVerdictState distinguishes none/ok/unreadable; classifySession holds verdict_unavailable when a determinate Personal cannot be persisted, a replace fails, or the verdict is unreadable without policy; tick treats unreadable as sticky Personal so a legacy downgrade holds personal_not_forwardable. | classification-durability (fault injection), verdict-store states, tick corrupt file/dir + legacy downgrade |
| IR-CLI003 | resolveAnalyticsEndpoint (syncCodeMieUrl, else targetUrl/url) resolved once per tick; canonical identity (origin + base path) must equal credential api_identity before any policy fetch or ingest; mismatch returns without fetch/send. | tick: other origin, other deployment, missing base path, matching via syncCodeMieUrl |
| CR004 | Not rewritten; fix-up commits carry ticket in footer. Final squash title/footer to be prepared at delivery. | n/a |

Residual risks: (1) resolveAnalyticsEndpoint prefers daemon syncCodeMieUrl then targetUrl; setups where neither equals credentials.apiUrl now send nothing (by design) - confirm no real profile relies on that. (2) A legacy session also stops on endpoint mismatch. (3) Loss reports need the daemon reachable; if it is down the loss is only a hook warn. (4) Policy-unavailable with proven route still sends the organization (backend authoritative). (5) Managed-settings paths are best effort. (6) Unrelated sso.auth-gate failures are environmental.


## QA findings and fix (Stage 7, attempt 1) - IR-CLI003 default-profile regression

Defect: resolveAnalyticsEndpoint used syncCodeMieUrl ?? targetUrl ?? url. connect-orchestrator passes the raw bare-host config.codeMieUrl as syncCodeMieUrl (connect-orchestrator.ts:440-441, 481-482), while SSO login stores credentials.apiUrl = ensureApiBase(codeMieUrl) (sso.auth.ts:363), or config.js VITE_API_URL when discovered (sso.auth.ts:375-378). Origin+base-path identity differed, so the resolver returned null and nothing was fetched or sent on the ordinary SSO profile. Baseline used targetUrl and delivered.

Fix (classification.ts resolveAnalyticsEndpoint): candidates = [syncApiUrl (ssoConfig.apiUrl, the explicit/discovered API URL), ensureApiBase(syncCodeMieUrl)] when either sync URL exists, else [targetUrl ?? url] (legacy). The first candidate whose apiIdentity (scheme/host/port/base path) equals the credentials' api_identity is the one endpoint used; none -> null, no fetch/send. The model gateway (targetUrl) is never a candidate next to a sync URL. Identity check is not weakened to origin-only.

Tests: tick-processor.test.ts "IR-CLI003: real profile shapes..." (bare host, trailing slash, explicit syncApiUrl, stale syncApiUrl + matching syncCodeMieUrl, legacy targetUrl, separate gateway, cross-host, cross-base-path, gateway-only, bare target fail closed). RED on 9f89248d code: failed on its own assertion (expected undefined to be API) for the bare-host case (qa-fix1-red.local.log). The older test's expected baseUrl for syncCodeMieUrl API+'/' is now the normalized API (no trailing slash).

Exact baseline failure identities (qa-baseline-ambient.local.log, exact baseline fd7d2ace, ambient CODEMIE_* env), 6 tests:
1. src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts > ensureCodeMieSsoAuth > starts a detached sign-in without awaiting authenticate when credentials are missing
2. src/providers/plugins/sso/__tests__/sso.auth-gate.test.ts > ensureCodeMieSsoAuth > blocks without starting a sign-in when the provider is SSO but no url is configured
3. src/agents/core/__tests__/AgentCLI-model-source.test.ts > AgentCLI.handleRun - CODEMIE_MODEL_SOURCE propagation > sets CODEMIE_MODEL_SOURCE=default when --model is not passed (implicit/profile-sourced model)
4. src/agents/plugins/codex/__tests__/codex.incremental-sync.test.ts > codex.incremental-sync > calls SessionSyncer.sync() on tick when ssoUrl/syncApiUrl set and credentials available
5. src/agents/plugins/opencode/__tests__/opencode.incremental-sync.test.ts > opencode.incremental-sync > upload > uploads via SessionSyncer as codemie-opencode when sync URLs and credentials are set
6. src/agents/plugins/pi/__tests__/pi.incremental-sync.test.ts > upload > uploads as codemie-pi once per tick when credentials are available
Cause for 1-4 is ambient CODEMIE_* env (verified); the opencode/pi cause is UNVERIFIED beyond baseline reproduction.

Post-fix combined check (ambient env unchanged; dirs sso/proxy, cli/commands/proxy, agents/core): tsc exit 0; eslint --max-warnings 0 on changed ts exit 0; vitest 1691 pass, 2 fail: AgentCLI-model-source (known baseline #3) and connectors/codex-desktop.test.ts "findCodexDesktopApp > returns null when no candidate path exists" (NEW to this list, untouched file; fails because the Codex desktop app is installed on this host under C:\Program Files\WindowsApps - host-environment dependent; not reproduced on baseline, unverified there).


## QA findings and fix (Stage 7, attempt 2) - canonical analytics base (review of 9f89248d..1167936c)

Finding: attempt 1 returned the raw matched candidate as baseUrl. forwarder.ts concatenates slash-prefixed constants (`${baseUrl}${CODEMIE_ENDPOINTS...}`, forwarder.ts:389, 439) while the policy fetch strips trailing slashes (policy-cache.ts:120), so a syncApiUrl with a trailing/repeated slash validated but POSTed to .../code-assistant-api//v1/...; probe and ingest disagreed.
Fix (classification.ts resolveAnalyticsEndpoint): once a candidate's apiIdentity equals the credential api_identity, the returned baseUrl IS that canonical identity (scheme, lowercased host, non-default port, slash-normalized path; no userinfo/query/fragment). Policy fetch and every hooks/OTLP URL therefore use the exact validated destination. Legacy no-identity path returns the canonical form when parseable.
Tests: forwarder.test.ts "IR-CLI003: every hooks and OTLP request URL..." asserts the actual fetch URLs (hooks, logs, metrics, traces) for trailing/repeated-slash/userinfo+query syncApiUrl, bare-host syncCodeMieUrl, localhost (no API prefix), plus mismatches (127.0.0.1 vs localhost, localhost vs API host, localhost with vs without /code-assistant-api) sending nothing. tick-processor test now expects canonical bases. RED against the attempt-1 behavior (raw candidate returned): exactly these two tests failed on their own assertions, nothing else (qa-fix2-red.local.log).
Checks: tsc exit 0; eslint --max-warnings 0 on 3 changed ts exit 0; vitest src/providers/plugins/sso/proxy/plugins/otlp-spool 15 files / 305 tests pass (qa-fix2-green.local.log).
codex-desktop "findCodexDesktopApp > returns null when no candidate path exists": REPRODUCED on exact baseline fd7d2ace under the same host/env (1 failed, 35 passed; qa-fix2-codex-desktop-baseline.local.log). It is a pre-existing host-dependent failure (Codex desktop app installed), not caused by this branch. A node_modules junction to the delivery worktree's node_modules was created inside the scratch tree only; nothing deleted.
Integration limitations unchanged: no combined claim with #707/#710/#711/#667/!4652; the six baseline failures above are untouched.
