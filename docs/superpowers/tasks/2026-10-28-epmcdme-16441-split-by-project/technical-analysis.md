# Technical Research

**Task**: otlp-spool project spool forwarder session-project hooks
**Generated**: 2026-10-28
**Research path**: filesystem

---

## 1. Original Context

Fix these cross-review findings in the otlp-spool plugin (src/providers/plugins/sso/proxy/plugins/otlp-spool/):

1. [High] Today the forwarder pins a multi-project session to the first sendable project and REWRITES differing event codemie_project_name values to it (forwarder.ts pinEventProject / unwrapHookRecords; session-project.ts decideProject; session-status.ts normalizeStatus). That bypasses the backend ingest gate, which deliberately answers project_context_conflict when the events in a request name a different project than the X-CodeMie-Project header, and it misattributes project B's prompts/repo/branch to project A and bypasses B's cli_analytics_enabled=false. Chosen approach: SPLIT BY PROJECT. Forward each project's hook events in its own request with a matching X-CodeMie-Project header, with no event rewriting. Events without a project name go with the session's bound project. Keep: unsendable project names still conflict (a name that cannot be sent as a header), the sealed-prefix legacy behaviour, byte-for-byte same wire bytes on retries, cursor/ack correctness per batch (a partial failure must not lose or duplicate events; define and test the cursor semantics when one project's request succeeds and another fails), and the 60s throttled warnOnBackendDrop. OTLP streams stay header-pinned to the session's bound project and unchanged. Reconsider the legacy-state migration in normalizeStatus (status.project ??= projectConflict[0]) in light of the new design; remove it if it no longer makes sense. Update docs/ARCHITECTURE-OTLP-PLUGIN.md and the PR-body claims accordingly.

3. [Medium] Add a contract test that pins the three backend drop-reason strings used by BACKEND_DROP_REASONS (cli_analytics_disabled, project_context_required, project_context_conflict) against the backend response shapes: hooks JSON {"accepted":0,"dropped":N,"reason":R}, and OTLP partial_success.error_message = R in both protobuf and JSON (errorMessage) encodings. Backend source of truth (gitbud epm-cdme/codemie, sibling checkout at <backend-checkout>, read-only): src/codemie/service/analytics/cli_analytics_project_gate.py (REASON_* constants) and src/codemie/repository/cli_analytics/postgres/ingestor.py (_otlp_result, hooks discard body). Add a comment next to BACKEND_DROP_REASONS naming that source.

7. [Low] Becomes moot if rewriting is removed (nested raw.codemie_project_name rewrite and blank-value pinning were unnecessary: the backend reads only the event's top-level codemie_project_name and treats blank as absent). Make sure nothing of it remains.

8. [Low] In the committed docs under docs/superpowers/tasks/2026-10-27-epmcdme-16441/ (findings-F1/F2/F3/T2/T3.md, handoff-backend.md) remove local absolute paths such as <home>/... and any internal-only detail that should not live in a possibly public repo (backend commit hashes, internal hostnames, developer names such as in the ticket text); keep the technical conclusions. Also update the docs where the first-seen-pin behaviour is described, since the design changes to split-by-project.

Existing tests in otlp-spool/__tests__ will need updating for the new behaviour. Pre-existing failures: 14 unit and 4 integration SSO tests fail on base 361cd5dc, not caused by this change.

(Run notes from the caller: working tree has unrelated dirty/untracked files — `.codemie/codemie-cli.config.json`, `docs/superpowers/reviews/`, `docs/superpowers/tasks/2026-10-27-epmcdme-16435-*/`, and untracked artifacts in the OLD task dir `docs/superpowers/tasks/2026-10-27-epmcdme-16441/` — do not modify. Repo branch EPMCDME-16441, PR #707.)

---

## 2. Codebase Findings

All paths under `src/providers/plugins/sso/proxy/plugins/otlp-spool/` (abbrev. `OS/`) unless stated.

### Existing Implementations

- `OS/forwarder.ts` (441 lines) — transport. `forwardSession` -> `forwardHooks` (one snapshot, one `send`, one `advanceCursor`) then, unless `hooksOnly`, `forwardOtelStream` x3. `send()` = stale-creds check, `isSendAllowed` re-check before every attempt (also the 401/403/302 retry), `postToBackend`, `warnOnBackendDrop`. `postToBackend(url, body, contentType, creds, project)` sets `X-CodeMie-Project` per call via `rawProjectHeader(project)` (`src/utils/header-value.ts`; Latin-1 printable only, otherwise header OMITTED). So a per-request project header already exists as a parameter; only one project per batch is ever passed today.
  - Rewriting to remove: `pinEventProject` (rewrites top-level AND `raw.codemie_project_name`, blank/non-string too), `unwrapHookRecords(records, project?)` second param, `HookPayload.rewritten`, the `payload.rewritten` debug log in `forwardHooks`, the "Project the session is bound to" doc comments.
  - `BACKEND_DROP_REASONS` (L36-40) is a module-private `const ReadonlySet<string>` with no source comment and NOT exported (a contract test needs an export or a behavioural test through `forwardSession`). `parseDropBody` (hooks JSON; regex fallback beyond 4096 chars), `parseOtlpDropBody` (substring match of the three reasons in the raw body; works for protobuf and JSON bodies alike), `warnOnBackendDrop` (fire-and-forget `void`, throttle key `${sessionId}:${reason}`, `DROP_WARN_INTERVAL_MS = 60_000`, module-level `lastDropWarn` Map). The throttle key has no project component, so per-project requests share one warning per reason per minute.
- `OS/spool-io.ts` — `appendSpool` (atomic ingest under session lock: observes names, `decideProject`, writes status BEFORE bytes, seal on bound->conflict, resets cursor/seal on recreated file); `snapshotPendingHookRecords` (locked; policy via `applyProjectPolicyLocked`; reads `[cursor, gate.limit)` cut at last `\n`; for sealed sessions filters with `hookRecordIsProject`); `snapshotPendingBytes` (OTLP); `isSendAllowed(sessionId, stream, project, {cursor,end,filtered})` (locked; requires policy kind `send`, `policy.project` == `project` case-insensitively, `status.cursors[stream] === range.cursor`, `Boolean(onlyProject) === filtered`, `range.end <= limit`). `PendingHookBatch = {project, cursor, records, byteLength, dropped, filtered}`: ONE project, ONE contiguous byte range, ONE cursor.
- `OS/session-project.ts` — `decideProject` (several distinct sendable names -> bind first; only unsendable names -> conflict, listed first), `applyProjectDecision` (writes seal), `parseProjectSeal`, `hookRecordIsProject` (all names top-level+`raw` non-blank and equal), `hookEventProjectNames` (collects top-level AND `raw` string values; also imported by `otlp.plugin.ts:13`), `isSendableProjectName` (printable ASCII, trimmed, non-blank), `evaluateProjectPolicy` (`StreamPolicy` send/discard/hold; sealed => `{send, project: seal.project, limit: end, onlyProject}` hooks only, OTLP discard).
- `OS/session-status.ts` — `SessionStatus` (`cursors` per stream, `project`, `projectConflict`, `projectSeal`, `projectScanned`, `endedAt`, `waitTicks`); `normalizeStatus` L80-86 is the legacy migration: if `projectConflict` is non-empty and every name sendable, `status.project ??= projectConflict[0]; delete projectConflict` (comment admits it is "a best guess for the first-seen project, not a proof"); `parseProjectSeal` is then evaluated against the (possibly deleted) conflict so a seal of such a status is dropped. `advanceCursor` is monotonic `Math.max` via `updateStatus` (lock-acquiring; not reentrant); `markSessionEnded` sets `endedAt ??= now`.
- `OS/tick-processor.ts` — takes policy under the lock; `policy.sealed` => `hooksOnly` forward at once; `forwardSession` guarded by in-process `currentlyForwarding` Set (one forward per session at a time).
- `OS/completeness-gate.ts`, `spool-state.ts`, `spool-config.ts` (`OTLP_ALLOW_HOOKS_ONLY_FORWARD`) — unchanged by this task.
- Hook-side (not in scope to change, but context): `src/agents/core/session-project-pin.ts` (per-session hook-side pin of `codemie_project_name`, distinct from the daemon-side gate), `OtlpAgentAdapter`, `identity-fields.ts`.

### Architecture and Layers Affected

Daemon-side spool pipeline only: forwarder (transport) <- spool-io (locked snapshots/policy) <- session-project (pure policy) <- session-status (persistence). Plus docs and tests. Hook-side adapters, OTLP streams, `otlp.plugin.ts` ingest, completeness gate: no change expected.

### Integration Points

- Backend `/v1/analytics/cli-analytics/event-hooks` (+ `/logs|metrics|traces`), via `CODEMIE_ENDPOINTS` (`sso.http-client.js`).
- Backend gate semantics verified in the sibling checkout (read-only) — see Section 8.
- `forwarder.ts` imports `isSendAllowed`, `snapshotPendingBytes`, `snapshotPendingHookRecords` (spool-io) and `advanceCursor`, `markSessionEnded` (session-status).

### Patterns and Conventions

- Cursor = acknowledged byte offset per stream; advance only after success; at-least-once; "unwrapped bytes are the final wire event, same bytes on every retry".
- Session lock is non-reentrant and never held across HTTP; locked code may not call `updateStatus`/`advanceCursor`/`snapshot*`.
- Tests mock `../spool-io.js` and `../session-status.js` in forwarder unit tests, and use a real temp spool root + real lock in `spool-io`, `project-interleave`, `tick-processor` tests.
- Repo rule (`CLAUDE.local.md`): comments say what it is, no history ("was/now"), no references from code to docs paths. AGENTS.md: ESM, `.js` import suffixes, `@/` alias, `logger` + `sanitizeLogArgs`.
- `.ai-run/guides/security/security-practices.md` flags any add/remove/rewrite of `X-CodeMie-Project` attribution headers as a security-reviewed change; the split removes event rewriting but sends several header values per session; worth stating in the PR.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `docs/ARCHITECTURE-OTLP-PLUGIN.md` is the canonical doc. Lines that describe first-seen pinning / rewriting and must be revised (line numbers as of now):
  - L75 forwarder bullet: "only a `codemie_project_name` that differs ... blank or non-string included, is rewritten to the pinned project"; also "sets `X-CodeMie-Project` on all four POSTs ... to the session's bound project".
  - L78 Atomic ingest: "several distinct sendable names pin the session to the first-bound one".
  - L79 Legacy recovery: "the first distinct name binds".
  - L80 "**Pin-first-seen**" bullet — the main one to rewrite (cost attributed to first-seen project is no longer true).
  - L81/L82/L84: nothing-sent-on-conflict / seal / guarantee text; the seal still applies, check wording "first project" vs split.
  - L93-94 (`codemie_project_name` resolution, hook-side pin): L94 says "the project gate pins the first-seen one" — reword.
  - L195 file table: `session-project.ts` described as "Pure project binding (first-seen pin)".
  - L83/L85 (not matched by keyword search) were not read; re-read lines 74-90 in full before editing.
- `.ai-run/guides/integration/` contains only `exposed-api.md` and `external-integrations.md`; the `cli-analytics-events.md` guide cited by the doc (L76) does not exist in this repo. No other guide mentions first-seen pinning (grep of `.ai-run/guides`, `docs/ARCHITECTURE-PROXY.md`, `HOOKS.md`, `ANALYTICS-REPORT.md`).
- Other tracked/untracked places that mention pinning (outside scope except where tracked): `docs/superpowers/tasks/2026-10-27-epmcdme-16441/findings-F3.md` (L9 "pin first-seen project; forwarder rewrites event project"), `findings-T3.md` (L10 "the forwarder additionally rewrites to the pinned pro..."), `handoff-backend.md` (L60 "The CLI also rewrites any differing project in an event to the pinned one before sending"; L16/L27/L51 "session-pinned codemie_project_name" refers to the hook-side pin — accurate, leave), `findings-F1.md` L11. Untracked: spec.md, plan.md, task-*-report.md, code-review.md, `docs/superpowers/reviews/...` — do not touch. PR body is not in the repo.

### Architectural Decisions

Backend contract (code comment in gate module): analytics stored only for a project with `cli_analytics_enabled`; project is the one in `X-CodeMie-Project`; no explicit project value in the request body may differ; discards answered HTTP 200 with a reason (403 would suspend forwarding, other errors retried forever).

### Derived Conventions

Per-batch single header + single project is baked into `PendingHookBatch`, `send(project, range)`, `isSendAllowed(project, range)`.

### Item 8 inventory (committed docs; all 6 files are git-tracked)

Matches found by grep in `docs/superpowers/tasks/2026-10-27-epmcdme-16441/`:
- Absolute local paths: `findings-T2.md:3` ("Paths relative to <cli-repo>"), `findings-F2.md:3` ("sibling checkout <backend-checkout> at commit 48fa31b56"), `handoff-backend.md:108` ("`<backend-checkout>`"), and "sibling checkout"/"sibling backend checkout" phrasing in `findings-F1.md:2`, `findings-T3.md:21`, `handoff-backend.md:4`.
- Backend commit/version hashes: `48fa31b56` (F1:2, F2:3, F3:2, handoff:4,34,70), `83fad2f6` (handoff:106,161), `2.49.0-SNAPSHOT.240-24-g48fa31b56` (F1:2). CLI commit hashes: `ecab0a11` (F1:5, F3:8), `8844a322` (F3:9), `46bad8dc`, `9e17fbb4` (handoff:155).
- Developer name: `findings-F1.md:18` "a developer (~9 sessions)". Ticket id EPMCDME-16441 appears in titles/links (T2:35, T3:1,29, F1/F2 headers) — ticket ids are in branch/PR names, judgement call; hostnames/URLs: none found by grep (`https?://` not matched in these six files). Also re-check handoff-backend.md (26 KB) by eye for "backend team", "ticket owner" (L161), repo names ("gitbud"/"epm-cdme" not found), and prod-access/internal tool names.
- A second grep for emails/internal domains found none.

---

## 4. Testing Landscape

### Existing Coverage

Vitest 4 (`vitest run --project unit`, include `src/**/*.test.ts`). Tests live in `OS/__tests__/`:
- `forwarder.test.ts` (533 lines; mocks spool-io/session-status/daemon-manager/logger, stubs `fetch`):
  - REWRITE tests to delete/replace: `describe('unwrapHookRecords with a pinned project')` L80-96, `describe('unwrapHookRecords pinning edge cases')` L98-116, `'sends one project in header and every event name for a multi-project batch'` L212-231 (asserts names `['A','A']`).
  - KEEP/adapt: byte-for-byte unwrap L32-78; drop-warn tests L152-210 (JSON hooks body, 4096 cap, throttle); auth retry/302/301/503 L242-310, L496-533; project header tests L326-405; `'sends one project header and untouched bytes on every OTLP stream of a multi-project session'` L407; OTLP `partial_success` warn L427 (hand-built protobuf bytes `\x0a\x1c\x08\x03\x12\x18project_context_conflict`); sealed/filtered pass-through L447-495. Mock batch shapes lack `dropped`/`filtered`; `advanceCursorMock` expectations assert `('s1','hooks',110)`.
- `spool-io.test.ts` (621 lines, real fs): `'pins a mixed first batch of sendable names to the first one'` L81, `'keeps the pin when a later sendable project arrives'` L93, legacy `'pins the first project when the disk holds two sendable projects'` L172 — binding behaviour; stays if first-seen binding stays for blank-name/OTLP purposes. Seal tests L385-620 unaffected unless seal semantics change.
- `session-project.test.ts` (355): `decideProject` L37-92; `'re-evaluates a legacy conflict of sendable names by pinning the first one'` L173-190 (the normalizeStatus migration test; two cases, one with a seal) and `'keeps a legacy conflict that contains an unsendable name'` L192; seal/policy L263-355.
- `tick-processor.test.ts`: `'binds a single legacy project...'` L195.
- `project-interleave.test.ts`: end-to-end real spool + forwarder, sections A-E (seal with `Bé` as the unsendable second project; fetch mocked `{ok:true,status:200}`); no multi-project split scenario. Helper `hookLine(project)`, `seedBoundA()`, `cursorsAtEof()`; ordering via deferreds, `authHook.onStaleCheck` seam. Best place for the real-cursor split/partial-failure tests.

### Testing Framework and Patterns

`vi.resetModules()` + dynamic `await import('../x.js')` after mocks; real temp spool root via mocked `spool-paths.js`; `fetchMock` via `vi.stubGlobal`; `mockResolvedValueOnce({ok:false,status:503})` for failures; `await new Promise(r => setTimeout(r,0))` to let the fire-and-forget drop warning run.

### Coverage Gaps

- No contract test for drop-reason strings; no test with JSON-encoded OTLP body (`errorMessage`) — `parseOtlpDropBody` substring-match is only exercised with a hand-built protobuf. No protobuf library in `package.json` (no protobufjs/@bufbuild); existing test hand-encodes bytes. Hooks drop body shape for the contract: `{"accepted":0,"dropped":N,"reason":R}`.
- No test of a multi-project hooks batch against the real spool; no test of partial-failure cursor semantics (one project ok, another fails); no test that a retry resends identical bytes per project group; no test for session-end event living in a non-bound project's group.

---

## 5. Configuration and Environment

### Environment Variables

`OTLP_ALLOW_HOOKS_ONLY_FORWARD` (default true; `spool-config.ts`; false => sealed prefix discarded too); spool send/sweep interval and hooks-only wait ticks in `spool-config.ts`. No new env var is implied by anything found.

### Configuration Files

None specific. Spool dir via `spool-paths.ts`; status file per session (`<session>.status`, JSON of `SessionStatus`) — persisted shape changes are visible to already-running daemons and to old statuses on disk.

### Feature Flags and Deployment Concerns

Daemon outlives CLI upgrades (doc L102): restart the proxy daemon after upgrade. On-disk statuses written by earlier builds (v0.16.x `projectConflict` of sendable names, this branch's pre-fix binding) are read by `normalizeStatus`.

---

## 6. Risk Indicators

Facts that bear on the split design (the design choices themselves are Speculative):

- Backend gate facts: hooks route reads ONLY the event's top-level `codemie_project_name` (`_note_project(batch, raw.get(PROJECT_KEY))`, `otlp.py:884`); blank = absent; comparison is `lower()` only (no strip/casefold); case-only difference is the same project and the stored canonical name wins. Re-sends are idempotent: ingest ledger `ingest_dedup` stores each record once ("a re-send skips it"), so duplicates from a re-sent group are absorbed provided `event_id`s are stable.
- Speculative: cursor semantics. There is one byte cursor per stream and a batch is one contiguous range holding interleaved projects, so a cursor cannot represent "project A's events up to X done, project B's not". The simplest correct rule: advance `cursors.hooks` to `batch.cursor + byteLength` only when EVERY project request of the batch returned `ok`; on any failure/auth-expired leave the cursor untouched and retry the whole range next tick (already-accepted groups are re-sent and deduplicated by the backend ledger => no loss, harmless duplicates). Within one pass, send groups in deterministic order (first appearance) and stop at the first non-`ok` (auth-expired must still propagate to `markCredentialsStale`). Per-project sub-cursors would need a status-schema change and are heavier. Same-bytes-on-retry holds per group only for an unchanged range; a grown range regroups, relying on dedup.
- Speculative: `isSendAllowed(..., project, range)` rejects any `project` != policy project (case-insens.), so a non-bound project's request would be refused locally; it needs a per-group notion (e.g. allow project in the set of names found in the snapshot, or check policy state + cursor/range only for hooks). The `Boolean(onlyProject) !== range.filtered` and `range.end <= limit` checks must stay.
- Speculative: group key = lowercased top-level name; blank/missing/non-string top-level -> bound project; header spelling should be deterministic (e.g. first spelling seen in the range). A group name that is not sendable (non-Latin-1 gets header OMITTED by `rawProjectHeader`, which would hit `project_context_required` on the backend) must never be posted; normally ingest already turned such a session into a conflict, so this is defensive/race handling.
- `hookEventProjectNames` and `hookRecordIsProject` also read `raw.codemie_project_name`, though the backend ignores it. Item 7 says nested rewriting must not remain; whether binding/conflict/seal proof should keep inspecting `raw` is a decision (an unsendable `raw` name currently makes a session conflict although the backend would not care; changing it touches `session-project.test.ts` L136-143 and seal tests).
- Sealed prefix (`onlyProject`) filter drops blank-named and other-project records; unchanged requirement ("keep legacy behaviour"), so splitting applies only to bound sessions; in the sealed path there is exactly one group (the sealed project). Bound snapshots are unfiltered (`filtered: false`) and blank-named records go with the bound project.
- Speculative: `markSessionEnded` currently runs after the cursor advance when the batch holds `agent.session.end`; with groups, `containsSessionEnd` must be aggregated across groups and applied only after the whole batch is acknowledged.
- `normalizeStatus` migration (L80-86): for a status whose conflict list is all-sendable it guesses `project = conflict[0]`, deleting the conflict and any seal. Under split-by-project a wrong guess misattributes blank-named events and sets the OTLP header project; a status with those fields can only come from a build older than the pin (the v0.16.x behaviour: any two distinct names => sticky conflict, backlog already discarded). Options for spec: remove the migration (keep the stored conflict => treated as conflict/sealed as before), or drop only the conflict and reset `projectScanned` so the next locked pass rescans hooks on disk and binds the first-seen name (the existing `resolveLegacyProjectLocked`). Either way update the two tests at `session-project.test.ts:173/192`.
- Throttled warning: per-session+reason key means N per-project requests that are all dropped log once per 60s; if the spec wants per-project visibility the key/fields change (and `lastDropWarn` is module-global, tests rely on it via `vi.resetModules`).
- Contract test: `BACKEND_DROP_REASONS` is not exported; protobuf must be hand-encoded (field 1 `partial_success` -> field 1 `rejected_*` varint, field 2 `error_message` string; tag bytes for logs/metrics/traces differ only in the rejected-field name, same number 1/2 layout as the existing test bytes) and JSON as `{"partialSuccess":{"rejectedLogRecords":N,"errorMessage":R}}` (proto3 JSON camelCase; backend uses `json_format.MessageToJson`). Backend is a sibling checkout; the test must not read it (hard-code the expected strings and shapes).
- Doc/PR hygiene: five committed task docs contain absolute paths, hashes, a developer name; the old task dir also has untracked files that must stay untouched; after editing, re-grep the 6 files.
- Pre-existing failures (14 unit, 4 integration SSO) are unrelated; do not chase them.

---

## 7. Summary for Complexity Assessment

The change is confined to the daemon-side otlp-spool pipeline: `forwarder.ts` (remove `pinEventProject`/rewrite; group hook records by top-level project; one POST per group with its own `X-CodeMie-Project`; one cursor advance after all groups succeed; aggregate session-end), `spool-io.ts` (`isSendAllowed` and possibly `PendingHookBatch` need to admit non-bound projects of a bound session), `session-project.ts`/`session-status.ts` (reconsider `normalizeStatus` migration and the `raw` name reading), plus one new contract test file, `BACKEND_DROP_REASONS` source comment/export, rewritten sections of `docs/ARCHITECTURE-OTLP-PLUGIN.md` (about 8 places), and a scrub of 6 committed task docs. About 4-6 source files, 1 new test file, 4-5 test files edited, 7 docs touched.

Technical novelty is moderate: no new dependencies or schema, but cursor correctness with a single byte cursor and several requests is the one real design decision (all-or-nothing advance with backend-ledger dedup is the lowest-risk reading), and it interacts with the lock/policy re-check machinery (`isSendAllowed`, `filtered`, sealed prefix). Test posture is strong for the spool and seal (real-fs tests, interleave tests) but absent for multi-project splitting, partial failure, and the drop-reason contract; several existing forwarder tests assert the rewriting behaviour and must be rewritten.

Key risks: partial-failure cursor semantics, local policy re-check refusing non-bound-project requests, legacy status migration guesses, `raw` vs top-level name inconsistency with the backend, header-attribution being a security-reviewed area per the repo guide, and doc scrub completeness.

---

## 8. External References

Named by the task:

- Backend sibling checkout `<backend-checkout>` — resolved, read-only.
  - `src/codemie/service/analytics/cli_analytics_project_gate.py`: `REASON_DISABLED = "cli_analytics_disabled"`, `REASON_CONTEXT_REQUIRED = "project_context_required"`, `REASON_CONTEXT_CONFLICT = "project_context_conflict"`. Gate: blank header -> required; `len({v.lower() for v in explicit} | {project.lower()}) > 1` -> conflict; unknown/deleted app, no access, non-member -> required; `not application.cli_analytics_enabled` -> disabled; accepted requests store the canonical application name. Discards are HTTP 200 (403 would suspend forwarding); only a failed policy lookup raises (503, CLI retries).
  - `src/codemie/repository/cli_analytics/postgres/ingestor.py`: hooks discard body `{"accepted": 0, "dropped": batch.wire_count, "reason": reason}` as JSON (`media_type=JSON_MEDIA_TYPE`), accepted-hooks body `{}`. `_otlp_message`: when `rejected` is truthy sets `partial_success.<rejected field>` and `partial_success.error_message = message`. `_otlp_result(signal, content_type, rejected, stored, message)`: JSON when request content type is `application/json` via `json_format.MessageToJson(response, indent=None)` (so key `errorMessage`), otherwise `response.SerializeToString()` (protobuf). On a gate discard the OTLP path calls `_otlp_result(signal, content_type, batch.wire_count, 0, reason)`, i.e. `error_message` is the bare reason string and the rejected count is the wire count.
  - `src/codemie/repository/cli_analytics/postgres/otlp.py:884`: hook events contribute only `raw.get("codemie_project_name")` (top level) to `explicit_projects`; blank counts as absent (`_note_project`). Ingest is idempotent per record (`ingest_dedup` ledger).
- Old task dir `docs/superpowers/tasks/2026-10-27-epmcdme-16441/` (findings-*.md, handoff-backend.md) — resolved; read as prior research, inventory in Section 3.
