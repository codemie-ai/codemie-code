# Live suite: claude-code-otlp sessions (EPMCDME-16992, EPMCDME-16993)

An isolated end-to-end harness for the `claude-code-otlp` analytics pipeline. Not part of vitest
(plain `.mjs`, no `*.test.ts`), run by hand against the built `dist/`.

```
hook payload --> node bin/codemie.js hook --agent claude-code-otlp   (REAL hook process, dist)
                   --> POST <daemon>/v1/analytics/hooks --> spool files under temp CODEMIE_HOME
native Claude Code OTLP/JSON --> POST <daemon>/v1/analytics/otlp/v1/logs  (lib/otlp-records.mjs)
                   --> spool --> REAL proxy daemon + forwarder (node dist/bin/proxy-daemon.js)
                   --> FAKE backend on 127.0.0.1 (lib/fake-backend.mjs) records every request
```

## Run the scenarios

```
npm run build
node tests/live/claude-code-otlp-sessions/run.mjs --label branch [--only S7,S9] [--concurrency 4]
# baselines: build a clean checkout (git worktree) and point the suite at it
LIVE_REPO_ROOT=<checkout> node tests/live/claude-code-otlp-sessions/run.mjs --label baseline-main
node tests/live/claude-code-otlp-sessions/report.mjs   # evidence/report.md from evidence/*.json
```

Twelve scenarios (`scenarios/index.mjs`): ordinary session; continuation without own work; continuation with
uuid-less copied lines; the QA case; parent and child together; late parent record; reopen with the native
records after the hook and before it (the startup race); reopen then real work; `startup`/`clear` sources;
reopen after the sweep removed the spool; two idle reopens then work. A full run takes about 1 minute.
The native startup records are synthetic (modelled on the QA list): a capture from real Claude Code needs its
login and is left out on purpose.

## Run the smoke

```
npm run build                       # dist must match the source under test
node tests/live/claude-code-otlp-sessions/scripts/smoke.mjs [--keep]   # --keep leaves the temp root for inspection
```

Needs Node >= 20. The smoke takes about 30 s (each hook process costs ~3.5 s of CLI start-up; the
script then waits 9 s to out-wait the OTel-only skip window).

## Files

| File | Purpose |
|---|---|
| `lib/env.mjs` | `createTestEnv()`: temp root with `codemie-home` (CODEMIE_HOME), `home` (HOME/USERPROFILE), `home/.claude` (CLAUDE_CONFIG_DIR), APPDATA; child env is an allowlist (no CODEMIE_*/OTEL_*/ANTHROPIC_* leaks). `te.project(name)` gives `{cwd, transcriptDir, transcriptPath(sid)}` where Claude Code expects the transcript. |
| `lib/fake-backend.mjs` | `createFakeBackend()`: records method/path/headers/body/arrival time. Answers the classification policy (advertises publication contract 1, `policy: 'legacy'` gives a 404 instead), echoes the contract/destination headers, `{}` for ingest. Helpers `hookEvents()`, `otlpLogRecords()`, `waitFor()`. |
| `lib/daemon.mjs` | `startDaemon(te, backend, {tuning})`, `runHook(te, payload)`, `hookInput()`. |
| `lib/seed-credentials.mjs` | Child script that stores a fake SSO login (JWT with an `email` claim) for the fake backend URL in the temp credential store. |
| `lib/no-keytar*.mjs` | `--import` preload that makes `import('keytar')` fail in every child, so the OS keychain / Credential Vault is never touched (the CLI then uses its file store under the temp CODEMIE_HOME). Verified at daemon start (`assertKeytarBlocked`). |
| `lib/otlp-records.mjs` | `native.*` record builders (`hook_registered`, `plugin_loaded`, `managed_settings_resolved`, `mcp_server_connection`, `hook_execution_start/complete`, `user_prompt`, `api_request`, `tool_result`), `postLogs(daemon, records)`. |
| `lib/transcripts.mjs` | Ordinary session, continuation copy (with/without no-uuid copied lines, synthetic and `/exit` own lines), `continued-in` record, reopen records, reopen-with-prompt. Copied from `C:\Users\OlehPrusak\codemie-eval\harness.mjs`. |
| `scripts/smoke.mjs` | The smoke described below. |
| `fixtures/`, `evidence/` | Reserved for `native-startup-records.json` and scenario output (Task 2 follow-up). |

## How the isolation works

* **Daemon**: `node dist/bin/proxy-daemon.js --target-url <fake backend> --port <free port> --state-file <tmp>/codemie-home/proxy-daemon.json --gateway-key live-gateway-key --provider ai-run-sso --profile live-test`. The state file path is derived from `CODEMIE_HOME` at module load, so the hook child (same env) finds this daemon and never the user's real one. The port is OS-assigned (never 4001), the real state file is never read.
* **Credentials**: the daemon runs in default `sso` mode and reads the stored SSO login for the target URL from the temp credential store. The seeded login is fake (cookie `codemie_access_token` = unsigned JWT with `email`), so no `/v1/user` lookup is needed and the hook (which only supports stored SSO logins, `agents/core/hook-credentials.ts`) resolves the same owner. `--auth-method jwt` would also start the daemon (`CODEMIE_JWT_TOKEN`), but the hook process would have no identity, so it is not used.
* **Identity match**: the forwarder only sends when the credentials' `apiUrl` identity equals the daemon state's `targetUrl`. Both are the fake backend URL.
* **Speed**: `OTLP_SEND_INTERVAL_MINUTES=0.02` (tick every 1.2 s), `OTLP_SEND_MAX_ATTEMPTS=3` (hooks-only force-forward and OTel-only skip after 3 ticks). Override with `startDaemon(..., {tuning: {...}})`; `FAST_TUNING` lists the knobs.
* **Why the policy answer matters**: the hook stamps a new-contract evidence record (`negotiate_publication`). Without a policy advertising publication contract `1`, the forwarder holds the session (`publication_contract_unavailable`) and nothing is sent; sends are only acknowledged when the response echoes `X-CodeMie-Publication-Contract`. The fake backend does both.
* **Safety nets**: `seed-credentials.mjs` refuses unless CODEMIE_HOME matches `otlp-live-*` and the backend is `http://127.0.0.1:<port>`; `te.assertInside()` guards state paths; temp root is deleted unless `--keep`.

## Gate rule (what the smoke proves)

`otlp-spool/completeness-gate.ts`: a session with hook events AND native OTel is forwarded (both streams); a
session with only hook events is force-forwarded after the wait; a session with ONLY native OTel records is
never forwarded (cursors advance to EOF after the wait, data is dropped). Native records of a session reach
the backend only because that session also has hook events.

## Not done / open

* Real native startup records of Claude Code 2.1.319 on `--resume` (`fixtures/native-startup-records.json`) were not captured; see the report. `lib/otlp-records.mjs` models them synthetically.
* Scenarios S1-S10 and `run.mjs` belong to the next step of the plan.
