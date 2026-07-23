# Technical Research

**Task**: sso auth browser windows open explorer spawn
**Generated**: 2026-07-23T00:00:00Z
**Research path**: filesystem

---

## 1. Original Context

CodeMie CLI setup SSO authentication fails on Windows corporate machines when browser opening is delegated to PowerShell through open npm v10+, because WDAC/AppLocker can block the Microsoft.PowerShell.Management module and make Start-Process unavailable. During codemie setup, selecting CodeMie SSO starts a browser-based authentication flow. On Windows, open npm v10+ opens the browser through: powershell.exe -EncodedCommand 'Start <url>'. On corporate Windows machines with WDAC/AppLocker endpoint protection policies, the Microsoft.PowerShell.Management module can be blocked, so Start-Process is unavailable. The browser does not open, the CLI does not print the SSO URL, and the user cannot complete authentication manually. The CLI waits for 120 seconds and then fails with 'Authentication timeout - no response received'. Proposed fix in src/providers/plugins/sso/sso.auth.ts: 1. Always print the SSO URL as a fallback for manual browser navigation. 2. On Windows, use spawn('explorer.exe', [ssoUrl]) instead of open() to launch the browser natively without PowerShell. 3. On macOS and Linux, keep the existing open() behavior unchanged.

---

## 2. Codebase Findings

### Existing Implementations

- `src/providers/plugins/sso/sso.auth.ts` — primary change target; `CodeMieSSO` class; `authenticate()` method calls `open(ssoUrl)` at line 110 with no URL print, no Windows guard, and no fallback; also contains the 120-second timeout default at line 114 (`config.timeout || 120000`)
- `src/providers/plugins/sso/sso.setup-steps.ts` — `SSOSetupSteps` class; calls `authenticateWithCodeMie(codeMieUrl, 120000)` at lines 50 and 277; the 120-second timeout is hardcoded in both call sites (no env var override exists)
- `src/providers/core/codemie-auth-helpers.ts` — `authenticateWithCodeMie()` helper; dynamically imports and calls `CodeMieSSO.authenticate()`; this is the only caller
- `src/cli/commands/setup.ts` — CLI `setup` command entry point; delegates to `ProviderRegistry` → `SSOSetupSteps.getCredentials()`; no changes needed here
- `src/utils/browser.ts` — thin wrapper around the `open` npm package (`open(url, { wait: false })`); exposes `openUrlInBrowser(url)`; NOT used by `sso.auth.ts` — SSO imports `open` directly; this is a pre-existing inconsistency
- `src/utils/exec.ts` — foundational `exec()` using `child_process.spawn`; includes platform detection (`os.platform() === 'win32'`) and suppresses shell on Windows; the guide-mandated entry point for process spawning
- `src/utils/processes.ts` — `spawnDetached()` and `commandExists()`; uses `os.platform() === 'win32'`; `spawnDetached` is the correct utility for fire-and-forget subprocesses; `commandExists` uses a full path to `where.exe` (`C:\\Windows\\System32\\where.exe`) to avoid shell dependency — this is the model for the `explorer.exe` approach
- `src/agents/core/BaseAgentAdapter.ts` — canonical reference for `process.platform === 'win32'` conditional spawn; uses `spawn(cmd, args, { shell: isWindows })`
- `src/mcp/auth/mcp-oauth-provider.ts` — the only other auth-path browser-opener in the codebase; uses `powershell -NoProfile -Command "Start-Process '...'"` specifically to preserve URL query-string characters that `cmd /c start` breaks; lines 162-168 contain the only inline architectural decision for Windows browser-opening; already has a URL-print fallback on `execFile` error (the pattern to replicate in SSO)
- `src/providers/plugins/sso/index.ts` — barrel export for the SSO plugin; no changes needed

### Architecture and Layers Affected

- **SSO Plugin layer** (`src/providers/plugins/sso/`) — primary change; `sso.auth.ts` is the only file that needs modification; `sso.setup-steps.ts` has no code changes but is the direct caller
- **Utilities layer** (`src/utils/`) — no code changes needed; `processes.ts` provides `spawnDetached()` as a potential utility, and `browser.ts` could optionally be updated to absorb the OS-conditional logic (refactor scope decision for implementer)
- **CLI layer** (`src/cli/commands/setup.ts`) — not touched
- **Provider Registry layer** (`src/providers/`) — not touched

The change surface is isolated to `src/providers/plugins/sso/sso.auth.ts`, specifically the `authenticate()` method, affecting approximately 5 lines of logic.

### Integration Points

**Internal:**
- `sso.setup-steps.ts` → `authenticateWithCodeMie()` → `CodeMieSSO.authenticate()` — call chain that terminates at the broken `open()` call; no changes required to callers
- `src/utils/processes.ts` (`spawnDetached`) — available as a utility; `explorer.exe` could use it, but a direct `spawn(...).unref()` is also acceptable per the `BaseAgentAdapter` pattern
- `src/utils/browser.ts` (`openUrlInBrowser`) — currently bypassed by SSO; implementer may choose to route through it and add OS branching there instead of directly in `sso.auth.ts`

**External:**
- `open@^10.2.0` (npm, production dep) — currently the only browser opener; on Windows v10+ delegates to `powershell.exe -EncodedCommand 'Start <url>'`; blocked by WDAC/AppLocker in corporate environments; to be replaced by `spawn('explorer.exe', [ssoUrl])` on Windows only
- `child_process` (Node built-in) — already used in `exec.ts`, `processes.ts`, `BaseAgentAdapter.ts`; `spawn` from it is the proposed replacement

### Patterns and Conventions

- **Platform detection**: two forms coexist — `process.platform === 'win32'` (preferred in `src/agents/` and `src/mcp/`) and `os.platform() === 'win32'` (preferred in `src/utils/`); either is acceptable in `sso.auth.ts`; `process.platform` requires no import
- **Windows spawn without shell**: `commandExists()` in `processes.ts` uses the full path `C:\\Windows\\System32\\where.exe` to avoid shell dependency — the same logic applies to `explorer.exe` (which lives at `C:\\Windows\\explorer.exe` but is also on PATH; using the bare name `explorer.exe` is acceptable since `spawn` without `{ shell: true }` does PATH lookup without invoking `cmd.exe`)
- **Fire-and-forget subprocess**: `spawn(...).unref()` or `spawnDetached()` from `processes.ts`; SSO should not await the browser process
- **URL print as fallback**: `mcp-oauth-provider.ts` already does this — prints the auth URL to `console.error` when `execFile` fails; `sso.auth.ts` should do the equivalent with `console.log` before attempting to open the browser (consistent with existing `console.log` usage at lines 85, 86, 91, 92, 109 of that file)
- **`child_process` usage**: the dev guide mandates `exec()` from `src/utils/processes.ts` over `child_process.exec()` directly; `spawn` from `child_process` is not prohibited and is used directly in `BaseAgentAdapter.ts`; using it in `sso.auth.ts` with a justifying comment is acceptable
- **No shell on Windows spawn**: `spawn('explorer.exe', [ssoUrl], { detach: true, stdio: 'ignore' })` — `shell: false` is the default and is correct here; avoids the PowerShell/cmd chain entirely
- **Inline comment required**: the divergence from `mcp-oauth-provider.ts`'s deliberate PowerShell choice must be explained with a comment referencing WDAC/AppLocker blocking

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — mandates the `CLI → Registry → Plugin → Core → Utils` layer flow; SSO browser-open logic lives in the Plugin layer; fix stays within that layer
- `.ai-run/guides/development/development-practices.md` — mandates use of `exec()` from `src/utils/processes.ts` instead of `child_process.exec()` directly; does not prohibit `child_process.spawn` when justified
- `.ai-run/guides/integration/external-integrations.md` — documents the `ai-run-sso` provider plugin, credential storage via `CredentialStore`; lists "SSO auth fails → Expired token → codemie setup" as the only recorded SSO failure mode; the Windows WDAC browser-open failure is not documented
- `.ai-run/guides/security/security-practices.md` — governs credential storage (keytar + AES-256-GCM fallback); no rules about process-spawn security
- `docs/AUTHENTICATION.md` — contains a troubleshooting table for MCP OAuth that mentions "Browser doesn't open → copy the URL from logs and open manually"; this applies to MCP OAuth, not SSO setup, but establishes the URL-print-as-fallback as an accepted project pattern

### Architectural Decisions

- `src/mcp/auth/mcp-oauth-provider.ts:162-168` — the only recorded Windows browser-open decision in the codebase: deliberately chose `powershell -NoProfile -Command "Start-Process '...'"` over `cmd /c start ""` because CMD splits on `&` and truncates URLs with query-string parameters. The proposed `explorer.exe` spawn diverges from this decision and must be justified in an inline comment (reason: WDAC/AppLocker blocks `Microsoft.PowerShell.Management`, making `Start-Process` unavailable in corporate environments).
- `src/utils/browser.ts` module comment — states "The `open` package handles macOS, Windows, and Linux platform differences." This assumption is invalidated for Windows WDAC environments; the comment should be updated or the module extended.

### Derived Conventions

- Auth-flow user-facing messages use `console.log` (not `logger.debug`); the URL print should use `console.log` consistent with lines 85, 86, 91, 92, 109 of `sso.auth.ts`
- Commit message scope: `fix(auth): ...` per the CONTRIBUTING.md scope table
- Browser-open error fallback: print the URL before attempting to open it (not after catching an error), because `open()` on WDAC-constrained machines may not throw — it silently fails as PowerShell exits without opening a browser

---

## 4. Testing Landscape

### Existing Coverage

- `src/providers/plugins/sso/__tests__/sso.auth.test.ts` — tests only the `deriveExpiresAt` utility (JWT expiry extraction); the entire `authenticate()` method, including the `open()` call, the callback server, and the timeout, is completely untested
- `src/utils/__tests__/browser.test.ts` — tests `openUrlInBrowser()` by mocking `open` with `vi.mock('open', () => ({ default: vi.fn() }))`; covers only the happy-path cross-platform case; no OS-specific branch tests
- `tests/integration/sso-per-url-credentials.test.ts` — tests SSO per-URL credential storage/retrieval; mocks the HTTP client; imports `CodeMieSSO` but exercises only credential state, not the browser-open path
- `tests/integration/sso-claude-plugin.test.ts` — tests plugin auto-installation; unrelated to browser opening

### Testing Framework and Patterns

- **Framework**: Vitest (`vitest.config.ts`); three named projects: `unit` (`src/**/*.test.ts`), `cli` (`tests/integration/**/*.test.ts` excluding agent), `agent`; coverage via `v8` provider
- **Module mock**: `vi.mock('open', () => ({ default: vi.fn() }))` — established in `browser.test.ts`; the new test for `sso.auth.ts` will need the same pattern
- **`child_process` spawn mock**: `vi.mock('child_process', async (importOriginal) => { ...actual, spawn: vi.fn(() => mockChildProcess) })` — established in `BaseAgentAdapter.test.ts`; mockChildProcess is a hand-rolled stub with `kill`, `on`, and `unref`; directly reusable pattern for the `explorer.exe` spawn test
- **Platform override**: `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })` with `afterEach` restore — canonical pattern from `windows-path.test.ts` and `desktop.test.ts`; use this for Windows-branch tests in `sso.auth.test.ts`
- **`os.platform()` spy**: `vi.mock('os', ...) + vi.mocked(os.platform).mockReturnValue('win32')` — alternative pattern from `cli-bin.test.ts`; prefer `process.platform` override if implementation uses `process.platform`
- **`vi.resetModules()` + dynamic import in `beforeEach`**: used in `browser.test.ts` to re-import module after mock setup; needed when the module under test has module-level side effects

### Coverage Gaps

- `CodeMieSSO.authenticate()` method — entirely untested; the browser-opening, callback-server-start, and timeout flows have zero coverage
- **Windows branch** — no test for `process.platform === 'win32'` inside `authenticate()`; must be added as part of this fix
- **URL fallback print** — no test verifies the SSO URL is printed to console before browser-open attempt
- **`spawn('explorer.exe', [ssoUrl])`** — no precedent for spawning `explorer.exe`; the `child_process` mock pattern from `BaseAgentAdapter.test.ts` is the direct template
- **macOS/Linux `open()` preservation** — no test verifies the non-Windows path continues to call `open()` after the conditional is added; regression test needed
- **Silent failure path** — no test simulates `open()` silently not opening a browser (as happens under WDAC); this may be out of scope for unit tests but worth a comment in the test file

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_DEBUG` — enables verbose/debug logging; does not affect the browser-open path
- `CODEMIE_BASE_URL` — overrides CodeMie backend URL; used in setup skip logic
- `CODEMIE_API_KEY` — API key override; used in setup skip logic
- `CODEMIE_NO_PROMPTS=1` — suppresses interactive prompts; relevant if the URL print is gated behind a prompt
- `CODEMIE_SESSION_SYNC_ENABLED` — toggles SSO session-sync plugin; unrelated to browser open
- `HTTPS_PROXY` / `HTTP_PROXY` — forwarded by SSO HTTP client; relevant for corporate networks with proxy

### Configuration Files

- `config.example.json` — top-level runtime config; includes `timeout` (default 300s for agent calls, not SSO auth); the SSO auth timeout is hardcoded separately at 120000ms in `sso.setup-steps.ts` and is not configurable via this file
- `package.json` — `open@^10.2.0` listed as a production dependency; `engines.node: >=20.0.0`
- `tsconfig.json` — `target: ES2022`, `module/moduleResolution: NodeNext`, strict mode; no build constraints affecting this fix

### Feature Flags and Deployment Concerns

- No feature flags control the browser-open path.
- **SSO timeout not configurable**: the 120-second timeout is hardcoded in three places (`sso.setup-steps.ts` lines 50 and 277, `sso.auth.ts` line 114 as `config.timeout || 120000`); on slow corporate VPN or with MFA flows, this timeout can expire before the browser even loads — a related but out-of-scope risk.
- **Windows installer context**: `install/windows/install.ps1` runs entirely within PowerShell; the same WDAC/AppLocker environment that blocks browser-open via `open` npm also governs the install script; however, this is a separate concern from the runtime fix.
- **`explorer.exe` availability**: `explorer.exe` is part of Windows Shell and is almost universally WDAC-whitelisted on corporate machines, making it the correct bypass for WDAC-constrained environments.
- No `.env.example` or environment documentation file exists in the repository; env var discovery requires reading source files directly.

---

## 6. Risk Indicators

- **`authenticate()` is completely untested** — `src/providers/plugins/sso/__tests__/sso.auth.test.ts` covers only `deriveExpiresAt`; any change to `authenticate()` has no regression safety net; new unit tests are mandatory for this fix
- **`open()` silent failure not detectable** — on WDAC-constrained machines, `open()` may exit without throwing an exception; the fix's URL print must precede the open call (not be in a catch block) to guarantee the user sees the URL regardless of whether the open attempt throws
- **Divergence from `mcp-oauth-provider.ts` PowerShell decision** — `mcp-oauth-provider.ts:162-168` documents a deliberate choice of PowerShell over `cmd /c start` for URL query-string safety; `explorer.exe` via `spawn` is a third path not previously evaluated; an inline comment explaining the WDAC/AppLocker rationale is required to avoid future reversion
- **`browser.ts` wrapper bypassed by SSO** — `sso.auth.ts` imports `open` directly instead of using `src/utils/browser.ts`; the fix can either stay in `sso.auth.ts` (minimal change) or refactor `browser.ts` to absorb OS-conditional logic (more consistent but larger scope); no guide mandates one approach over the other
- **Hardcoded 120-second timeout in three places** — `sso.setup-steps.ts:50`, `sso.setup-steps.ts:277`, `sso.auth.ts:114`; no env var override exists; on slow corporate VPN/MFA flows, the timeout can expire before the fallback URL can be acted upon; not in scope for this fix but should be noted
- **No `.env.example` or env var documentation** — all env vars must be discovered from source; increases onboarding and debugging risk for corporate environment issues
- **codegraph not indexed** — no `.codegraph/` directory present; all analysis was filesystem-based; cross-module call paths were traced manually and may be incomplete

---

## 7. Summary for Complexity Assessment

The fix is narrowly scoped to a single method (`authenticate()`) in a single file (`src/providers/plugins/sso/sso.auth.ts`), touching approximately 5 lines of logic. The architectural layers involved are: SSO Plugin layer (primary change) and, optionally, the Utilities layer if the implementer chooses to route the OS-conditional browser-open logic through `src/utils/browser.ts`. The CLI and Provider Registry layers are not touched. Estimated file change surface: 1–2 source files plus 1 test file. The fix does not require schema changes, API changes, or new dependencies.

The implementation follows established codebase patterns — `process.platform === 'win32'` guards, `child_process.spawn(...).unref()` for fire-and-forget processes, and `console.log` for user-facing auth messages — but introduces one novel element: spawning `explorer.exe` directly, which has no precedent in the repo. The existing `mcp-oauth-provider.ts` made an opposite decision (PowerShell over cmd) for a related problem; the divergence must be justified with an inline comment. The URL-print-before-open pattern is already established in `mcp-oauth-provider.ts`'s error-path fallback and in `docs/AUTHENTICATION.md`'s troubleshooting guidance, so this part of the fix aligns with existing convention.

The primary risk factor is test coverage: the `authenticate()` method is entirely untested, meaning the fix must ship with new unit tests to have any regression safety. The required test patterns are fully established elsewhere in the codebase — `Object.defineProperty(process, 'platform', ...)` for platform branching and `vi.mock('child_process', ...)` with a `spawn` stub from `BaseAgentAdapter.test.ts` — so writing the tests is mechanical rather than exploratory. Overall complexity is low-to-medium: the code change itself is small and low-risk, but the absence of existing test scaffolding for `authenticate()` means the test authoring effort is non-trivial and represents the bulk of the implementation work.
