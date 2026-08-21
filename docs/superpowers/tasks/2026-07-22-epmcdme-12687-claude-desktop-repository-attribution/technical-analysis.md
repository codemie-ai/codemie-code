# Technical Research

**Task**: EPMCDME-12687 — Claude Desktop per-request repository/branch attribution
**Generated**: 2026-07-22
**Research path**: filesystem (this repo) + live Elasticsearch query (preview cluster) +
local debug logs (`~/.codemie/logs/`) + cross-repo context (`codemie`, `codemie-ui`)

---

## 1. Original Context

Claude Desktop is a single long-running application; a user can have it pointed at different
projects across a day — a Cowork chat with no folder, Cowork with a folder open, or the Code
tab (Claude Code running inside Desktop, potentially in a different project than whatever
Cowork last had open). All of this traffic flows through one local proxy daemon
(`codemie proxy connect desktop`, port 4001) for the lifetime of that daemon. Before this
change, `X-CodeMie-Repository` was set once from `config.repository` — resolved at daemon
startup from wherever `codemie proxy connect desktop` happened to be run — so every request,
regardless of which Desktop tab/project it actually came from, got the same repository
attribution.

The ticket owner's stated goal (confirmed directly): be able to switch between Cowork (no
folder) → Cowork with project A → Code tab (project B) → back to Cowork, and see each segment
attributed correctly and separately in CLI Insights analytics.

---

## 2. Codebase Findings

### Existing Implementations

- `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` — the sole per-request
  header-injection point for the local proxy. Runs at priority 20 (after auth). Owns the new
  three-strategy resolution chain.
- `src/providers/plugins/sso/proxy/sso.proxy.ts` — `CodeMieProxy`, builds the `ProxyContext`
  per incoming request; now also captures `req.socket?.remotePort`, the one piece of
  request-level state the process-lookup strategy needs (the client's ephemeral TCP port,
  used as the `lsof` search key since that port is bound locally by the connecting process,
  not the proxy).
- `src/telemetry/runtime/DesktopTelemetryRuntime.ts` — a **second, independent** discovery
  path: polls Desktop's session-file directories every `pollIntervalMs` (default 10s),
  parses transcripts, and syncs conversation/metrics history directly (not through the proxy's
  per-request header injection at all). Runs in parallel with the header-injection plugin for
  the entire life of the daemon.
- `src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts` — `discoverClaudeDesktopSessions()`,
  used by `DesktopTelemetryRuntime`'s poll loop; `walk()` (now exported) recursively lists
  session-file directories, reused by `header-injection.plugin.ts`'s session-file-scan
  strategy to avoid a second directory-walking implementation.
- `src/utils/paths.ts` — `extractRepository()`, the shared repository-name-from-path resolver
  used both by the proxy (for git-remote-derived paths) and, via the sandbox-path regex
  branch, for Desktop sessions with no resolvable project (`'Cowork'` fallback).

### Architecture and Layers Affected

- **Proxy request-interception layer** (`header-injection.plugin.ts`): the new
  per-`cliSessionId` resolution chain and its in-flight-promise dedup cache.
- **Telemetry polling layer** (`DesktopTelemetryRuntime.ts`): a parallel writer into the same
  `config.sessionRepositoryMap` the proxy layer reads/writes — the two layers were not
  originally coordinated (see Review Findings, Fix B).
- **Shared config surface** (`proxy-types.ts`, `telemetry/runtime/types.ts`): the
  `sessionRepositoryMap`/`sessionCoworkMap`/`lastDesktopRepo` fields are the only channel
  connecting these two otherwise-independent subsystems; both are constructed once in
  `proxy-daemon.ts` and passed by reference into each.

### Integration Points

- `proxy-daemon.ts` → constructs `sessionRepositoryMap`/`sessionCoworkMap`, assigns to
  `config`, passes `sessionRepositoryMap` into `DesktopTelemetryRuntimeConfig` — the one place
  that wires the two subsystems together.
- `header-injection.plugin.ts` → reads `context.remotePort` (from `sso.proxy.ts`) and
  `context.url` (for the `?beta=true` orchestrator check) — both request-level, not
  session-level, state.
- `DesktopTelemetryRuntime.ensureSession()` → `ConfigLoader.load(workingDirectory)` — a
  filesystem read of the *target* project's own `.codemie/codemie-cli.config.json`, distinct
  from the Desktop proxy's own config, to resolve `codeMieProject` for that session.

### Root-Cause Verification Against Live Data

Two questions raised during review were resolved by querying the preview Elasticsearch
cluster directly (`kubectl port-forward -n preview-elastic svc/elasticsearch-master 9200:9200`,
`codemie_metrics_logs` index) rather than by static code reading alone:

1. **Does "Code tab: client stays as CLI" (the original in-code comment) match reality?**
   Queried for `client_type: claude-desktop` documents with a non-empty `branch` (the
   signature of a Code tab session — only Code tab writes a real branch). Found 86 matching
   documents, e.g. `epm-cdme/codemie-ui | EPMCDME-12687 | claude-desktop | cli_request=true`.
   **Conclusion: false.** Code tab sessions are labeled `claude-desktop`, not `CLI`. The
   comment was stale/aspirational documentation that never matched the actual code path (which
   never overrides `X-CodeMie-Client` back to a CLI value for Code tab — it simply doesn't
   touch the header, leaving `config.clientType`'s Desktop-mode default in place). Fixed as
   part of this review (spec.md Fix C).

2. **Are rows like `codemie-ai/codemie-code | <branch> | CLI` (from the ticket owner's own
   Repositories-table screenshot) evidence of a Code tab mislabeling bug?** Queried the same
   repository's documents directly: `user_agent: "claude-cli/2.1.216 (external, cli)"`,
   `client_type: "codemie-claude"`, `cli_request: true` — a **real CLI session**, unrelated
   to the Desktop proxy entirely (3,410 total documents for that repository; only 11 are
   `claude-desktop`). **Conclusion:** those rows were not evidence of anything wrong in this
   code — they were simply a different developer running the CLI directly on that repo.

### Log Investigation (inconclusive — documented for future reference)

The ticket owner asked whether the concurrent-resolution and dual-write patterns found during
review (spec.md Fix A/B) originated from the multi-project-switching use case described above.
Investigated local debug logs (`~/.codemie/logs/debug-2026-07-{17..22}.log`) for
`header-injection` resolution entries — found only plugin-registration log lines, no actual
per-request resolution traces, because Desktop mode was not actively exercised in the last ~5
days these logs cover. The original development session (per `git log`, late June 2026 —
`fix(proxy): fix Cowork vs Code tab session attribution and branch fallback`, 2026-06-24) is
outside the local log retention window; those logs no longer exist. **Could not confirm from
logs**; resolved instead by reasoning about the code structure (each project switch gets a new
`cliSessionId`, so the per-session cache already supports the described use case — the review
findings are a narrower, session-*internal* timing concern, not a multi-project-switching bug).

### Patterns and Conventions

- **macOS-only system introspection**: every `lsof`/`ps`-based resolution strategy starts with
  `if (process.platform !== 'darwin') return null;` — a deliberate, silent no-op on other
  platforms rather than an error, consistent with this being a best-effort enrichment (falls
  through to the `lastDesktopRepo` cache or `Cowork` default, never blocks the request).
- **Read-don't-shell for cheap git info**: `readGitRemoteLocal`/`readGitBranchLocal` parse
  `.git/config`/`.git/HEAD` directly via `fs.readFile` rather than spawning `git` — avoids a
  process spawn on the hot per-request path (the `lsof`/`ps` calls are already the expensive
  part, gated behind `macOS` + only running once per new session thanks to the resolution
  cache).
- **In-flight promise caching for request-triggered async work**: the pattern added in this
  review (Fix A) — a module-level `Map<key, Promise<T>>`, populated on first call, awaited by
  concurrent callers, cleared in a `finally` block — is a standard Node.js idiom for
  deduplicating expensive async work triggered by concurrent requests; not previously used
  elsewhere in this plugin family, worth reusing if a similar race surfaces elsewhere.
- **"First writer wins" for shared caches with multiple independent producers**: once
  `DesktopTelemetryRuntime.ts`'s poll loop was found to write into the same
  `sessionRepositoryMap` the proxy layer owns, the simplest correct fix was making both writers
  respect the same guard (`!map.has(key)`) rather than introducing a priority/locking scheme
  between the two subsystems — appropriate here because the two resolutions are expected to
  usually agree, and staleness/inconsistency risk is low (both resolve from the same
  underlying session's working directory, just via different means).

---

## 3. Documentation Findings

### Guides and Architecture Docs

No `.ai-run/`/`.codemie/guides/` entry documents the Desktop proxy's per-request resolution
chain or the two-subsystem (proxy vs. telemetry-poll) coordination. This file + spec.md are the
first record.

### A Note on In-Code "Fix N" References

The pre-review implementation's comments referenced a numbering scheme ("Fix 3", "Fix 4",
"Fix 4B") from a personal working spec (`claude-desktop-project-attribution/spec.md`) that was
**never committed to this repository** — it existed only in the ticket owner's local notes
(moved to `~/Downloads/spec.md`, outside any repo, during an earlier cleanup pass this session).
Confirmed via `grep -rn "Fix [0-9]" src/` (post-fix: zero remaining matches) that this repo now
has no dangling references to that external numbering. This spec/plan file's own prose section
headers ("Fix A", "Fix B", "Fix C", "Fix D" under Review Findings) are **local to this document
only** — they are not referenced anywhere in code comments and exist purely to organize this
write-up; if that becomes confusing in the future, prefer descriptive prose in code and reserve
lettered/numbered fix labels for review documents like this one.

### Cross-Repo Findings

- `codemie` repo, `classification_engine.py`: the backend-side counterpart to this repo's
  `Cowork` fallback convention — both repos independently converged on `'Cowork'` as the label
  for "no resolvable repository context," but there is no shared constant between them (each
  defines its own string). Documented as a cross-repo convention, not a shared dependency.
- `codemie-ui` repo, `helpers.tsx` `CLIENT_CONFIG`: renders `client_type: claude-desktop` with
  a dedicated icon/label — directly consumes the client attribution this repo's header
  injection produces; no changes needed there for this task (already handled defensively for
  both `CLI`-family and `claude-desktop` values).

---

## 4. Testing Landscape

### Existing Coverage

- `src/utils/__tests__/paths.test.ts` — covers `extractRepository()`'s sandbox-path detection;
  updated in lockstep with the `Cowork` label rename (5 assertions).
- No unit coverage exists for `header-injection.plugin.ts`'s resolution chain, the in-flight
  dedup cache, or `DesktopTelemetryRuntime.ensureSession()`'s repository-map write. Verified
  manually against a real Desktop session (`CODEMIE_DEBUG=true` + `codemie proxy connect
  desktop`) and cross-checked against live Elasticsearch, consistent with how this plugin
  family has been verified historically — no existing harness mocks `lsof`/`ps` output or a
  live proxy session.

### Gaps

- No regression test locks in the in-flight-promise dedup (Fix A) — e.g. asserting that two
  concurrent `resolveDesktopSessionRepository()` calls for the same `cliSessionId` only trigger
  one `getPidForRemotePort` call. Would require mocking `child_process.exec`; out of scope for
  this pass given no existing mock infrastructure for these system calls in this plugin family.
- No regression test locks in the "first writer wins" guard (Fix B) between
  `header-injection.plugin.ts` and `DesktopTelemetryRuntime.ts` — would require constructing
  both subsystems against a shared `ProxyConfig` and asserting write order doesn't matter for
  the final map value.
