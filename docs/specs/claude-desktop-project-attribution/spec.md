# SPEC: Claude Desktop Project Attribution (EPMCDME-12374)

---
# PART 1 — Context & Implementation
---

## Status

PR #324 open — continuation of PR #316 (merged, commit `e934933`).

## Background

PR #316 fixed Claude Desktop sessions showing raw sandbox paths (`local_<uuid>`) as repository name in analytics. It added `extractRepository()` in `src/utils/paths.ts` that detects the UUID sandbox pattern and returns `'Claude Desktop'` label.

PR #324 is the follow-up: Desktop sessions were missing the `project` field entirely in metric payloads, making project-level filtering in the analytics dashboard impossible.

## Root Cause

`DesktopTelemetryRuntime` built sessions and metric payloads without a `project` field. The proxy daemon never forwarded `config.project` into the runtime, so all Desktop-originated events were unattributed by project.

## Solution (final approach after review iterations)

### Data flow

1. Proxy daemon passes `config.project` into `DesktopTelemetryRuntime` constructor.
2. `DesktopTelemetryRuntime.startSession()` includes `project` in the `Session` object.
3. `sessionStart` and `sessionEnd` metric payloads carry `project`.
4. After resolving the git remote per session, `DesktopTelemetryRuntime` fires `onRepositoryResolved(repository)` callback.
5. Proxy daemon's callback updates `config.repository` so the `X-CodeMie-Repository` header reflects the actual repo (or `'Default'` for sessions outside any git repo).

### What was intentionally removed

- `loadProjectFromConfig` fallback in `ensure-session.ts` — `CODEMIE_PROJECT` is already injected via env by provider templates before agent spawn.
- Hardcoded `repository: 'Claude Desktop'` in proxy-daemon — repository is resolved per-session dynamically.
- `resolveProject()` helper in `DesktopTelemetryRuntime` — `config.project` is set at proxy startup from the active profile, same pattern as `CODEMIE_PROJECT` for CLI sessions.

## Changed Files

| File | Change |
|---|---|
| `src/telemetry/runtime/types.ts` | Added `project?: string` and `onRepositoryResolved?: (repository: string \| undefined) => void` to `DesktopTelemetryRuntimeConfig` |
| `src/telemetry/runtime/DesktopTelemetryRuntime.ts` | Fire `onRepositoryResolved` after git detection; include `project` in session and both metric payloads |
| `src/bin/proxy-daemon.ts` | Pass `config.project`; wire `onRepositoryResolved` callback to update `config.repository` |

## Key Design Decisions

- Repository resolved **per session** (not statically at startup) — Desktop can switch git context between conversations.
- Fallback repository label is `'Default'` (not `'Claude Desktop'`) for sessions outside any git repo — `'Claude Desktop'` is already used as the sandbox-path label from PR #316.
- `project` comes from proxy config (active profile) — no separate config load needed at runtime.

## Local User Setup (one-time)

The local postgres has its own user database (`IDP_PROVIDER=local`). To match the local user with the preview server user (so analytics data is attributed correctly), update the user_id in postgres to match the preview user_id.

**Credentials for local login:** `mykola_nehrych@epam.com` / `Qwerty123`

**Get preview user_id** from `https://codemie-preview.lab.epam.com` → profile/me endpoint.

**Update local DB** (run once after fresh postgres setup):

```sql
-- Disable FK checks temporarily
SET session_replication_role = 'replica';

UPDATE codemie.users
SET id = '<preview_user_id>', is_admin = true
WHERE email = 'mykola_nehrych@epam.com';

UPDATE codemie.user_projects
SET user_id = '<preview_user_id>'
WHERE user_id = '<old_local_user_id>';

UPDATE codemie.user_preferences
SET user_id = '<preview_user_id>'
WHERE user_id = '<old_local_user_id>';

UPDATE codemie.user_data
SET user_id = '<preview_user_id>'
WHERE user_id = '<old_local_user_id>';

SET session_replication_role = 'origin';

-- Verify
SELECT id, email, is_admin FROM codemie.users WHERE email = 'mykola_nehrych@epam.com';
```

Run via docker:
```bash
docker exec -i postgres psql -U postgres -d postgres -c "<sql here>"
```

**Current IDs:**
- Preview user_id: `ab908f16-8ff5-4d9f-9b6c-c8df18acf1b4`
- Old local user_id: `a77dbec6-f11e-4380-a1ae-6843dba722ca`

**Why:** Analytics data in elasticsearch is attributed to the preview user_id. Local UI reads from local postgres. If the IDs don't match, the logged-in user won't see their sessions.

Also update `username` and `name` to match the full name stored in elasticsearch metrics (used for user resolution in detail widgets):

```bash
docker exec -i postgres psql -U postgres -d postgres -c "
UPDATE codemie.users
SET username = 'Mykola Nehrych', name = 'Mykola Nehrych'
WHERE email = 'mykola_nehrych@epam.com';
"
```

**Why:** `cli-insights-user-repositories` and other detail widgets resolve `user_id` by matching `user_name` from the URL against `user_name` stored in elasticsearch metrics (`"Mykola Nehrych"`). If the local postgres has a short name (`"Mykola"`), the match fails → widget returns empty rows.

**After any postgres change:** re-login in the UI — JWT token caches the old user data.

## Known Issues & Fixes

### Analytics page shows "Analytics query failed"

**Symptom:** All analytics widgets fail, uvicorn logs show `ServerDisconnectedError` on elasticsearch, node marked as failed 70+ times.

**Root cause:** Two possible reasons (can combine):
1. `ELASTIC_URL=http://localhost:9200` in `.env` but preview elasticsearch requires **HTTPS**
2. kubectl port-forward dropped — uvicorn accumulates failed attempts and puts node on 30s timeout

**Fix:**
1. Change `.env` in `codemie` repo: `ELASTIC_URL=https://localhost:9200`
2. Renew port-forward (terminal 3)
3. Restart uvicorn (terminal 2) — `--reload` is not enough, need full restart

**Verify elasticsearch is reachable:**
```bash
curl -sk -u elastic:$ELASTIC_PASSWORD https://localhost:9200
# Expected: { "name": "elasticsearch-master-1", ... }
# Exit code 52 = empty reply = using HTTP instead of HTTPS
```

## Backend Setup (sibling repo: `codemie`)

Three terminals required:

```bash
# Terminal 1 — infrastructure
docker compose up postgres elasticsearch

# Terminal 2 — API server
poetry run uvicorn codemie.rest_api.main:app --host=0.0.0.0 --port=8080 --reload

# Terminal 3 — Elasticsearch port-forward from preview cluster
KUBECONFIG=~/Downloads/kubeconfig kubectl port-forward -n preview-elastic svc/elasticsearch-master 9200:9200
```

## Backend Temporary Change (codemie repo — local dev only)

File: `src/codemie/rest_api/routers/analytics.py`, function `_create_response`.

```python
# Before (original):
if config.is_local:
    response.headers["Cache-Control"] = "no-store"
else:
    response.headers["Cache-Control"] = "public, max-age=300"
    response.headers["ETag"] = hashlib.sha256(...).hexdigest()

# After (temporary local change):
response.headers["Cache-Control"] = "no-store"  # always no-store
if not config.is_local:
    response.headers["ETag"] = hashlib.sha256(...).hexdigest()
```

**Why:** QA reported that a new session appeared in "last 6 hours" filter immediately but showed up in "last 1 hour" filter only after a delay — caused by `max-age=300` (5 min) browser/proxy cache. Removing it allows verifying session data right after `codemie proxy stop`.

**Status:** Temporary — must NOT be committed or merged. Revert before finishing the PR.

## QA Testing Note — Revert Backend Cache Change Before QA

Before handing off to QA, revert the `analytics.py` temporary change (see above). QA tests must run with the **original caching behavior** — `max-age=300` (5 min) on non-local environments.

### What changes with cache enabled

| State | Delay |
|---|---|
| Cache on + session active | up to 2 min (sync cycle) + up to 5 min (cache) |
| Cache on + session stopped | immediate sync + up to 5 min (cache) |
| Cache off + session active | up to 2 min (next sync cycle) |
| Cache off + session stopped | immediate |

### Test case — session appears in analytics with cache enabled

**Setup:** revert `analytics.py` to original (cache enabled).

**Steps:**
1. `codemie proxy connect desktop`
2. Open Claude Desktop, send at least 2 messages
3. `codemie proxy stop`
4. Open analytics → CLI Insights, filter "last 1 hour"

**Expected:** session does NOT appear immediately. Wait up to 5 minutes — then refresh. Session must appear with correct `repo` and `project`.

**Why this matters:** with cache disabled locally we verified data was correct, but QA needs to confirm the session still appears correctly within the cache TTL window (≤5 min after proxy stop). If it doesn't appear after 5 min — it's a sync issue, not a cache issue.

## Frontend Setup (sibling repo: `codemie-ui`)

```bash
# In codemie-ui repo
npm run dev
# → http://localhost:5173/analytics?tab=cliInsights
```

This is the page used to verify that Desktop sessions appear with correct project and repository attribution.

## Local Dev Setup

### Switch to local build (for testing changes)

```bash
# In codemie-code repo
npm run build
npm link

# Verify — must be a symlink pointing to local repo
ls -la ~/.nvm/versions/node/v20.19.6/lib/node_modules/@codemieai/code
# Expected: lrwxr-xr-x ... -> ../../../../../../../WebstormProjects/codemie-code
```

### Switch back to published version

```bash
npm unlink -g
npm install -g @codemieai/code@latest

# Verify — must be a real directory (not a symlink)
ls -la ~/.nvm/versions/node/v20.19.6/lib/node_modules/@codemieai/code
```

## CLI Profile Requirement

The active profile must be **Preview** before running any verification commands.

```bash
codemie profile
# Check that "Preview (Active)" is shown

# If not active — switch:
codemie profile switch
```

Preview profile config:
- CodeMie URL: `https://codemie-preview.lab.epam.com/`
- Provider: `ai-run-sso`
- Scope: Global

---
# PART 2 — CLI Investigation (local dev context)
---

## Happy Path — Expected Analytics Output (CLI)

After running 3 sessions (last_hour filter):

**`cli-insights-top-spenders`:**
```json
{ "user_name": "Mykola Nehrych", "total_sessions": 3, "total_cost": 0.35 }
```

**`cli-insights-user-repositories`:**
```json
[
  { "repository": "epm-cdme/codemie-ui", "sessions": 2, "branches": ["EPMCDME-12524_analytics-users-filter-stale-results"] },
  { "repository": "Users/mykola_nehrych",  "sessions": 1, "branches": ["HEAD"] }
]
```

Session breakdown:
| Session | CLI | Directory | Repository | Branch |
|---|---|---|---|---|
| codemie-claude | claude | `codemie-ui/` | `epm-cdme/codemie-ui` | feature branch |
| codemie-code | codemie-code | `codemie-ui/` | `epm-cdme/codemie-ui` | feature branch |
| codemie-claude | claude | `~` (global terminal) | `Users/mykola_nehrych` | `HEAD` |

Note: running from a directory without a git remote → repository = `Users/<username>`, branch = `HEAD`. This is expected behavior, not a bug.

## CLI Session Flow (regular, non-Desktop)

This is a separate code path from Desktop. Used when running `codemie` (Claude Code) directly in the terminal.

### What happens on session start

1. `SessionStart` hook fires → `codemie_cli_session_total` metric sent to `/v1/metrics`
2. Proxy forwards LLM requests to `codemie-preview.lab.epam.com` with headers:
   - `X-CodeMie-Repository`
   - `X-CodeMie-Branch`
   - `X-CodeMie-Project`

### Log markers to look for

```
[hook:SessionStart] Session created: id=... agent=codemie-code provider=ai-run-sso
[MetricsApiClient] Successfully sent metric: Metric 'codemie_cli_session_total' sent successfully
[hook:SessionStart] Session start metrics sent successfully
```

### Note

Log format shows header **names** but not their values in forwarding entries. To verify actual `project` / `repository` values — check metric payload in the database or the analytics page.

### SessionEnd log markers

```
[MetricsApiClient] Successfully sent metric: Metric 'codemie_cli_tool_usage_total' sent successfully
[metrics-sync] Successfully synced metric for branch ""
[metrics-sync] Successfully Synced 1/1 deltas across 1 branches
[hook:SessionEnd] API sync complete: Synced 1 metrics
[MetricsApiClient] Successfully sent metric: Metric 'codemie_cli_session_total' sent successfully
[hook:SessionEnd] Session end metrics sent successfully { "status": { "status": "completed", "reason": "exit" }, ... }
[hook:SessionEnd] Session status updated: id=... status=completed reason=exit
[hook:SessionEnd] Renamed files: session, metrics
[sso-session-sync] sync: phase=final status=success session_id=...
```

Two metrics sent on SessionEnd:
- `codemie_cli_tool_usage_total` — per-branch usage delta
- `codemie_cli_session_total` — final session metric

Note: branch field was `""` (empty string) for this session — user was in `codemie-ui` but no branch was resolved.

### When does the session appear in analytics?

| State | Delay |
|---|---|
| Cache on + session active | up to 2 min (sync cycle) + up to 5 min (cache) |
| Cache on + session stopped | immediate sync + up to 5 min (cache) |
| Cache off + session active | up to 2 min (next sync cycle) |
| Cache off + session stopped | immediate |

"Stop" removes the sync delay. "No cache" removes the frontend delay. Both together → instant.

---
# PART 3 — Desktop: Expected Behavior
---

## User Cases Covered by This Fix

1. **Regular user (non-admin)** — can see their own Desktop sessions in analytics. Currently sessions without `project` are invisible or visible to admins only.
2. **Project filter** — Desktop sessions now have `project` → CLI Insights can be filtered by project and Desktop sessions appear in results.
3. **Cost attribution** — Desktop session costs are attributed to the correct project instead of being unattributed.
4. **Repository label** — `'Default'` or local path instead of `'Claude Desktop'` — consistent with CLI behavior and meaningful in analytics.
5. **Desktop with folder** — when a user opens a project folder in Desktop, `repo` and `project` resolve exactly like CLI from that same folder.

**In short:** after the fix, Desktop sessions look and behave like CLI sessions in analytics — with correct project and repository. Before the fix they were "blind spots" with no attribution.

## What We Want

Two scenarios for Desktop sessions:

### Scenario 1 — Desktop without a folder (new session, no project opened)
```
repo:    'Default'   ← not 'Claude Desktop', not sandbox path
branch:  ''
project: from ~/.codemie/codemie-cli.config.json → codeMieProject (empty if not set)
agent:   'claude-desktop'
```

### Scenario 2 — Desktop with a folder (project opened)
```
repo:    'org/repo-name'   ← git remote from opened folder (same as CLI)
branch:  ''                ← no branch for Desktop
project: 'project-name'    ← codeMieProject from .codemie/codemie-cli.config.json in that folder
agent:   'claude-desktop'
```

### Key principle
Desktop should behave like CLI but with working directory coming from the folder opened in Claude Desktop, not the terminal. When no folder is open — behave like CLI run from `~`.

### Why PR #324 was not merged
PR #324 read `project` from `config.project` set **once at proxy startup** from the active profile. This is static — it doesn't change per session. If a user opens different project folders in different Desktop conversations, the project won't update. Project must be resolved **per session** from the working directory config, just like `repository` is already resolved per session.

### What needs to change
1. `extractRepository()` in `src/utils/paths.ts` — replace `'Claude Desktop'` label with `'Default'` (or home directory path) for sandbox paths
2. `DesktopTelemetryRuntime` — resolve `project` from working directory's `.codemie/codemie-cli.config.json` → `codeMieProject` per session, not from static proxy config

## Verification Flow

End-to-end manual check (happy path):

```bash
# 1. Start proxy in Desktop mode
codemie proxy connect desktop

# 2. Open Claude Desktop — start a conversation (any message)

# 3. Stop proxy
codemie proxy stop

# 4. Open analytics dashboard
# http://localhost:5173/analytics?tab=cliInsights
# → session must appear with correct project and repository attribution
```

Expected result: the session shows up in CLI Insights with the `project` field populated (from working directory's `.codemie/codemie-cli.config.json` or global fallback) and `repository` set to the resolved git remote or `'Default'` if no git repo.

## Analytics Endpoints to Verify

Two frontend API endpoints to check after each test scenario (Mykola Nehrych local dev user_id: `ab908f16-8ff5-4d9f-9b6c-c8df18acf1b4`):

**1. User summary (sessions + cost):**
```
http://localhost:5173/api/v1/analytics/cli-insights-users?time_period=last_hour&users=ab908f16-8ff5-4d9f-9b6c-c8df18acf1b4&page=0&per_page=10
```

**2. Repository breakdown:**
```
http://localhost:5173/api/v1/analytics/cli-insights-user-repositories?user_name=Mykola+Nehrych&time_period=last_hour&users=ab908f16-8ff5-4d9f-9b6c-c8df18acf1b4
```

**What to check:**
- `repository` matches expected value from test scenario table (e.g. `Default`, `epm-cdme/codemie-ui`)
- `cost` > 0 on the correct repository (not on `Default` when a folder is open)
- No `Claude Desktop` or `local_<uuid>` entries for new sessions

---
# PART 4 — Desktop: Real Picture & Fix
---

## Test Scenarios

### Desktop scenarios

| # | Setup | Expected `repo` | Expected `project` |
|---|---|---|---|
| 1 | Desktop, no folder open (sandbox path) | `'Default'` | from `~/.codemie/codemie-cli.config.json` → `codeMieProject` (empty if not set) |
| 2 | Desktop, folder with git remote + `.codemie` config | `org/repo` | `codeMieProject` from folder's `.codemie/codemie-cli.config.json` |
| 3 | Desktop, folder with git remote, no `.codemie` config | `org/repo` | empty / undefined |
| 4 | Desktop, folder without git remote + `.codemie` config | `Users/username` | `codeMieProject` from folder's config |
| 5 | Desktop, folder without git remote, no `.codemie` config | `Users/username` | empty / undefined |
| 6 | Desktop, switch A → B → A → stop proxy | Session A: repo/project from Folder A; Session B: repo/project from Folder B — each independent | per-session resolution, switching doesn't overwrite |

### Regression — CLI must not be affected

| # | Setup | Expected `repo` | Expected `project` |
|---|---|---|---|
| 7 | CLI from project folder with git + `.codemie` config | git remote | `codeMieProject` from local config |
| 8 | CLI from `~` (no git remote) | `Users/username` | from global config |
| 9 | CLI from folder without git remote | local path | from local or global fallback |

### Unit tests — `extractRepository()`

| # | Input | Expected output |
|---|---|---|
| 10 | Normal project path | `parent/repo` |
| 11 | Desktop sandbox path (full UUID) | `'Default'` ← changed from `'Claude Desktop'` |
| 12 | Sandbox path with subfolder inside outputs | `'Default'` |
| 13 | `local_deadbeef` (short hex, no dashes) | NOT matched → local path |
| 14 | `local_cafebabe` (short hex, no dashes) | NOT matched → local path |

### Proxy header timing scenarios

| # | Setup | Expected `X-CodeMie-Repository` header | Note |
|---|---|---|---|
| 15 | Open folder, **send first message** | correct git remote | Fix 4 fires for subprocess request; Fix 4B (process tree descent) fires for the orchestrator request — both correct before forwarding |
| 16 | Switch to new folder, send first message | correct git remote | same Fix 4 + Fix 4B path; each new session triggers fresh lookup |
| 17 | Send second+ message in same session | correct git remote | already cached from #15; no lookup needed |
| 18 | Switch back to previously opened folder, send message | correct git remote | session already cached from first discovery |
| 19 | **Ping** (95-byte, no `x-claude-code-session-id`) | `'Default'` | Acceptable — no session ID → falls through to `config.repository ?? 'Default'`; request has no real LLM cost |
| 20 | **Orchestrator** (28 KB, Desktop's own `x-claude-code-session-id`) | correct git remote | Fix 4 → null (Desktop renderer has no `--add-dir`); Fix 3 → null (session file not on disk yet); **Fix 4B** → process tree descent finds subprocess → correct repo |
| 21 | **Second+ orchestrator** in same session (subprocess has already exited) | correct git remote | Fix 4B → process tree → null (subprocess gone); **`__last_desktop_repo__` fallback** → repo cached by subprocess's Fix 4 earlier in same session |

**IMPORTANT FOR TESTING:** Every message (including the first) is expected to have correct repository attribution. Per user turn Desktop sends two request types, both with their own `x-claude-code-session-id`:
- **Subprocess** requests (~179 KB) → Fix 4 (TCP port → subprocess PID → `--add-dir`)
- **Orchestrator** requests (~28 KB) → Fix 4B (process tree descent from Desktop renderer) + `__last_desktop_repo__` fallback

Send at least 2 messages to verify the `__last_desktop_repo__` fallback path (second orchestrator after subprocess exits).

**Key discovery (2026-06-07):** The Desktop orchestrator (28 KB, `?beta=true`) DOES send `x-claude-code-session-id` — it's Desktop's own UUID, different from the subprocess's UUID. The 95-byte ping is the only truly "sessionless" request.

**Verified 2026-06-04 (pre-Fix 4):** two messages sent 7s apart — msg 1 → `Default`, msg 2 → `epm-cdme/codemie-ui` via targeted lookup. Fix 4 + Fix 4B eliminate all `Default` attributions.

### Why the first message WAS limited (and how Fix 4 solves it)

Claude Desktop writes the session file **after receiving the LLM response**, not before sending the request. This was verified by comparing `birthtime` and `mtime` of session files — both timestamps are identical, meaning the file is created and written atomically in a single operation, only after the response arrives.

The sequence for a new conversation **before Fix 4**:

```
1. User sends message in Desktop
2. Desktop spawns claude process (CWD = user's project folder)
3. claude connects TCP → proxy :4001
4. Desktop sends LLM request to proxy  ← session file does not exist on disk yet
5. Proxy processes request              ← targeted lookup scans disk, finds nothing → 'Default'
6. LLM returns response to proxy
7. Proxy returns response to Desktop
8. Desktop writes session file          ← file appears here, too late
9. User sends second message
10. Proxy targeted lookup → finds file → resolves repo → caches → correct repo
```

**Fix 4 breaks the dependency on the session file** by using the TCP connection itself:

```
1. User sends message in Desktop
2. Desktop spawns claude process (CWD = user's project folder)
3. claude connects TCP → proxy :4001  (remotePort = ephemeral port, e.g. :52254)
4. Desktop sends LLM request to proxy
5. Proxy reads req.socket.remotePort → runs lsof → finds claude PID → reads CWD (~50ms)
6. Proxy resolves repo from CWD → caches in sessionRepositoryMap → forwards with correct header
7. LLM returns response
```

The TCP connection exists in the kernel's table from step 3. By the time the HTTP request reaches `onRequest` in step 5, `lsof` can see the connection and its owning PID immediately.

**Alternatives investigated before Fix 4 was found:**
- **Retry loop during request** — useless, session file cannot appear until after the response is returned
- **fs.watch on sessions directory** — same timing problem as targeted lookup alone; file appears after response
- **Desktop preferences / app state files** — investigated extensively (Preferences, IndexedDB `expandedIds`, Local Storage `cowork-read-state`, `LSS-sidebar-selected-mode`, `ccd-session-store`, `dframe-store`, IndexedDB `store:chat-draft:cowork-new-task`). None contain the active folder before the first request for a new conversation.
- **`spaces.json`** — lists all spaces with folder paths but has no "currently active" indicator; Desktop holds active space in React memory state only.

**`lsof` reliability on macOS:** measured at ~25ms per call. Claude Desktop is macOS-only. Process CWD is stable — Claude Code sets it to the project folder at spawn and does not change it. Two `lsof` calls total (~50ms) run before forwarding to the upstream LLM API.

**Note on `lsof` command name:** the Claude Code binary appears as its version string (e.g. `2.1.165`) in `lsof` output, not as `claude`. The lookup uses TCP port matching (`-i 4TCP@127.0.0.1:<remotePort>`), not process name — so version changes don't affect it.

**Fallback chain (all requests with `x-claude-code-session-id`):**

```
1. sessionRepositoryMap.has(cliSessionId)      → cached hit, skip all lookups
2. findWorkingDirViaProcess(remotePort)         → Fix 4: TCP port → subprocess PID → --add-dir (~50ms)
3. findWorkingDirForSession(cliSessionId)       → Fix 3: session file scan (fallback, from msg 2 onward)
4. findWorkingDirForDesktopDirectRequest(port)  → Fix 4B: process tree descent; for orchestrator
                                                   requests whose connecting process is the Desktop
                                                   renderer (no --add-dir); body > 1 KB gate (~100ms)
5. sessionRepositoryMap.get('__last_desktop_repo__')
                                                → last repo resolved by Fix 4 in this proxy session;
                                                   covers subsequent orchestrator calls after subprocess exits
6. 'Default', cached under cliSessionId        → all lookups failed; cached to avoid retry overhead
```

**Requests without `x-claude-code-session-id`** (95-byte ping only):
- Falls through directly to `config.repository ?? 'Default'` — no lookup, no cost

### Use cases covered by the targeted lookup fix

1. **Second and subsequent messages** — correct repo for all messages after the first in any session
2. **Switching between folders** — each new session triggers targeted lookup on second message, correctly attributed
3. **Long proxy session with many folder switches** — map grows per session, all sessions correctly attributed from message 2
4. **Cost reporting by repository** — the vast majority of LLM cost occurs after the first message; `codemie_litellm_proxy_usage` metrics carry correct `repository` from message 2 onward

### How to verify Desktop scenarios manually

```bash
# Standard run
codemie proxy connect desktop

# Debug run — direct node invocation, bypasses CLI wrapper, logs to /tmp/proxy-debug.log.
# Use this when you need to see raw targeted lookup logs, session file scan, repo resolution.
CODEMIE_DEBUG=true node /Users/mykola_nehrych/WebstormProjects/codemie-code/bin/proxy-daemon.js \
    --target-url https://codemie-preview.lab.epam.com/code-assistant-api \
    --provider ai-run-sso --profile Preview --gateway-key codemie-proxy \
    --project mykola_nehrych@epam.com \
    --state-file /Users/mykola_nehrych/.codemie/proxy-daemon.json \
    --port 4001 --telemetry-mode claude-desktop \
    --sync-codemie-url https://codemie-preview.lab.epam.com/ \
    2>&1 | tee /tmp/proxy-debug.log

# open Claude Desktop, run the scenario, stop proxy
codemie proxy stop

# 1. Check proxy logs (only if debug run was used)
grep "header-injection" /tmp/proxy-debug.log | tail -20
# look for: "Resolved repository via targeted lookup" → targeted lookup fired (msg sent < 10s after first)
# absence of this line → poll already populated map before second message arrived

# 2. Check elasticsearch — repo and project in raw metrics
curl -sk -u elastic:$ELASTIC_PASSWORD -X POST "https://localhost:9200/codemie_metrics_logs/_search" \
  -H "Content-Type: application/json" \
  -d '{"query":{"terms":{"metric_name":["codemie_cli_session_total","codemie_litellm_proxy_usage"]}},"sort":[{"@timestamp":{"order":"desc"}}],"size":10}' \
  | python3 -m json.tool
# verify: repository and project match expected values from test scenario table

# 3. Check analytics endpoints (see "Analytics Endpoints to Verify" section above)
# cli-insights-users    → session appears, cost > 0
# cli-insights-user-repositories → repository matches expected, cost on correct repo, no 'Claude Desktop' or 'local_<uuid>'
```

## Happy Path — Expected Analytics Output (Desktop, after fix)

### Scenario 1 — Desktop without a folder

```
repo:    'Default'
branch:  ''
project: from ~/.codemie/codemie-cli.config.json → codeMieProject (empty if not set)
agent:   'claude-desktop'
```

`cli-insights-user-repositories`:
```json
{ "repository": "Default", "sessions": 1, "branches": [] }
```

### Scenario 2 — Desktop with a folder (git repo + .codemie config)

```
repo:    'org/repo-name'     ← git remote from opened folder
branch:  ''
project: 'project-name'      ← codeMieProject from folder's .codemie/codemie-cli.config.json
agent:   'claude-desktop'
```

`cli-insights-user-repositories`:
```json
{ "repository": "org/repo-name", "sessions": 1, "branches": [] }
```

### Scenario 3 — Desktop with a folder but no git remote

```
repo:    'Users/mykola_nehrych'   ← local path, same as CLI from that dir
branch:  ''
project: from folder's .codemie config or global fallback
agent:   'claude-desktop'
```

## What Desktop Actually Sends Today

Observed from elasticsearch after `codemie proxy connect desktop` + message + `codemie proxy stop`:

```
codemie_cli_session_total (SessionStart):
  repo:    'Claude Desktop'   ← PR #316 sets this, needs to change to 'Default'
  branch:  ''
  project: —                  ← missing, this is the bug (EPMCDME-12374)
  agent:   'claude-desktop'

codemie_cli_tool_usage_total:
  repo:    'Claude Desktop'
  branch:  ''
  project: —

codemie_cli_session_total (SessionEnd):
  repo:    'Claude Desktop'
  branch:  ''
  project: —
```

**Desktop does NOT send** `X-CodeMie-Repository` or `X-CodeMie-Branch` headers (unlike CLI). Repository and project are resolved by `DesktopTelemetryRuntime` and injected into metric payloads directly.

**externalSessionId** in logs = Desktop sandbox session (`local_<uuid>`) — this is what `extractRepository()` detects to return `'Claude Desktop'`.

## Proxy Header Timing Problem & Fix

### Problem

`DesktopTelemetryRuntime` and `CodeMieProxy` are completely separate. The proxy sets `X-CodeMie-Repository` from `sessionRepositoryMap` which is populated by the polling cycle (every 10s by default).

**Race condition:** Desktop creates the session file and sends the first LLM request almost simultaneously. All LLM messages sent within the first poll interval (up to 10s) arrive before the session is discovered → `X-CodeMie-Repository = 'Default'` → LLM costs billed to wrong repository in analytics.

This was verified during testing: sending 2 quick messages resulted in both attributed to `Default` ($0.34) and `epm-cdme/codemie-ui` showing $0 cost.

### Fix — targeted lookup + local git remote read on unknown session

When the proxy sees an unknown `cliSessionId`:

1. **Targeted session file scan** — search Desktop session files specifically for this `cliSessionId` (not a full poll). Session file is always on disk before Desktop sends the first LLM request, so this scan succeeds immediately.

2. **Local git remote read** — instead of spawning `git remote get-url origin` subprocess (~100-500ms), read `.git/config` directly with `readFile` and parse the remote URL with a regex. Total time: ~2-5ms.

3. Cache result in `sessionRepositoryMap` → forward request with correct header.

4. **Timeout guard** — 1.5s max. If scan or git read fails → fallback to `'Default'`.

```typescript
// header-injection.plugin.ts — on unknown cliSessionId:
if (config.sessionRepositoryMap && !config.sessionRepositoryMap.has(cliSessionId)) {
  const workingDirectory = await findSessionWorkingDir(cliSessionId); // targeted scan
  if (workingDirectory) {
    const repository = await readGitRemoteLocal(workingDirectory) // .git/config read
      ?? extractRepository(workingDirectory);
    config.sessionRepositoryMap.set(cliSessionId, repository);
  }
}

// readGitRemoteLocal — reads .git/config, parses remote "origin" url, no subprocess:
async function readGitRemoteLocal(dir: string): Promise<string | null> {
  const gitConfig = await readFile(join(dir, '.git', 'config'), 'utf-8').catch(() => null);
  if (!gitConfig) return null;
  const match = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
  if (!match) return null;
  return extractRepository(match[1].trim()); // reuse existing URL → org/repo parser
}
```

**Result:** first message of a new session adds ~5-10ms latency (file scan + file read). Every subsequent request uses cached map entry instantly. LLM cost correctly attributed from the first message.

**Why not triggerPoll?** Full poll scans all session files and runs subprocess git detection for each → too slow and subject to same race condition if poll runs before file is on disk. Targeted lookup finds exactly one file and reads git config directly — both operations complete in milliseconds.

## Root Cause: `userSelectedFolders` Not Used

Claude Desktop session JSON files contain two relevant fields:

```json
{
  "cwd": "/sandbox/local_<uuid>/outputs",      ← sandbox path, always set
  "userSelectedFolders": ["/Users/.../codemie-ui"]  ← actual project folder opened by user
}
```

`ClaudeDesktopTelemetryAdapter` (`claude-desktop.discovery.ts`) resolves `workingDirectory` in this order:
```
originCwd → worktreePath → cwd → transcriptDir
```

`userSelectedFolders` is NOT in `DesktopMetadata` interface and NOT used → always falls through to `cwd` (sandbox path) → `extractRepository()` always returns `'Default'` → scenario 2 (folder open) is indistinguishable from scenario 1 (no folder).

### Fix — `claude-desktop.discovery.ts` (already implemented)

1. Add `userSelectedFolders?: string[]` to `DesktopMetadata` interface
2. Use `userSelectedFolders[0]` before `cwd` in `workingDirectory` resolution:

```typescript
workingDirectory:
  companionMetadata?.originCwd
  || companionMetadata?.worktreePath
  || metadata.originCwd
  || metadata.worktreePath
  || metadata.userSelectedFolders?.[0]   ← add this
  || metadata.cwd
  || transcriptDir
```

## What Needs to Change

### Fix 0 — `src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts`

Add `userSelectedFolders?: string[]` to `DesktopMetadata` and prioritize it over `cwd` in `workingDirectory` resolution (see "Root Cause" section above).

### Fix 1 — `src/utils/paths.ts`

`extractRepository()` currently returns `'Claude Desktop'` for sandbox paths. Change to `'Default'` (or home directory path — TBD):

```typescript
// Current (PR #316):
if (CLAUDE_DESKTOP_SANDBOX_RE.test(repoPath)) {
  return 'Claude Desktop';
}

// New:
if (CLAUDE_DESKTOP_SANDBOX_RE.test(repoPath)) {
  return 'Default'; // or: return os.homedir().split('/').slice(-2).join('/');
}
```

### Fix 2 — `src/telemetry/runtime/DesktopTelemetryRuntime.ts`

Resolve `project` per session from working directory config, not from static proxy config:

```typescript
// After resolving workingDirectory per session:
const project = await ConfigLoader.load(workingDirectory).then(c => c.codeMieProject) ?? undefined;

// Include in session and metric payloads:
session.project = project;
```

### Fix 3 — Targeted lookup + local git remote read in header injection plugin

When proxy sees unknown `cliSessionId` in `X-CodeMie-Session-ID` header:

1. **`findSessionWorkingDir(cliSessionId)`** — scans Desktop session files for matching `cliSessionId`, returns `workingDirectory`
2. **`readGitRemoteLocal(workingDirectory)`** — reads `.git/config` directly (no subprocess), parses `remote "origin"` URL
3. **If found** — put result in `sessionRepositoryMap` (cache) → use for this and future requests
4. **If not found** — do NOT cache; return `'Default'` for this request only; next request triggers lookup again

The "no cache on failure" rule is critical: the session file does not exist during the first message (Desktop writes it after receiving the response). If we cached the failure, every subsequent message in that session would also get `'Default'`. By not caching, the second message triggers a fresh lookup and finds the file.

Files to create/modify:
- `src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts` — export `findSessionWorkingDir(cliSessionId: string): Promise<string | null>`
- `src/utils/processes.ts` — add `readGitRemoteLocal(dir: string): Promise<string | null>`
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — replace `debugLogSessionFileState` with production targeted lookup; cache only on success; no timeout guard needed (file read is ~2-5ms, and on first message the file simply won't be there)

### Fix 4B — Orchestrator requests: process tree descent + last-repo fallback

Handles the **Desktop Electron app's own LLM calls** — the orchestrator/hostloop requests (`?beta=true`, ~28 KB) that Desktop sends directly (not via the subprocess). These DO carry `x-claude-code-session-id`, but it is Desktop's **own** UUID — different from the subprocess's UUID.

**Why Fix 4 fails for orchestrator requests:**

Fix 4 reads `--add-dir` from the process that owns the TCP connection (via remotePort). For subprocess requests, that process IS the `claude` subprocess (which has `--add-dir`). For orchestrator requests, the connecting process is the **Desktop Electron renderer** — it has no `--add-dir` in its args. Fix 4 returns null.

Fix 3 also fails because the session file for the orchestrator's `cliSessionId` doesn't exist on disk at request time.

**Key discovery (2026-06-07):** the orchestrator and subprocess use *different* `x-claude-code-session-id` values. The orchestrator has its own UUID; the subprocess has its own. Both are present in every user turn.

**Mechanism — Fix 4B (process tree descent):**
1. Runs inside the `cliSessionId` block, after Fix 4 and Fix 3 both return null, when `requestBody.length > 1000`
2. `lsof -n -P -i 4TCP@127.0.0.1:<remotePort>` → Desktop renderer PID
3. `ps -axww -o pid,ppid,args` (one snapshot, run in parallel with lsof)
4. Walk **up** from renderer PID through ancestors until a path matches `/Claude.app/`
5. BFS **down** from the Claude app root through all descendants
6. Find any descendant with `--add-dir` → extract path → resolve repository
7. Cache under `sessionRepositoryMap[cliSessionId]` AND `__last_desktop_repo__`

**Mechanism — `__last_desktop_repo__` fallback:**
Covers the case where the subprocess has already exited (second+ orchestrator in the same multi-turn session). Every time Fix 4 or Fix 4B successfully resolves a repository, it also writes to `sessionRepositoryMap['__last_desktop_repo__']`. Subsequent orchestrator calls whose Fix 4B returns null (subprocess gone) check this key and cache the result under their own `cliSessionId`.

**Files to modify:**
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — add `findWorkingDirForDesktopDirectRequest(remotePort)` function; add Fix 4B block and `__last_desktop_repo__` fallback inside the existing `cliSessionId` block after Fix 3

### Fix 4 — First-message fix: process CWD lookup via TCP connection

Runs **before** Fix 3 (targeted file scan) on every unknown `cliSessionId`. Resolves the working directory directly from the running `claude` process without needing any session file on disk.

**Mechanism:**
1. `req.socket.remotePort` — TCP source port of the connecting Claude Code process (available on first byte of the HTTP request)
2. `lsof -n -P -i 4TCP@127.0.0.1:<remotePort>` — find which PID owns that connection; filter out `process.pid` (proxy itself)
3. `lsof -p <pid> -F n -a -d cwd` — get CWD of that process (~50ms total for both calls)
4. Resolve repository via `readGitRemoteLocal(cwd)` + `extractRepository(cwd)` fallback
5. Cache in `sessionRepositoryMap[cliSessionId]`

**macOS-only:** Claude Desktop runs on macOS only; `lsof` is always available. No fallback to other platforms needed.

**Files to modify:**
- `src/providers/plugins/sso/proxy/proxy-types.ts` — add `remotePort?: number` to `ProxyContext`
- `src/providers/plugins/sso/proxy/sso.proxy.ts` `buildContext()` — add `remotePort: req.socket?.remotePort`
- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — add `findWorkingDirViaProcess(remotePort, proxyPort)` function; call it first; fall through to Fix 3 on failure

**Lookup order in `onRequest` (all requests with `x-claude-code-session-id`):**
```
1. sessionRepositoryMap.has(cliSessionId)                → cached hit, skip
2. findWorkingDirViaProcess(remotePort)                   → Fix 4: subprocess TCP → --add-dir (~50ms)
3. findWorkingDirForSession(cliSessionId)                 → Fix 3: session file scan
4. findWorkingDirForDesktopDirectRequest(remotePort)      → Fix 4B: process tree descent (~100ms)
                                                             (only if body > 1 KB)
5. sessionRepositoryMap.get('__last_desktop_repo__')      → fallback: last repo from Fix 4/4B
6. 'Default', cached under cliSessionId                   → all lookups failed
```

**Requests without `x-claude-code-session-id`** (95-byte ping):
```
→ config.repository ?? 'Default'   (no lookup at all)
```

## Planned Diff (new approach)

PR #324 can be used as a base. Keep the callback architecture for `repository`, fix `project` to resolve per-session from working directory config.

```diff
// types.ts — keep from PR #324
+  project?: string;
+  onRepositoryResolved?: (repository: string | undefined) => void;

// DesktopTelemetryRuntime.ts
-  ...(this.config.project && { project: this.config.project }),  // ← REMOVE: static project from proxy config
+  const project = await ConfigLoader.load(discovered.workingDirectory)
+    .then(c => c.codeMieProject ?? undefined)
+    .catch(() => undefined);
+  ...(project && { project }),  // ← per-session, from working directory

// map key = agentSessionId (cliSessionId), NOT externalSessionId
+  sessionRepositoryMap?.set(discovered.agentSessionId, repository || 'Default');

+  project: session.project,  // in sessionStart payload
+  project: session.project,  // in sessionEnd payload

// proxy-daemon.ts — remove static project, wire map
-  project: config.project,   // ← REMOVE
+  sessionRepositoryMap,
+  config.triggerPoll = () => telemetryRuntime.triggerPoll();

// header-injection.plugin.ts — look up by cliSessionId directly (no local_ prefix)
+  const cliSessionId = context.headers['x-claude-code-session-id'];
+  // lookup: sessionRepositoryMap.get(cliSessionId) (no local_ prefix needed)

// src/utils/paths.ts
-  return 'Claude Desktop';
+  return 'Default';

// claude-desktop.discovery.ts — use userSelectedFolders[0] before cwd
+  || metadata.userSelectedFolders?.[0]
```
