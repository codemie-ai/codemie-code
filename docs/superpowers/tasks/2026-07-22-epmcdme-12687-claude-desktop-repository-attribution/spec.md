# Spec — EPMCDME-12687: Claude Desktop Per-Request Repository/Branch Attribution

## Problem

Claude Desktop sends all LLM traffic through the local proxy (`codemie proxy connect
desktop`, listening on `127.0.0.1:4001`). Before this change, the proxy could only inject a
single, static `X-CodeMie-Repository` value (`config.repository`, resolved once at proxy
startup from the CLI's own launch directory) into every outgoing request header. Since
Desktop is a single long-running app that a user can point at many different projects across
the day — Cowork chat with no folder, Cowork with a folder open, or the Code tab (Claude
Code running inside Desktop) — a static per-daemon repository value cannot distinguish any of
that. Every Desktop LLM cost landed under one repository (or `Cowork`), making the CLI
Insights Repositories table useless for a Desktop user's real activity.

---

## Approach

Resolve repository (and branch) **per request**, keyed by the `x-claude-code-session-id`
header Claude Desktop sends on every LLM call (`cliSessionId`), and cache the result in a
`Map` shared across requests for the life of the proxy daemon (`config.sessionRepositoryMap`).
Three independent resolution strategies run in order, each covering a gap the previous one
can't:

1. **Process CWD lookup** — resolve the PID of the process holding the TCP connection at
   `context.remotePort` (via `lsof`), then read that process's `--add-dir` argument (Cowork +
   folder) or OS-level current working directory (Code tab). Works from the very first
   message, before Desktop has written any session file to disk. macOS only, ~50ms.
2. **Session file scan** — Desktop writes a session JSON file (`local_<uuid>.json`) to one of
   two roots (`local-agent-mode-sessions/` for Cowork, `claude-code-sessions/` for Code tab)
   **after** the first LLM response, not before the request. Scan both roots for a file whose
   `cliSessionId` matches, and read its `cwd` / `originCwd` / `worktreePath` /
   `userSelectedFolders[0]`. Only useful from the session's second message onward.
3. **Process tree descent** — for orchestrator requests (identified by `?beta=true` in the
   URL), the connecting process is the Desktop renderer itself, not the `claude` subprocess,
   so strategy 1 fails (renderer's cwd is generic, not the project folder). Walk up from the
   renderer to the Claude app root process, then BFS down the process tree looking for a
   `claude` subprocess with `--add-dir` (Cowork+folder) or `--output-format stream-json`
   (Code tab, resolved via its own `lsof` cwd).

If none of the three resolve a working directory, fall back to the most recently resolved
Desktop repository (`config.lastDesktopRepo`, 30s TTL — covers the common case of a subprocess
and its paired orchestrator request arriving ~200ms apart for the same user turn), then
finally to the static `Cowork` label.

Once a working directory is found, the actual repository name and branch are read directly
from the local filesystem (`.git/config` remote origin URL, `.git/HEAD`) rather than shelling
out to `git` — cheaper and avoids spawning a process per request.

---

## Client Attribution (Cowork vs. Code Tab)

Every Desktop-mode request defaults to `X-CodeMie-Client: claude-desktop` (set once from
`config.clientType` at proxy startup). The per-request resolution additionally distinguishes
**which kind** of Desktop session it is, via `isCodeIntegration` (true = Code tab session,
resolved from the `claude-code-sessions/` root or a subprocess without `--add-dir`; false =
Cowork):

- **Cowork** (`isCodeIntegration=false`): branch is injected (when resolvable) and
  `X-CodeMie-Client` is explicitly (re)asserted as `claude-desktop` — necessary so that both
  the orchestrator and subprocess requests for the same Cowork turn land in the same
  `(repository, branch, claude-desktop)` bucket on the backend, instead of splitting into
  separate rows.
- **Code tab** (`isCodeIntegration=true`): client is left as whatever `config.clientType`
  already set — which for a Desktop-mode proxy is `claude-desktop`. **Verified against live
  preview Elasticsearch data** during review: Code tab sessions (real `.git/HEAD` branch
  values, `cli_request: true`) do carry `client_type: claude-desktop`, not `CLI`. An earlier
  in-code comment claimed "client stays as CLI" for this case — that was stale/incorrect
  documentation, not actual behavior; corrected during review (see [Review Findings](#review-findings)).

Branch is only injected when a working directory was found via one of the three strategies
above, or from the `lastDesktopRepo` cache — never for the plain Desktop-default fallback
(`Cowork`, no resolution). `local-agent-mode-sessions` (Cowork chat mode) sessions have no git
hooks, so a tool-usage delta for that session type never carries `gitBranch` on the backend
side either — injecting a branch header there would create a spurious second bucket
`{repo, branch}` alongside the real `{repo, ""}` bucket.

---

## Supporting Changes

- **`claude-desktop.discovery.ts`**: `DesktopMetadata.userSelectedFolders` added as a
  higher-priority working-directory source than `cwd` (Desktop sets this when the user
  explicitly selects a project folder in Cowork, which may differ from the process's actual
  `cwd`). `walk()` exported so `header-injection.plugin.ts` can reuse it for the session file
  scan instead of duplicating directory-walking logic.
- **`paths.ts` / `extractRepository()`**: sandbox paths (Cowork with no resolvable project)
  now return `'Cowork'` instead of `'Claude Desktop'` — the label needed to match what the
  rest of the pipeline (and the backend's own `Cowork` fallback, see the `codemie` repo's
  companion change) expects.
- **`metrics-aggregator.ts` / `metrics-sync-processor.ts`**: individual metric deltas parsed
  from Desktop session files never carry a `gitBranch` field (only the session object does,
  via `detectGitBranch`). Both now fall back to `session.gitBranch` when `delta.gitBranch` is
  `undefined`, so Desktop deltas bucket under the session's real branch instead of always
  landing in an empty-branch bucket.
- **`DesktopTelemetryRuntime.ts`**: `ensureSession()` now also resolves and stores
  `config.codeMieProject` (via `ConfigLoader`) and writes into the same
  `config.sessionRepositoryMap` the header-injection plugin reads/writes, so a session
  discovered by polling (before any LLM request arrives) still gets a `Cowork`-vs-real-repo
  entry. `stop()` now runs one final `poll()` before finalizing tracked sessions, to catch
  transcripts written between the last regular poll tick and proxy shutdown (common for Code
  tab sessions, where the transcript write is async relative to the LLM response).

---

## Review Findings

Three issues surfaced during self-review and were fixed before this change was considered
complete; a fourth was investigated live and turned out not to be a functional bug:

### Fix A — Concurrent resolution race for a brand-new session

The subprocess and orchestrator requests for the same Desktop user turn can arrive within
~200ms of each other (per the `lastDesktopRepo` TTL comment). Before the fix, both would
independently see `!config.sessionRepositoryMap.has(cliSessionId)` and each kick off its own
`lsof`/`ps` resolution chain — redundant work, and a narrow window where the two could
theoretically disagree if process state changed between the two lookups.

**Fix:** extracted the resolution chain into `resolveDesktopSessionRepository()`, backed by an
in-flight-promise cache (`inFlightSessionResolutions: Map<string, Promise<...>>`) keyed by
`cliSessionId`. A second concurrent request for the same new session awaits the same promise
instead of starting its own resolution; each request still independently applies the shared
result to its own `context.headers`.

### Fix B — Telemetry poll could silently overwrite a more precise per-request resolution

`DesktopTelemetryRuntime.ensureSession()` wrote into `config.sessionRepositoryMap`
unconditionally on first discovery of a session, with no check for whether the header-injection
plugin's per-request lookup (which runs first, in real time, and is generally more precise —
process-level CWD vs. this poll's session-file-derived `workingDirectory`) had already resolved
a value. The two writers had no coordination.

**Fix:** added the same "don't overwrite if already set" guard `DesktopTelemetryRuntime.ts`
already existed on the header-injection side, so whichever writer resolves first wins and the
other becomes a no-op for that session.

### Fix C — Stale/incorrect comment ("Code tab: client stays as CLI")

See [Client Attribution](#client-attribution-cowork-vs-code-tab) above — verified against live
data that this claim was wrong; the comment has been corrected to describe actual behavior
(client stays `claude-desktop`, inherited from `config.clientType`) instead of asserting a
distinction the code never implemented.

### Fix D — Numbered "Fix N" comment references removed

The original implementation's comments referenced "Fix 3", "Fix 4", "Fix 4B" — numbers from a
personal working document that was never committed to this repository (moved to the ticket
owner's local notes outside any repo during cleanup). Left in place, these numbers would be
dangling references with no way for a future reader to resolve what they meant. All such
comments were rewritten to describe what the code does directly, with no external numbering
scheme to maintain.

---

## Known Gaps

- Repository/branch resolution here (`readGitRemoteLocal`/`readGitBranchLocal`, direct
  `.git/config`/`.git/HEAD` reads) is a **separate mechanism** from the backend's own
  branch-merge/display logic (`codemie` repo, `classification_engine.py`). Both independently
  arrived at `Cowork` as the fallback label for "no resolvable context" — kept consistent by
  convention, not by a shared constant across repos (there is none; each repo defines its own
  `'Cowork'` string).
- macOS only (`process.platform !== 'darwin'` short-circuits every `lsof`/`ps`-based
  resolution strategy to `null`). No fallback resolution path exists for other platforms —
  Desktop-mode proxy on Windows/Linux would only ever see the `lastDesktopRepo` cache or the
  static `Cowork` default.
