# Agent launch config in `codemie doctor` — design

Date: 2026-11-16 · Branch: `fix/claude-prompt-cache-1h-ttl` · Status: for approval (builder-checked)

## Intent

`codemie doctor` should show, for each installed agent, the configuration CodeMie applies when it
launches that agent: every environment variable the launcher sets, its effective value, and where
that value came from. Today the only such view is a standalone "Claude Prompt Cache" check. The
user finds that confusing: agent config belongs under the agent, and prompt cache is just one of
several variables `codemie-claude` overrides. Auto-compaction, tool search, telemetry and the
auto-updater are others.

The solution has to plug in. Each agent plugin declares what it sets, and doctor renders whatever
the plugin declares, with no agent-specific code in doctor. Doctor and launch must read the same
declaration, so doctor can never show a value launch doesn't actually set.

This replaces the standalone `PromptCacheCheck` on this branch, before the prompt-cache PR is
opened, so `main` never gets the rejected UX.

## Goals

- Under **Installed Agents**, each agent that declares launch config shows indented rows beneath
  its version line.
- One row per declared variable: name, effective value, source. If the shell overrides the
  CodeMie value, the row shows both.
- Claude declares every variable its default `beforeRun` sets with the "only when unset" rule.
  Those are:
  - `ENABLE_PROMPT_CACHING_1H`
  - `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS`
  - `CLAUDE_CODE_AUTO_MODE_SERVER`
  - `CLAUDE_CODE_ENABLE_TELEMETRY`
  - `DISABLE_AUTOUPDATER`
  - `FORCE_AUTOUPDATE_PLUGINS`
  - `ENABLE_TOOL_SEARCH`
  - `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`
- The Claude launch hook applies those variables from the declaration rather than from inline
  `if (!env.X)` blocks. The values, provider conditions and precedence stay identical.
- Claude adds one derived line: the resolved prompt-cache TTL and what decided it (shell, settings
  file, CodeMie default), plus the subagent-TTL warning. This reuses the existing
  `resolvePromptCacheSetup`.
- `PromptCacheCheck` and its doctor entry are removed. Its behaviors move to the new place:
  - terminal-control stripping
  - "not confirmed" on providers that replace the hook
  - the settings-blanking warning
  - ~~the `codemie-claude -p … --output-format json` confirm hint~~ (dropped after user review)

## Non-goals

- Showing the full agent environment or provider/auth variables (`ANTHROPIC_BASE_URL`, tokens,
  model IDs). Settings files are read only to find each declared variable's effective value.
  Doctor never dumps their contents.
- Launch-time state that isn't a plain env default: statusline refresh, model-picker temp files,
  router model IDs, subagent model warnings.
- Changing any default value or launch behavior.
- New doctor flags (no `--agent`, no `--section`).
- Migrating the other agents' defaults in this change. The contract is generic, and Copilot CLI,
  Codex, OpenCode and OpenWiki can declare theirs later (see Calls made).

## Anti-goals: failure even if it works

- Doctor shows a value that differs from what `codemie-claude` would actually set.
- Doctor runs `beforeRun` or causes any side effect: file writes, network calls, printed warnings.
- Doctor prints a secret, or prints repository-controlled text without stripping terminal controls.
- A plugin that declares nothing breaks or clutters the agent line.

## Constraints

- Plugin architecture (`CLI → Registry → Plugin`): doctor gets declarations through
  `AgentRegistry` and the adapter, never by importing `claude.plugin.ts` internals.
- Provider hooks (`src/agents/core/lifecycle-helpers.ts` `resolveHook`):
  - A provider with an agent-specific `beforeRun` for `claude` (bedrock) **replaces** the agent's
    default hook, so the declared defaults don't apply there.
  - A provider `'*'` wildcard hook runs **before** the agent default and may set variables first.
    Today the claude-relevant wildcards are anthropic-subscription, bedrock, moonshot and ollama.
    sso and jwt also have one, through `defaultAgentHooks`
    (`src/providers/core/default-agent-hooks.ts:18-19`), and sso is the default provider. That
    wildcard installs the extension and sets `CODEMIE_<AGENT>_EXTENSION_DIR`. None of these
    wildcards sets any of the declared variables.
  - The bedrock replacement is keyed to `claude` only (`bedrock.template.ts:90`). So
    "defaults apply" must be computed per agent name: `defaultsApplyOnProvider(agent.name, provider)`.
    It must not hard-code `claude` the way `PromptCacheCheck.ts:44` does.
- `claude-acp` shares Claude's default `beforeRun`: it spreads `...ClaudePluginMetadata`
  (`claude-acp.plugin.ts:18`), `ClaudeAcpPlugin extends ClaudePlugin` (`:64`), and the hook is bound
  to the launching adapter (`claude.plugin.ts:221-224`). Declarations on the metadata therefore
  reach both agents, which is correct, because both launches set them.
- Today the variables are set in two places. The cache pair is set at `claude.plugin.ts:251`,
  before the prompt-cache debug log (255-274), and the other six after it (280-349). A single
  `applyLaunchEnvDefaults` call after the debug log is safe, because that log resolves from
  `shellEnv`, not from the mutated `env`. The plan must say this explicitly.
  - `PromptCacheCheck` already derives "defaults apply" from
    `ProviderRegistry.getProvider(p)?.agentHooks?.claude?.beforeRun`. Keep that rule and move it
    into the shared helper.
- The autocompact value depends on the active profile (`claudeAutocompactPct` via
  `CODEMIE_PROFILE_CONFIG`). Doctor must evaluate with the active profile from `ConfigLoader.load()`.
- Repo conventions: ES modules with `.js` imports, the `@/` alias, `logger` (not `console`) for
  debug, explicit return types, no `any`, and `sanitizeLogArgs` for logged values.

## Approaches

Three were considered. The user picked **A**.

- **A. Declared launch defaults per plugin (chosen).** The plugin declares its env defaults as
  data. `beforeRun` applies them through a shared helper, and doctor reads the same list. An
  optional per-plugin hook adds derived lines.
  - Pro: launch and doctor can't drift, and new agents plug in by declaring.
  - Con: refactors Claude's `beforeRun`.
- **B. A per-plugin doctor hook only.**
  - Pro: smallest diff.
  - Con: every rule exists twice and drifts. Rejected.
- **C. Dry-run `beforeRun` and diff the env.**
  - Pro: exact.
  - Con: `beforeRun` has side effects (statusline, temp files, network, warnings) and can't
    separate a profile value from a CodeMie default. Rejected.

## Design (decided parts)

### 1. Contract: `src/agents/core/types.ts`

```ts
/** One environment variable an agent's launcher sets when it is unset. */
export interface LaunchEnvDefault {
  name: string;
  /** What CodeMie would set, given the env before defaults; undefined = not set on this path. */
  value(env: NodeJS.ProcessEnv): { value: string; from: 'codemie-default' | 'profile' } | undefined;
  /** One line: why CodeMie sets it. Shown nowhere by default; available to verbose/debug. */
  why: string;
}
```

Hang it on the agent's metadata (`AgentMetadata.launchEnvDefaults?: readonly LaunchEnvDefault[]`),
next to `envMapping`. Add an optional adapter method for derived lines:

```ts
describeLaunchConfig?(ctx: LaunchConfigContext): Promise<HealthCheckDetail[]>;
```

`LaunchConfigContext` contains the shell env, the provider, the profile name, `cwd`, and
`defaultsApply`. The method's result type lives in `src/agents/core/types.ts`, not in doctor, so
agents don't depend on the CLI layer. Its shape mirrors `HealthCheckDetail`.

### 2. Shared helpers: `src/agents/core/launch-env.ts` (new)

- `applyLaunchEnvDefaults(env, defaults): void` sets each declared variable only when `env[name]`
  is unset or empty, in declaration order. This is the same rule as today's inline blocks.
- `defaultsApplyOnProvider(agentName, provider): boolean` is moved from `PromptCacheCheck`.
- `describeLaunchEnv(defaults, { shellEnv, defaultsApply, settingsLayers }): LaunchEnvRow[]` is
  pure. The settings layers are passed in, already read by the caller. A row shows **what the
  agent ends up running with**, not only what CodeMie sets (decided by the user, 2026-11-16).
  Each row is `{ name, effective, source, path?, codemieValue? }`. `source` is the first that
  applies, in this order:
  - `settings` (with `path`): the agent's settings `env` block sets it. Claude Code applies that
    block over the process environment. Includes `codemieValue` when CodeMie's launch value
    differs, e.g. `CLAUDE_CODE_ENABLE_TELEMETRY=1  settings ~/.claude/settings.json (codemie: 0)`,
    which is what users of the OTLP connector see.
  - `shell`: set before launch. Includes `codemieValue` when CodeMie would have set something
    different.
  - `profile`
  - `codemie-default`
  - `not-applied`: the provider replaces the hook (rendered as one line per agent, see Calls made).
  - `unset`: nothing sets it on this path. Gets no row.

  Settings handling reuses the existing machinery:
  - layer order and the reader: `readClaudeSettingsLayers`;
  - unreadable files and a settings entry that blanks a variable: handled the same way the
    prompt-cache resolver handles them. An unreadable layer gives an `info` row naming the file;
    a blanked variable gives a `warn` with `Remove <name> from <path>`.

  So the env rows and the TTL line always agree on the cache variables. Settings layers are
  agent-specific, so the agent supplies them: add an optional `readLaunchSettingsLayers?(cwd)`
  next to `describeLaunchConfig` on the adapter, and Claude implements it with
  `readClaudeSettingsLayers`. An agent that doesn't implement it gets no `settings` source.
  Every value and path read from settings goes through `safeTerminalValue`.

### 3. Claude plugin

- In `claude.plugin.ts` (or a sibling `launch-env-defaults.ts`), declare the eight variables in the
  current order. Move the existing comments (why, opt-out, doc links) onto the declarations.
- `claudeCacheDefaults` becomes two declarations, or feeds them. `resolvePromptCacheSetup` keeps
  using the same source.
- `beforeRun` calls `applyLaunchEnvDefaults(env, CLAUDE_LAUNCH_ENV_DEFAULTS)` exactly where the
  inline blocks were. Statements around them stay where they are: the cache debug log, the
  statusline refresh, and everything after.
- `describeLaunchConfig` takes over everything `PromptCacheCheck` prints today, moved unchanged
  except that the command is named per agent:
  - the TTL outcome, with its `ok`/`info`/`warn` statuses;
  - the removal hints (`removalHint`, `decidedByText`): "unset X", "Remove key from <path>",
    "Fix the JSON…";
  - the bedrock "known gap" message;
  - the subagent-TTL warning;
  - ~~the confirm hint~~ (dropped after user review, 2026-11-16).

  Every existing `PromptCacheCheck.test.ts` case moves with it and stays green. Only assertions
  about the check's own name or header change. The `Profile "<name>", evaluated in <cwd>` line
  moves up one level: it prints once, at the top of Installed Agents, not once per agent.

### 4. Doctor

- `AgentsCheck.buildDetail` keeps the version line. For each agent with declarations it appends
  indented child rows from `describeLaunchEnv`, then the plugin's `describeLaunchConfig` lines.
  The environment is `process.env` plus the active profile from `ConfigLoader.load()`.
- `HealthCheckDetail` gets an optional `indent?: number`, or `children?: HealthCheckDetail[]`; the
  builder picks one. The formatter renders it in both the item-wise and the batch path.
- Every printed name, value and path goes through `safeTerminalValue` (`src/utils/terminal-text.ts`).
- Remove `PromptCacheCheck` (file, export, registration in `doctor/index.ts`, and its test). Move
  its test cases to the new helper and adapter tests. The doctor integration assertion changes from
  "Claude Prompt Cache" to a row under Installed Agents.
- If launch-config resolution fails for one agent, show a single `info` row ("launch config
  unavailable: <reason>"). It never fails the agent check.

### Target output

Revised 2026-11-16 after user review:
- The billing-check line is removed.
- Each row reads `NAME = value  source`, aligned under one header, so the value in effect is
  unmistakable.
- The variables that can shorten, override or disable the cache are watched rows, shown only
  when set: `FORCE_PROMPT_CACHING_5M`, `CLAUDE_CODE_PROMPT_CACHE_TTL`,
  `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and `DISABLE_PROMPT_CACHING[_HAIKU|_SONNET|_OPUS]`.
- A `Prompt cache:` line appears only when the rows alone don't tell the outcome: another TTL won,
  a settings key decided, the TTL can't be verified on this provider, the known gap applies, or
  there's a subagent override. A verified 1h set by a row variable gets no extra line.

```
Installed Agents
  ○ Profile "work", evaluated in /proj
  ⚠ Claude Code (2.1.322) - CodeMie recommends v2.1.281
      codemie install claude --supported
      ○ Environment at launch (value in effect, then where it comes from):
          ✓ CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = 0     CodeMie default
          ✓ ENABLE_PROMPT_CACHING_1H               = 1     CodeMie default
          ○ CLAUDE_CODE_ENABLE_TELEMETRY           = 1     ~/.claude/settings.json, overrides CodeMie's 0
          ○ ENABLE_TOOL_SEARCH                     = 0     your shell, overrides CodeMie's true
          ✓ CLAUDE_AUTOCOMPACT_PCT_OVERRIDE        = 70    profile "work"
          ○ FORCE_PROMPT_CACHING_5M                = 1     your shell
      ⚠ Prompt cache: 5m TTL (set by FORCE_PROMPT_CACHING_5M=1, from shell)
          unset FORCE_PROMPT_CACHING_5M
  ✓ Gemini CLI (0.9.0)
```

On bedrock, the env rows read `not applied on bedrock`, and the TTL line is
`info Prompt cache: 1h TTL requested, not verified on this provider`.

## Left to the builder

- `indent` vs `children` on `HealthCheckDetail`, and the exact column alignment.
- Whether the declarations live in `claude.plugin.ts` or a sibling module.
- Whether `why` is shown under `--verbose`.
- Test layout, beyond keeping every existing prompt-cache and launch-hook assertion green.

## Calls made (not discussed; correct me)

- Only Claude declares in this change. The other plugins with env defaults (copilot-cli 2,
  codex 1, opencode 1, openwiki 1) are a follow-up.
- `claude-acp` shows its own block when it's installed. Its launch really does set these
  variables, and on bedrock its rows legitimately differ from Claude's (defaults apply to ACP).
- Rows show only variables that have a value on this path. A variable nothing sets (for example
  `CLAUDE_CODE_AUTO_MODE_SERVER` off `ai-run-sso`) gets no row. When the provider replaces the
  hook, the block is a single `not applied on <provider>` line instead of eight rows.
- When doctor runs inside a CodeMie agent session (`CODEMIE_WRAPPER_PID` set), every launch
  variable is inherited and would read `shell`. Doctor adds one `info` line saying so and
  suggesting a plain terminal for a clean reading.
- Wildcard provider hooks are not modelled. None sets a declared variable today. If one starts
  to, its value shows as `codemie-default`/`unset` rather than `provider`.
- Agent rows always show in plain `codemie doctor`, with no flag needed.

## Additions after user review (2026-11-16)

- `codemie doctor --profile <name>` evaluates launch config for that profile. Without the flag it
  uses the active profile. The profile line at the top of Installed Agents names it.
- **Provider-specific values live with the provider**, following the documented rule ("agents
  provider-agnostic; providers register hooks for the agents they customize"):
  - `ProviderLifecycleHooks.env` is a side-effect-free map under the provider's existing per-agent
    hook entry, e.g. `agentHooks.claude.env`.
  - `executeBeforeRun` applies it before any `beforeRun` hook, only where a variable is unset, so
    the shell wins. It does not replace the agent's default hook.
  - Doctor reads the same map and labels the row `provider <name>`.
- **Claude's defaults are provider-neutral and gateway-safe.** The values are
  `ENABLE_TOOL_SEARCH=0`, `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` and no
  `CLAUDE_CODE_AUTO_MODE_SERVER`, plus the 1h cache, telemetry, auto-updaters and autocompact.
  `TOOL_SEARCH_VERIFIED_PROVIDERS` and `AUTO_MODE_SERVER_UNSUPPORTED_PROVIDERS` (both already on
  `main`) and `DIRECT_ANTHROPIC_PROVIDERS` are removed.
- **Provider declarations**, for both `claude` and `claude-acp`:
  - `ai-run-sso`: tool search `true`, betas `0`, auto-mode server `0`.
  - `litellm`: tool search `true`, betas `0`.
  - `anthropic-subscription`: tool search `true`, betas `0`.
  - `jwt`, `ollama`, `bedrock`: none, so their behavior is unchanged.
- **Measured on the same model and prompt:**
  - `anthropic` profile before: 21,466 uncached input tokens per request, 131,073 total.
  - After: 4 uncached, 94,146 total.
  - Plain `claude`: 93,594 total.
  - `ai-run-sso` is unchanged: 114,390 total, 4 uncached.
- **Prompt-cache resolver removed** (follow-up review, 2026-11-16).
  - Deleted: `prompt-cache.ts`, `launch-config-report.ts`, the `[claude] prompt cache` launch debug
    line, and the `describeLaunchConfig` agent hook.
  - Why: the environment rows already show every cache variable, its value and its source. The
    resolver's remaining job, choosing a winning TTL when variables conflict, rested on a
    precedence order nobody had verified against Claude Code.
  - Now: doctor lists every cache variable and the `promptCacheTtl` / `subagentPromptCacheTtl`
    settings keys (via `settingsKey` declarations) that are set, and leaves the precedence to
    Claude Code.
