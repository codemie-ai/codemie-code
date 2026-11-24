# CLI classification evidence and project routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`.

**Goal:** Stamp durable per-session classification evidence in the CLI and forward it with fail-closed holds (spec rev 4 plus retention correction, I1-I6, AC1-AC18).
**Architecture:** Hook-time durable record -> structural OTLP proof in the forwarder -> single response consumer in `send()`. New code lives in small modules under `src/agents/core/evidence/` (hook side) and `spool/` (forwarder side).
**Tech Stack:** TypeScript ESM (`.js` import suffixes, `@/` alias), vitest `unit` project.

Commit per task using the repository's existing convention (Conventional Commits, EPMCDME-16440). Each task is green on its own targeted files: `npx vitest run --project unit <paths>`. Run `npm run typecheck` only at checkpoints (after T3, T9, T13) and at final integration, not every task. `spool/` = `src/providers/plugins/sso/proxy/plugins/otlp-spool/`.

**Worker guidance (Git/shell):** use `git -C <literal absolute worktree path>`; `git add -- <explicit files>` and `git commit -F <literal absolute message file> -- <explicit files>` as separate tool calls; no `cd ...;` prefix, no variable-expanded file lists, no pipelines or chaining that hide exit status; write the message file with Write; check each exit status. Do not pipe gates through head/tail/grep. Targeted tests only; no whole-suite reruns without a concrete new change.

## Global Constraints
- Base fd7d2ace. Open PRs #707 (forwarder `send`/`forwardHooks`, `decideProject`, `applyProjectPolicyLocked`, `config.ts:233`), #710 (`UNMASKED_FIELD_KEYS`; add NO event fields), #711 (`isTracked` gate), #667 (`config.ts`) stay unmerged: no cherry-pick, no combined-integration or !4652 claim, no push/MR. Expect textual conflicts only in `forwarder.ts`, `session-project.ts`, `spool-io.ts`, `config.ts`, `OtlpAgentAdapter.ts`.
- Backend: RAW_RETENTION_DAYS=90, SESSION_RETENTION_DAYS=0 (binding kept indefinitely). Local 90-day idle / 20,000-file eviction is a bounded client policy, NOT backend-lifetime equality; local eviction never proves a fresh server session.
- Never log org name, remote URL, credentials. Windows: Edit/Write only. No new store/framework.
- Whole-suite gates, browser checks, review, commits of artifacts are owned by the calling flow, not tasks here.

## Tasks

### Task 1: Plan-time evidence probes and fixtures
**Files:** Create `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/fixtures/` (`*.bin` + `manifest.json`) and `otlp-fixtures.test.ts`.
- Independent wire evidence (hand-encoding then asserting the same numbers is NOT proof). Generate fixture bytes for logs/spans/metrics (gauge, sum, histogram, summary, exp-histogram; session id and `codemie_project_name` on record, span, data-point and resource attributes; concatenated records) with an existing real encoder: first `@opentelemetry/otlp-transformer` in `node_modules` if present; otherwise the backend protobuf environment READ-ONLY via a one-off script kept outside the repo, run as `C:/codemie-dev/codemie/.venv/Scripts/python.exe -I <script>` using the `opentelemetry.proto` packages, writing outputs only into this repo's fixtures dir. The manifest (expected session id, project, resource-entry boundaries) is produced by the decoder, not typed by hand. No backend changes, no new dependency. Task 11's reader is validated against these manifests.
- Record as comments in the test file: (a) where the OTLP resource project originates (grep `codemie_project_name` in the OTLP env/headers setup); (b) `.claude.json` placement under `CLAUDE_CONFIG_DIR` by a key-names-only probe (never print values); (c) daemon state profile/base-path fields (`daemon-manager.readState`); (d) where the spool retention bound lives (`spool-config.ts`); (e) session birth time vs `epoch.json` (spool session file stat); (f) whether Claude exports settings.json `env` to hook processes; (g) byte-accurate cursor semantics in `advanceCursor`/`isSendAllowed`; (h) the model-route evidence for Task 6: `buildProxyConfig` (`targetApiUrl` from original `CODEMIE_BASE_URL`, `syncCodeMieUrl` from `CODEMIE_URL`, ~1000-1045), `setupProxy` (~1081-1084), how a NATIVE session's configured model route (profile provider/baseUrl/integration) can be read separately from the analytics destination (`forwarder.resolveBaseUrl`: daemon `targetUrl ?? url`). Only a material contract contradiction -> stop and report `needs_input`; routine choices are resolved in scope. T1 findings are reused by T6, T7, T8, T11, T12.
- Test-first: no — fixture generation and evidence capture; the fixture test checks bytes against the decoder-derived manifest.

### Task 2: Pure `classify()` and result contract
**Files:** Create `src/agents/core/evidence/classify.ts`; Test `.../__tests__/classify.test.ts`.
**Produces:** `classify(evidence: Evidence, policy: Policy|null): ClassResult` where `ClassResult = {class:'codemie'|'corporate'|'personal'|'unknown', status:'determinate'|'indeterminate', basis:'routed'|'org_match'|'org_no_match'|'org_list_empty'|'no_org'|'policy_unavailable'|'routing_unproven', policy_version?: string}`; `decide(r, consumer?): 'forward'|'suppress'|'withhold'`.
- First read the backend contract (`cli-analytics-events.md` "Classification and routing") and mirror its D7 table and status/basis/policy_version names exactly; adjust the basis union if the contract names differ (not a material contradiction). Policy-unavailable (null/expired) is distinct from a known-empty organization list. `Evidence.routing_proof` (`'proven'|'direct'|'unproven'`, from Task 6; the stored record field): `unproven` yields `unknown`/indeterminate (local diagnostic basis `routing_unproven`), never `personal`.
- Default `decide` (no consumer): indeterminate => `forward` (sent as `unknown`); only an explicitly supplied consumer may return `suppress`/`withhold`. No opt-out logic here.
- [ ] Failing tests: D7 fixtures for routed (no policy still determinate codemie), matching org (corporate), non-matching org (personal), known-empty list, unavailable policy (AC2: known org, not routed => unknown+indeterminate+`policy_unavailable`, never personal), unproven routing, `policy_version` carried through; `decide` default vs explicit consumer (AC3), including a consumer `withhold` re-decided after a refresh/retry that supplies a policy.
- [ ] Implement; run `npx vitest run --project unit src/agents/core/evidence/__tests__/classify.test.ts`.
- Test-first: yes — known-org/not-routed/no-policy returns indeterminate unknown, and default decide forwards it.

### Task 3: Canonical `api_identity` and owner hash
**Files:** Create `src/agents/core/evidence/api-identity.ts`; Test alongside.
**Produces:** `apiIdentity(url: string): string` (throws on unparsable), `ownerHash(email: string): string`.
- Scheme, lowercased host, default port dropped, normalized path including base path, no userinfo/query/fragment (AC14). Run `npm run typecheck` after this task (checkpoint).
- Test-first: yes — two URLs differing only by base path yield different identities; `https://u:tok@h/a?x=1` yields no token.

### Task 4: Credential-free repository key
**Files:** Modify `src/utils/processes.ts` (add `repoKeyFromRemote` beside `parseGitRemoteUrl`, ~line 418; add raw-origin reader reusing the `exec` helper); Test `src/utils/__tests__/processes-git.test.ts`.
- Backend `host[:port]/path` rules per spec design item 4; `repo_remote` untouched.
- Test-first: yes — parity table (scp, ssh, https, default ports 22/443/80 dropped, `:8443` kept, `git@h:8443/a/b` -> `h/8443/a/b`, path case kept, host lowercased, trailing `/`, `.git`, credentials, `[addr]` IPv6) (AC12).

### Task 5: Claude organization reader
**Files:** Create `src/agents/plugins/claude-code-otlp/event-fields/claude-org.ts` (reuse `readJsonFile` from `session-env-fields.ts:30`, export it if needed); Test in `__tests__/`.
- `$CLAUDE_CONFIG_DIR/.claude.json` when set (no home fallback), else `~/.claude.json`; read only `oauthAccount.organizationName`; trimmed non-empty string, 256 cap, else `undefined`; no logging of value (AC6).
- Test-first: yes — unreadable/missing/wrong-type/257-char value => none; set vs unset CLAUDE_CONFIG_DIR read the right file.

### Task 6: Routing evidence separate from launch_mode
**Files:** Create `src/agents/core/evidence/routing.ts`; Test alongside.
**Produces:** `launchMode(env): 'managed'|'native'`; `routedViaCodemie(input): {routed: boolean, routing_proof: 'proven'|'direct'|'unproven'}`.
- Real roles (do not conflate): `buildProxyConfig` sets `targetApiUrl` from the original `CODEMIE_BASE_URL` (the MODEL upstream) and `syncCodeMieUrl` from `CODEMIE_URL`; `setupProxy` keeps `CODEMIE_TARGET_API_URL` = model upstream and rewrites `CODEMIE_BASE_URL` to the loopback local proxy; the analytics destination (`forwarder.resolveBaseUrl`) is a third host. All three can differ. The model upstream is NOT required to equal or prefix the analytics backend URL, and `CODEMIE_TARGET_API_URL` is not compared with `CODEMIE_BASE_URL`. No hostname-only inference.
- Managed: positive proof = the proxy ran under the actual provider/auth setup (`shouldUseProxy`, sso/jwt); the effective Anthropic endpoint (settings.json `env` over process env, `claude.plugin.ts:368-403`) canonically equals the proven local proxy URL; and the preserved model target (`CODEMIE_TARGET_API_URL`) is validated against the configured provider/integration (as found in T1 (h)). Any element missing/mismatched => `routed=false`. Managed direct subscription (no CodeMie proxy) => `direct`.
- Native: derive the evidence from the actual configured model route (profile provider/baseUrl/integration), kept separate from the analytics destination. If proof is unavailable => `routed=false`, `routing_proof='unproven'`, which Task 2 maps to Unknown, never Personal.
- Fixtures use SEPARATE model gateway, local proxy and analytics hosts, built from the real executor (`setupProxy`/`envMapping`, style of `BaseAgentAdapter.test.ts:385-400` which uses `llm-gateway.example.com`), plus a direct managed subscription (anthropic/moonshot-subscription) and a settings.json override to another host. Do not touch payer logic.
- Test-first: yes — managed run with distinct gateway/proxy/analytics hosts is routed; settings.json override, loopback-without-provider-proof, and unavailable native route proof are not routed (the last is `unproven`) (AC1).

### Task 7: Durable evidence record store
**Files:** Create `src/agents/core/evidence/record-store.ts` (beside `session-project-pin.ts` patterns, `getCodemiePath`, mode 0600); Modify `spool/spool-config.ts` (lazy env knob for idle days, default 90); Test `__tests__/record-store.test.ts`.
**Produces:** `createOrRead(key, fields): Result` (atomic temp + `fs.link`, `wx` fallback, loser reads winner up to 3 retries), `readRecord(key)`, `touch`, `sweepRecords({pendingKeys})`.
- Key = sha256(api_identity, owner_hash, sessionId); record fields per spec item 1; validation fails on corrupt/other schema/mismatched key fields => `stamp_invalid`. Hook never unlinks/repairs; `last_used` touched at most daily.
- Retention: evict only records idle >90 days AND not referenced by pending spool (`pendingKeys`); over 20,000 files evict oldest `last_used` that are not pending; if the cap cannot be met without erasing pending state, new sessions are held `evidence_capacity` (visible, never silent erase). Spool cleanup removes bytes/cursors only, never records.
- Test-first: yes — concurrent creators converge on one winner; corrupt file => invalid, not rewritten (AC14, AC15, AC18 retention, pending-protected eviction).

### Task 8: Policy/capability cache and sticky verdict
**Files:** Create `spool/policy-cache.ts` (fetch via `buildAuthHeadersFromCreds`/`resolveBaseUrl` as in `forwarder.ts:38,195`), `spool/verdict-store.ts`; Test `spool/__tests__/policy-cache.test.ts`.
- One file per namespace sha256(api_identity, owner_hash, profile if daemon state has it); stored identity mismatch => ignored. Usable 24h, 5 min backoff; capability `evidence|legacy|unknown`: `legacy` only from authenticated 404, re-probe after 1h; 401/403/302/5xx/timeout/non-JSON => `unknown`.
- Verdict file (same key and retention rules as Task 7, atomic replace, never evicted while pending): first determinate `personal` is sticky (I5); no usable policy + sticky personal => full evidence if capable, else hold `personal_not_forwardable`.
- Test-first: yes — 404 authed => legacy and recovers after re-probe; 401/5xx/HTML never legacy; two base paths share nothing (AC11, AC16).

### Task 9: `.codemie` link beats global profile
**Files:** Modify `src/utils/config.ts:233-248` (`resolveProfileWorkspace`: for native, keep local `codeMieProject` and mark origin `linked_folder`); Test `src/utils/__tests__/config-project-override.test.ts`.
- Managed mode keeps profile project (D2). Seam with #707/#667 stays textual; do not touch `IDENTITY_KEYS` for other callers (`config.ts:135,1293`, `profile/index.ts:57`). Typecheck checkpoint after this task.
- Test-first: yes — global profile + `.codemie` project => linked project and `linked_folder` (AC7).

### Task 10: Hook-side stamping and `evidence_v`
**Files:** Modify `src/agents/core/OtlpAgentAdapter.ts` (`processOtlpEvent` 60-135, `resolveProjectName` 83-96), spool envelope writer (find via `OtlpHookSpoolData`/`appendSpool`, `spool-io.ts:257`); Test `OtlpAgentAdapter.test.ts`.
- Before spooling: create/read record (Tasks 3-7,9); on create/read failure do not enqueue and log a reason; `resolveProjectName` reads the record first then env/pin/config. Add `evidence_v: 1` to the spool envelope only (no event-body field; #710-safe). Untracked project (gate) stamps nothing.
- Test-first: yes — project change mid-session keeps record project; record failure enqueues nothing; envelope carries `evidence_v` (AC1, AC9, AC13, AC14).

### Task 11: Bounded structural OTLP reader
**Files:** Create `spool/otlp-reader.ts`; Test `spool/__tests__/otlp-reader.test.ts` using the Task 1 decoder-generated `.bin` fixtures and manifests (expectations come from the manifest, not retyped field numbers).
**Produces:** `proveRange(bytes, {sessionId, project}): {verified: number /*byte length of longest verified prefix at resource-entry boundary*/, hold?: Reason}` for OTLP; `proveHookLines(...)` for NDJSON.
- Walk needed fields, skip others by wire type, check declared lengths, fixed depth, 5,242,880-byte and 256-attribute bounds. Log session = `session.id` else `session_id`; spans/data points `session.id` only; resource attributes not a session source. Reasons: `session_id_absent`, `session_mismatch`, `project_conflict` (case-insensitive equality), `otlp_unparseable`. Concatenated records treated as one request; lookalike text ignored.
- Test-first: yes — each AC10 case, incl. poisoned tail sends the verified prefix byte-identically.

### Task 12: Spool holds, stamp_pending, loss reasons
**Files:** Modify `spool/spool-io.ts` (`applyProjectPolicyLocked` 159, `isSendAllowed` 225, `discardBacklogLocked` 134), `spool/tick-processor.ts:24-102`, `spool/session-project.ts`; Create `spool/epoch.ts`; Tests extend `spool-io`, `tick-processor`, `session-project`.
- `epoch.json` atomic one-time write; pre-epoch OTLP-only = legacy; newer without record on evidence-capable backend => `stamp_pending` (nothing sent, no Session-Id-only request); past the retention bound record loss `no_evidence_timeout`. Marked records without valid record => `stamp_invalid`; unmarked => legacy `unstamped_legacy`. No project: send without Project headers, no local discard (AC8). Head-of-line hold ends at retention with visible reason. Keep `isSendAllowed` cursor/range equality.
- Test-first: yes — new OTLP-only session without record sends nothing, then sends with full evidence once a record appears (AC17).

### Task 13: `send()` typed outcomes and single body consumer
**Files:** Modify `spool/forwarder.ts` (`postToBackend` 52-82, `send` 93-148, `forwardHooks` 204, `forwardOtelStream` 254, cursor advance 244/274); Test `spool/__tests__/forwarder.test.ts`.
**Produces:** `send(): {kind:'ok'|'discarded'|'stale'|'retry'|'failed'|'auth-expired', reason?, accepted?}`.
- One bounded body read; decode hooks JSON and OTLP `partial_success` (protobuf/JSON). Evidence headers per spec item 6 (Session-Id, Routed-Via-CodeMie, Organization, Subscription-Type, Policy-Version, Project-Source, Project, Repo-Remote). Advance only the acknowledged verified-prefix bytes; complete rejection final with real reason; 409 `stale_policy` => refresh policy, re-classify, resend once, failed refresh keeps spool; 5xx/503 retain; hooks never acknowledge OTLP. Replaces `warnOnBackendDrop` conceptually (no #707 code taken). Typecheck checkpoint after this task.
- Test-first: yes — 409 refresh+resend once; hooks discard advances exactly its range with the real reason (AC4, AC5).

### Task 14: Consumer seam and sticky wiring
**Files:** Modify `spool/tick-processor.ts` (call `classify`, `decide`, verdict store).
- Default (no consumer): indeterminate is forwarded as `unknown`. An explicit consumer `withhold` leaves the session unsent/unmoved and re-decides after refresh; past retention records `classification_unresolved`; no opt-out logic (#711 plugs in later).
- Test-first: yes — default forwards unknown; explicit withhold keeps cursor and expiry records `classification_unresolved` (AC3, AC16).

### Task 15: Lifetime, resume and classification matrix tests
**Files:** Test `spool/__tests__/evidence-lifecycle.test.ts`, `agents/core/evidence/__tests__/matrix.test.ts`.
- Matrix routed/direct x managed/native x scopes user/project-in-allowlist/project-outside. Lifecycle: drain -> sweep -> restart -> resume same id with changed project/org/routing reuses the record (AC18); post-eviction old-id fixtures: late Personal on a shared anchor surfaces a recorded `session_project_conflict` discard (never an accepted shared send), sticky-Personal and capability-loss stay protected, eviction blocked while pending (`evidence_capacity` hold). Existing allowlist/identity tests unchanged (AC13). Run final integration typecheck after this task.
- Test-first: yes — resume with changed project sends original evidence.

### Task 16: Docs
**Files:** Modify `docs/ARCHITECTURE-OTLP-PLUGIN.md` (evidence contract, record lifetime, reason codes incl. `evidence_capacity`, backend-retention caveat, open-PR seams).
- Test-first: no — documentation only.
