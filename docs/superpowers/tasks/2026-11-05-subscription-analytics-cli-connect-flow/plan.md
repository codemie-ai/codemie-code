# CLI explicit-connect, funding route, session-transition handling — Plan

Spec: `spec.md` (approved). Baseline `916710fb`. Commit per task using the repository's existing convention. Paths are under `src/` unless noted. Tests: vitest, beside code in `__tests__/`; use `tests/helpers/isolated-cli.ts` for CLI-home isolation. No whole-suite gate, browser check or review task here (Stage 7 owns them).

## Shared-mechanism contract (read before T1, T4-T6)

- **Invariants.** (1) Disabled hooks collect/write no session state and publish nothing. Excluded hooks collect no content/events and start no daemon; the approved narrow exception is a privacy-stop marker for an already-known session via `onUntrackedHook`, so returning cannot backfill excluded activity. (2) Once `isStopped(key)` is true, no new network send for that session leaves the daemon, backlog included; no `through`/partial drain. (3) Consent and funding on the wire come only from the frozen record plus a fresh consent-store check, never from spooled or inbound headers. (4) Corrupt, unreadable, unknown-version or missing scope evidence means no consent / stopped, never open.
- **Callers.** `isStopped`: `OtlpAgentAdapter.processOtlpEvent` (before spooling, `OtlpAgentAdapter.ts:107-121`), `tick-processor.ts processSessionTick`, `forwarder.ts forwardSession:441`. Consent resolver: hook stamp and `evidence-send.ts evidenceHeaders:28`. Sibling adapters (copilot-*) must stay unchanged: all new behaviour is gated on the claude-code-otlp new-contract path.
- **Failure/retry.** Marker write failure in the hook = nothing spooled for that hook. Daemon-side marker failure = no send, retry next tick. Stopped data stays under existing spool expiry and is reported unpublished on expiry, never acknowledged. Marker is swept only when its record AND queued data are both absent plus the retention margin; reconnect never deletes it.
- **Not touched:** global profiles, installed CLI, hooks installation, class derivation, `policy_version` handling.

## T1 — Stop marker (`agents/core/evidence/stop-marker.ts`, sidecar of `record-store.ts`)

Add create-once-style atomic sidecar keyed by `recordKey(...)` next to `verdictFileName` (`record-store.ts:72`): `writeStop(key, reason)`, `isStopped(key)`, `takeNotice(key)` (returns pending reason once; marks shown), bounded reason enum (no project/path text). Extend `sweepRecords` (`:228`) so it pins markers while a record or spool data exists.
Test-first: yes — marker survives record eviction and is still honoured; `takeNotice` returns once; sweep keeps marker while queued data exists; corrupt marker reads as stopped.

## T2 — Consent store and connect/disconnect (`evidence/consent-store.ts`, `connectors/claude-code-otlp.ts:529-728`)

New versioned file under `getCodemiePath()`; entries scoped to authenticated CodeMie owner, canonical folder, API identity and project, using existing owner hashing, `project-allowlist.ts` canonicalisation and `evidence/api-identity.ts`. Consent requires a matching owner/backend/folder/project, with existing descendant semantics; unreadable/unknown version = false. Connect/disconnect actions on the existing connector menu; connect refuses fs roots, home and its ancestors, prints canonical folder, project, descendant coverage and admin-visibility text; connect does NOT add an allowlist entry (global gates unchanged). Explain if collection/exclusion currently prevents sending; connecting does not silently re-enable collection. Profile/workspace configuration may supply the requested project but never consent.
Test-first: yes — cloned `.codemie` config, other owner/backend/project, moved folder, root/home/ancestor connect, corrupt store each yield no consent; disconnect removes it; store path is outside any repo.

## T3 — Funding route and collection generation (`evidence/stamp.ts:107`, `routing.ts:132`, `claude-code-otlp.preferences.ts:108`)

Compute `funding_route` (`api_based|subscription|unknown`) once beside `classify()` from the same routing inputs; first-wins, frozen in the record as a short enum (measure serialized size against the 1024 cap in `record-store.ts` before adding). `subscription` only if `oauthAccountPays()` with no contradicting source; `api_based` only on positive proof; all else `unknown`. Add `collection_generation` in preferences, bumped atomically by the explicit settings enable/disable action (failed write fails closed); frozen into the record at first stamp. No credentials logged.
Test-first: yes — funding table incl. contradictions/apiKeyHelper/unproven -> `unknown`, first-wins across a mid-session auth change; generation bump persists and a failed write throws.
Update record-store types/validation and handle old records missing publication/generation fields explicitly: no silent upgrade of an existing private/legacy session into new consent. Preserve sibling adapter behavior and the existing size/corruption failure semantics.

## T4 — Wire: contract, capability, headers (`policy-cache.ts:75,102-180`, `evidence-send.ts:28-44`, `header-injection.plugin.ts:61,145`)

One exported `PUBLICATION_CONTRACT = '1'` used by policy check, sender, verifier. Policy cache keeps `publication_contracts`; a cached policy lacking it is refresh-due regardless of age (under the 5 min backoff); an expired policy only informs hold (never classification). `evidenceHeaders` adds contract and funding on every new-contract request, `Work-Consent: explicit-folder` only with non-blank project and a current `resolveConsent` hit; each header once; none when capability not advertised. In `onRequest` delete contract/funding/consent/analytics-only headers case-insensitively from model requests; sender ignores spooled/inbound headers.
Test-first: yes — no list -> one refresh then hold, never legacy; headers appear once with correct values; injected mixed-case headers via model path and via `otlp.plugin.ts` handleRequest ingress never reach the backend request; revoked consent STOPS the bound session and backlog, never downgrades it by removing the consent header and sending under another scope.

## T5 — Response handling and daemon stops (`response.ts:154`, `forwarder.ts:441`, `tick-processor.ts:170`)

Decode per spec items 2-3: 422 finals drop session data and set notice; hold 503s hold with notice at first hold and suspend after ~24h retention; retry 503s/unknown reasons use existing retry; recognised 200 discards are terminal-unsuccessful with no echo required; an acceptance needs contract echo + `X-CodeMie-Destination` (N1: `project` and case-insensitive `Bound-Project` = frozen project) else `response_unverified` -> `writeStop`; no redirects. Check stop/current consent/owner/backend/scope/generation before every new send; consent or continuity mismatch -> stop. Funding is sent from the frozen first claim for both N0/N1, NOT recomputed/compared to stop or reject. Already accepted in-flight requests cannot be recalled; do not resend or falsely acknowledge stopped pending data.
Test-first: yes — table-driven statuses/reasons from `backend-contract-handoff.md`; mismatched echo never acknowledges and persists a stop across daemon restart; stopped session sends nothing including backlog; expiry reports unpublished.

## T6 — Hook-side transitions and notice (`OtlpAgentAdapter.ts:107-121`, claude-code-otlp plugin `onUntrackedHook`)

After the existing gate: `isStopped` before spooling; non-startup `SessionStart` (resume/fork) or any later hook with no record and no marker writes a marker and publishes nothing; in-session cwd resolving to another project, unconnected or excluded scope, or generation mismatch writes a marker (also from `onUntrackedHook` for an already-recorded session); `/clear` and startup use a fresh record. Surface `takeNotice` once through the hook output channel (reuse `copilot-analytics-gate.ts` message builder; text carries no project or path); `logger.warn` fallback. Hooks always return normally.
Test-first: yes — disabled hook writes no session state; excluded unknown session remains untracked; excluded already-known session writes only the privacy-stop marker and cannot backfill on return. Resume with no record stops; repeated startup does not clear an existing stop; folder change stops; re-enable with new generation stops old session; notice emitted exactly once, including a daemon-written marker; `tests/integration/hook-stdout.test.ts` updated for the notice.

## T7 — Real E2E runnable script (`tests/e2e/subscription-analytics/run-e2e.sh` + node helpers)

Not a unit test. Drive the real built CLI (hook -> durable state -> queued forwarder) against the real backend worktree `C:/codemie-dev/_local/epmcdme-16849/codemie` (HEAD 984941d5c, capability enabled) and ONE task-owned loopback Podman PG17, then query the real analytics reader. Backend SQL/migration PG14/17 evidence is already valid; do not repeat its matrix for unchanged SQL. Reuse capture/probe utilities only where their transports are real: `pipe.mjs`/`run-pipe.sh` use synthetic credentials/transport and cannot establish E2E. Replay recorded real inputs through the actual producer/HTTP/ingest/storage/reader where appropriate, explicitly distinguish replay from a live Claude session, and verify notification reach with the real supported hook output. Wrapper launches use the authorized personal profile in the local run. Parameterize any checked-in script's repository paths/profile/ports; keep machine-specific credentials and captures outside Git. Scenarios: consented personal work visible to admin; no consent -> owner-only personal/hold; disabled/excluded; /clear, resume, fork, folder change, disable/re-enable stops; old backend (setting off) hold, never success; 422 requires-session; discard with/without echo; no duplicate consumption. Persist commands, real exit codes and outputs under the existing local evidence directory, labelling synthetic inputs/transports. Interactive TUI `/clear` after `cd` remains a documented manual gap, not claimed passed. No general automation framework or new test environment matrix.
Test-first: no — the script is the verification; it fails non-zero on any unmet scenario assertion.

## Negative-constraint pass

- No partial drain / `through`: T5 stops the whole session (T1 contract).
- Marker not sweepable while record/queue can reauthorise: T1.
- Funding first-wins N0+N1, echo check N1 only: T3, T5.
- 200 discards terminal without echo; acceptance w/o echo unverified: T5.
- No profile switch, global profile change, personal toggle, repo-carried consent, new tracking framework, allowlist auto-edit: T2, T6.
- Disabled session tracking stays off; excluded known-session stop is the narrow privacy-enforcement exception: T6. Header hygiene: T4. Notice without project/path: T6.
- No backend, UI, MR or publication work.
