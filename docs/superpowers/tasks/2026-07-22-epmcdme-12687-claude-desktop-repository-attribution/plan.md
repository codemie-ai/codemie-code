# EPMCDME-12687: Claude Desktop Repository/Branch Attribution — Implementation Plan

**Goal:** Resolve `X-CodeMie-Repository`/`X-CodeMie-Branch`/`X-CodeMie-Client` per LLM request
in Desktop mode, instead of once per proxy daemon lifetime, so each Cowork/Code-tab session —
and each project switch within a Desktop session — attributes correctly in analytics.

**Architecture:** A three-strategy resolution chain (process CWD lookup → session file scan →
process tree descent) in `header-injection.plugin.ts`, results cached per `cliSessionId` in a
`Map` shared via `ProxyConfig`. A parallel, independent write path in
`DesktopTelemetryRuntime.ts`'s poll loop populates the same cache for sessions discovered
before any LLM request arrives.

**Tech Stack:** TypeScript, Node.js `child_process`/`fs` (macOS `lsof`/`ps` shell-outs),
Vitest.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts` | Modify | Per-request resolution chain, in-flight dedup, header injection |
| `src/providers/plugins/sso/proxy/proxy-types.ts` | Modify | Add `sessionRepositoryMap`, `sessionCoworkMap`, `lastDesktopRepo`, `remotePort` to shared config/context types |
| `src/providers/plugins/sso/proxy/sso.proxy.ts` | Modify | Populate `context.remotePort` from the incoming socket |
| `src/bin/proxy-daemon.ts` | Modify | Wire the shared maps into `ProxyConfig` and `DesktopTelemetryRuntime` at daemon startup |
| `src/telemetry/runtime/DesktopTelemetryRuntime.ts` | Modify | Poll-based session discovery also resolves/caches repository; final poll on stop |
| `src/telemetry/runtime/types.ts` | Modify | Add `sessionRepositoryMap` to `DesktopTelemetryRuntimeConfig` |
| `src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts` | Modify | `userSelectedFolders` fallback; export `walk()` |
| `src/utils/paths.ts` | Modify | `extractRepository()` sandbox fallback: `'Claude Desktop'` → `'Cowork'` |
| `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts` | Modify | Delta branch fallback to `session.gitBranch` |
| `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts` | Modify | Same fallback for the branch-matching filter |
| `src/utils/__tests__/paths.test.ts` | Modify | Update expected label to `Cowork` |

---

## Task 1: Per-request repository resolution chain

**Test-first: no.** No existing unit harness mocks `lsof`/`ps` process output or a live
Desktop proxy session for this plugin; verified via `CODEMIE_DEBUG=true` runs against a real
Claude Desktop instance connected through `codemie proxy connect desktop`, cross-checked
against Elasticsearch (`codemie_metrics_logs`) for the resulting `repository`/`branch`/
`client_type` attribution.

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts`
- Modify: `src/providers/plugins/sso/proxy/proxy-types.ts`
- Modify: `src/providers/plugins/sso/proxy/sso.proxy.ts`
- Modify: `src/bin/proxy-daemon.ts`

---

- [x] **Step 1: Add shared resolution state to `ProxyConfig`/`ProxyContext`**

```ts
// proxy-types.ts
sessionRepositoryMap?: Map<string, string>;
sessionCoworkMap?: Set<string>;
lastDesktopRepo?: { repo: string; branch: string | null; ts: number };
// ProxyContext:
remotePort?: number;
```

- [x] **Step 2: Populate `remotePort` from the incoming socket**

`sso.proxy.ts`: `remotePort: req.socket?.remotePort` when building `ProxyContext`.

- [x] **Step 3: Wire the maps at daemon startup**

`proxy-daemon.ts`, inside the `telemetryMode === 'claude-desktop'` branch:

```ts
const sessionRepositoryMap = new Map<string, string>();
config.sessionRepositoryMap = sessionRepositoryMap;
config.sessionCoworkMap = new Set<string>();
```

- [x] **Step 4: Implement the three resolution strategies**

In `header-injection.plugin.ts`, three helper functions, each `macOS`-gated
(`process.platform !== 'darwin'` short-circuits to `null`):

1. `getPidForRemotePort(remotePort)` — `lsof -n -P -i 4TCP@127.0.0.1:${remotePort}`, matches
   the outbound-direction line, excludes the proxy's own PID.
2. `findWorkingDirViaProcess(pid)` — `ps -p ${pid} -o args=`, extracts `--add-dir <path>` via
   lazy regex (stops at the next `--` flag, so paths with spaces work); falls back to
   `lsof -a -d cwd -p ${pid} -Fn` for the OS-level cwd, rejecting `$HOME`/`/Library/`/
   `.app/Contents` paths (default launcher locations, not real project dirs).
3. `findWorkingDirForSession(cliSessionId)` — walks both Desktop session-file roots
   (`getClaudeDesktopLocalSessionsRoot()`, `getClaudeDesktopCodeSessionsRoot()`), parses each
   JSON file, matches on `cliSessionId`, reads `originCwd`/`worktreePath`/
   `userSelectedFolders[0]`/`cwd` in that priority order.
4. `findWorkingDirForDesktopDirectRequest(connectingPid)` — for orchestrator requests
   (`context.url?.includes('beta=true')`): builds a `pid → {ppid, args}` map from
   `ps -axww -o pid,ppid,args`, walks up from the renderer PID to the `Claude.app` root, then
   BFS-descends looking for a subprocess with `--add-dir` or `--output-format stream-json`
   (resolving the latter's cwd via `lsof`, same rejection rules as step 2).

- [x] **Step 5: Compose the chain and inject headers**

```ts
if (cliSessionId && !config.sessionRepositoryMap.has(cliSessionId)) {
  const resolved = await resolveDesktopSessionRepository(cliSessionId, context);
  if (resolved) {
    config.sessionRepositoryMap.set(cliSessionId, resolved.repository);
    config.lastDesktopRepo = { repo: resolved.repository, branch: resolved.branch, ts: Date.now() };
    if (resolved.branch) context.headers['X-CodeMie-Branch'] = resolved.branch;
    if (!resolved.isCodeIntegration) {
      config.sessionCoworkMap?.add(cliSessionId);
      context.headers['X-CodeMie-Client'] = 'claude-desktop';
    }
  } else {
    const last = config.lastDesktopRepo;
    if (last && Date.now() - last.ts < 30_000) {
      config.sessionRepositoryMap.set(cliSessionId, last.repo);
      if (last.branch) context.headers['X-CodeMie-Branch'] = last.branch;
    }
  }
}
const resolvedRepository = cliSessionId
  ? (config.sessionRepositoryMap.get(cliSessionId) ?? config.repository ?? 'Cowork')
  : (config.repository ?? 'Cowork');
context.headers['X-CodeMie-Repository'] = resolvedRepository;
if (cliSessionId && config.sessionCoworkMap?.has(cliSessionId)) {
  context.headers['X-CodeMie-Client'] = 'claude-desktop';
}
```

- [x] **Step 6: Verify against a real Desktop session**

```bash
codemie proxy connect desktop
# Open Desktop, exercise Cowork (no folder), Cowork+folder, and Code tab scenarios
codemie proxy stop
```

Cross-check `cli-insights-user-repositories` for the test user/period against the three
scenarios documented in spec.md.

---

## Task 2: Supporting resolution fixes

**Test-first: partial** — `paths.test.ts` updated alongside the `paths.ts` label change
(existing test file, not new coverage).

**Files:**
- Modify: `src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts`
- Modify: `src/utils/paths.ts`
- Modify: `src/utils/__tests__/paths.test.ts`
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-aggregator.ts`
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-sync-processor.ts`
- Modify: `src/telemetry/runtime/DesktopTelemetryRuntime.ts`
- Modify: `src/telemetry/runtime/types.ts`

---

- [x] **Step 1: `userSelectedFolders` fallback + export `walk()`**

`claude-desktop.discovery.ts`: add `userSelectedFolders?: string[]` to `DesktopMetadata`,
insert before `cwd` in the working-directory priority chain; `export async function walk(...)`
so the header-injection session-file scan can reuse it.

- [x] **Step 2: Rename Desktop sandbox label to `Cowork`**

`paths.ts`: `extractRepository()` returns `'Cowork'` (was `'Claude Desktop'`) for the sandbox
path regex match. Update all 5 assertions in `paths.test.ts` to match.

- [x] **Step 3: Branch fallback in metric aggregation**

`metrics-aggregator.ts`: `const branch = delta.gitBranch || session.gitBranch || '';` (was
`delta.gitBranch || ''`) when grouping deltas — individual Desktop deltas never carry
`gitBranch`, only the session object does.

`metrics-sync-processor.ts`: same fallback in the branch-matching filter that pairs pending
deltas with their metric for sync.

- [x] **Step 4: Telemetry runtime resolves project + writes to the shared map**

`DesktopTelemetryRuntime.ts` `ensureSession()`: resolve `project` via
`ConfigLoader.load(discovered.workingDirectory)` alongside the existing `gitBranch`/
`repository` `Promise.all`; write into `config.sessionRepositoryMap` (guarded, see Task 3 Fix
B). `stop()`: run one final `poll()` before finalizing tracked sessions.

- [x] **Step 5: Lint + typecheck**

```bash
npx eslint src/telemetry/clients/claude-desktop/claude-desktop.discovery.ts src/utils/paths.ts src/providers/plugins/sso/session/processors/metrics/ src/telemetry/runtime/
npx tsc --noEmit
```

---

## Task 3: Review fixes

**Test-first: no.**

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts`
- Modify: `src/telemetry/runtime/DesktopTelemetryRuntime.ts`

---

- [x] **Step 1 (Fix A): In-flight promise dedup for concurrent resolution**

Extracted the resolution chain (Task 1 Step 4-5's lookup logic) into
`resolveDesktopSessionRepositoryUncached(cliSessionId, context)`, wrapped by
`resolveDesktopSessionRepository()` which checks/populates a module-level
`inFlightSessionResolutions: Map<string, Promise<DesktopSessionResolution | null>>` keyed by
`cliSessionId`, removing the entry in a `finally` block once settled.

- [x] **Step 2 (Fix B): Guard the telemetry-poll write against overwriting a per-request result**

```ts
// DesktopTelemetryRuntime.ts ensureSession()
if (!discovered.agentSessionId.startsWith('local_') && !this.config.sessionRepositoryMap?.has(discovered.agentSessionId)) {
  this.config.sessionRepositoryMap?.set(discovered.agentSessionId, repository || 'Cowork');
}
```

- [x] **Step 3 (Fix C): Correct the stale "client stays as CLI" comment**

Rewrote to describe verified actual behavior (client inherits `config.clientType` =
`claude-desktop` for Code tab; only explicitly reasserted for Cowork). See spec.md
"Client Attribution" for the live-data verification.

- [x] **Step 4 (Fix D): Remove numbered "Fix N" comment references**

All `// Fix 3`, `// Fix 4`, `// Fix 4B` comment prefixes rewritten to describe the code
directly, since the numbering scheme they referenced was never committed to this repo.

- [x] **Step 5: Typecheck + lint**

```bash
npx tsc --noEmit
npx eslint src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts src/telemetry/runtime/DesktopTelemetryRuntime.ts --max-warnings=0 --no-warn-ignored
```

Both clean.
