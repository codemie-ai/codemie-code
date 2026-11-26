# Technical Research

**Task**: profile status config env model banner
**Generated**: 2026-11-25
**Research path**: filesystem

---

## 1. Original Context

User request (verbatim): "lets implement the fix then. what ticket asks for: all ACs except for #5"

Ticket EPMCDME-17853 (Bug, CLI 0.17.2 fix version): "codemie profile status and codemie-claude show different models for the same active profile".
Summary: the model shown in the codemie-claude launch banner differs from the model `codemie profile status` shows for the same active profile, run in the same directory. Users can't tell which model their session uses, and `codemie profile switch` doesn't change it.

Acceptance criteria in scope (AC #5, printing the CLI version in profile status, is OUT of scope):
1. Given the effective model comes from the CODEMIE_MODEL environment variable, when the user runs `codemie profile status`, then the output shows the model a launch would actually use and marks the override. Example: `claude-opus-4-8[1m] (CODEMIE_MODEL env overrides profile: claude-sonnet-5-5)`.
2. Given the override comes from the shell or from a .env file, when `codemie profile status` shows the override, then it says which of the two it came from.
3. Given the model came from an environment variable, when codemie-claude prints its launch banner, then the banner marks the model as coming from an environment variable. It uses the source already recorded in CODEMIE_MODEL_SOURCE (AgentCLI.ts, ~line 437-443 in current code).
4. Given no environment variable overrides the profile model, when the user runs `codemie profile status` and `codemie-claude` in the same directory, then both show the same model and neither shows an override marker.
6. Tests cover the override from a shell environment variable, the override from a .env file, and the no-override case.

Already confirmed by investigation and a manual reproduction (verify, don't redo from scratch):
- ConfigLoader.load() (src/utils/config.ts ~141-262) loads <envDir>/.env via dotenv.config (does NOT override existing process.env keys, so an existing even-empty CODEMIE_MODEL wins over .env), then loadFromEnv() (~619) applies CODEMIE_MODEL over the profile unless a profile name is passed explicitly (cliOverrides.name filters model/provider/baseUrl/apiKey/etc. out of env).
- Plain `codemie profile status` (handleStatus in src/cli/commands/profile/index.ts ~116) calls ConfigLoader.load() but prints the model from ConfigLoader.listProfiles() (stored profile) via ProfileDisplay.formatStatus (src/cli/commands/profile/display.ts ~127) -> renderProfileInfo (src/utils/profile.ts). It never shows an override.
- `codemie profile status --show-sources` uses ConfigLoader.loadWithSources() (config.ts ~1538) and showWithSources() (~1660). It marks values from shell env as `(env)` but does NOT load .env, so a .env override is reported as `(project)` — reproduced. This must be fixed for AC 2.
- Banner: BaseAgentAdapter.ts ~636-660 prints env.CODEMIE_MODEL via renderProfileInfo before the plugin beforeRun hook (~678). AgentCLI sets CODEMIE_MODEL_SOURCE = cli|env|default (~440); only claude.models.ts reads it. The banner shows no source.
- Existing precedent for marking a value's source in the same display: describeProjectBinding() (src/utils/project-binding.ts:46) adds "(shared fallback)" to the Project line text, used by both banner and profile status.
- The launcher reads config from findNearestConfigDir(cwd) (walks up to git root) with envDir = process.cwd(); profile status uses process.cwd() for both.
- There is no way today to distinguish "came from shell" vs "came from .env": dotenv merges into process.env.
Open design points to research: where to capture shell-vs-.env provenance (snapshot process.env before dotenv.config?), how the banner learns it (CODEMIE_MODEL_SOURCE values, e.g. 'env' vs 'dotenv'?), whether 'env' should be marked when the env value equals the profile value (AC 4 says no marker when nothing overrides), CODEMIE_MODEL_SOURCE consumers that must keep working (claude.models.ts EXPLICIT_MODEL_SOURCES = cli, env), other agents' banners (all share BaseAgentAdapter), existing tests for config loading / profile status / banner and their patterns.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose A: tell the user which model a launch uses and where it came from.**
- `ConfigLoader.load()` — `src/utils/config.ts:141-265`. Layers: defaults → global profile → local profile → workspace/identity → `.env` (`dotenv.config({ path: <envDir>/.env })`, `:197-203`) → `loadFromEnv()` (`:204`) → CLI overrides (`:260`). With `cliOverrides.name` set, env `model/provider/baseUrl/apiKey/codeMieUrl/authMethod/codeMieIntegration` are dropped unless the same field is in `cliOverrides` (`:214-253`). Returns a plain `CodeMieConfigOptions`; no provenance. ~25 callers (AgentCLI `:235`, `copilot-cli.launch-env.ts:14`, `identity-fields.ts:218-219`, `hook-auth-profile.ts:72`, profile/auth, doctor, models, assistants, proxy connect).
- `ConfigLoader.loadFromEnv()` — `config.ts:619-659`, private. Reads `process.env.CODEMIE_MODEL` only when truthy (`:631`), so an empty string is "no override" here, yet still blocks `.env` from filling the key (dotenv never overwrites an existing key). Consumers: `load()` `:204`, `loadWithSources()` `:1594`, `getEnvOverrides()` `:1780`.
- `ConfigLoader.loadWithSources()` — `config.ts:1538-1655`. Builds per-key `{value, source}` from layers `default/global/project/<workspace>/<identity>/env/cli`, last wins (`:1639-1645`). `envLayer = this.loadFromEnv()` at `:1594` runs **before** `this.load()` at `:1648`, which is where `.env` gets merged — so `.env` values are absent from `envLayer` (confirms the reproduced `(project)` mislabel). Also does not apply the `cliOverrides.name` env filtering that `load()` applies. Source type `ConfigWithSource.source = 'default'|'global'|'project'|'profile'|'env'|'cli'` (`src/env/types.ts:219-222`). Consumers: `showWithSources()`, `config-project-override.test.ts`, `config-per-profile-identity.test.ts`.
- `ConfigLoader.showWithSources()` — `config.ts:1660-1695`; prints `key: value (source)`, colours via `getSourceColor()` (`:1765-1775`, `env` = green). Only caller: `handleStatusWithSources()` `src/cli/commands/profile/index.ts:178`.
- `handleStatus()` — `profile/index.ts:116-172`. Calls `ConfigLoader.load(workingDir)` (`:118`, used only for provider/auth), then prints `activeProfileInfo` from `listProfiles()` via `ProfileDisplay.formatStatus()` (`display.ts:113-144`), which passes `profile.model || 'N/A'` (`display.ts:130`) — stored model, never the effective one.
- `renderProfileInfo()` — `src/utils/profile.ts:17-107`; `model` row is the raw string (`:55-57`). Only special-casing of a value is the Project row colour, yellow when the text ends in `(shared fallback)` / `(no project selected)` (`:61-63`). Callers: `BaseAgentAdapter.ts:649` (banner), `display.ts:46` (`format`, list view) and `display.ts:127` (`formatStatus`).
- Banner — `src/agents/core/BaseAgentAdapter.ts:635-673`. Reads `env.CODEMIE_MODEL` (`:639`), where `env = {...process.env, ...envOverrides}` (`:602-604`). Runs before `transformEnvVars` (`:676`) and `executeBeforeRun` (`:680`), so a model that Claude's beforeRun auto-heal later replaces is not reflected. Shared by every agent that is not `silentMode`.
- `CODEMIE_MODEL_SOURCE` producer — `src/agents/core/AgentCLI.ts:440-444`: `options.model ? 'cli' : process.env.CODEMIE_MODEL ? 'env' : 'default'` (also an earlier `'cli'` assignment at `:416-418`). `process.env.CODEMIE_MODEL` here is read after `ConfigLoader.load()` merged `.env`, so `.env` and shell both yield `'env'`. It does not check whether `load()` filtered the env model out (explicit `--profile`) or whether the env value equals the profile value.
- Second producer — `bin/codemie-copilot.js:98-101,118,182,193`: `resolveInitialModelSource()` → `'cli'` / `hasEnvModelOverride()` (`Boolean(process.env.CODEMIE_MODEL)`, `:67-69`) → `'env'`.

**Purpose B: mark a displayed value with where it came from (both banner and profile status).**
- `describeProjectBinding()` — `src/utils/project-binding.ts:46-61`: appends `(shared fallback)` / returns `none (no project selected)`; used by `BaseAgentAdapter.ts:642` and `profile/index.ts:21`. `bindingLabel()` (`:64`) is the short label `--show-sources` prints.
- Shell-vs-`.env` provenance: none found. Searched `dotenv`, `loadFromEnv`, `CODEMIE_MODEL_SOURCE`, `ConfigWithSource` across `src/` and `bin/`. `dotenv.config()` return value is discarded (`config.ts:200`). Installed `dotenv` is 16.6.1 (`package.json:135` `^16.3.1`).

**Other touched code**
- `src/cli/commands/profile/display.ts` — `ProfileInfo` (`:15-20`), `ProfileIdentityDisplay` (`:27-30`) is the existing channel for resolved (not stored) values into `formatStatus`.

### Decisions Already in the Code
- Env beats project/global unless a profile is named explicitly (`config.ts:212-257`); recorded reason in comment: "prevents environment contamination from overriding the selected profile". Documented in `.ai-run/guides/usage/project-config.md:209`.
- `.env` never overrides an existing `process.env` key (dotenv default, no `override` option at `config.ts:200`); reason: none found.
- `.env` is read from the launch cwd while `.codemie` is read from the nearest config dir (`AgentCLI.ts:231-235`, `project-parity.test.ts:399-411`, guide `project-config.md:211`). `handleStatus` passes `process.cwd()` for both.
- `dotenv.config` mutates `process.env`; a second `load()` in the same process sees `.env` keys as already-present env. `handleStatus` path: `load()` once; `--show-sources` path: `loadWithSources()` → `load()` once. AgentCLI: `load()` at `:235`, then `identity-fields`/launch-identity may load again.
- Convention for "explicit model" consumers: `CODEMIE_MODEL_SOURCE ∈ {cli, env}` = user choice (`claude.models.ts:38-40`, `codex-models.ts:94-100`, `copilot-cli.models.ts:183`, `copilot-cli.plugin.ts:418-421`); unknown values fall through to `'default'` behaviour in all four (Set membership / equality checks).
- Convention for source-marking display text: computed string passed into `renderProfileInfo` rather than a new field (`describeProjectBinding`).
- Data direction: model provenance is stored nowhere; `load()` returns values only, provenance exists only as per-key layer labels inside `loadWithSources()`.

### Task Statements Checked Against the Code
- "load() loads .env via dotenv, does not override existing keys, then loadFromEnv applies CODEMIE_MODEL unless profile name passed" — holds (`config.ts:197-257`). Note: an empty `CODEMIE_MODEL` blocks `.env` but is ignored by `loadFromEnv` (`:631`).
- "Plain profile status prints stored model via listProfiles/formatStatus" — holds (`index.ts:119-169`, `display.ts:130`).
- "--show-sources does not load .env, so .env override shows (project)" — holds; cause is ordering: `loadFromEnv()` `:1594` before `load()` `:1648`.
- "Banner prints env.CODEMIE_MODEL via renderProfileInfo before beforeRun" — holds (`BaseAgentAdapter.ts:639,649,680`).
- "Only claude.models.ts reads CODEMIE_MODEL_SOURCE" — contradicted: also `codex-models.ts:96-99`, `copilot-cli.models.ts:146,183`, `copilot-cli.plugin.ts:418-419`, and `bin/codemie-copilot.js` writes it.
- "AgentCLI sets CODEMIE_MODEL_SOURCE = cli|env|default (~440)" — holds (`:440-444`).
- "describeProjectBinding precedent used by banner and profile status" — holds (`project-binding.ts:46`, `BaseAgentAdapter.ts:642`, `index.ts:21`).
- "Launcher reads config from findNearestConfigDir, envDir = cwd; profile status uses cwd for both" — holds (`AgentCLI.ts:233-235`; `index.ts:117-118`). From a repo subfolder the two read different `.codemie` (status: none in subfolder → global; launch: repo root).
- "No way today to distinguish shell vs .env" — holds (see Purpose B).

### Consumers of Changed Contracts
- `CODEMIE_MODEL_SOURCE` values: `claude.models.ts:40,441-443`; `codex-models.ts:96-99`; `copilot-cli.models.ts:18,146,183` (typed `ConfigSource = default|global|project|env|cli`); `copilot-cli.plugin.ts:418-419`; `bin/codemie-copilot.js:98-101,118,182,193`; tests `AgentCLI-model-source.test.ts`, `claude.models.test.ts`, `codex-models.test.ts`, copilot tests. A new value not in `{cli, env}` is treated as non-explicit by all of them.
- `ConfigWithSource.source` union (`env/types.ts:221`): `loadWithSources`, `getSourceColor` (fallback `chalk.white` for unknown), tests asserting `{ value, source }` in `config-project-override.test.ts:172-383,686-735` and `config-per-profile-identity.test.ts:324-357`.
- `ConfigLoader.load()` return shape: ~25 callers (listed above); `AgentCLI-model-source.test.ts:41` and others `vi.spyOn(ConfigLoader,'load').mockResolvedValue(<plain config>)`.
- `renderProfileInfo` `model` input: three callers (banner, `format`, `formatStatus`); `BaseAgentAdapter.test.ts:68` mocks it to `''`.
- `ProfileDisplay.formatStatus` signature: one caller `index.ts:169`; tests `profile/__tests__/index.test.ts:109-124,180+`.

### Architecture and Layers Affected
- Utils/config: `ConfigLoader.load`, `loadFromEnv`, `loadWithSources`, `showWithSources` (`src/utils/config.ts`); types `src/env/types.ts`.
- CLI command: `src/cli/commands/profile/index.ts` (`handleStatus`, `handleStatusWithSources`), `display.ts`.
- Agent core: `AgentCLI.handleRun` (`:440`), `BaseAgentAdapter.run` banner (`:635-659`).
- Shared display: `src/utils/profile.ts` `renderProfileInfo`.

### Integration Points
- `dotenv` 16.6.1 (`config()` returns `{ parsed }`; `parse()` available).
- Agent plugins reading `CODEMIE_MODEL_SOURCE` (claude, codex, copilot-cli). Spawned agents inherit `CODEMIE_MODEL` via `{...process.env, ...envOverrides}` (`BaseAgentAdapter.ts:602-604`); a `codemie` command run from inside a managed session sees that inherited value as a shell env var.

### Patterns and Conventions
- ES modules with `.js` imports, static `ConfigLoader` methods, chalk colouring in display code, `logger.debug` not console for diagnostics.

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/usage/project-config.md:15,209,232,269` — documents `--show-sources` labels (`cli, env, project, global, default`) and env-over-config rule; `:211` documents `.env` read from cwd.
- `docs/CONFIGURATION.md:133,246,255`, `docs/ARCHITECTURE-CONFIGURATION.md`, `docs/EXAMPLES.md` mention `CODEMIE_MODEL`/`--show-sources`.

### Architectural Decisions
- Profile protection comment `config.ts:212-213`; model-source rationale comments `AgentCLI.ts:413-415,436-439`, `claude.models.ts:38-39`, `codex-models.ts:94-95`.
- Prior task notes: `docs/superpowers/tasks/2026-09-25-epmcdme-15285/gate-run.json:50` and `2026-09-28-epmcdme-14763-claude-1m-context/gate-run.json:50` record `AgentCLI-model-source.test.ts` failing when run inside a CodeMie session because ambient `CODEMIE_MODEL` leaks in.

### Derived Conventions
- Display marking via suffix text in the value string (`describeProjectBinding`).

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/__tests__/AgentCLI-model-source.test.ts` — `cli`/`default` propagation; stubs `CODEMIE_MODEL` undefined; mocks `ConfigLoader.load`/`exportProviderEnvVars`. No `env` case.
- `src/utils/__tests__/config-project-override.test.ts` — `loadWithSources` layer labels (`:172-383,686-735`), profile-protection env filtering with `process.env.CODEMIE_MODEL='env-model'` (`:745-769`); deletes `CODEMIE_*` in setup (`:35-44,453-462`). No `.env` case.
- `src/utils/__tests__/config-per-profile-identity.test.ts:324-357` — `showWithSources` output captured via `console.log` spy.
- `src/agents/core/__tests__/project-parity.test.ts` — real config in tmp dirs (`CODEMIE_HOME` stub, `.git` marker), `AgentCLI.handleRun` with spied `run` capturing env, `.env` written in cwd (`:399-411`); full env snapshot/restore (`:77-107`). Closest pattern for launch-vs-status parity and `.env` cases.
- `src/cli/commands/profile/__tests__/index.test.ts` — mocks `ConfigLoader` and `chalk`; asserts `formatStatus` rendered text (`:109-124`). No test of `handleStatus` itself (not exported).
- `src/agents/core/__tests__/BaseAgentAdapter.test.ts:68` mocks `renderProfileInfo`; no banner content test.
- `claude.models.test.ts`, `codex-models.test.ts` — `CODEMIE_MODEL_SOURCE` `cli` cases.

### Testing Framework and Patterns
- Vitest ^4.1.5; `vi.stubEnv`/`vi.unstubAllEnvs`, `vi.spyOn(process,'cwd')`, tmp dirs via `fs.mkdtemp`, chalk mocked to tags.

### Coverage Gaps
- No test of model source when it comes from shell env vs `.env`; no `.env` case for `loadWithSources`; no banner model-row test; no `handleStatus` model test.

---

## 5. Configuration and Environment

### Environment Variables
- `CODEMIE_MODEL` (override), `CODEMIE_MODEL_SOURCE` (`cli|env|default`, set by AgentCLI), `CODEMIE_PROFILE_NAME`, `CODEMIE_CLI_VERSION` (banner inputs), `CODEMIE_HOME` (test isolation).

### Configuration Files
- `<cwd>/.env`; `.codemie/codemie-cli.config.json` (local); `~/.codemie/codemie-cli.config.json` (global).

### Feature Flags and Deployment Concerns
- None found. Working tree has unrelated local edits (`src/cli/first-time.ts` banner text "LINKED", `.codemie/codemie-cli.config.json`).

---

## 6. Risk Indicators

- `CODEMIE_MODEL_SOURCE` has four readers plus a second writer (`bin/codemie-copilot.js`), not one; any new value (e.g. a `.env` variant) is non-explicit for all of them unless each set is extended (see Consumers).
- `dotenv.config` mutates `process.env`, so provenance computed by snapshotting `process.env` is order-dependent across repeated `load()` calls in one process (AgentCLI, identity-fields, `loadWithSources`→`load`).
- `loadWithSources()` reads env before `.env` is loaded (`config.ts:1594` vs `:1648`) and ignores `cliOverrides.name` filtering, so its labels can disagree with `load()`.
- AgentCLI marks `'env'` whenever `process.env.CODEMIE_MODEL` is non-empty, including when `--profile` filtered it out and when it equals the profile model — relevant to AC 4's "no marker".
- Banner shows `CODEMIE_MODEL` before Claude's beforeRun auto-heal may replace it (`BaseAgentAdapter.ts:639` vs `:680`).
- From a repo subfolder, status reads `<cwd>/.codemie` while the launcher reads the repo-root `.codemie` (`AgentCLI.ts:233-235`), a second source of status/banner divergence.
- `codemie` commands run inside a managed agent session inherit `CODEMIE_MODEL` from the spawned env (`BaseAgentAdapter.ts:602-604`) and would report it as a shell override; same leak breaks `AgentCLI-model-source.test.ts` in prior runs.
- `ConfigLoader.load()` has ~25 callers and is mocked with plain objects in tests; a return-shape change reaches all of them.
- Speculative: AC 6 tests for `.env` need real tmp-dir `.env` files and env snapshot/restore like `project-parity.test.ts`.

---

## 7. Summary for Complexity Assessment

The change spans four layers: config loading (`src/utils/config.ts` `load`/`loadFromEnv`/`loadWithSources`/`showWithSources`, `src/env/types.ts`), the profile CLI (`src/cli/commands/profile/index.ts` `handleStatus`, `display.ts` `formatStatus`), agent core (`AgentCLI.ts:440` source marker, `BaseAgentAdapter.ts:635-659` banner) and the shared renderer `src/utils/profile.ts`. The codebase already has a precedent for suffixing a displayed value with its provenance (`describeProjectBinding`) and a per-key source map (`loadWithSources`), but nothing records whether an env value came from the shell or `.env`; `dotenv.config()`'s return value is discarded and it mutates `process.env`.

Novelty is moderate: provenance capture across a `process.env`-mutating loader, and a `CODEMIE_MODEL_SOURCE` contract that has four readers (claude, codex, copilot-cli models and plugin) plus a second writer in `bin/codemie-copilot.js`, all treating only `cli`/`env` as explicit. `loadWithSources` has an ordering bug (env read before `.env` merge) that explains the reproduced `(project)` label.

Test posture: good patterns exist (`project-parity.test.ts` real tmp config + `.env` + captured launch env; `config-project-override.test.ts` source labels; `profile/__tests__/index.test.ts` rendered status text) but nothing covers shell vs `.env` model provenance, the banner model row, or `handleStatus`'s model. Key risks: ambient `CODEMIE_MODEL` leakage into tests and nested sessions, repeated `load()` calls seeing `.env` keys as env, AgentCLI marking `env` when the override was filtered or equal, and subfolder config-dir divergence between status and launch.

---

## 8. External References

None named by the task.
