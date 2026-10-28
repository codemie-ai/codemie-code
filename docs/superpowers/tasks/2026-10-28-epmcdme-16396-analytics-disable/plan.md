# EPMCDME-16396 Analytics Disable Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user stop all Claude Code analytics collection, or exclude one project from collection (even under Global scope), without uninstalling the CodeMie hooks — and let them see the effective configuration.

**Architecture:** A new CodeMie-owned preferences file (`~/.codemie/claude-analytics.json`) holds `{ enabled, excludedProjects }`. A new gate function combines that file with the existing `~/.claude/settings.json` allowlist (`isProjectTracked`). `ClaudeCodeOtlpPlugin.isTracked` delegates to the new gate, so the existing `OtlpAgentAdapter` invariant (no daemon start, no SSO, no spool write when untracked) covers every new rule with zero changes to `OtlpAgentAdapter.ts` or the daemon. A new `codemie proxy analytics` subcommand group (distinct from the unrelated, pre-existing `codemie analytics` reporting command) reads and writes the preferences file.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander, Vitest `^4.1.5`.

**Spec:** No `spec.md` for this flow (`sdlc-light`). This plan is the sole planning artifact; it supersedes `docs/superpowers/plans/2026-10-28-epmcdme-16396-analytics-disable.md`, whose personal-subscription tasks (2, and the `personal` parts of 4/5/6) are out of scope — split to EPMCDME-16479. Research: `docs/superpowers/tasks/2026-10-28-epmcdme-16396-analytics-disable/technical-analysis.md`. Ticket: EPMCDME-16396.

## Global Constraints

- Scope is the Claude Code hook/OTLP pipeline only. Do not touch personal-subscription classification (EPMCDME-16479) or the SSO Session Sync channel (`CODEMIE_SESSION_SYNC_ENABLED`) — both explicitly out of scope per this session's clarity-check answer.
- Do not modify `src/agents/core/OtlpAgentAdapter.ts`, the proxy daemon, the spool, or the completeness gate. New logic plugs into `ClaudeCodeOtlpPlugin.isTracked()` only.
- When `~/.codemie/claude-analytics.json` is absent or empty, behavior must be byte-for-byte identical to today (`enabled: true`, nothing excluded).
- New persisted state lives in a new CodeMie-owned file via `getCodemiePath('claude-analytics.json')` — do not add a new key to `~/.claude/settings.json`'s `env`.
- Writes to the new preferences file are atomic (temp file + `rename`) because the hook reads it concurrently from short-lived child processes.
- A corrupt `claude-analytics.json` fails closed (not tracked) on the hook read path; CLI writes refuse to overwrite a corrupt file and throw `ConfigurationError`.
- Reuse `canonicalizePath`/`isPathInside` from `src/agents/core/project-allowlist.ts` for exclusion-path matching (symlink-aware, Windows case-insensitive) — do not reimplement path comparison.
- Code style: ESM `.js` import extensions, `@/` alias, no `any`, explicit return types on every exported function. `ConfigurationError` for config errors, `logger.debug`/`logger.info`/`logger.warn` + `sanitizeLogArgs` for logging, no `console.log` outside CLI command files.
- New CLI surface lives under `src/cli/commands/proxy/`, nested as `codemie proxy analytics <subcommand>` — never a new top-level `codemie analytics-*` command, to avoid confusion with the existing, unrelated reporting command at `src/cli/commands/analytics/index.ts`.
- `exclude`/`include` operate on exactly one project path per invocation (bulk operations are out of scope per the ticket).
- Tests are in scope (AC4 requires them). Test command: `npx vitest run <file>`. Follow house conventions confirmed in research: temp-dir real-fs I/O (`mkdtemp(join(tmpdir(), 'codemie-otlp-...'))`), `vi.doMock` + `vi.resetModules()` + dynamic `import()` for orchestrator-level tests, `vi.hoisted(() => vi.fn())` for mocks referenced inside `vi.mock()` factories, mocking `resolveProjectRoot`/`resolveHomeDir` to redirect into temp dirs, and `describe('regression: EPMCDME-16396 — ...')` labeling for the AC4 matrix.
- No commit steps in this plan — the orchestrating SDLC flow commits after each task separately.

## Review Focus

1. **Hand-edited or corrupt `claude-analytics.json`** (invalid JSON, `excludedProjects` not an array, a non-absolute path inside it). The hook must fail closed (not tracked) and a CLI write must refuse without touching the file on disk. Covered by: Task 1 (read), Task 3 (write refusal).
2. **Path variants for an excluded project** — trailing slash, a nested subdirectory of the excluded path, and a sibling directory with a shared string prefix (`/repo` vs `/repo2`) that must NOT be treated as excluded. Covered by: Task 1.
3. **Exclusion under Global scope (`[]`/absent allowlist)** — today nothing can be removed from an empty/absent allowlist; this ticket's core gap. Covered by: Task 2, Task 5.
4. **`exclude` run twice on the same path, or `include` run on a path that was never excluded** — must not duplicate entries or error; must say "Nothing to change." for the no-op case. Covered by: Task 3.
5. **Exclusions and the disabled flag surviving `connect --scope user` / `disconnect`** — the new preferences file must never be touched by the existing connector write/remove paths, so turning hooks off and back on (or switching to Global scope) never resets user preferences. Covered by: Task 5.

---

### Task 1: Analytics preferences file (read / write / exclusion match)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.ts`
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.preferences.test.ts`

**Interfaces:**
- Consumes: `getCodemiePath` (`@/utils/paths.js`), `canonicalizePath`/`isPathInside` (`@/agents/core/project-allowlist.js`), `ConfigurationError` (`@/utils/errors.js`), `logger` (`@/utils/logger.js`), `sanitizeLogArgs` (`@/utils/security.js`).
- Produces:
  ```ts
  export interface ClaudeAnalyticsPreferences {
    version: 1;
    enabled: boolean;
    excludedProjects: string[]; // absolute, canonical paths
  }
  export const DEFAULT_CLAUDE_ANALYTICS_PREFERENCES: ClaudeAnalyticsPreferences; // { version: 1, enabled: true, excludedProjects: [] }
  export type ClaudeAnalyticsPreferencesState =
    | { kind: 'ok'; value: ClaudeAnalyticsPreferences }
    | { kind: 'corrupt' };
  export function getClaudeAnalyticsPreferencesPath(): string; // getCodemiePath('claude-analytics.json')
  export async function readClaudeAnalyticsPreferences(): Promise<ClaudeAnalyticsPreferencesState>; // never throws
  export async function updateClaudeAnalyticsPreferences(
    mutate: (current: ClaudeAnalyticsPreferences) => ClaudeAnalyticsPreferences
  ): Promise<ClaudeAnalyticsPreferences>; // throws ConfigurationError if the existing file is corrupt/unreadable
  export async function isProjectExcluded(cwd: string | undefined, excludedProjects: string[]): Promise<boolean>;
  ```
  `mutate` receives the current value (defaults if the file is absent/empty) and returns the next value to persist; callers (Task 3) never read-then-write by hand.

- [ ] **Step 1: Write the failing tests**

  `readClaudeAnalyticsPreferences`:
  - File absent → `{ kind: 'ok', value: DEFAULT_CLAUDE_ANALYTICS_PREFERENCES }`.
  - Empty file → same default.
  - Partial file `{"version":1,"enabled":false}` → `excludedProjects` defaults to `[]`.
  - Corrupt cases, each → `{ kind: 'corrupt' }`: invalid JSON; array root; `enabled: "no"`; `excludedProjects: "not-an-array"`; `excludedProjects: ["relative/path"]` (non-absolute entry).

  `updateClaudeAnalyticsPreferences`:
  - On an absent file, creates it with `mutate(DEFAULT_CLAUDE_ANALYTICS_PREFERENCES)`'s result; a subsequent `readClaudeAnalyticsPreferences` round-trips it.
  - When the existing file is corrupt, throws `ConfigurationError` and the file's bytes on disk are unchanged (read the raw bytes before and after, assert equal).
  - No `*.tmp` file is left in the directory after a successful or failed write.

  `isProjectExcluded`:
  - `('/a/b/c', ['/a/b'])` → `true` (nested subdirectory).
  - `('/a/b', ['/a/b/'])` → `true` (trailing slash on the excluded entry).
  - `('/a/bc', ['/a/b'])` → `false` (sibling with a shared string prefix, not nested).
  - `(undefined, ['/a'])` → `false`.
  - `('/x', [])` → `false`.

  Mock `@/utils/paths.js`'s `getCodemiePath` to redirect into a `mkdtemp` temp dir (per-test, cleaned up in `afterEach`).

- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.preferences.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement the module.** Validation mirrors `isValidScope` in `src/agents/core/copilot-connector-scope.ts`: an object with `enabled` boolean and `excludedProjects` an array of non-empty absolute path strings (use `isAbsolute` from `node:path`) is valid; anything else is corrupt. `readClaudeAnalyticsPreferences` fills missing fields from `DEFAULT_CLAUDE_ANALYTICS_PREFERENCES` only when the file as a whole is structurally valid (per `copilot-connector-scope.ts`'s pattern: unknown/missing keys default, a wrong-typed *present* key is corrupt). The write path is `${path}.${process.pid}.tmp` + `writeFile` + `rename`, with `unlink` of the temp file (swallowing errors) on any failure, matching `writeCopilotConnectorScope`. `updateClaudeAnalyticsPreferences` reads first (treating `{kind:'ok'}` as the input to `mutate`, throwing on `{kind:'corrupt'}`), then writes the mutated value. `isProjectExcluded` loops `excludedProjects`, canonicalizing both sides and calling `isPathInside`, matching the existing `isProjectTracked` loop shape in `src/agents/core/project-allowlist.ts`.
- [ ] **Step 4: Run** the same command. Expected: PASS.

---

### Task 2: Single analytics gate wired into `isTracked` (AC1, AC2, AC3 bullet 3)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/claude-code-otlp.gate.ts`
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:91-93` (`isTracked`)
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts`
- Modify (test): `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`

**Interfaces:**
- Consumes: Task 1's `readClaudeAnalyticsPreferences`, `isProjectExcluded`; the existing `isProjectTracked`, `readAllowlistState` re-exported from `./claude-code-otlp.allowlist.js` (import from that module, not `project-allowlist.js` directly, so the existing `vi.mock('../claude-code-otlp.allowlist.js')` in `claude-code-otlp.plugin.test.ts` keeps covering this path).
- Produces:
  ```ts
  export type ClaudeAnalyticsGateReason =
    'tracked' | 'preferences-corrupt' | 'disabled' | 'project-excluded' | 'not-in-allowlist';
  export interface ClaudeAnalyticsGateDecision {
    tracked: boolean;
    reason: ClaudeAnalyticsGateReason;
  }
  export async function evaluateClaudeAnalyticsGate(cwd: string | undefined): Promise<ClaudeAnalyticsGateDecision>;
  ```
  Evaluation order (first match wins):
  1. Preferences file corrupt → `{ tracked: false, reason: 'preferences-corrupt' }`.
  2. `enabled === false` → `{ tracked: false, reason: 'disabled' }`.
  3. `cwd` excluded (via `isProjectExcluded`) → `{ tracked: false, reason: 'project-excluded' }`.
  4. Existing `isProjectTracked(cwd, await readAllowlistState())` is `false` → `{ tracked: false, reason: 'not-in-allowlist' }`.
  5. Otherwise → `{ tracked: true, reason: 'tracked' }`.

- [ ] **Step 1: Write the failing gate tests**, one per reason above, plus:
  - Absent preferences file → identical `tracked` result to calling `isProjectTracked` directly with the same allowlist state (i.e. the gate is a strict superset, never narrower, when nothing is configured).
  - Exclusion wins over an allowlist entry that covers the same path (allowlist says tracked, exclusion says no → not tracked).
  - Exclusion applies when the allowlist is absent/empty (Global scope) — the AC2 case with no prior coverage anywhere in the codebase.
  - `cwd === undefined` with an exclusion configured → not excluded (falls through to the allowlist check), matching `isProjectExcluded(undefined, …) === false` from Task 1.

  Mock `./claude-code-otlp.preferences.js` (`vi.mock`) and `./claude-code-otlp.allowlist.js` (`vi.mock`) independently per test case.

- [ ] **Step 2: Add a failing plugin-level test** to `claude-code-otlp.plugin.test.ts`, in the existing `processOtlpEvent` describe block: mock `evaluateClaudeAnalyticsGate` (new `vi.mock('../claude-code-otlp.gate.js')` at the top of the file, alongside the existing allowlist mock) to return `{ tracked: false, reason: 'disabled' }`, fire `UserPromptSubmit`, and assert `ensureOtlpProxy`, `forwardOtlpEventsToSpool` are not called (the existing untracked-project assertions in that file already cover this shape — add one case for the new reason, don't duplicate the suite).
- [ ] **Step 3: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`. Expected: the two new tests FAIL (`evaluateClaudeAnalyticsGate` doesn't exist yet / isn't wired), every pre-existing test in both files still PASSES.
- [ ] **Step 4: Implement the gate module**, then change `claude-code-otlp.plugin.ts:91-93` to:
  ```ts
  protected async isTracked(hookInput: HookInput): Promise<boolean> {
    const decision = await evaluateClaudeAnalyticsGate(hookInput.cwd);
    logger.debug(`[${this.name}] analytics gate decision`, ...sanitizeLogArgs({ reason: decision.reason }));
    return decision.tracked;
  }
  ```
  Add the `evaluateClaudeAnalyticsGate` import; `logger`/`sanitizeLogArgs` are already imported transitively in this file's module graph — import them directly if not already present.
- [ ] **Step 5: Run** the same command as Step 3. Expected: all PASS, including every pre-existing test in both files (no regressions to the current inclusion-only behavior).

---

### Task 3: `codemie proxy analytics` write commands (AC1 disable, AC2 exclude, AC3 persist)

**Files:**
- Create: `src/cli/commands/proxy/analytics-command.ts`
- Modify: `src/cli/commands/proxy/index.ts` (register: `proxy.addCommand(createProxyAnalyticsCommand())`, alongside the existing `proxy.addCommand(connect)` / `proxy.addCommand(inspect)` at the end of `createProxyCommand()`)
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts:671` (the Global-scope noop `reason` string in `removeClaudeCodeOtlpConfig`, currently `'all projects are tracked (no per-project entries)'`)
- Test: `src/cli/commands/proxy/__tests__/analytics-command.test.ts`

**Interfaces:**
- Consumes: Task 1's `updateClaudeAnalyticsPreferences`, `readClaudeAnalyticsPreferences`, `getClaudeAnalyticsPreferencesPath`; `resolveProjectRoot` (`@/utils/project-root.js`); `canonicalizePath` (`@/agents/core/project-allowlist.js`).
- Produces: `export function createProxyAnalyticsCommand(): Command;` returning a `Command` named `'analytics'` with subcommands (`status` is added by Task 4):

  | Subcommand | Effect |
  |---|---|
  | `disable` | `updateClaudeAnalyticsPreferences(p => ({ ...p, enabled: false }))` (AC1) |
  | `enable` | `updateClaudeAnalyticsPreferences(p => ({ ...p, enabled: true }))` |
  | `exclude [path]` | add `canonicalizePath(path ?? resolveProjectRoot())` to `excludedProjects` (dedupe) (AC2) |
  | `include [path]` | remove the canonical `path ?? resolveProjectRoot()` from `excludedProjects` |

- Exact output text:
  - After every write that changes something: `` ✓ Saved to <path>. Applies to the next Claude Code hook event. `` where `<path>` is `getClaudeAnalyticsPreferencesPath()`, in `chalk.green`.
  - `exclude`/`include` additionally print the canonical path acted on: `` (project: <canonicalPath>) `` appended to the success line.
  - When the requested state is already in effect (`exclude` on an already-excluded path, `include` on a path not excluded, `disable` when already disabled, `enable` when already enabled): print `Nothing to change.` in `chalk.dim` and do not write the file. Exit code 0.
  - On `ConfigurationError` from Task 1 (corrupt preferences file): `` ✗ <error.message> `` in `chalk.red`, `process.exitCode = 1`, matching the pattern in `disconnect-orchestrator.ts`'s `disconnectClaudeCodeOtlp`.
- Update the Global-scope noop reason string in `connectors/claude-code-otlp.ts` to: `'all projects are tracked (no per-project entries); to stop one project use: codemie proxy analytics exclude'`.

- [ ] **Step 1: Write the failing tests.** Drive the command via `await createProxyAnalyticsCommand().parseAsync(['node', 'analytics', ...args])` against a temp-dir-redirected `getCodemiePath` (mock `@/utils/paths.js`, following the house pattern):
  - `disable` then `readClaudeAnalyticsPreferences()` → `enabled: false`.
  - `enable` after `disable` → `enabled: true`.
  - `exclude /work/a` → `excludedProjects` contains the canonical form of `/work/a`.
  - `exclude` with no path argument, with `resolveProjectRoot` mocked to `/work/root` → excludes `/work/root`.
  - `exclude /work/a` run twice → still exactly one entry, and the second run prints `Nothing to change.` (capture `console.log` with `vi.spyOn`).
  - `include /work/a` after `exclude /work/a` → entry removed.
  - `include /work/z` (never excluded) → prints `Nothing to change.`, file unchanged.
  - A pre-existing corrupt `claude-analytics.json` → any subcommand exits with `process.exitCode === 1` and the file's bytes are unchanged.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/__tests__/analytics-command.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** `createProxyAnalyticsCommand()` and register it in `index.ts`. Each subcommand's `.action()` wraps its body in try/catch per the error-text contract above.
- [ ] **Step 4: Update** the noop reason string at `connectors/claude-code-otlp.ts:671` as specified. Search `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` for any assertion on the old string (none found in current research — if one now exists, update it to match).
- [ ] **Step 5: Run** `npx vitest run src/cli/commands/proxy`. Expected: PASS, including every pre-existing test in that directory.

---

### Task 4: `codemie proxy analytics status` (AC3 view)

**Files:**
- Modify: `src/cli/commands/proxy/analytics-command.ts` (add the `status [--json]` subcommand)
- Create: `src/cli/commands/proxy/analytics-status.ts`
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (add one new export, no behavior change)
- Test: `src/cli/commands/proxy/__tests__/analytics-status.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readClaudeAnalyticsPreferences`), Task 2 (`evaluateClaudeAnalyticsGate`), the existing `readAllowlistState`/`inferAllowlistScope` from `claude-code-otlp.allowlist.js`.
- Produces:
  ```ts
  // connectors/claude-code-otlp.ts — new export, reads the same file writeClaudeCodeOtlpConfig/removeClaudeCodeOtlpConfig already touch
  export async function hasClaudeCodeOtlpHooks(): Promise<boolean>; // true iff any hooks entry contains CODEMIE_COMMAND_MARKER; never throws (false on read error)

  // analytics-status.ts
  export interface ClaudeAnalyticsStatus {
    hooksInstalled: boolean;
    scope: 'user' | 'project' | 'invalid' | 'not-configured'; // from readAllowlistState via inferAllowlistScope; 'invalid' when AllowlistState.kind === 'invalid'; 'not-configured' when hooksInstalled is false
    trackedProjects: string[]; // the raw allowlist paths; [] under 'user'/'not-configured'/'invalid'
    enabled: boolean; // true when preferences are absent/default
    excludedProjects: string[];
    preferencesCorrupt: boolean;
    preferencesPath: string;
    current: { path: string; tracked: boolean; reason: ClaudeAnalyticsGateReason };
  }
  export async function collectClaudeAnalyticsStatus(cwd: string): Promise<ClaudeAnalyticsStatus>;
  export function formatClaudeAnalyticsStatus(status: ClaudeAnalyticsStatus): string;
  ```
- `--json` output is `JSON.stringify(status, null, 2)`.
- Text output (one line each, in this order): `Hooks: installed|not installed`; `Scope: <scope>` (+ `Tracked projects:` list when `scope === 'project'`); `Collection: enabled|disabled`; `Excluded projects:` list (or `(none)`); `Current directory (<path>): tracked|not tracked (<reason>)`.
  - If `!hooksInstalled`, append a line: `Run: codemie proxy connect --claude-code-otlp`.
  - If `preferencesCorrupt`, append a line: `Preferences file is corrupt — collection is stopped. Fix or delete <preferencesPath>.`

- [ ] **Step 1: Write the failing tests.**
  - `hasClaudeCodeOtlpHooks()`: `false` with no settings file; `true` after a real `writeClaudeCodeOtlpConfig`-style settings file is written to the (mocked-home) temp dir with the command marker present.
  - `collectClaudeAnalyticsStatus`: no settings file + no preferences file → `hooksInstalled: false`, `scope: 'not-configured'`, `enabled: true`, `excludedProjects: []`.
  - Project scope with two tracked paths → `scope: 'project'`, `trackedProjects` has both.
  - Global scope (`[]`) plus one excluded project covering `cwd` → `current.tracked === false`, `current.reason === 'project-excluded'`.
  - `disable` applied → `enabled: false`, `current.tracked === false`, `current.reason === 'disabled'`.
  - Corrupt preferences file → `preferencesCorrupt: true`, `current.tracked === false`, `current.reason === 'preferences-corrupt'`.
  - `formatClaudeAnalyticsStatus`: output contains the "corrupt" line only in the corrupt case, and the "Run: codemie proxy connect" hint only when hooks are not installed.
  - `--json`: parsing the command's stdout with `JSON.parse` yields an object matching `collectClaudeAnalyticsStatus`'s direct return value for the same fixture.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/__tests__/analytics-status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `hasClaudeCodeOtlpHooks`, `collectClaudeAnalyticsStatus`, `formatClaudeAnalyticsStatus`, and wire `status [--json]` into `createProxyAnalyticsCommand()` (default `cwd` is `process.cwd()`).
- [ ] **Step 4: Run** the same command, plus `npx vitest run src/cli/commands/proxy`. Expected: all PASS.

---

### Task 5: AC4 regression matrix + docs

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.disable-matrix.test.ts`
- Modify: `README.md` (around line 612-645, the `proxy connect --claude-code-otlp` section)
- Modify: `docs/COMMANDS.md` (around line 1591-1650, the Claude Code OTLP analytics section — add a `#claude-code-otlp-analytics-disable` subsection)

**Interfaces:**
- Consumes: `ClaudeCodeOtlpPlugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool })` with spies (same harness `claude-code-otlp.plugin.test.ts` already uses), Task 1-2's modules, and the real (unmocked) allowlist/gate/preferences modules in this file — point `resolveHomeDir`/`getCodemiePath` at one shared temp dir via `vi.mock('@/utils/paths.js', ...)` so both `~/.claude/settings.json` and `~/.codemie/claude-analytics.json` land under it. Mock `ensureCodeMieSsoAuth` → `{ ok: true }` and `ensureOtlpProxy`/`forwardOtlpEventsToSpool` as spies, as in `claude-code-otlp.plugin.test.ts`.

- [ ] **Step 1: Write the matrix as `it.each` cases** under `describe('regression: EPMCDME-16396 — analytics disable matrix', ...)`. Rows cross operation × scope:
  - operations: `disable all` (`updateClaudeAnalyticsPreferences(p => ({...p, enabled:false}))`), `exclude /work/a` (`updateClaudeAnalyticsPreferences` adding the canonical path)
  - scopes: Global (write `~/.claude/settings.json` with `CODEMIE_ANALYTICS_PROJECT_FILTER` absent/`'[]'`), Project (`'["/work/a","/work/b"]'`)

  For each row, fire `SessionStart` then `UserPromptSubmit` with `cwd: '/work/a'` and assert `ensureOtlpProxy`/`forwardOtlpEventsToSpool`/`ensureCodeMieSsoAuth` are **not** called. Then fire the same two events with `cwd: '/work/b'` and assert:
  - under `exclude /work/a`: `/work/b` **is still forwarded** (AC2 — excluding one project doesn't affect another).
  - under `disable all`: `/work/b` is **also not forwarded** (AC1 — disabling all stops everything, regardless of scope).

  Add two more cases:
  - After `exclude /work/a` then `updateClaudeAnalyticsPreferences` removing it again (`include`), `/work/a` is forwarded again.
  - After `disable all` then re-`enable`, `/work/a` is forwarded again.
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude-code-otlp src/cli/commands/proxy`. Expected: PASS. If a row fails, fix the owning task's code (Task 1-4), not the test.
- [ ] **Step 3: Docs.** In `README.md`'s existing `proxy connect --claude-code-otlp` block, add three example lines: `codemie proxy analytics disable`, `codemie proxy analytics exclude`, `codemie proxy analytics status`, with one sentence noting that `disconnect` uninstalls while `analytics disable`/`exclude` turn collection off and keep the hooks installed. In `docs/COMMANDS.md`, add a `#claude-code-otlp-analytics-disable` subsection documenting all five subcommands (`disable`, `enable`, `exclude [path]`, `include [path]`, `status [--json]`) with their effect, matching the table style already used at the existing `connect`/`disconnect` section there.
- [ ] **Step 4: Run the full quality gates:** `npm run lint`, `npm run typecheck`, `npm test`. Expected: zero lint warnings, zero type errors, all suites PASS.

---

## AC coverage

| AC | Tasks |
|---|---|
| AC1 — disable all, no SSO | Task 2 (gate runs before SSO/daemon/spool — existing invariant), Task 3 `disable`, Task 5 |
| AC2 — exclude one project, incl. Global | Task 1 (`isProjectExcluded`), Task 2 (gate), Task 3 `exclude`, Task 5 |
| AC3 — persist / view / honor installed hooks | Task 1 (file persistence), Task 2 (hooks stay installed, gate decides), Task 4 `status`, Task 5 (survives enable/disable cycling) |
| AC4 — regression coverage | Task 5 (+ the unit tests added in Tasks 1-4) |

## Known coverage gap (confirmed with user)

AC4 calls for regression coverage "including native Claude Code launches." Task 5's matrix
(`claude-code-otlp.disable-matrix.test.ts`) covers the full Project/Global × disable-all/exclude-one
matrix at the `ClaudeCodeOtlpPlugin.processOtlpEvent()` level, with `ensureOtlpProxy`/
`forwardOtlpEventsToSpool`/SSO mocked — it does not spawn or simulate the real `claude` CLI binary
invoking the hook end-to-end. Verified during code review (EPMCDME-16396 Stage 5): this is accepted
as a manual/out-of-automation-scope verification step rather than an automated test gap to close in
this ticket — a native-launch integration test (shelling out to `bin/codemie.js hook --agent
claude-code-otlp` against a real `settings.json` + `claude-analytics.json`) was deliberately not
added here.

## Decisions made without user confirmation (flag for review)

- Session-sync channel (`CODEMIE_SESSION_SYNC_ENABLED`) is untouched — confirmed out of scope by the user this session.
- `connect`/`disconnect` never read or write `claude-analytics.json`; preferences survive every connect/disconnect/scope-switch cycle.
- `getClaudeSettingsPath()` continues to hardcode `~/.claude` (via `resolveHomeDir()`), ignoring `CLAUDE_CONFIG_DIR` — this is pre-existing behavior, not introduced or fixed by this ticket; out of scope to change here.
- `exclude`/`include` only ever mutate `claude-analytics.json`'s `excludedProjects`; they never touch the separate `~/.claude/settings.json` allowlist that `connect --scope project` manages.
