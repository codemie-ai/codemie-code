# Agent Launch Config in Doctor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Under **Installed Agents**, `codemie doctor` shows each agent's launch environment
variables: their effective value and source. This replaces the standalone `PromptCacheCheck`.

**Architecture:**
- Agents declare the variables their launcher sets as `LaunchEnvDefault` data on `AgentMetadata`.
- One core helper applies the declarations at launch (Claude's `beforeRun`), and a pure core
  resolver describes them for doctor. The resolver gives settings precedence over shell, then
  profile, then the CodeMie default.
- Agents can add derived lines (Claude: the prompt-cache TTL) through an optional adapter method.
  `AgentsCheck` renders everything as indented children of the agent's line.

**Tech Stack:** TypeScript (ES modules, `.js` imports, `@/` alias), Node ≥ 20, Vitest, chalk/ora.

**Spec:** `docs/superpowers/specs/2026-11-16-agent-launch-config-in-doctor-design.md`

## Global Constraints

- Launch behavior is unchanged: the same eight variables, values, provider conditions and
  "only when unset or empty" rule as `claude.plugin.ts` today.
- Doctor never runs `beforeRun` and never writes files, spawns processes or makes network calls
  for this feature.
- Every name, value and path printed from settings, shell or profile goes through
  `safeTerminalValue` (`src/utils/terminal-text.ts`).
- `src/agents/core/*` must not import from `src/cli/**` or from any plugin directory.
- "Defaults apply" is computed per agent name, as
  `!ProviderRegistry.getProvider(provider)?.agentHooks?.[agentName]?.beforeRun`. Never hard-code
  `claude`.
- No `any`, explicit return types on exports, `logger.debug` (not `console`) for diagnostics.
- Commit messages follow Conventional Commits with an allowed scope (`agents`, `cli`), and end
  with the repo's attribution lines.
- Commit only when the user has authorized commits for this execution.

## Review Focus

1. **A settings `env` entry sets a declared variable to `""`.** It hides the shell and CodeMie
   values, so the row must `warn` with `Remove <name> from <path>`, never show `codemie default`.
   (Task 1)
2. **A settings layer is unreadable, or its `env` isn't an object.** Show an `info` line naming
   the file. Rows from other layers, the shell and defaults still render. (Tasks 1, 3)
3. **Settings values or paths contain terminal controls or URL credentials.** They are stripped
   before printing. (Task 1)
4. **Bedrock replaces the hook for `claude` only.** Claude Code shows one `not applied on bedrock`
   line, while Claude Code ACP shows full rows. (Tasks 1, 4)
5. **Agent-specific resolution throws.** If `describeLaunchConfig` or settings reading fails,
   that agent gets one `info` child, `launch config unavailable: <reason>`. The version line
   status is unchanged and doctor continues. (Task 4)

---

### Task 1: Core contract and launch-env helpers

**Files:**
- Modify: `src/agents/core/types.ts` (next to `lifecycle?` at :320 in `AgentMetadata`; optional
  methods next to `checkVersionCompatibility?` at :875 in `AgentAdapter`)
- Modify: `src/agents/core/BaseAgentAdapter.ts` (add `getLaunchEnvDefaults`)
- Create: `src/agents/core/launch-env.ts`
- Test: `src/agents/core/__tests__/launch-env.test.ts`

**Interfaces:**
- Produces (in `types.ts`):
  ```ts
  export interface LaunchEnvValue { value: string; from: 'codemie-default' | 'profile' }
  export interface LaunchEnvDefault {
    name: string;
    /** env is the environment BEFORE defaults; undefined = not set on this path. */
    value(env: NodeJS.ProcessEnv): LaunchEnvValue | undefined;
    why: string;
  }
  export interface LaunchSettingsLayer { path: string; state: 'ok' | 'absent' | 'unreadable'; env?: Record<string, unknown> }
  export type LaunchConfigStatus = 'ok' | 'warn' | 'error' | 'info';
  export interface LaunchConfigLine { status: LaunchConfigStatus; message: string; hint?: string }
  export interface LaunchConfigContext {
    shellEnv: NodeJS.ProcessEnv; provider?: string; profileName: string; cwd: string; defaultsApply: boolean;
  }
  // AgentMetadata:  launchEnvDefaults?: readonly LaunchEnvDefault[];
  // AgentAdapter:   getLaunchEnvDefaults?(): readonly LaunchEnvDefault[];
  //                 readLaunchSettingsLayers?(cwd: string, env: NodeJS.ProcessEnv): Promise<LaunchSettingsLayer[]>;
  //                 describeLaunchConfig?(ctx: LaunchConfigContext): Promise<LaunchConfigLine[]>;
  ```
- Produces (in `launch-env.ts`):
  - `applyLaunchEnvDefaults(env: NodeJS.ProcessEnv, defaults: readonly LaunchEnvDefault[]): void`
  - `defaultsApplyOnProvider(agentName: string, provider: string | undefined): boolean`
  - `describeLaunchEnv(defaults, input: { shellEnv: NodeJS.ProcessEnv; defaultsApply: boolean; settingsLayers: LaunchSettingsLayer[] }): LaunchEnvReport`
  - `export type LaunchEnvSource = 'settings' | 'shell' | 'profile' | 'codemie-default'`
  - `export interface LaunchEnvRow { name: string; effective: string; source: LaunchEnvSource; path?: string; codemieValue?: string }`
  - `export interface LaunchEnvReport { applied: boolean; rows: LaunchEnvRow[]; unreadable: string[] }`
  - `formatLaunchEnvReport(report: LaunchEnvReport, opts: { provider?: string; profileName: string }): LaunchConfigLine[]`

- [ ] **Step 1: Write the failing tests** in `launch-env.test.ts`, using a two-entry fixture list
  (`A`: always `{ value: '1', from: 'codemie-default' }`; `B`: `{ value: env.P ?? '85', from: env.P ? 'profile' : 'codemie-default' }`):
  - `applyLaunchEnvDefaults sets only unset or empty variables, in declaration order`. With
    `{ A: '', B: '70' }`, `A` becomes `'1'` and `B` stays `'70'`. A declaration whose `value`
    returns `undefined` leaves the variable absent (`'x' in env === false`).
  - `defaultsApplyOnProvider is false only when the provider has a beforeRun for that agent name`.
    Stub `ProviderRegistry.getProvider` to return `{ agentHooks: { claude: { beforeRun } } }`.
    Expect `('claude','bedrock') === false`, `('claude-acp','bedrock') === true` and
    `('claude', undefined) === true`.
  - `describeLaunchEnv precedence: settings > shell > profile/codemie default`. The highest layer
    is last in the array. Settings `{ A: '0' }` gives
    `{ name:'A', effective:'0', source:'settings', path, codemieValue:'1' }`. Shell `A=1` gives
    `source:'shell'` with no `codemieValue` (same value). Profile `P=70` gives `B` with
    `source:'profile'`.
  - `describeLaunchEnv: a variable nothing sets gets no row`.
  - `describeLaunchEnv: an unreadable layer or a non-object env is listed in unreadable and skipped`.
  - `describeLaunchEnv: defaultsApply=false gives { applied:false, rows:[] }`.
  - `formatLaunchEnvReport`. Messages are `A=1  codemie default`, `B=70  profile "work"`,
    `A=0  settings <path> (codemie: 1)` and `A=(empty)  settings <path>`. Statuses are `ok` for
    codemie default and profile, `info` for shell and settings overrides, and `warn` for an empty
    settings value, with hint `Remove A from <path>`.
    - An unreadable file gives `info` `Could not read <path>; its values are not shown`, with hint
      `Fix the JSON or the permissions of <path>`.
    - A report that isn't applied gives the single line
      `{ status:'info', message:'Launch defaults not applied on <provider>' }`.
  - `formatLaunchEnvReport strips terminal controls`. A path and value containing
    `\x1b]0;evil\x07` and `\x1b[31m` print without them.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/agents/core/__tests__/launch-env.test.ts`
  Expected: FAIL, cannot resolve `../launch-env.js`.

- [ ] **Step 3: Implement the types, `getLaunchEnvDefaults()` and `launch-env.ts`**

  - `BaseAgentAdapter.getLaunchEnvDefaults()` returns `this.metadata.launchEnvDefaults ?? []`.
  - In `describeLaunchEnv`, the settings source is the highest `state:'ok'` layer whose `env[name]`
    is neither `undefined` nor `null`, taken as `String(...)`, including `''`.
  - The shell source is a non-empty `shellEnv[name]`.
  - Otherwise use `value(shellEnv)`.
  - `codemieValue` is set only when `value(shellEnv)?.value` exists and differs from `effective`.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/agents/core/__tests__/launch-env.test.ts && npm run typecheck`
  Expected: PASS, with no type errors.

- [ ] **Step 5: Commit**

  ```bash
  git add src/agents/core/types.ts src/agents/core/BaseAgentAdapter.ts src/agents/core/launch-env.ts src/agents/core/__tests__/launch-env.test.ts
  git commit -m "feat(agents): declare agent launch env defaults and describe them"
  ```

### Task 2: Claude declares its launch env; `beforeRun` applies the declaration

**Files:**
- Create: `src/agents/plugins/claude/launch-env-defaults.ts`
- Modify: `src/agents/plugins/claude/prompt-cache.ts:20-40`
  - `TOOL_SEARCH_VERIFIED_PROVIDERS` moves out and is re-exported from here.
  - `claudeCacheDefaults` is derived from the declarations.
- Modify: `src/agents/plugins/claude/claude.plugin.ts`
  - `AUTO_MODE_SERVER_UNSUPPORTED_PROVIDERS` moves out of `:77`.
  - `launchEnvDefaults` is added to `ClaudePluginMetadata`.
  - The inline blocks at `:235-251` and `:276-349` are replaced.
- Test: `src/agents/plugins/claude/__tests__/launch-env-defaults.test.ts`. Existing tests stay
  green: `claude.plugin.prompt-cache.test.ts`, `claude.plugin.tool-search.test.ts`,
  `prompt-cache.test.ts`, and the other `claude.plugin.*` files.

**Interfaces:**
- Consumes: `LaunchEnvDefault` and `applyLaunchEnvDefaults` from Task 1.
- Produces:
  - `export const CLAUDE_LAUNCH_ENV_DEFAULTS: readonly LaunchEnvDefault[]`
  - `export const TOOL_SEARCH_VERIFIED_PROVIDERS: Set<string>`
  - `export const AUTO_MODE_SERVER_UNSUPPORTED_PROVIDERS: Set<string>`

  All three are exported from `launch-env-defaults.ts`. That file imports nothing from
  `prompt-cache.ts` or `claude.plugin.ts`.

- [ ] **Step 1: Write the failing tests** in `launch-env-defaults.test.ts`:
  - `declares exactly the eight variables in launch order`. The names, in this order:
    `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`, `ENABLE_PROMPT_CACHING_1H`,
    `CLAUDE_CODE_AUTO_MODE_SERVER`, `CLAUDE_CODE_ENABLE_TELEMETRY`, `DISABLE_AUTOUPDATER`,
    `FORCE_AUTOUPDATE_PLUGINS`, `ENABLE_TOOL_SEARCH`, `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`.
  - `values per provider` (`it.each` over `ai-run-sso`, `litellm`, `ollama`, `undefined`):
    - betas: `'0'` for providers in `TOOL_SEARCH_VERIFIED_PROVIDERS`, else `'1'`;
    - 1h: `'1'`;
    - auto-mode server: `'0'` for providers in `AUTO_MODE_SERVER_UNSUPPORTED_PROVIDERS`, else
      `undefined`;
    - telemetry: `'0'`;
    - autoupdater: `'1'`;
    - plugin auto-update: `'1'`;
    - tool search: `'true'` for verified providers, else `'0'`.
  - `autocompact comes from the profile when set`:
    - `CODEMIE_PROFILE_CONFIG='{"claudeAutocompactPct":70}'` gives `{ value:'70', from:'profile' }`;
    - no config, or malformed JSON, gives `{ value:'85', from:'codemie-default' }`.
  - `claudeCacheDefaults equals the first two declarations`. For each provider above, the result
    equals the values the betas and 1h declarations produce for the same env.
  - `beforeRun sets every declared variable to its declared value`. Run the Claude default
    `beforeRun` the way `claude.plugin.prompt-cache.test.ts` does, with its mocks, on
    `{ CODEMIE_PROVIDER: 'ai-run-sso' }`. For each declaration with a defined value, `env[name]`
    must equal it. A pre-set `ENABLE_TOOL_SEARCH='0'` is kept.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/agents/plugins/claude/__tests__/launch-env-defaults.test.ts`
  Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

  - Write `launch-env-defaults.ts`. Move each inline block's comment (why, opt-out, doc link)
    onto its declaration's `why` and a JSDoc above it.
  - In `prompt-cache.ts`, re-export `TOOL_SEARCH_VERIFIED_PROVIDERS`. Implement
    `claudeCacheDefaults(env)` by evaluating only the two cache declarations, and only for keys
    that are unset or empty in `env`.
  - In `ClaudePluginMetadata`, set `launchEnvDefaults: CLAUDE_LAUNCH_ENV_DEFAULTS`.
  - In `beforeRun`, delete `Object.assign(env, claudeCacheDefaults(env))` and the six later
    blocks. Call `applyLaunchEnvDefaults(env, CLAUDE_LAUNCH_ENV_DEFAULTS)` once, right after the
    prompt-cache debug-log `try/catch`, which ends around `:274`.
  - Add a one-line comment there: the debug log resolves from `shellEnv`, so applying after it
    is equivalent.
  - Keep the `toolSearchVerified` local only if something else still reads it; otherwise remove it.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/agents/plugins/claude src/agents/plugins/claude-code-otlp && npm run typecheck`
  Expected: PASS. All previously passing Claude plugin tests still pass.

- [ ] **Step 5: Commit**

  ```bash
  git add src/agents/plugins/claude/launch-env-defaults.ts src/agents/plugins/claude/prompt-cache.ts src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/claude/__tests__/launch-env-defaults.test.ts
  git commit -m "refactor(agents): apply Claude launch env from one declaration"
  ```

### Task 3: Claude's settings layers and derived launch-config lines

**Files:**
- Create: `src/agents/plugins/claude/launch-config-report.ts`. Its logic moves from
  `src/cli/commands/doctor/checks/PromptCacheCheck.ts:24-93`: `CONFIRM_DETAIL`, `removalHint`,
  `decidedByText`, `outcomeDetail`.
- Modify: `src/agents/plugins/claude/claude.plugin.ts`. Add the class methods
  `readLaunchSettingsLayers` and `describeLaunchConfig`. `ClaudeAcpPlugin` inherits them.
- Test: `src/agents/plugins/claude/__tests__/launch-config-report.test.ts`

**Interfaces:**
- Consumes: `LaunchConfigContext`, `LaunchConfigLine`, `LaunchSettingsLayer` (Task 1);
  `resolvePromptCacheSetup` and `describePromptCacheSource` (`prompt-cache.ts`);
  `readClaudeSettingsLayers(cwd, env)` (`claude-settings-env.ts:66`).
- Produces:
  - `describeClaudeLaunchConfig(ctx: LaunchConfigContext, agentName: string): Promise<LaunchConfigLine[]>`
  - `toLaunchSettingsLayers(layers: ClaudeSettingsLayer[]): LaunchSettingsLayer[]`. A layer whose
    `settings.env` is present but isn't a plain object becomes `state:'unreadable'`, matching
    `untrustedLayer`.
  - On `ClaudePlugin`, `readLaunchSettingsLayers(cwd, env)` returns
    `toLaunchSettingsLayers(await readClaudeSettingsLayers(cwd, env))`, and
    `describeLaunchConfig(ctx)` returns `describeClaudeLaunchConfig(ctx, this.metadata.name)`.

- [ ] **Step 1: Write the failing tests**

  Move these cases from `PromptCacheCheck.test.ts`, keeping their names and assertions. Each one
  calls `describeClaudeLaunchConfig(ctx, 'claude')` with `resolvePromptCacheSetup` mocked as in
  the original file:
  - `resolves from the current shell and directory, with CodeMie defaults on`
  - `hands the shell environment to the resolver`
  - `is info "not confirmed" on bedrock when the shell asks for 1h`
  - `warns when a settings file blanks the variable, naming the file to edit`
  - `strips terminal control sequences from repository-controlled names, values and paths`
  - `is ok on a clean ai-run-sso profile, naming the source`
  - `is info "not confirmed" on a clean ollama profile`
  - `reports the bedrock gap as info and resolves without CodeMie defaults`
  - `warns when a shell variable forces 5m, naming the variable and how to remove it`
  - `warns when a settings file decides, naming the key and the file`
  - `warns when prompt caching is disabled`
  - `warns when a settings file is unreadable, naming the file to fix`
  - `adds a warning for a subagent override that is not 1h`
  - `says nothing extra about a subagent override of 1h`
  - `never claims a cost effect`

  Add:
  - `the confirm hint names the launching agent's command`. For `'claude-acp'` the last line
    contains `codemie-claude-acp -p "hi" --output-format json`; for `'claude'` it contains
    `codemie-claude -p`.
  - `toLaunchSettingsLayers maps env and marks a non-object env unreadable`.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/agents/plugins/claude/__tests__/launch-config-report.test.ts`
  Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement**

  - Move the functions unchanged, except: `codemieDefaults` becomes `ctx.defaultsApply`, the
    provider comes from `ctx.provider`, and the confirm command is `codemie-${agentName}`.
  - The resolver call is
    `resolvePromptCacheSetup({ env: { ...ctx.shellEnv, CODEMIE_PROVIDER: ctx.provider }, codemieDefaults: ctx.defaultsApply, cwd: ctx.cwd })`.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/agents/plugins/claude && npm run typecheck`
  Expected: PASS.

- [ ] **Step 5: Commit**

  ```bash
  git add src/agents/plugins/claude/launch-config-report.ts src/agents/plugins/claude/claude.plugin.ts src/agents/plugins/claude/__tests__/launch-config-report.test.ts
  git commit -m "feat(agents): report Claude launch config and prompt-cache TTL per agent"
  ```

### Task 4: Doctor renders launch config under Installed Agents; remove `PromptCacheCheck`

**Files:**
- Modify: `src/cli/commands/doctor/types.ts:15-19`. `HealthCheckDetail` gets
  `children?: HealthCheckDetail[]`.
- Modify: `src/cli/commands/doctor/formatter.ts`. `displayItem`, `displayCheck` and
  `displayCheckWithHeader` render children through one private `printDetail(detail, depth)`. The
  top level keeps its current spacing; depth 1 is indented 6 spaces with its hint at 10.
- Modify: `src/cli/commands/doctor/checks/AgentsCheck.ts`
- Delete: `src/cli/commands/doctor/checks/PromptCacheCheck.ts` and
  `src/cli/commands/doctor/checks/__tests__/PromptCacheCheck.test.ts` (cases already moved in
  Task 3).
- Modify: `src/cli/commands/doctor/checks/index.ts` (remove the export) and
  `src/cli/commands/doctor/index.ts:20,104` (remove the import and registration).
- Test: `src/cli/commands/doctor/checks/__tests__/doctor-checks.test.ts` (`describe('AgentsCheck')`)
  and `tests/integration/cli-commands/doctor.test.ts:52-55`.

**Interfaces:**
- Consumes: from Task 1, `defaultsApplyOnProvider`, `describeLaunchEnv` and
  `formatLaunchEnvReport`; from adapters, `getLaunchEnvDefaults?`, `readLaunchSettingsLayers?`
  and `describeLaunchConfig?`.

- [ ] **Step 1: Write the failing tests** in `describe('AgentsCheck')`, with
  `ConfigLoader.load` mocked to `{ name: 'work', provider: 'ai-run-sso', claudeAutocompactPct: 70 }`:
  - `nests launch-env rows under an agent that declares them`. A fake adapter declares `A`, and
    its detail has `children[0].message === 'A=1  codemie default'`.
  - `appends the agent's describeLaunchConfig lines after the env rows`.
  - `an agent without declarations has no children`.
  - `names the profile and directory once, before the agents`. The first detail is
    `info Profile "work", evaluated in <cwd>`, and it appears only when an agent has launch config.
  - `on a provider that replaces the agent's beforeRun, shows one not-applied child for that agent only`.
    With provider `bedrock` stubbed with `agentHooks.claude.beforeRun`, the `claude` agent has
    exactly `[{ status:'info', message:'Launch defaults not applied on bedrock' }]` plus its
    `describeLaunchConfig` lines. `claude-acp` has full rows.
  - `inside a CodeMie session, adds one info line about inherited variables`. When
    `CODEMIE_WRAPPER_PID` is set, a top-level
    `info 'Running inside a CodeMie agent session: launch variables are inherited; run doctor from a plain terminal for a clean reading'`
    appears.
  - `a failing describeLaunchConfig becomes one info child and leaves the version status unchanged`.
    The child reads `launch config unavailable: <message>`, and the parent status stays `ok`.
  - `a failing ConfigLoader.load() becomes one warning and agents still list (Review Focus 5)`.
    There is one top-level `warn` and no children, and `success` is `true`.
  - `runWithItemDisplay passes children through onDisplayItem`.

  Integration (`doctor.test.ts:52-55`): replace `/Claude Prompt Cache/` with
  `expect(output).not.toMatch(/Claude Prompt Cache/)`. If `output` matches `/Claude Code \(/`,
  also expect `/ENABLE_PROMPT_CACHING_1H=/`.

- [ ] **Step 2: Run the tests and confirm they fail**

  Run: `npx vitest run src/cli/commands/doctor`
  Expected: FAIL on the new `AgentsCheck` cases.

- [ ] **Step 3: Implement**

  In `AgentsCheck`, build the context once per run:
  - `shellEnv = process.env`
  - `{ provider, name: profileName } = await ConfigLoader.load()`
  - `cwd = process.cwd()`
  - `launchEnv = { ...shellEnv, CODEMIE_PROVIDER: provider, CODEMIE_PROFILE_CONFIG: shellEnv.CODEMIE_PROFILE_CONFIG || JSON.stringify(config) }`

  Then, per agent:
  - Compute `defaultsApply = defaultsApplyOnProvider(agent.name, provider)`.
  - Build the rows from `describeLaunchEnv` and `formatLaunchEnvReport`, followed by
    `describeLaunchConfig` lines, as `children` of `buildDetail`'s result.
  - Wrap the per-agent part in try/catch for Review Focus 5.
  - Call `logger.debug` with `sanitizeLogArgs` on failure.

  Finally, delete `PromptCacheCheck` and its registration, and update the integration assertion.

- [ ] **Step 4: Run the tests and confirm they pass**

  Run: `npx vitest run src/cli/commands/doctor src/agents && npm run lint && npm run typecheck`
  Expected: PASS, with zero lint warnings.

  Run (alone, outside an agent session if possible):
  `npx vitest run --project cli tests/integration/cli-commands/doctor.test.ts`
  Expected: 7/7 PASS.

- [ ] **Step 5: Manually check the real output**

  Run `npm run build && node bin/codemie.js doctor` from a plain terminal. Under Installed Agents,
  Claude Code shows indented `NAME=value  source` rows, then the TTL line and the confirm hint.
  No `Claude Prompt Cache` section appears.

- [ ] **Step 6: Commit**

  ```bash
  git add -A src/cli/commands/doctor tests/integration/cli-commands/doctor.test.ts
  git commit -m "feat(cli): show agent launch config under installed agents in doctor"
  ```
