# EPMCDME-16396 Analytics Disable Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users turn Claude Code analytics off entirely, for personal subscriptions only, or for one project (including under Global scope), and see the effective configuration. The hooks stay installed and existing users see no change in behaviour.

**Architecture:** A new CodeMie-owned file `~/.codemie/claude-analytics.json` holds the user's choices. One new gate function, `evaluateClaudeAnalyticsGate`, combines that file with the existing settings.json allowlist and the Claude account classification. `ClaudeCodeOtlpPlugin.isTracked` delegates to it, so the existing `OtlpAgentAdapter` invariant (no daemon, no SSO, no spool write for untracked) covers every new rule. A new `codemie proxy analytics` subcommand reads and writes the file.

**Tech Stack:** TypeScript (ESM, Node ≥ 20), commander, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-epmcdme-16396-analytics-disable-investigation.md` plus the minimal-change recommendation agreed in chat. Ticket: EPMCDME-16396.

## Global Constraints

- If `claude-analytics.json` is absent or empty, behaviour must be **identical to today** (enabled, nothing excluded, personal sessions collected).
- Do not modify `OtlpAgentAdapter.processOtlpEvent`, the daemon/spool/completeness gate, `native-loader.ts`, `--include-external`, or the external collector.
- In `connectors/claude-code-otlp.ts` the only allowed changes are the exported `hasClaudeCodeOtlpHooks()` (Task 5) and the noop-reason text (Task 4). Leave the backup/strip/merge logic alone.
- A corrupt `claude-analytics.json` fails closed (not tracked) on the hook path, and CLI writes refuse to overwrite it (`ConfigurationError`). Same policy as `copilot-connector-scope.ts`.
- Writes are atomic (temp file + `rename`) because hooks read the file concurrently.
- Code style: `.js` import extensions, `@/` alias, no `any`, explicit return types on exports. Use `ConfigurationError` for errors and `logger.debug` + `sanitizeLogArgs` for logging; no `console.log` outside CLI output.
- Exclusions are one project per command (bulk operations are out of scope per the ticket).
- AC5 explicitly requires tests, so they are in scope. **No git commits/pushes/branches unless the user asks** (AGENTS.md). The tasks below have no commit steps.
- Test command: `npx vitest run <file>`. `vitest.config.ts` already isolates `CODEMIE_HOME`.

## Review Focus

1. **Hand-edited or corrupt `claude-analytics.json`** (bad JSON, `excludedProjects: "x"`, relative path). Hooks must stop forwarding, `status` must say "corrupt", and CLI writes must refuse without overwriting the file. Tests: Task 1, Task 5.
2. **Path variants for excluded projects** (trailing slash, subdirectory cwd, sibling with a shared prefix `/repo` vs `/repo2`). Exclusion matches only the project and its children. Test: Task 1.
3. **Stale `oauthAccount` while an API key, Bedrock or custom base URL is in use.** The session must not be classified as personal. Test: Task 2.
4. **`excludePersonal` on while no corporate list is configured.** Nothing is Personal (16440 AC7), so the CLI must say that it has no effect yet instead of implying that collection stopped. Test: Task 4.
5. **Missing, unreadable or malformed `~/.claude.json`** → `'unknown'` → still collected (never silently dropped). Test: Task 2.

---

### Task 1: Analytics config file (read/write/exclusion match)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/claude-code-otlp.analytics-config.ts`
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.analytics-config.test.ts`

**Interfaces:**
- Consumes: `getCodemiePath` (`@/utils/paths.js`); `canonicalizePath`, `isPathInside`, `addProjectPath`, `removeProjectPath` (`@/agents/core/project-allowlist.js`); `ConfigurationError`.
- Produces:
  ```ts
  export interface ClaudeAnalyticsConfig {
    version: 1; enabled: boolean; excludePersonal: boolean;
    excludedProjects: string[];   // absolute, canonical
  }
  export const DEFAULT_CLAUDE_ANALYTICS_CONFIG: ClaudeAnalyticsConfig; // enabled:true, excludePersonal:false, excludedProjects:[]
  export type ClaudeAnalyticsConfigState = { kind: 'ok'; value: ClaudeAnalyticsConfig } | { kind: 'corrupt' };
  export function getClaudeAnalyticsConfigPath(): string;            // getCodemiePath('claude-analytics.json')
  export async function readClaudeAnalyticsConfig(): Promise<ClaudeAnalyticsConfigState>; // never throws
  export async function updateClaudeAnalyticsConfig(
    mutate: (current: ClaudeAnalyticsConfig) => ClaudeAnalyticsConfig | Promise<ClaudeAnalyticsConfig>
  ): Promise<ClaudeAnalyticsConfig>;                                 // throws ConfigurationError if corrupt/unreadable
  export async function isProjectExcluded(cwd: string | undefined, excluded: string[]): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

  `readClaudeAnalyticsConfig`:
  - absent file → `{kind:'ok', value: DEFAULT…}`; empty file → same.
  - partial file `{"version":1,"enabled":false}` → missing fields filled from defaults.
  - corrupt cases each → `{kind:'corrupt'}`: invalid JSON, array root, `enabled: "no"`, `excludedProjects: "x"`, `excludedProjects: ["rel/path"]`.

  `updateClaudeAnalyticsConfig`:
  - Creates the file. Round-trips through `read`.
  - A pre-existing corrupt file throws `ConfigurationError` and the bytes on disk are unchanged.
  - No `*.tmp` file is left behind.

  `isProjectExcluded`:
  - `('/a/b/c', ['/a/b'])` → true.
  - `('/a/b', ['/a/b/'])` → true.
  - `('/a/bc', ['/a/b'])` → false.
  - `(undefined, ['/a'])` → false.
  - `('/x', [])` → false.

- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.analytics-config.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the module.
  - Validation mirrors `isValidScope` in `copilot-connector-scope.ts`.
  - Missing fields default and unknown keys are ignored.
  - The write is a temp `${path}.${process.pid}.tmp` + `rename`, with `unlink` of the temp file on failure (same as `writeCopilotConnectorScope`).
- [ ] **Step 4: Run** the same command. Expected: PASS.

---

### Task 2: Claude subscription classification (AC2)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/claude-code-otlp.subscription.ts`
- Create: `src/agents/core/corporate-organizations.ts` (stub until EPMCDME-16440; see Step 5)
- Modify: `src/agents/plugins/claude-code-otlp/event-fields/session-env-fields.ts:38` (add `export` to `resolveProviderAndHost` only)
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.subscription.test.ts`

**Interfaces:**
- Consumes: `resolveHomeDir` (`@/utils/paths.js`). Use it, not `os.homedir()`, so tests can redirect it. Also `resolveProviderAndHost()`.
- Produces:
  ```ts
  // src/agents/core/corporate-organizations.ts
  export async function getCorporateOrganizations(): Promise<string[]>; // lower-cased UUIDs; stub returns [] (16440 AC7)
  // claude-code-otlp.subscription.ts
  export type ClaudeSubscriptionClass = 'codemie' | 'corporate' | 'personal' | 'unknown';
  export function getClaudeAccountFilePath(env?: NodeJS.ProcessEnv): string;
  //   env.CLAUDE_CONFIG_DIR ? join(CLAUDE_CONFIG_DIR, '.claude.json') : resolveHomeDir('.claude.json')
  export async function classifyClaudeSubscription(
    corporateOrgs: string[], env?: NodeJS.ProcessEnv
  ): Promise<ClaudeSubscriptionClass>;   // never throws; default env = process.env
  ```
- **Verified on real data (2026-10-28, personal Claude Pro machine):**
  - `~/.claude.json` `oauthAccount` has `organizationUuid`, `organizationType: "claude_pro"`, `billingType`.
  - `~/.claude/.credentials.json` `claudeAiOauth.subscriptionType: "pro"` and its top-level `organizationUuid` equal the oauthAccount one.
  - Hook payloads carry no account or org field, so the file read is required.
  - A **managed `codemie claude` session (provider `ai-run-sso`) still reported the personal `organization.id` in OTel**: `oauthAccount` stays stale while traffic goes through CodeMie. That makes rule 1 mandatory and means org data alone must never decide.
  - **Hook env probe** (isolated `claude -p` run, Claude Code 2.1.312, `--setting-sources project` + `--settings`; script in the session scratchpad). What reaches a hook subprocess, on both `SessionStart` and `UserPromptSubmit`:
    - shell env: `CODEMIE_SESSION_ID`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CONFIG_DIR` ✔;
    - settings `env`: `ANTHROPIC_BASE_URL` ✔;
    - `OTEL_*` ✘ (stripped by Claude Code; not needed).
    - Claude Code itself reports *"ANTHROPIC_API_KEY or another auth source is set and takes precedence over your claude.ai login"*, which confirms that a stale `oauthAccount` must be ignored when a key is set.
    - With `CLAUDE_CONFIG_DIR`, the account file is `$CLAUDE_CONFIG_DIR/.claude.json` ✔ (the connector's hardcoded `~/.claude/settings.json` is a confirmed separate edge case, out of scope).
  - The `claude.exe` 2.1.312 binary has `organizationType` values `claude_pro`, `claude_max`, `claude_team`, `claude_enterprise`. These are informational only: per EPMCDME-16440 the classification is by the admin-managed list, not by type.
  - **EPMCDME-16440 defines the classes:**
    - AC1: models routed through CodeMie → CodeMie.
    - AC2: org in the corporate list managed by an **installation administrator**, *"no organization is built in"* → Corporate.
    - AC3: any other org → Personal.
    - **AC7: no list configured or org unknown → Unknown, never Personal.**
  - **Not verifiable on this machine:** whether `oauthAccount` is rewritten immediately on a `/login` account switch (needs a second account). The per-event file read picks up any change as soon as Claude Code writes it.
- **Reuse, don't re-derive:** export the existing `resolveProviderAndHost()` from `event-fields/session-env-fields.ts:38` (it already returns `codemie-proxy` | `litellm-proxy` | `bedrock` | `vertex` | `anthropic` at hook time) and use it here.
- **Corporate list source = EPMCDME-16440 (dependency).** This ticket only *consumes* `getCorporateOrganizations(): Promise<string[]>`, which 16440 owns along with its storage. Until 16440 lands it is a stub returning `[]`, so by AC7 nothing is Personal and `personal disable` has no effect yet. No user-facing `org add/remove` commands.
- Rules, evaluated in order. Only `'personal'` matters for the gate; the rest are reported in `status`:
  1. `env.CODEMIE_SESSION_ID` is non-empty → `'codemie'` (managed launch; required, because managed sessions were seen carrying the personal `organization.id`).
  2. `resolveProviderAndHost().provider` is `codemie-proxy` → `'codemie'`; `litellm-proxy` / `bedrock` / `vertex` → `'unknown'` (not a claude.ai login).
  3. `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` is non-empty → `'unknown'` (it takes precedence over the OAuth login; verified).
  4. The corporate list is empty, the account file is missing or invalid, or there is no `oauthAccount.organizationUuid` → `'unknown'` (16440 AC7).
  5. The org (lower-cased) is in the list → `'corporate'`; otherwise → `'personal'`.

- [ ] **Step 1: Write the failing tests.** One test per rule above, plus:
  - stale-oauth: `ANTHROPIC_API_KEY` is set and `.claude.json` has a non-corporate org → `'unknown'`.
  - stale-oauth with `CODEMIE_SESSION_ID` and a non-corporate org → `'codemie'` (the real `ai-run-sso` case).
  - an empty corporate list with a `claude_pro` account → `'unknown'`, never `'personal'`.
  - the UUID match is case-insensitive.
  - `CLAUDE_CONFIG_DIR` is honoured.
  - malformed `.claude.json` → `'unknown'`.

  Use fixture `oauthAccount` objects shaped like the real one (`organizationUuid`, `organizationType: 'claude_pro'`, `billingType`), with fake UUIDs.

  Mock `@/utils/paths.js` so `resolveHomeDir` points at a temp dir. Pass an explicit `env` object, never mutate `process.env`.
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.subscription.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Never log email or name fields from `oauthAccount`. Only `logger.debug` the resulting class.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Coordinate with the EPMCDME-16440 owner** on the exact module and signature of `getCorporateOrganizations()`. If 16440 merges first, import theirs and delete the stub.

---

### Task 3: Single analytics gate wired into the plugin (AC1, AC2, AC3, AC4 bullet 3)

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/claude-code-otlp.gate.ts`
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:91-93` (`isTracked`)
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts`

**Interfaces:**
- Consumes: Task 1 (`readClaudeAnalyticsConfig`, `isProjectExcluded`), Task 2 (`classifyClaudeSubscription`), and the existing `readAllowlistState` / `isProjectTracked` from `./claude-code-otlp.allowlist.js`. Import them from that module so the existing `vi.mock('../claude-code-otlp.allowlist.js')` in `claude-code-otlp.plugin.test.ts` keeps working.
- Produces:
  ```ts
  export type ClaudeAnalyticsGateReason =
    'tracked' | 'config-corrupt' | 'disabled' | 'project-excluded' | 'not-in-allowlist' | 'personal-subscription';
  export interface ClaudeAnalyticsGateDecision {
    tracked: boolean; reason: ClaudeAnalyticsGateReason; subscription?: ClaudeSubscriptionClass;
  }
  export async function evaluateClaudeAnalyticsGate(
    cwd: string | undefined, env?: NodeJS.ProcessEnv
  ): Promise<ClaudeAnalyticsGateDecision>;
  ```
- Order (first match wins):
  1. `config-corrupt`
  2. `disabled`
  3. `project-excluded`
  4. `not-in-allowlist` (existing `isProjectTracked` is false)
  5. `personal-subscription`, only evaluated when `excludePersonal` is true, so `.claude.json` is not read otherwise
  6. `tracked`

  `subscription` is set only when step 5 ran.

- [ ] **Step 1: Write the failing gate tests**, one per reason, plus:
  - exclusion wins over an allowlist entry for the same path.
  - exclusion applies when the allowlist is `[]` (Global).
  - `excludePersonal` + `'corporate'` → tracked.
  - `excludePersonal` + `'codemie'` → tracked.
  - absent config → identical result to `isProjectTracked` alone.
- [ ] **Step 2: Add a failing plugin test** to `claude-code-otlp.plugin.test.ts` in the `processOtlpEvent` describe block. Write `{"version":1,"enabled":false}` to `getClaudeAnalyticsConfigPath()` with `isProjectTracked` mocked true. Fire `UserPromptSubmit` and assert:
  - `ensureCodeMieSsoAuth` was not called;
  - `ensureOtlpProxy` was not called;
  - `forwardOtlpEventsToSpool` was not called.

  Remove the file in `afterEach`.
- [ ] **Step 3: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`. Expected: the new tests FAIL and the existing ones PASS.
- [ ] **Step 4: Implement** the gate. Change `isTracked` to `return (await evaluateClaudeAnalyticsGate(hookInput.cwd)).tracked;`. Add `logger.debug` of the reason (no paths beyond what the existing debug line logs).
- [ ] **Step 5: Run** the same command. Expected: all PASS, including every pre-existing plugin test.

---

### Task 4: `codemie proxy analytics` write commands (AC1, AC2, AC3, AC4 persist)

**Files:**
- Create: `src/cli/commands/proxy/analytics-command.ts`
- Modify: `src/cli/commands/proxy/index.ts` (register via `proxy.addCommand(createProxyAnalyticsCommand())` next to `connect`/`inspect`)
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts:669` (Global noop reason text only)
- Modify: `README.md:612-639`, `docs/COMMANDS.md` (`#claude-code-otlp-analytics` section)
- Test: `src/cli/commands/proxy/__tests__/analytics-command.test.ts`

**Interfaces:**
- Consumes: Task 1 (`updateClaudeAnalyticsConfig`, `readClaudeAnalyticsConfig`), Task 2 (`getCorporateOrganizations` for the warning), `resolveProjectRoot` (`@/utils/project-root.js`), `addProjectPath` / `removeProjectPath`.
- Produces: `export function createProxyAnalyticsCommand(): Command;` with these subcommands (`status` is added by Task 5):

  | Command | Effect |
  |---|---|
  | `disable` | `enabled = false` (AC1) |
  | `enable` | `enabled = true` |
  | `exclude [path]` | add canonical `path ?? resolveProjectRoot()` to `excludedProjects` (AC3) |
  | `include [path]` | remove it from `excludedProjects` (does not touch the settings.json allowlist) |
  | `personal disable` / `personal enable` | `excludePersonal = true / false` (AC2) |

- Output text (exact):
  - After every write: `✓ Saved to <path>. Applies to the next Claude Code hook event.`
  - When `personal disable` runs while `getCorporateOrganizations()` returns `[]`: `⚠ No corporate organizations are configured for this installation, so no session is classified as personal yet. This setting takes effect once an administrator configures them.`
  - `exclude`/`include` print the canonical path. When the path is already in the requested state, print `Nothing to change.` and exit 0.
- Errors: a `ConfigurationError` from Task 1 is printed in red with `process.exitCode = 1` (same pattern as `disconnect-orchestrator.ts`).
- Global noop reason in `removeClaudeCodeOtlpConfig`: `'all projects are tracked (no per-project entries); to stop one project use: codemie proxy analytics exclude'`.

- [ ] **Step 1: Write the failing tests.** Drive `createProxyAnalyticsCommand().parseAsync([...], { from: 'user' })`.
  - Each subcommand writes the expected config (read back via `readClaudeAnalyticsConfig`).
  - `exclude` defaults to the project root of `process.cwd()` (mock `resolveProjectRoot`).
  - `exclude` twice keeps a single entry.
  - The `personal disable` warning appears only when `getCorporateOrganizations` (mocked) returns `[]`.
  - A corrupt config → exit code 1, file unchanged.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/__tests__/analytics-command.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** the command and register it. Update the noop reason string and its existing assertion in `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`, if one asserts that text.
- [ ] **Step 4: Run** the new test plus `npx vitest run src/cli/commands/proxy`. Expected: PASS.
- [ ] **Step 5: Docs.** In README and COMMANDS.md, add an "Turning analytics off" block listing the commands above. Explain that `disconnect` uninstalls, while `analytics disable` turns analytics off and keeps the hooks.

---

### Task 5: `codemie proxy analytics status` (AC4 view)

**Files:**
- Create: `src/cli/commands/proxy/analytics-status.ts`
- Modify: `src/cli/commands/proxy/analytics-command.ts` (add the `status [--json]` subcommand)
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (add the export only)
- Test: `src/cli/commands/proxy/__tests__/analytics-status.test.ts`

**Interfaces:**
- Consumes: Task 1 (read), Task 2 (`classifyClaudeSubscription`), Task 3 (`evaluateClaudeAnalyticsGate`), `readAllowlistState`.
- Produces:
  ```ts
  // connectors/claude-code-otlp.ts
  export async function hasClaudeCodeOtlpHooks(): Promise<boolean>; // any hook command containing CODEMIE_COMMAND_MARKER; never throws
  // analytics-status.ts
  export interface ClaudeAnalyticsStatus {
    hooksInstalled: boolean;
    scope: 'global' | 'project' | 'invalid' | 'not-configured';  // from readAllowlistState: absent→not-configured, []→global
    projects: string[];
    corporateOrgsConfigured: number;   // getCorporateOrganizations().length
    config: { kind: 'ok'; enabled: boolean; excludePersonal: boolean; excludedProjects: string[] }
          | { kind: 'corrupt'; path: string };
    current: { path: string; tracked: boolean; reason: ClaudeAnalyticsGateReason; subscription?: ClaudeSubscriptionClass };
  }
  export async function collectClaudeAnalyticsStatus(cwd: string): Promise<ClaudeAnalyticsStatus>;
  export function formatClaudeAnalyticsStatus(status: ClaudeAnalyticsStatus): string;
  ```
- The status always classifies the subscription for `current` (it calls `classifyClaudeSubscription` directly when the gate did not), so users can see their class before enabling the personal filter.
- The `--json` output is `JSON.stringify(status, null, 2)`.
- Text output, one line each: Hooks, Scope (+ projects), Collection (enabled/disabled), Personal subscriptions (collected/excluded + org count), Excluded projects, Current directory → tracked/not tracked (reason, subscription).
  - If the hooks are not installed, add `Run: codemie proxy connect --claude-code-otlp`.
  - If the config is corrupt, add `Config is corrupt — collection is stopped. Fix or delete <path>.`

- [ ] **Step 1: Write the failing tests.**
  - Collecting the status for: no settings + no config; Global + exclusion covering cwd; project scope; disabled; corrupt config.
  - `formatClaudeAnalyticsStatus` contains the corrupt-config line and the not-installed hint in those cases.
  - `--json` parses back to the same object.
  - `hasClaudeCodeOtlpHooks()`: false with no file, true after `writeClaudeCodeOtlpConfig`.
- [ ] **Step 2: Run** `npx vitest run src/cli/commands/proxy/__tests__/analytics-status.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.

---

### Task 6: AC5 regression matrix

**Files:**
- Create: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.disable-matrix.test.ts`
- Modify: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` (two cases)

**Interfaces:**
- Consumes: `ClaudeCodeOtlpPlugin.processOtlpEvent(raw, { ensureOtlpProxy, forwardOtlpEventsToSpool })` with spies, Tasks 1–3, and the real allowlist module (no `vi.mock` of it here). Point `resolveHomeDir` at a temp dir via a partial `vi.mock('@/utils/paths.js')`. Write `~/.claude/settings.json` (allowlist) and `~/.claude.json` (oauthAccount) there. Mock `ensureCodeMieSsoAuth` → `{ ok: true }`, as in `claude-code-otlp.plugin.test.ts`.

- [ ] **Step 1: Write the matrix as `it.each` cases.** Rows are operation × scope × launch:
  - operations: `disable all`, `personal disable` (mock `getCorporateOrganizations` → `['corp-uuid']`, account org `'personal-uuid'`), `exclude /work/a`
  - scopes: Global (`CODEMIE_ANALYTICS_PROJECT_FILTER: '[]'`), Project (`'["/work/a","/work/b"]'`)
  - launches: native (`env` without `CODEMIE_SESSION_ID`), managed (`CODEMIE_SESSION_ID: 'x'`)

  For each row, fire `SessionStart` + `UserPromptSubmit` with `cwd: '/work/a'` and assert:
  - `forwardOtlpEventsToSpool`, `ensureOtlpProxy` and `ensureCodeMieSsoAuth` are **not** called. The one exception: `personal disable` × managed launch **is** forwarded (AC2: CodeMie sessions are kept).
  - the same event with `cwd: '/work/b'` **is** forwarded, except under `disable all` (AC5: one project does not affect others; disable all stops everything).
  - After `enable` / `include` / `personal enable`, `/work/a` is forwarded again.

  The classifier reads `process.env`, so set the launch env via `vi.stubEnv` and restore it in `afterEach`.
- [ ] **Step 2: Add the connector cases.**
  - `writeClaudeCodeOtlpConfig({ scope: 'user' })` leaves `claude-analytics.json` byte-identical (exclusions survive a switch to Global).
  - `removeClaudeCodeOtlpConfig()` also leaves it untouched (preferences survive a reinstall).
- [ ] **Step 3: Run** `npx vitest run src/agents/plugins/claude-code-otlp src/cli/commands/proxy`. Expected: PASS. If a row fails, fix the owning task's code, not the test.
- [ ] **Step 4: Run the quality gates:** `npm run lint`, `npm run typecheck`, `npm test`. Expected: zero warnings, zero type errors, all suites PASS.

---

## AC coverage

| AC | Tasks |
|---|---|
| AC1 disable all, no SSO | 1, 3 (gate before SSO), 4 `disable`, 6 |
| AC2 personal only | 2, 3, 4 `personal` / `org`, 6 |
| AC3 one project, incl. Global | 1, 3, 4 `exclude`, 6 |
| AC4 persist / view / installed hooks honour it | 1 (file), 3 (hooks check the gate), 5 `status`, 6 (survives connect/disconnect) |
| AC5 regression | 6 (+ unit tests in 1–5) |

## Decisions made without user confirmation (check these)

- The corporate org list belongs to EPMCDME-16440 (admin-managed). This ticket consumes it through a stub; until 16440 lands, `personal disable` is stored but excludes nothing (16440 AC7).
- Non-OAuth sessions (API key, Bedrock, Vertex, custom base URL) count as `'unknown'` and are **collected**. This matches 16440 AC7 (never Personal).
- `include` only removes an exclusion. It never adds to the settings.json allowlist.
- Preferences survive `disconnect` (the file is not deleted).
- The daily collector (separate repo) is not changed. Record this as out of scope in the PR.
