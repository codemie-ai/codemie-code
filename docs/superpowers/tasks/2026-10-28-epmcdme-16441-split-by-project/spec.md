# EPMCDME-16441: split hook forwarding by project (otlp-spool)

Size L (21), per the complexity assessment. Paths below are under `src/providers/plugins/sso/proxy/plugins/otlp-spool/` (`OS/`) unless stated.

## Problem

For a multi-project session the forwarder pins everything to the first sendable project and rewrites differing `codemie_project_name` values (`forwarder.ts` `pinEventProject`, `unwrapHookRecords`). This bypasses the backend gate, which answers `project_context_conflict` when the events of a request name a project other than the `X-CodeMie-Project` header. It also attributes project B's prompts, repo and branch to project A and defeats B's `cli_analytics_enabled=false`.

## Decision (settled by the user, not open)

Split by project: each project's hook events travel in their own request with a matching `X-CodeMie-Project` header. No event is ever rewritten. OTLP streams are unchanged and stay header-pinned to the session's bound project.

## Design

**Grouping (hooks, bound session).** Group key is the lowercased top-level `codemie_project_name`. Missing, blank or non-string goes to the bound project's group. Groups are ordered by first appearance in the range; events keep file order inside a group. Header spelling is the bound project's if the key matches it, else the first spelling seen in the range. Each group body is the unwrapped `hookEvent` bytes joined as today, so retries of an unchanged range are byte-identical per group.

**Sealed prefix.** A sealed session stays one group: the already filtered records, header = seal project. No splitting there.

**Unsendable names.** A name that cannot travel as a header is never posted. Ingest already turns it into a session conflict (status is written before the bytes). Defensive rule for a bound snapshot that still contains one (corrupt or legacy disk state): drop that group, log at debug, send the rest, advance as usual. This matches the discard semantics of a conflicted session.

**Session conflict, now.** Only an unsendable top-level name (`decideProject`). Several distinct sendable names are neither a conflict nor a pin: the bound project is the first sendable name seen. It is only the default for events without a name and the header of the OTLP streams; it never overrides an event's own project.

**Cursor semantics (one byte cursor, many requests).**
- Send groups sequentially; stop at the first non-`ok`.
- Advance `cursors.hooks` to `cursor + byteLength` only after every group returned `ok` (or nothing was sendable, as today). Any `failed` or `auth-expired` leaves the cursor untouched and the next tick re-snapshots and re-sends the whole range.
- Groups already accepted are re-sent on retry. This relies on the backend `ingest_dedup` ledger (a re-send of a record is skipped), the same assumption that already covers a crash between a 2xx and the cursor write. No per-project sub-cursors (status schema change, heavier; rejected).
- `auth-expired` in any group still propagates to `markCredentialsStale`.
- Consequence to document: one persistently failing group blocks the acknowledgement of the whole range (head-of-line), exactly as one failing batch does today.
- `markSessionEnded` runs only after the cursor advance of a fully acknowledged batch; `containsSessionEnd` is aggregated across all groups, so a session end sitting in a non-bound group counts.
- Backend answers 200 with `dropped` when a project is not accessible or has analytics disabled: that group is dropped by the backend, the other groups are accepted, all count as `ok`, and the drop is logged.

**Local re-check.** `isSendAllowed` keeps the cursor, `filtered` and `end <= limit` checks. For the hooks stream of an unsealed bound session it admits any sendable `project` (the group's); for a sealed session and for OTLP streams `project` must still equal the policy project (case-insensitive).

**Drop warning.** Still fire-and-forget and throttled to 60 s, but keyed by `sessionId:project(lowercased):reason`, and the log fields gain `project`, so A disabled and B without access are visible separately.

**Names read top-level only.** `hookEventProjectNames` and `hookRecordIsProject` read only the top-level `codemie_project_name`, like the backend (`raw` is ignored there). One definition of "the event's project" for binding, conflict, seal proof and grouping. `otlp.plugin.ts` ingest, which imports `hookEventProjectNames`, follows. No code touching `raw.codemie_project_name` remains, and no blank/non-string pinning.

**Legacy migration removed.** The `status.project ??= projectConflict[0]` branch in `normalizeStatus` goes. Under the old release any two names made a sticky conflict and discarded the backlog; guessing a binding from the conflict list would set the OTLP header and the home of unnamed events on no evidence. A stored all-sendable conflict is kept as stored (discard, or the sealed prefix as before). Rejected alternative: drop the conflict and reset `projectScanned` to rebind from disk.

**Contract test.** Export `BACKEND_DROP_REASONS` from `forwarder.ts` with a comment naming the backend source (gitbud epm-cdme/codemie: `cli_analytics_project_gate.py` `REASON_*` constants; `postgres/ingestor.py` `_otlp_result` and the hooks discard body). New test file `__tests__/backend-drop-contract.test.ts` with hard-coded shapes (never reads the backend checkout): the set equals exactly the three strings; hooks JSON `{"accepted":0,"dropped":N,"reason":R}`; OTLP `partial_success.error_message = R` hand-encoded as protobuf (logs, metrics, traces) and as JSON `{"partialSuccess":{...,"errorMessage":R}}`; each driven through `forwardSession` asserting the warning fires for all three reasons and not for an unknown reason.

## Acceptance criteria

1. No hook event is modified; `pinEventProject`, `unwrapHookRecords`' project parameter, `HookPayload.rewritten` and its log are gone.
2. A bound session with events for projects A and B produces two hook requests, each with `X-CodeMie-Project` equal to its group and a body of only that group's unmodified lines; unnamed events are in the bound project's request.
3. Group order is deterministic (first appearance); case-only variants share one group.
4. A OK + B failed: cursor unchanged, no `markSessionEnded`; retry re-sends A with identical bytes, then B; cursor advances only when both are ok. Auth-expired marks credentials stale and leaves the cursor.
5. A session end in a non-bound group sets `endedAt` only after the whole batch is acknowledged.
6. Unsendable group is never posted; sealed prefix remains one filtered request; OTLP streams keep the bound project header and bytes.
7. `isSendAllowed` admits non-bound projects for unsealed hooks only; still refuses stale cursor, wrong `filtered`, beyond `limit`.
8. Drop warnings throttle per session, project and reason (60 s).
9. Binding, conflict and seal proof use top-level names only; the `normalizeStatus` guess is removed.
10. Contract test as above; existing otlp-spool tests updated (forwarder rewrite tests replaced; `session-project`, `spool-io`, `tick-processor` legacy and `raw` cases adapted; split and partial-failure scenarios added to `project-interleave` against the real spool).
11. `docs/ARCHITECTURE-OTLP-PLUGIN.md` rewritten wherever first-seen pinning or rewriting is described (forwarder, atomic ingest, legacy recovery, the pin-first-seen bullet, seal/guarantee wording, hook-side pin remark, file table); no remaining claim of rewriting or cost attributed to the first project.
12. In the six committed docs under `docs/superpowers/tasks/2026-10-27-epmcdme-16441/` (findings F1, F2, F3, T2, T3, handoff-backend): no local absolute paths, backend or CLI commit hashes and version snapshots, internal hostnames, developer names; sibling-checkout wording made generic; the first-seen/rewrite statements updated to split-by-project; technical conclusions kept; re-grep clean. Ticket key stays.
13. PR note drafted (not pushed) stating that this is a security-reviewed `X-CodeMie-Project` attribution change: header values are now several per session (one per project), event rewriting removed, OTLP unchanged, and that PR-body claims about pinning/rewriting are replaced.
14. One commit on the current branch carrying the ticket key; no push, no PR.

## Non-goals

- No per-project cursors or status schema change.
- No change to OTLP streams, hook-side session pin (`session-project-pin.ts`), the completeness gate, adapters or `OTLP_ALLOW_HOOKS_ONLY_FORWARD`.
- No change to the sealed-prefix mechanism or to what makes a name sendable.
- No client-side access or `cli_analytics_enabled` checks; the backend decides per group.
- No reordering of events across projects and no cross-group retry/backoff logic.
- No edits to unrelated dirty files, `docs/superpowers/reviews/`, the 16435 task dirs, or untracked files of the old task dir.
- Pre-existing failures (14 unit, 4 integration SSO tests on the base) are not chased.

## Risks

- Re-send of accepted groups depends on backend `ingest_dedup` and stable event ids.
- Head-of-line blocking by a persistently failing group.
- Several header values per session: needs security review of the attribution change.
