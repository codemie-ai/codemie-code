## EPMCDME-16441: split hook forwarding by project

**Security-reviewed `X-CodeMie-Project` attribution change.** A session can now send several `X-CodeMie-Project` header values, one per project. Please review it as an attribution change, not only as a forwarder fix.

This replaces the earlier PR-body claims that the forwarder pins a session to its first project and rewrites other projects' events. Neither is true any more.

### What changed

- The forwarder groups the hook events of a batch by the lowercased top-level `codemie_project_name` and sends one request per project. Each request has a matching `X-CodeMie-Project` header and a body that holds only that project's lines.
- No event is modified. The old event rewriting (`pinEventProject`, the project parameter of `unwrapHookRecords`) is removed. Previously another project's prompts, repo and branch were attributed to the first project, and the backend answered `project_context_conflict` or ignored the other project's `cli_analytics_enabled=false`.
- Events without a usable name (missing, blank or non-string) go to the session's bound project. The group order is first appearance, events keep file order, and case-only variants share a group. An unchanged range produces byte-identical groups on every retry.
- A sealed session still sends one filtered request under the seal's project.
- OTLP streams (logs, metrics, traces) are unchanged: bound project header, same bytes.
- Project names are read from the top level of the event only, as the backend does. Binding, conflict detection, seal proof and grouping share this one definition; `raw.codemie_project_name` is ignored.
- The send re-check (`isSendAllowed`) admits any sendable project for the hooks of an unsealed session. A sealed prefix and every OTLP stream must still match the policy project. The stale-cursor, `filtered` and limit checks are unchanged.

### Cursor semantics and the head-of-line trade-off

There is still one byte cursor for hooks. Groups are sent in order and the batch stops at the first result that is not `ok`.

- The cursor advances (and `markSessionEnded` runs) only after every group returned `ok`. A session end in any group counts.
- On `failed` or `auth-expired` the cursor stays put, and the next tick re-sends the whole range. Groups the backend already accepted are sent again and de-duplicated by the backend `ingest_dedup`. This is the same assumption that already covers a crash between a 2xx and the cursor write.
- Trade-off: one persistently failing group holds back the acknowledgement of the whole range. I did not add per-project cursors, to avoid a status schema change.
- A group whose name cannot travel as a header is never posted (debug log, counted), and the rest is sent.

### Legacy and observability

- The legacy first-name guess in `normalizeStatus` is removed (`status.project ??= projectConflict[0]`). It set the OTLP header and the home of unnamed events on no evidence. A stored conflict made only of sendable names is kept as stored (discard, or the sealed prefix as before).
- The backend-drop warning (the backend answers 200 but discards) is throttled per session, project and reason (60 s), and the log carries `project`. A disabled project A and an inaccessible project B are visible separately.
- `BACKEND_DROP_REASONS` is exported and pinned by a new contract test, `backend-drop-contract.test.ts`. It uses hard-coded response shapes (hooks JSON, OTLP protobuf for logs, metrics and traces, and OTLP JSON) and asserts the warning for all three reasons and none for an unknown one.
- Tests cover the split, partial failure and retry bytes, including the interleave scenario against the real spool. `docs/ARCHITECTURE-OTLP-PLUGIN.md` is updated.

### Rollout

Restart the daemon after upgrading. A running daemon keeps the old pin-and-rewrite forwarder until it restarts.

### Not changed

No per-project cursors, no OTLP change, no change to the hook-side session pin, the completeness gate or the sealed-prefix mechanism, and no client-side access checks. The backend decides per group.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
