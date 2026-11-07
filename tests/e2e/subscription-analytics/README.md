# Subscription analytics connect flow: real E2E (EPMCDME-16849)

`bash tests/e2e/subscription-analytics/run-e2e.sh` (after `npm run build`). Exit code 0 = every assertion held.
Parameters are environment variables, see the header of `run-e2e.sh`. Commands, exit codes, the assertion list
(`results.json`, with a step trace) and the backend log are written to `$EVIDENCE_DIR`.

Path under test: built CLI hook/command processes -> the real proxy daemon (spool, stop markers, queued forwarder) ->
HTTP -> the backend's `cli_analytics` router, publication-contract check, gates, ingestor and SQL on one task-owned
loopback Postgres 17 container -> the backend's analytics reader. The CLI runs with a scratch `CODEMIE_HOME`/`HOME` on
`--profile claude-personal`; the global profile, installed CLI and installed hooks are never read or changed
(`NODE_ENV=test` keeps `bin/codemie.js` from running its self-update check).

| Labelled | What |
| --- | --- |
| REAL | CLI processes, daemon process, durable state, HTTP, backend router/ingestor/SQL, reader, hook stdout (notices) |
| REPLAY | hook inputs shaped like real Claude Code captures; a real Claude-written transcript with a per-session id |
| SYNTHETIC | JWT/credentials, config files, backend authentication and application directory stubs, the two canned backend responses (`SYNTHETIC` in `drive.mjs`: 422 requires-session, 200 without contract echo) |

Covered: consent connect/disconnect, consented work visible to super/project admins only, unconsented personal
(owner-only) storage, disabled and excluded, `/clear`, resume of an unrecorded session, folder change, disable then
re-enable, consent revoked, no duplicate consumption, old backend (setting off: held, never published, user notified
once, delivered after the backend advertises the contract), header injection on the analytics wire (request log), 422
requires-session, accepted answer without echo, profile-sourced project without consent (private), derived corporate N0 (project routing kept, SYNTHETIC organization name), a 503 hold produced by the real backend gate (project analytics disabled, then delivered), a SYNTHETIC final 200 discard (not a stop), `/clear` pair plus repeated resume of the known session (REPLAY hook sequence; no duplicated usage rows), notification (hook `systemMessage` on stdout).

Not covered (gaps):
- A live Claude Code session: hooks are replayed, so the interactive `/clear`-after-`cd` TUI case remains a manual check.
- Model-request traffic: stripping of analytics-only headers on model requests is unit-tested only.
- The 200 discard is a canned (SYNTHETIC) response; the 503 hold is real (backend gate). Other statuses are unit-tested in
  `forwarder-contract.test.ts` and `response.test.ts`.
- The backend's real authentication and application database (stubbed) and the PG14 leg (not repeated).
