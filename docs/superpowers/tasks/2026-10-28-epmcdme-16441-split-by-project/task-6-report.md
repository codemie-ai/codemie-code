DONE
commit: 72ef75b6
paths:
docs/ARCHITECTURE-OTLP-PLUGIN.md
test_command: docs-only task, no tests; pre-commit hooks passed (commit exit 0). Done check: grep -nEi "first-seen|pin-first|rewrit|pinned" docs/ARCHITECTURE-OTLP-PLUGIN.md

Done-check grep output (matches, line:word):
94: "...the global active profile — pinned, for that session's later hooks to read back unchanged" (hook-side session-project-pin.ts)
94: "...falls back to the hook's own cwd, unwalked and unpinned, exactly as before this existed." (hook-side)
189: "readPinnedProjectName(sessionId)" in the session-project-pin.ts file-table row (hook-side)

Notes:
- Rewritten: forwarder bullet (no event alteration, per-project header), status-fields (top-level names only), atomic ingest (first sendable name = bound default, multiple names not a conflict), legacy recovery (stored sendable-only conflict kept as stored, no guess), the pin-first-seen bullet replaced by "Split by project" plus a new "Cursor semantics" bullet (all-or-nothing advance, resend of accepted groups via backend ingest_dedup, head-of-line blocking, no sub-cursors), seal wording (top-level names, sealed range is one group), guarantee wording (isSendAllowed per stream/project/range: any sendable project for unsealed hooks, seal project for sealed, bound project for OTLP), backend-answers bullet (drop-warning key ${sessionId}:${project lowercased}:${reason}, 60 s throttle, project in log), hook-side pin remark (L94), session-project.ts file-table row, and the CODEMIE_PROJECT "never pinned against" phrase.
- Facts verified against forwarder.ts (groupHookRecords, forwardHooks, warnOnBackendDrop), spool-io.ts (isSendAllowed), session-project.ts, session-status.ts.
- Left untouched: the "exactly as before this existed" phrase at L94 (pre-existing wording, not about pinning/rewriting).
