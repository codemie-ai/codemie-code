# Technical Research

**Task**: windows daemon process-spawn signal-handling mcp-auth-proxy
**Generated**: 2026-07-05
**Research path**: filesystem (codegraph MCP tool not available in this environment; fell back to read-only Explore agents)

---

## 1. Original Context

Fix the `codemie mcp-auth-proxy` feature so it works correctly on a Windows host. The feature is a local loopback-only HTTP proxy daemon (CLI command `codemie mcp-auth-proxy start|stop|status`) plus a core module. It was just implemented on branch feat/mcp-auth-proxy. The concern: the daemon is spawned detached and stopped via POSIX signals, and Windows lacks POSIX signal semantics. Specifically investigate: (1) how the daemon is spawned — `spawnDetached()` in src/utils/processes.ts and its use in src/cli/commands/mcp-auth-proxy.ts; whether it passes `windowsHide`; (2) how the daemon is stopped — `process.kill(pid, 'SIGTERM')` then poll then `SIGKILL` in src/cli/commands/mcp-auth-proxy.ts, and the daemon-side `process.on('SIGTERM'|'SIGINT')` handlers in src/mcp/auth-proxy/runtime.ts; whether graceful shutdown actually runs on Windows; (3) pid-liveness check `process.kill(pid, 0)` in src/mcp/auth-proxy/state.ts on Windows; (4) any path/port/bind assumptions in src/mcp/auth-proxy/server.ts, config.ts, state.ts that could differ on Windows; (5) how OTHER existing daemons in this repo handle Windows — compare src/cli/commands/proxy/daemon-manager.ts (SSO proxy) and src/cli/commands/codebase/daemon-manager.ts, and note whether they set windowsHide or handle SIGTERM cross-platform, so the fix matches existing repo precedent rather than inventing a new pattern. Also check src/utils/exec.ts and BaseAgentAdapter for the established `os.platform()==='win32'` + `windowsHide` idiom.

> Caller focus: exact Windows failure modes (graceful shutdown not running because Windows terminates immediately on `process.kill` with a signal name; possible console-window flash from missing `windowsHide`), the established repo idiom for platform-conditional behavior, and the minimal surgical set of files/functions to change — grounded in quoted `file:line` references.

---

## 2. Codebase Findings

### Existing Implementations

Confirmed real file paths for the feature:

- `src/cli/commands/mcp-auth-proxy.ts` — CLI command (`start`/`stop`/`status`); spawns the daemon and drives the SIGTERM→SIGKILL stop sequence.
- `src/bin/mcp-auth-proxy-daemon.ts` → built `bin/mcp-auth-proxy-daemon.js` — the detached daemon entry point actually spawned. Doc header: "Loads the config, starts McpAuthProxy, writes the state file, handles SIGTERM." (`src/bin/mcp-auth-proxy-daemon.ts:5`).
- `src/mcp/auth-proxy/runtime.ts` — installs the `SIGTERM`/`SIGINT` graceful-shutdown handlers.
- `src/mcp/auth-proxy/state.ts` — state file read/write/clear + `isProcessAlive` liveness.
- `src/mcp/auth-proxy/server.ts` — `McpAuthProxy` HTTP server, bind host, `proxy.stop()`.
- `src/mcp/auth-proxy/config.ts` — port and path defaults.
- `src/utils/processes.ts` — the shared `spawnDetached()` helper.

### Architecture and Layers Affected

Four layers of the plugin-based architecture are in scope; the fix surface is small and concentrated:

- **Utility layer** — `src/utils/processes.ts` `spawnDetached()` (the single shared daemon-spawn primitive; also used by the SSO and codebase daemons).
- **CLI layer** — `src/cli/commands/mcp-auth-proxy.ts` (`start` spawn, `stop` kill sequence, `status`).
- **MCP auth-proxy core module** — `src/mcp/auth-proxy/runtime.ts` (signal handlers), `state.ts` (liveness), `server.ts` (bind), `config.ts` (ports/paths).
- **Bin entry** — `src/bin/mcp-auth-proxy-daemon.ts` (detached process root).

### Integration Points

- The daemon is spawned via `process.execPath` (node binary directly, so no `.cmd`/shell resolution is needed on Windows) launching the built bin:
  - `src/cli/commands/mcp-auth-proxy.ts:129` — `const daemonBin = join(getDirname(import.meta.url), '../../../bin/mcp-auth-proxy-daemon.js');`
  - `src/cli/commands/mcp-auth-proxy.ts:130-135` — `spawnDetached(process.execPath, [ daemonBin, '--config', configPath, '--port', String(port), '--state-file', getDefaultStatePath() ]);` — **no options object passed**.
- CLI ↔ daemon handshake is via the **state file** (poll on start, `isProcessAlive` for status, force-clear after kill). CLI ↔ daemon health check is over TCP loopback: `src/cli/commands/mcp-auth-proxy.ts:71` — `{ host: '127.0.0.1', port, path: '/healthz', timeout: 2000 }`.
- There is **no** control channel from CLI to a running daemon other than OS signals — this is the crux of the Windows problem (see §6).

### Patterns and Conventions

The established repo idiom for platform-conditional spawning is `windowsHide: isWindows` where `isWindows = os.platform() === 'win32'` — but it is applied only to **foreground/attached** spawns, never to `spawnDetached`:

- `src/utils/exec.ts:42` — `const isWindows = os.platform() === 'win32';`
- `src/utils/exec.ts:77` — `windowsHide: isWindows, // Hide console window on Windows`
- `src/agents/core/BaseAgentAdapter.ts:678` — `const isWindows = process.platform === 'win32';`
- `src/agents/core/BaseAgentAdapter.ts:742` — `windowsHide: isWindows // Hide console window on Windows`
- `src/cli/commands/skills/lib/run-skills-cli.ts:117` — `windowsHide: os.platform() === 'win32',`

The shared detached-spawn helper does **not** set `windowsHide` and its options type does not even accept it:

- `src/utils/processes.ts:104-108` — `export interface DetachedSpawnOptions { cwd?: string; env?: NodeJS.ProcessEnv; stdio?: 'ignore' | 'inherit'; }`
- `src/utils/processes.ts:115-121` — `const child = spawn(command, args, { cwd: options.cwd, env: options.env, detached: true, stdio: options.stdio ?? 'ignore' }); child.unref();`

Termination convention across the repo is **100% signal-based and platform-agnostic** — `process.kill(pid, 'SIGTERM')` then escalate to `'SIGKILL'`. Grep for `taskkill` across `src/` returned **zero** hits, and **no** code path anywhere branches on `win32`/`os.platform()` when killing a process. Liveness is uniformly `process.kill(pid, 0)` in try/catch.

Precedent daemons the new feature was modeled on (both share the same Windows gaps):

- SSO proxy — `src/cli/commands/proxy/daemon-manager.ts:132` `spawnDetached(process.execPath, args);` (no options → no `windowsHide`); stop at `:158` `process.kill(state.pid, 'SIGTERM');` → `:173` `process.kill(state.pid, 'SIGKILL');`; liveness `:59-66` `process.kill(pid, 0)`.
- Codebase UI — `src/cli/commands/codebase/daemon-manager.ts:103-113` `spawnDetached(process.execPath, [...], { stdio: 'ignore' })` (no `windowsHide`); stop at `:156` `process.kill(state.pid, 'SIGTERM');` (no SIGKILL escalation); liveness `:50-57` `process.kill(pid, 0)`.

**Conclusion on precedent:** the new `mcp-auth-proxy` code already matches the SSO daemon almost verbatim. The Windows defects are therefore **shared by all three daemons**, not unique to this feature. There is no in-repo "correct Windows daemon" to copy — the `windowsHide` idiom exists only for attached spawns, and no cross-platform kill mechanism exists at all.

---

## 3. Documentation Findings

### Guides and Architecture Docs

`.ai-run/guides/` is present. Relevant guides read:

- `.ai-run/guides/development/development-practices.md:131` — "✅ Use `exec()` from `src/utils/exec.ts` for all process spawning"; `:135` "❌ Use `child_process.exec()` directly"; `:377` names `src/utils/processes.ts` and `src/utils/exec.ts` as the process modules. **No `windowsHide` / detached-spawn / graceful-shutdown / signal convention is documented anywhere in the guides.**
- `.ai-run/guides/testing/testing-patterns.md:46,59,70,196` — codifies the `vi.mock()` at module level + `vi.spyOn()` in `beforeEach` / `vi.restoreAllMocks()` in `afterEach` + dynamic-import-after-spy convention the daemon tests already use.
- Cross-platform is mentioned only incidentally elsewhere (`security-practices.md:25` keychain per-OS, `external-integrations.md:168` Windows storage path, `git-workflow.md:22` example branch name) — **none** prescribe `windowsHide`, detached spawn, or shutdown behavior.

### Architectural Decisions

- Design doc: `docs/superpowers/specs/2026-07-03-mcp-auth-proxy-design.md`.
  - `:135` Non-goals explicitly list **"Windows service"** as out of scope. Ordinary Windows CLI/daemon support is neither promised nor addressed.
  - `:43` runtime responsibility: "install SIGTERM/SIGINT cleanup (stop server, unlink state)" — POSIX-signal framing, no Windows note.
  - `:46` CLI `stop`: "SIGTERM + poll, SIGKILL escalation, clear state" — assumes POSIX semantics.
  - `:44` bin entry "Mirrors `src/bin/proxy-daemon.ts` minus watcher" — confirms the SSO-daemon lineage.
  - The doc references `docs/SPEC-mcp-auth-proxy.md` as the "authoritative functional spec" (`:7`) but **that file does not exist in the repo**.
  - The spec is **silent on Windows signal/spawn compatibility**. (It does record a macOS loopback nuance — `localhost`→IPv6 `::1` — but no Windows analysis.)
- The Windows follow-up work item `docs/superpowers/tasks/2026-07-05-mcp-auth-proxy-windows/` currently contains **only** `.state.json` (flow `sdlc-light`, branch `feat/mcp-auth-proxy`, phase `main`) — no requirements/spec/plan yet.

### Derived Conventions

Because guides are silent on daemon platform handling, the operative conventions are derived from code (§2 Patterns): (a) attach the `windowsHide: os.platform()==='win32'` flag when a spawn could open a console window; (b) never introduce `taskkill` or a `win32` kill branch — the repo standardizes on `process.kill` signals; (c) use `path.join` / `getCodemiePath` and literal `127.0.0.1` for portability.

---

## 4. Testing Landscape

### Existing Coverage

- `src/mcp/auth-proxy/__tests__/state.test.ts` — state round-trip/atomicity (`:35`), malformed/missing parse → null (`:41`), `clear` tolerates absence (`:49`), `isProcessAlive` true-for-self / false-for-dead-pid (`:56`). No signal/spawn/Windows coverage.
- `src/mcp/auth-proxy/__tests__/server.test.ts` — SSE pass-through (`:170`), degraded `/healthz` isolation (`:286`) against a local fake `node:http` upstream. No process/signal logic.
- `src/mcp/auth-proxy/__tests__/{rewrites,config,metadata-cache}.test.ts` — pure rewrite/config/discovery logic; unrelated to platform/process.
- Comparison daemons: `src/cli/commands/proxy/__tests__/daemon-manager.test.ts` (state + `isProcessAlive` + stale-pid cleanup `:84,:109`; spawn/kill never run) and `src/cli/commands/codebase/__tests__/daemon-manager.test.ts` (mocks `spawnDetached` `:22`, asserts call args `:93`; real spawn/kill never run).

### Testing Framework and Patterns

- Vitest `^4.1.5` (`@vitest/ui ^4.1.5`). Scripts: `test`, `test:unit` (`vitest run src`), `test:integration` (`vitest run tests/integration`), `test:coverage`, `test:run`. Config `vitest.config.ts`. Pre-commit runs `vitest related --run`.
- Mock idiom for daemon spawning: `vi.mock('../../../../utils/processes.js', () => ({ spawnDetached: vi.fn(() => process.pid) }))` (`codebase/__tests__/daemon-manager.test.ts:22`) asserted with `toHaveBeenCalledWith(process.execPath, [...], { stdio: 'ignore' })` (`:93`).
- Path redirection: `vi.mock('.../utils/paths.js', … getCodemieHome: () => tmpdir(), getDirname: () => tmpdir())` (`proxy/__tests__/daemon-manager.test.ts:13`).
- Liveness in tests uses real `process.pid` (alive) vs a large fake pid `2**30` (dead) — `state.test.ts:57`. **No test ever mocks `process.kill` for signal delivery.**

### Coverage Gaps

- `src/utils/processes.ts` `spawnDetached` (110-123) — no direct test; only ever mocked away. The `windowsHide` fix lands here with no existing test to catch regressions.
- `src/mcp/auth-proxy/runtime.ts:56-60` — the `SIGTERM`/`SIGINT` graceful-stop+unlink handlers have **no** `runtime.test.ts`.
- `src/cli/commands/mcp-auth-proxy.ts` — the entire command (`start` spawn `:130`, `stop` `:199-213`, `status` `:161`) has **no** test file.
- `src/bin/mcp-auth-proxy-daemon.ts` — untested.
- No start→stop happy-path (spawn → state poll `:137` → SIGTERM shutdown → state cleanup) exercised on any platform.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — root for config/state paths (`src/utils/paths.ts:356-362`, `getCodemieHome()` → `CODEMIE_HOME` or `path.join(homedir(), '.codemie')`). The only env var in the feature's runtime path.
- `CODEMIE_DEBUG` — referenced in CLI help text only (`src/cli/commands/mcp-auth-proxy.ts:100,150`).

### Configuration Files

- `src/mcp/auth-proxy/config.ts:12` — `export const DEFAULT_AUTH_PROXY_PORT = 42800;`
- `src/mcp/auth-proxy/config.ts:13-14` — filenames `mcp-auth-proxy.json` / `mcp-auth-proxy.state.json`.
- `src/mcp/auth-proxy/config.ts:21-27` — paths via `getCodemiePath(...)` → `src/utils/paths.ts:374-376` `path.join(getCodemieHome(), ...paths)`. All `path.join`; **no hardcoded separators** → Windows-safe.
- State file uses atomic `${stateFile}.tmp` + `rename` (`src/mcp/auth-proxy/state.ts:30-32`) — rename-over-existing works on Windows.

### Feature Flags and Deployment Concerns

- Bind is deliberate literal IPv4 loopback (Windows-safe; avoids `localhost`→`::1`): `src/mcp/auth-proxy/server.ts:33` `export const BIND_HOST = '127.0.0.1';`; listen at `:148` `server.listen(this.port, BIND_HOST, () => resolve());`; port-in-use surfaced as `EADDRINUSE` ConfigurationError (`:141-144`). No unix-domain-socket / named-pipe usage — TCP loopback only, portable. **No path/port/bind Windows defect found in server/config/state** beyond the signal/spawn concerns.

---

## 6. Risk Indicators

Windows failure modes (grounded, with `file:line`):

- **[HIGH] Graceful shutdown never runs on Windows.** `src/cli/commands/mcp-auth-proxy.ts:199` `process.kill(state.pid, 'SIGTERM');` — on Windows, POSIX signals do not exist; Node ignores the signal name and terminates the target **forcefully and abruptly (SIGKILL-equivalent)**. Consequently the daemon's `src/mcp/auth-proxy/runtime.ts:59-60` `process.on('SIGTERM', onSignal); process.on('SIGINT', onSignal);` handlers never fire, so `proxy.stop()` (server.close + SSE `socket.destroy()`, `runtime.ts:46` → `server.ts:162-176`) and the daemon-side `clearAuthProxyState(stateFile)` (`runtime.ts:51`) are skipped. Net effect: in-flight SSE connections are dropped hard rather than drained. State stays consistent only because the CLI force-removes the state file afterwards (`mcp-auth-proxy.ts:214` `await clearAuthProxyState();`).
- **[MEDIUM] Console-window flash / stray `conhost.exe` from missing `windowsHide`.** `src/utils/processes.ts:115-120` calls `spawn(..., { detached: true, stdio: 'ignore' })` with **no `windowsHide`**, and the options type (`processes.ts:104-108`) does not even accept it. The feature's spawn (`mcp-auth-proxy.ts:130`) passes no options. A detached Node process on Windows opens a visible console window. This diverges from the repo idiom at `exec.ts:77` / `BaseAgentAdapter.ts:742`. **Fixing this in the shared helper also fixes the SSO and codebase daemons** (same omission at `proxy/daemon-manager.ts:132`, `codebase/daemon-manager.ts:103`).
- **[LOW] SIGTERM→poll→SIGKILL escalation is dead code on Windows.** `mcp-auth-proxy.ts:206-213` assumes SIGTERM may be ignored, then escalates. On Windows step 1 already force-kills, so the 5s poll + `SIGKILL` (`:209`) is moot. Harmless, but the graceful-then-force contract does not hold.
- **[LOW] Liveness false-negatives via `EPERM`.** `src/mcp/auth-proxy/state.ts:47` `process.kill(pid, 0);` inside try/catch (`:49-50` returns `false` on any throw). On Windows, signal 0 can raise `EPERM` for a process the caller cannot open, which this code reports as "not alive" — a potential false "not running" and PID-reuse ambiguity. Shared with both other daemons (`proxy/daemon-manager.ts:59`, `codebase/daemon-manager.ts:50`).
- **[Coverage] Zero test coverage on the exact surface being changed** — `spawnDetached`, the CLI `start/stop/status`, the `runtime.ts` signal handlers, and the bin entry all have no tests (§4). A Windows fix has no safety net; regressions on POSIX would go unnoticed.
- **[Novelty] No in-repo precedent for cross-platform daemon shutdown.** `taskkill` appears nowhere; no `win32` kill branch exists. Adding a Windows-graceful shutdown mechanism (e.g. a loopback `/shutdown` control endpoint the CLI POSTs to) would be a **new pattern** with no existing example to match — an architectural decision, not a mechanical fix.
- **[Requirements] Spec silent + explicitly de-scoped Windows.** Design doc lists "Windows service" as a non-goal (`design.md:135`) and never addresses Windows signal/spawn; the follow-up task dir has only `.state.json`. The intended fidelity of "works correctly on Windows" (hard-kill-with-state-cleanup vs. true graceful drain) needs a decision before implementation.

Windows-safe parts (explicitly not at risk): `BIND_HOST = '127.0.0.1'` (`server.ts:33`), all path construction via `path.join`/`getCodemiePath`, atomic `tmp`+`rename` state writes, TCP-loopback-only (no unix sockets/named pipes).

---

## 7. Summary for Complexity Assessment

This is a **low-to-medium** complexity, tightly bounded fix touching three layers: the Utility layer (`src/utils/processes.ts`), the CLI layer (`src/cli/commands/mcp-auth-proxy.ts`), and the MCP auth-proxy core module (`runtime.ts`, plus read-only confirmation that `server.ts`/`state.ts`/`config.ts` are already portable). The mechanical part of the fix is genuinely small: the missing-`windowsHide` defect is a **one-line change in `spawnDetached` at `src/utils/processes.ts:115-120`** (add `windowsHide: os.platform() === 'win32'`; `os` is already imported and used elsewhere in that file), which simultaneously repairs the console-window flash for the SSO and codebase daemons — a strict improvement that matches the existing `exec.ts:77` idiom with zero new pattern. Estimated file change surface for the console-window issue alone: 1 file.

The **graceful-shutdown-on-Windows** concern is where complexity and risk concentrate. `process.kill(pid, 'SIGTERM')` hard-kills on Windows, so the daemon's cleanup handlers never run. The repo offers **no precedent** to copy — termination is signal-based everywhere and there is no `taskkill` or `win32` branch anywhere in `src/`. Two paths exist: (a) the minimal, precedent-aligned option — accept immediate hard-kill on Windows and rely on the CLI's existing post-kill `clearAuthProxyState()` (state stays consistent; SSE sockets drop abruptly), touching ~1–2 files and matching how the SSO/codebase daemons already behave; or (b) a novel loopback control channel (e.g. a `/shutdown` endpoint the CLI POSTs so the daemon runs its own `proxy.stop()`), which is a new architectural pattern spanning CLI + runtime + server (~3 files) and warrants a design decision. The assessor should treat option (b) as the driver if "works correctly on Windows" is interpreted as true graceful drain.

Test posture is a compounding risk factor: the entire changed surface (`spawnDetached`, the CLI command, the `runtime.ts` signal handlers, the bin entry) is **untested** — existing tests only mock `spawnDetached` away and never exercise `process.kill` signal delivery. Any fix therefore ships without regression coverage on either platform unless new tests are added, and Vitest cannot realistically assert real Windows signal semantics on a Linux CI runner (platform behavior would have to be simulated by mocking `os.platform`/`process.kill`). Net: score the console-window fix as trivial-surgical; score the graceful-shutdown fix as medium with a genuine novelty/decision flag and a testability gap.
