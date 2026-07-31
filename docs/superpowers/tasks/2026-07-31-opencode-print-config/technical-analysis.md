# Technical Research

**Task**: opencode config cli provider — add print-only/dry-run mode to codemie-opencode
**Generated**: 2026-07-31
**Research path**: filesystem

---

## 1. Original Context

When a user starts codemie-opencode, it generates a config for opencode on the fly and passes it to opencode when it starts. We need a new parameter/flag for codemie-opencode that will print the actual generated config to the console and NOT start opencode (i.e., a dry-run/print-only mode).

---

## 2. Codebase Findings

### Existing Implementations

- `bin/codemie-opencode.js` — entry point. Looks up `opencode` via `AgentRegistry.getAgent('opencode')` (`src/agents/registry.ts`), builds an `AgentCLI`, calls `cli.run(process.argv)`. Thin wrapper — no opencode-specific CLI parsing here.
- `src/agents/core/AgentCLI.ts` — universal Commander-based CLI builder shared by **all** agent CLIs (claude, codex, gemini, opencode, kimi...). `setupProgram()` (~lines 69-129) declares all root-command options. `handleRun()` (~lines 153-412) parses options, resolves config/env, and at line ~398 calls `this.adapter.run(agentArgs, providerEnv)`. **This is where a new flag must be declared and where the short-circuit before spawn must happen.**
- `src/agents/plugins/opencode/opencode.plugin.ts` — the OpenCode plugin (`OpenCodePluginMetadata`). `lifecycle.beforeRun(env, config)` (lines ~248-408) is the on-the-fly config generator: builds a local `openCodeConfig: Record<string, unknown>` object (provider map for `codemie-proxy`/`openai`/`ollama`, `model`, `plugin` array, `enabled_providers`, `share`), `JSON.stringify`s it, and injects the result into `env.OPENCODE_CONFIG_CONTENT` (inline, primary) or writes it via `writeConfigToTempFile` and sets `env.OPENCODE_CONFIG` (temp-file path, fallback when JSON > 32KB). Also sets `env.OPENCODE_HOOKS` (merged hooks JSON) and `env.OPENCODE_DISABLE_SHARE='true'`. Early-returns bare `env` if `CODEMIE_BASE_URL` is missing/malformed. **The generated config object is a closure-local variable — it is never returned or exposed outside the env-var side effect; a print-only flag needs to capture it before/at the point it's stringified.**
- `src/agents/core/BaseAgentAdapter.ts` — `run(args, envOverrides)` (~lines 715-880) is the shared orchestration: proxy setup → `executeOnSessionStart` → env transform → `executeBeforeRun` (invokes the opencode plugin's `beforeRun` above via `lifecycle-helpers.ts`) → `executeEnrichArgs` → flag transforms → `spawn(finalCommand, finalArgs, { stdio: 'inherit', env, shell, windowsHide })` (line ~791, imports `spawn` directly from Node's `child_process`, **not** the project's `exec()`/`processes.ts` helper convention) → signal handlers → exit-code lifecycle hooks. **A dry-run/print flag must skip the spawn call and everything after it, but should still run `beforeRun` to obtain the real generated config.**
- `src/agents/core/lifecycle-helpers.ts` — `executeBeforeRun(context, lifecycle, agentName, env, config)` resolves and invokes the (possibly provider-chained via `resolveHook()`) `beforeRun` hook. This is the only supported way to trigger config generation without duplicating logic.
- `src/agents/core/temp-config.ts` — `writeConfigToTempFile(configJson, agentTag): string`, `MAX_ENV_SIZE` (32KB) constant; registers a best-effort `process.on('exit', ...)` cleanup handler (`unlinkSync`) for the temp file. Zero test coverage.
- `src/agents/core/types.ts` — `AgentLifecycle.beforeRun` type: `(env, config) => Promise<NodeJS.ProcessEnv>`; `AgentAdapter` interface (line ~712) defines `run()`.
- `src/agents/registry.ts` — `AgentRegistry.getAgent('opencode')` returns the `OpenCodePlugin` instance consumed by `bin/codemie-opencode.js`.
- `src/agents/plugins/opencode/opencode-model-configs.ts` — `OpenCodeModelConfig` interface (~lines 40-55) including `providerOptions?: { headers?: Record<string,string>; timeout?: number }` — the realistic place a real bearer token/header ends up embedded in the generated config.
- `docs/superpowers/tasks/2026-07-31-opencode-print-config/.state.json` — a task-tracking stub already exists (flow `sdlc-standard`, branch `feat/opencode-print-config`, started today) confirming this is the active in-flight task; no prior design/requirements content exists yet beyond bookkeeping.

### Architecture and Layers Affected

Per `.ai-run/guides/architecture/architecture.md` (5-layer: `CLI → Registry → Plugin → Core → Utils`):

- **bin/ entrypoint** — `bin/codemie-opencode.js` (no changes expected; thin wrapper).
- **CLI/Commander layer** — `src/agents/core/AgentCLI.ts` (`setupProgram()` new option declaration; `handleRun()` short-circuit logic).
- **Agent adapter base (Core) layer** — `src/agents/core/BaseAgentAdapter.ts` (`run()` needs a way to stop before `spawn()` while still executing `beforeRun`).
- **Lifecycle-hook resolution layer** — `src/agents/core/lifecycle-helpers.ts` (`executeBeforeRun`) — reused as-is, no change expected.
- **Agent plugin layer** — `src/agents/plugins/opencode/opencode.plugin.ts` (`beforeRun` — the config object needs to become retrievable, not just an env-var side effect).
- **Temp-file/env-passing (Utils) layer** — `src/agents/core/temp-config.ts` — reused as-is.
- **Registry layer** — `src/agents/registry.ts` — no change expected.

### Integration Points

- `AgentCLI.ts` → `opencode.plugin.ts` (via `OpenCodePluginMetadata`, currently only for compatibility validation) → `ConfigLoader` (`src/agents/utils/config.js`) → `ProviderRegistry` (`src/providers/core/*`).
- `opencode.plugin.ts` → `BaseAgentAdapter.ts` (extends), `temp-config.ts`, `src/agents/core/session/ensure-session.ts`, `src/utils/processes.ts` (`commandExists`), `codemie-code-hooks`, `src/cli/commands/hook.js`, `src/providers/plugins/bedrock/bedrock.utils.js`.
- `BaseAgentAdapter.ts` → `lifecycle-helpers.ts`, `src/utils/processes.ts` (`getCommandPath`, `commandExists`), `src/providers/plugins/sso/index.js` (`CodeMieProxy`), `src/providers/index.js` (`ProviderRegistry`), Node `child_process` (`spawn`).
- External: opencode's own config loader consumes `OPENCODE_CONFIG_CONTENT` (verified against opencode's `src/config/config.ts:93-96` per code comment) and `OPENCODE_CONFIG` fallback (verified against opencode's `src/flag/flag.ts` per code comment).
- `beforeRun` also has a network side effect: `fetchDynamicModelConfigs` (calls the CodeMie API using `CODEMIE_JWT_TOKEN`) to build per-model routing. A true print-only mode still triggers this network call unless explicitly bypassed — relevant to complexity/design.

### Patterns and Conventions

- Metadata-driven, provider-agnostic plugin architecture: each agent supplies an `AgentMetadata` object with a `lifecycle` block (`onSessionStart`, `beforeRun`, `enrichArgs`, `onSessionEnd`, `afterRun`); `BaseAgentAdapter`/`lifecycle-helpers.ts` invoke hooks generically. Provider hooks can wrap/chain agent-default hooks via `resolveHook()` (`'*'` + agent-specific + agent-default composition) — any short-circuit must still let the full chained `beforeRun` run.
- Dual-path config injection ("primary env var, fallback temp file") is documented inline in `opencode.plugin.ts` as referencing "ADR-002" and a "Fallback Strategy" — shared utility (`MAX_ENV_SIZE`/`writeConfigToTempFile`) is reused across agents via a generic `agentTag` param, not opencode-specific.
- Commander options are declared once at the shared `AgentCLI` level, not per-agent (no opencode-specific commander file exists). A new flag either goes here (uniform across agents, even though only opencode currently "prints" a generated config) or must be conditionally scoped to the opencode adapter inside `handleRun()`.
- Non-interactive-mode auto-detection precedent: `isNonInteractiveMode = !!options.task` auto-enables silent mode early in `handleRun()` — the natural place to intercept for a print/dry-run path before `this.adapter.run(...)` is called.
- `NOTE (GPT-5.5 review)` marker at `opencode.plugin.ts:520`: "This method should be SIDE-EFFECT FREE" — an existing design constraint recorded near config-related code, relevant context (not directly about this flag, but underscores that the config-building logic is expected to be side-effect-free where possible).
- `.allowUnknownOption()` + pass-through arg collection (`collectPassThroughArgs`) forwards anything unrecognized to the underlying opencode binary — a new flag must be explicitly consumed/stripped in `AgentCLI`/`opencode.plugin.ts`'s `enrichArgs` so it isn't accidentally forwarded to the real `opencode` binary.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — 5-layer architecture (`CLI → Registry → Plugin → Core → Utils`); opencode plugin registered per this layering; "no CLI layer changes required" language in the guide applies to plugin *discovery* only — adding a flag to an existing agent's CLI still goes through `AgentCLI.ts`, not the plugin file.
- `.ai-run/guides/integration/external-integrations.md` — dedicated "OpenCode Integration" section documenting two deployment modes (bundled `@codemieai/codemie-opencode` vs standalone `opencode-ai`) and the exact config-injection mechanism (`OPENCODE_CONFIG_CONTENT` primary / `OPENCODE_CONFIG` fallback).
- `.ai-run/guides/usage/project-config.md` — `ConfigLoader` (`src/utils/config.ts`) merge/priority rules (CLI args > env > project > global > defaults). Relevant only if the print flag needs to reflect CodeMie's own resolved config alongside the opencode-specific config content.
- `.ai-run/guides/integration/exposed-api.md` — confirms `loadWithSources()`/`showWithSources()` as an established "print resolved config with provenance" pattern (used by `codemie profile status --show-sources`) — a naming/output-shape precedent worth mirroring for a config-print flag.

### Architectural Decisions

- No dedicated ADR/design doc exists specifically for "print config / dry-run." The referenced "ADR-002" and "Fallback Strategy" comments live inline in `opencode.plugin.ts` and describe the *existing* env-var/temp-file injection strategy, not a print mode.
- No CHANGELOG entry or docs/ design note mentions config-printing or dry-run for codemie-opencode.

### Derived Conventions

- CLI flag naming is kebab-case, long-form primary with an optional short alias: `-s, --silent`, `-v, --verbose` (elsewhere), `--profile <name>`, `--task <prompt>`.
- Negation/disable convention exists: `--no-analytics-report` ("Disable the automatic per-session analytics report") — precedent for boolean toggle-style flags defined at the shared `AgentCLI` level.
- Repo-wide `--dry-run` precedent (different domain, same wording pattern) at `src/cli/commands/skill.ts:210` ("Preview what would be synced without writing") and `src/cli/commands/workflow.ts:156` ("Preview installation without writing files") — supports `--dry-run` as an idiomatic name.
- Alternate-output-format precedent (changes output, doesn't skip action): `src/cli/commands/skills/list.ts:28` — `--json` ("emit JSON output").
- `src/migrations/runner.ts` has an internal `dryRun?: boolean` parameter gating side effects but it is **never** exposed as a CLI flag — a programmatic-only precedent, not a CLI one.
- `--show-sources` on `codemie profile status` is the closest "print resolved state, take no action" naming precedent in the repo, suggesting `--print-config` or `--show-config` as equally idiomatic alternatives to `--dry-run` (verb-first, unambiguous vs. `--config` which implies *supplying* a config rather than printing one).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/core/__tests__/BaseAgentAdapter.test.ts` — generic (agent-agnostic) test of the process-spawn logic; mocks `child_process`/`spawn` via `vi.mock('child_process', async (importOriginal) => {...})` with a fake `EventEmitter`-based spawned process. **Reusable pattern for asserting a dry-run flag suppresses spawn.**
- `src/agents/core/__tests__/AgentCLI-resume.test.ts`, `AgentCLI-effort.test.ts` — generic CLI flag-parsing tests against `AgentCLI`, using a fake `createAdapter(overrides)` helper (not the real opencode adapter). **Reusable pattern for testing a new flag's parsing/short-circuit behavior.**
- `src/agents/plugins/__tests__/opencode-gpt55-routing.test.ts` — tests per-model routing/limit conversion (`convertApiModelToOpenCodeConfig`, `OPENCODE_MODEL_CONFIGS`), not the full `openCodeConfig` object assembled in `beforeRun`.
- `src/agents/plugins/opencode/__tests__/opencode-session-lifecycle.test.ts`, `opencode-session-record.test.ts`, `session/processors/__tests__/opencode.metrics-processor.test.ts` — cover session/metrics processing, unrelated to config generation.
- `tests/integration/session/opencode-metrics-basic.test.ts` — integration test for metrics/session tracking, unrelated.
- `tests/integration/opencode/` — directory exists but is **empty**. Natural home for new integration tests covering the print-only flag once implemented.

### Testing Framework and Patterns

- Vitest `^4.1.5` (`@vitest/ui` same version), confirmed in `package.json`. Test suite split via `vitest run --project unit|cli|agent`.
- Dynamic-import mocking convention: `vi.resetModules()` + `await import(...)` inside `beforeEach` for fresh module instances per test (used in `opencode-gpt55-routing.test.ts` and broadly across `src/cli/commands/**/__tests__`).
- `spawn` mocked as `vi.fn(() => mockSpawnedProcess)` returning a fake child process emitting `'exit'` immediately with code 0; assertions via `vi.mocked(spawn).toHaveBeenCalledWith(...)`.
- Fake-adapter factory pattern (`createAdapter(overrides)`) to drive `AgentCLI` without a real agent implementation.

### Coverage Gaps

- **Config generation** (`beforeRun` in `opencode.plugin.ts`): no test exercises the full assembly of `openCodeConfig`, the `JSON.stringify`, or the inline-vs-temp-file decision (`MAX_ENV_SIZE` threshold). This is exactly the logic a print-only flag must reuse — currently untested.
- **`temp-config.ts`**: zero test files found for `writeConfigToTempFile`/`MAX_ENV_SIZE`.
- **CLI flag parsing for the opencode command specifically**: no test instantiates `AgentCLI` with the real `opencode` adapter; existing `AgentCLI-*` tests use a fake generic adapter.
- **Process spawning for opencode specifically**: `BaseAgentAdapter.test.ts` tests `spawn` generically; no test verifies `OPENCODE_CONFIG_CONTENT`/`OPENCODE_CONFIG` reach the spawned process, nor that a dry-run flag suppresses `spawn` for the opencode path.

---

## 5. Configuration and Environment

### Environment Variables

- `OPENCODE_CONFIG_CONTENT` — primary channel: inline JSON of the generated config, consumed directly by opencode.
- `OPENCODE_CONFIG` — fallback: path to a temp file (`{tmpdir}/codemie-opencode-config-{pid}-{timestamp}.json`) when JSON exceeds 32KB (`MAX_ENV_SIZE`).
- `OPENCODE_HOOKS` — merged telemetry + profile hooks JSON, injected alongside the config.
- `OPENCODE_DISABLE_SHARE` — set to `'true'` alongside config generation.
- `CODEMIE_BASE_URL`, `CODEMIE_PROVIDER`, `CODEMIE_MODEL`, `CODEMIE_JWT_TOKEN`, `CODEMIE_TIMEOUT`, `AWS_REGION`/`CODEMIE_AWS_REGION` — consumed inside `beforeRun` to build the provider/model sections; `beforeRun` early-returns (no config generated) if `CODEMIE_BASE_URL` is missing/malformed — relevant edge case for a print-only mode (should surface an error rather than print an empty/partial config).
- `CODEMIE_DEBUG` — global debug/verbose switch (`src/utils/logger.ts`, `src/utils/config.ts`).
- `OPENAI_API_KEY` — set to the literal placeholder `'proxy-handled'` when Responses API models exist; visually indistinguishable from a real secret if ever printed.

### Configuration Files

- `src/agents/plugins/opencode/opencode.plugin.ts` — builds the `openCodeConfig` object (provider map, model, plugin, mcp-adjacent settings) inside `beforeRun`. Single source of truth for what a print-only flag should output.
- `src/agents/plugins/opencode/opencode-model-configs.ts` — `OpenCodeModelConfig` interface, including `providerOptions.headers` (potential real-credential carrier).
- `src/agents/core/temp-config.ts` — fallback temp-file writer, shared across agents via `agentTag`.

### Feature Flags and Deployment Concerns

- Shared `AgentCLI.setupProgram()` flags inherited by codemie-opencode: `-s/--silent`, `--status`, `--profile <name>`, `--provider <provider>`, `-m/--model <model>`, `--api-key <key>`, `--base-url <url>`, `--timeout <seconds>`, `--jwt-token <token>`, `--task <prompt>` (auto-enables silent mode), `--reasoning-effort <level>`, `--resume <session-id>`, `--no-analytics-report`. No `--print-config`/`--dry-run` flag exists today.
- **Temp-file cleanup**: `writeConfigToTempFile` registers a best-effort `process.on('exit', ...)` cleanup. If a print-only flag triggers the same code path (config > 32KB) and then exits differently/early, must confirm the exit handler still fires so temp files don't leak.
- **Session/network side effects during "just print"**: `beforeRun` calls `fetchDynamicModelConfigs` (network call to the CodeMie API using `CODEMIE_JWT_TOKEN`) to build model routing. Session-start hooks (`onSessionStart`) are invoked separately in `BaseAgentAdapter.run()`, before `beforeRun`. A strictly "no side effects" print mode would need to either accept these effects (network call, possibly session record creation) or bypass them explicitly — this is a design decision the caller/architect should make explicitly, not something this research resolves.
- **Unknown-option pass-through**: `AgentCLI` uses `.allowUnknownOption()` and forwards unrecognized args to the opencode binary; a new flag must be consumed before pass-through so it isn't forwarded as a raw arg to the real `opencode` process (which will never even be spawned in print mode, but the CLI parsing must still filter it correctly if `--` pass-through parsing is shared code).

### Secrets in Generated Config (redaction concern for printing)

- `provider['codemie-proxy'|'openai'].options.apiKey` — currently placeholder `'proxy-handled'`; `provider['ollama'].options.apiKey` — placeholder `'ollama'`. Same field name as a real secret would use.
- `provider[*].options.headers` — populated from `providerOptions.headers` (`OpenCodeModelConfig.providerOptions.headers: Record<string,string>`) — the most realistic place a real `Authorization`/bearer token ends up embedded in the generated config object.
- `env.OPENAI_API_KEY = 'proxy-handled'` — set on process env, not the JSON config object itself, but relevant if any debug output also dumps env.
- Recommendation carried forward from research (not yet a decision): redact/mask fields named `apiKey`, `token`, `secret`, `authorization`, `headers` (case-insensitive) before printing, since today's values are placeholders but the schema clearly allows real credentials in `headers`.

---

## 6. Risk Indicators

- No test coverage exists for the config-generation logic (`beforeRun` in `opencode.plugin.ts`), for `temp-config.ts`, for opencode-specific CLI flag parsing, or for opencode-specific spawn suppression — a new flag has no existing regression safety net to build on; new tests will need to be authored from scratch (only on explicit request per repo policy).
- The generated config object (`openCodeConfig`) is a closure-local variable inside `beforeRun`, never returned to the caller — printing it requires either capturing it via a new return/callback mechanism or re-deriving it from `env.OPENCODE_CONFIG_CONTENT`/`env.OPENCODE_CONFIG` after `beforeRun` runs. Either approach touches shared, generic (`AgentCLI`/`BaseAgentAdapter`) code used by every other agent (claude, codex, gemini, kimi) — a change here must not alter behavior for non-opencode agents.
- `beforeRun` has a network side effect (`fetchDynamicModelConfigs` against the CodeMie API using `CODEMIE_JWT_TOKEN`) — a "pure print, no side effects" mode is not fully achievable without either accepting this network call or restructuring the hook, which is a design decision, not a pure research finding.
- Secrets exposure: `provider[*].options.headers` and `apiKey` fields can carry real credentials in some configurations (currently placeholders in the codebase, but schema allows real values) — printing the raw config to console without redaction is a security risk that must be addressed in design/implementation.
- Config generation early-returns a bare `env` (no config built at all) when `CODEMIE_BASE_URL` is missing/malformed — a print-only flag must handle/report this case explicitly rather than silently printing nothing.
- The `AgentCLI` `.allowUnknownOption()` pass-through mechanism means a new flag not properly declared/filtered could leak through to the (never-spawned, in print mode) opencode binary's own arg parsing — needs explicit handling in `enrichArgs`/pass-through logic.
- No exact `--dry-run`/`--print-config`/`--show-config` precedent exists in this specific CLI area; naming must be chosen based on cross-repo conventions (`--dry-run` in `skill.ts`/`workflow.ts`, `--show-sources` in `profile status`, `--json` in `skills/list.ts`) — a naming decision, not a technical blocker, but should be resolved during design rather than left ambiguous.
- Filesystem-fallback research path used (no codegraph tool available in this environment) — findings rely on Explore-agent grep/read passes rather than an indexed graph; file line numbers cited are approximate as reported by sub-agents and should be re-verified during implementation.

---

## 7. Summary for Complexity Assessment

This task touches four layers of the shared agent-plugin architecture: the CLI/Commander layer (`src/agents/core/AgentCLI.ts`, where the new flag is declared and `handleRun()` must short-circuit before invoking `adapter.run()`), the core adapter orchestration layer (`src/agents/core/BaseAgentAdapter.ts`, whose `run()` method must skip the `spawn()` call and everything downstream of it while still executing `beforeRun`), the opencode plugin layer (`src/agents/plugins/opencode/opencode.plugin.ts`, whose `beforeRun` hook builds the config as a closure-local object that currently only escapes via an env-var side effect — it will need to become retrievable/returnable so the caller can print it), and the temp-file fallback layer (`src/agents/core/temp-config.ts`, exercised unchanged when config exceeds 32KB). Because `AgentCLI` and `BaseAgentAdapter` are shared by every agent (claude, codex, gemini, kimi, opencode), any change to their control flow carries cross-agent blast radius even though the new user-facing behavior is opencode-specific — expect the change surface to span roughly 3-5 files (AgentCLI.ts, BaseAgentAdapter.ts, opencode.plugin.ts, possibly lifecycle-helpers.ts, plus new test files).

Technical novelty is moderate: the codebase has no existing print-only/dry-run flag for this CLI, but strong naming and structural precedents exist elsewhere (`--dry-run` in `skill.ts`/`workflow.ts`, `--show-sources` in `profile status`, the non-interactive `--task` auto-detection pattern in `handleRun()`) and the plugin/lifecycle-hook architecture already generically supports intercepting `beforeRun` results — the work is more "wire an existing mechanism to a new exit path" than inventing new architecture. The main open design question, not resolved by this research, is how to handle `beforeRun`'s network call (`fetchDynamicModelConfigs`) and secret redaction in print mode.

Test coverage posture for the affected code paths is weak to nonexistent: no tests cover `beforeRun`'s config assembly, `temp-config.ts`, opencode-specific CLI flag parsing, or opencode-specific spawn suppression, though reusable mocking patterns exist (`BaseAgentAdapter.test.ts`'s `child_process` mock, `AgentCLI-resume.test.ts`'s fake-adapter pattern) and an empty `tests/integration/opencode/` directory is ready to receive new coverage. Key risk factors for complexity scoring: cross-agent shared-code blast radius, an unresolved secret-redaction requirement, an unresolved side-effect (network call) question for "pure" dry-run semantics, and zero existing regression tests in the exact code paths being modified.
