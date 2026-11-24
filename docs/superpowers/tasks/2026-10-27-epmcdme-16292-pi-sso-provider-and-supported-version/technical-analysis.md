# Technical Research

**Task**: pi provider install
**Generated**: 2026-10-27
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-16292 (Bug): Pi fails to start with a valid CodeMie SSO profile, and `codemie install pi --supported` cannot reinstall it.

With the `medecision` profile active, `codemie doctor` reports the `ai-run-sso` provider as operational and confirms `claude-sonnet-5-5-vertex` is available. Starting Pi (`codemie-pi`) fails: Pi exits with code 1 and reports `Error: Unknown provider "codemie-anthropic".`
Separately, `codemie install pi --supported` fails with `Pi: No supported version defined in metadata`.

Preconditions: CodeMie CLI 0.15.9; active profile uses ai-run-sso and model claude-sonnet-5-5-vertex; Pi 1.4.0 installed.

Acceptance Criteria:
1. Given an active profile with a provider and model reported as operational by `codemie doctor`, when the user starts Pi, then Pi recognizes the configured provider and launches successfully.
2. Given Pi's supported version is defined for the current release, when the user runs `codemie install pi --supported`, then installation or reinstallation completes without a missing-version-metadata error.
3. Given these Pi fixes are applied, when existing extension or dependency warnings are emitted, then they do not prevent Pi from starting if the provider and installation configuration are valid.

Hints: Pi plugin lives in src/agents/plugins/pi/ (upstream @earendil-works/pi-coding-agent; redirects PI_CODING_AGENT_DIR to <cwd>/.pi/codemie/agent; metrics via injected extension + run ledger). Design docs under docs/superpowers/specs/. Investigate how the "codemie-anthropic" provider is registered/written for Pi (models.json / settings / extension), why Pi 1.4.0 doesn't recognize it (upstream API change in provider registration? extension load failure?), and how `supportedVersion` metadata is defined for other agents vs pi.

---

## 2. Codebase Findings

### Existing Implementations
- `src/agents/plugins/pi/pi.models.ts` — writes `<cwd>/.pi/codemie/agent/models.json`.
  - `classifyPiModel()` (l.32) maps `claude*` to `codemie-anthropic`, everything else to `codemie-proxy`.
  - `buildModelsConfig()` (l.277-324) emits provider-level `compat: { supportsReasoningEffort: true, thinkingFormat: 'reasoning_effort' }` on **both** `codemie-proxy` (l.301-304) and `codemie-anthropic` (l.314-317).
  - `buildOllamaModelsConfig()` (l.383-396) emits the same `compat` on the `ollama` provider.
  - `buildStaticFallbackModel()` (l.399) goes through `buildModelsConfig`, so the fallback path carries it too.
  - `PiModelsConfig` interface (l.243) types `compat` as `Record<string, unknown>`, so there is no compile-time check.
- `src/agents/plugins/pi/pi.plugin.ts`
  - `PiPluginMetadata` (l.163-490) has **no `supportedVersion` and no `minimumSupportedVersion`**.
  - `beforeRun` (l.303) calls `preparePiAgentDir`, then `fetchAndBuildPiModels`, then `ensurePiCodeMieExtension`.
  - `enrichArgs` (l.331) builds `--provider <classifyPiModel(model).provider> --model <model>`.
  - `additionalInstallation` (l.517) calls `installRequiredPiPackages`.
- `src/agents/plugins/pi/pi.packages.ts` — `REQUIRED_PI_PACKAGES` = superpowers (git), `npm:pi-subagents`, `npm:pi-mcp-adapter`. Each is installed via `pi install`. A failure throws `AgentInstallationError`.
- `src/agents/plugins/pi/pi.setup.ts` — copies `~/.pi/agent` into the project agent dir once. If the dir exists, it skips the copy.
- `src/agents/plugins/pi/pi.extension.ts` — materializes the run-ledger extension and runs a load self-test. Per the comment at l.68, Pi turns any extension load failure into `process.exit(1)`. A failed self-test removes the copy and warns.
- `src/agents/core/BaseAgentAdapter.ts`
  - `installVersion()` l.183-199 throws `` `${displayName}: No supported version defined in metadata` `` when the version is `'supported'` and `metadata.supportedVersion` is unset. This is the exact AC2 error.
  - `checkVersionCompatibility()` l.281-385 falls back to `'latest'` when the field is unset.
  - The version notice is at l.392-435.
- `src/cli/commands/install.ts` l.109-125 maps `--supported` to `'supported'`. Only `claude` and `codex` default to `'supported'` without the flag.

### Architecture and Layers Affected
- Agent plugin layer: `src/agents/plugins/pi/` (`pi.models.ts`, `pi.plugin.ts`).
- Agent core: `BaseAgentAdapter.installVersion` / `checkVersionCompatibility`. The behavior is consumed as-is; nothing there is pi-specific.
- CLI: `src/cli/commands/install.ts`. It reads `checkVersionCompatibility().supportedVersion` for display.

### Integration Points
- Upstream Pi (`@earendil-works/pi-coding-agent`) reads `$PI_CODING_AGENT_DIR/models.json`, validating it with a TypeBox schema from `@earendil-works/pi-ai/providers/compat-schema`.
- SSO model list: `fetchCodeMieLlmModels` (`src/providers/plugins/sso/sso.http-client.ts`) and `CodeMieSSO`.
- Local SSO proxy base URL arrives through `CODEMIE_BASE_URL`.

### Patterns and Conventions
- Version pins are module constants at the top of the plugin file, as in these examples:
  - `CLAUDE_SUPPORTED_VERSION = '2.1.281'` (`claude.plugin.ts:40`)
  - `CODEX_SUPPORTED_VERSION = '0.154.0'` (`codex.plugin.ts:73`)
  - `GEMINI_SUPPORTED_VERSION = '0.59.0'` (`gemini.plugin.ts:16`)
  - `KIMI_SUPPORTED_VERSION` (`kimi.plugin.ts:26`)
  - `COPILOT_SUPPORTED_VERSION` (`copilot-cli.plugin.ts:27`)
- Each pin has a paired `*_MINIMUM_SUPPORTED_VERSION`. The documented rule is that the minimum is "the previously recommended version" (`gemini.plugin.ts:20-27`). The minimum is the only hard startup gate.
- ACP variants set `supportedVersion: undefined` on purpose (`codex-acp.plugin.ts:38`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/integration/external-integrations.md` does not cover Pi. AGENTS.md states this explicitly.
- `docs/superpowers/specs/2026-08-07-codemie-pi-design.md:116` records the now-invalid choice: "`compat`: provider-level `supportsReasoningEffort: true, thinkingFormat: "reasoning_effort"`; per-model `forceAdaptiveThinking: true`".
- Related specs:
  - `2026-08-07-codemie-pi-required-packages-design.md`
  - `2026-08-12-codemie-pi-metrics-design.md`

### Architectural Decisions
- Supported version is a recommendation. A mismatch gives one non-blocking notice. The minimum blocks startup (`src/agents/core/types.ts:220-235`).

### Derived Conventions
- When you bump a supported version, move the old value into the minimum constant.
- The constant name carries the `**UPDATE THIS WHEN BUMPING ... VERSION**` comment.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/plugins/pi/__tests__/pi.models.test.ts` covers cost resolution and per-model `compat` (`forceAdaptiveThinking`, l.253). It has **no assertion on provider-level `compat`/`thinkingFormat`**.
- `pi.args.test.ts:68` asserts `['--provider','codemie-anthropic','--model','claude-sonnet-4-6']`.
- The version-pin test pattern is in other plugins:
  - `codex/__tests__/codex.plugin.version-support.test.ts` (asserts `supportedVersion` `'0.154.0'`)
  - `kimi/__tests__/kimi.plugin.test.ts:55`
  - `core/__tests__/BaseAgentAdapter.version-notice.test.ts`

### Testing Framework and Patterns
- Vitest with `vi.mock` of `utils/pricing.js` and dynamic imports. There is no Pi binary in tests.

### Coverage Gaps
- There is no test that validates generated `models.json` against Pi's schema. That is why the regression shipped silently.
- There is no Pi `supportedVersion` test.
- There is no test of `installRequiredPiPackages` failure semantics during `--supported` reinstall.

---

## 5. Configuration and Environment

### Environment Variables
- Read by Pi models generation:
  - `CODEMIE_BASE_URL`
  - `CODEMIE_API_KEY` (default `'proxy-handled'`)
  - `CODEMIE_JWT_TOKEN`
  - `CODEMIE_URL` (SSO)
  - `CODEMIE_MODEL`
  - `CODEMIE_PROVIDER` (`ollama` branch)
- `PI_CODING_AGENT_DIR` is set to `<cwd>/.pi/codemie/agent`.
- `CODEMIE_PI_BIN` overrides `cliCommand`.
- `PI_CODING_AGENT_SESSION_DIR`.

### Configuration Files
- `<cwd>/.pi/codemie/agent/models.json` is regenerated on every run.
- `settings.json` and `extensions/` are copied from `~/.pi/agent` once.

### Feature Flags and Deployment Concerns
- `pi.extension.ts:23` defines an env toggle that disables the run-ledger extension.
- There are no deployment manifests involved.

---

## 6. Risk Indicators

- **Root cause of AC1 (verified):** Pi 1.4.0 rejects the whole `models.json` because of `providers.<id>.compat.thinkingFormat: must be equal to constant`.
  - Pi then loads zero custom providers, prints only a warning, and the `--provider codemie-anthropic` lookup fails in `model-resolver.js:330` with `Unknown provider "codemie-anthropic"`.
  - The same defect hits `codemie-proxy` and `ollama`. Non-Claude models fail the same way, as `Unknown provider "codemie-proxy"`.
- `thinkingFormat: 'reasoning_effort'` is not an allowed literal in any checked 1.x release (1.0.0, 1.2.0, 1.3.0, 1.4.0).
  - Allowed values in 1.4.0: `openai`, `openrouter`, `deepseek`, `together`, `baseten`, `zai`, `qwen`, `chat-template`, `qwen-chat-template`, `string-thinking`, `ant-ling`.
  - `"openai"` is documented as "uses reasoning_effort".
  - Omitting the field means Pi auto-detects it from the URL.
- Verified fix: with `thinkingFormat` removed from both providers and everything else unchanged (`authHeader`, `supportsReasoningEffort`, `thinkingLevelMap` with `max`, per-model `compat`), Pi 1.4.0 `--list-models` lists `codemie-anthropic claude-sonnet-5-5-vertex` and `codemie-proxy`.
- Speculative: `thinkingFormat` is an OpenAI-completions concept. Sending it on the `anthropic-messages` provider may be meaningless even if valid. The spec should choose between omitting it for anthropic and using `'openai'` for the proxy and ollama providers.
- Speculative: the AC2 fix is adding `PI_SUPPORTED_VERSION` (likely `'1.4.0'`) and possibly a minimum to `PiPluginMetadata`.
  - Setting a minimum makes older installed Pi versions refuse to start. That is a product decision.
  - No minimum means AC2 alone needs only `supportedVersion`.
- The `--supported` reinstall also runs `additionalInstallation` → `pi install` for 3 packages. That step can raise `AgentInstallationError` independently of the version metadata.
- AC3 (extension/dependency warnings) is not reproduced here.
  - Pi 1.4.0 depends on `@earendil-works/pi-mcp` (built-in MCP) while CodeMie also installs `npm:pi-mcp-adapter`. This is a possible source of warnings or tool conflicts.
  - Extension load failures are fatal in Pi (`pi.extension.ts:68`).
- The design spec `2026-08-07-codemie-pi-design.md:116` documents the invalid value and will go stale.
- Pi does not cover `models.json` with tests. `compat` is typed `Record<string, unknown>`, so nothing catches schema drift.

---

## 7. Summary for Complexity Assessment

The bug spans two small, independent defects in the Pi agent plugin. The provider failure (AC1) is fully explained and reproduced against Pi 1.4.0.
- `src/agents/plugins/pi/pi.models.ts` writes `compat.thinkingFormat: 'reasoning_effort'` on every provider it generates: `codemie-anthropic`, `codemie-proxy` and `ollama`.
- Pi's TypeBox schema (1.x) accepts no such literal. It discards the whole `models.json` with a warning, and then `--provider codemie-anthropic` fails with `Unknown provider`.
- Removing the field restores all providers. The fix is confined to `buildModelsConfig` and `buildOllamaModelsConfig`, and possibly the `PiModelsConfig` typing.

The install failure (AC2) comes from `PiPluginMetadata` in `pi.plugin.ts`, which defines no `supportedVersion`. `BaseAgentAdapter.installVersion` therefore throws the exact reported error. Every other npm-installed agent pins `*_SUPPORTED_VERSION` and `*_MINIMUM_SUPPORTED_VERSION` constants, so the pattern is established. AC3 has no concrete reproduction. Plausible sources:
- the `pi install` steps in `pi.packages.ts`
- the overlap between `pi-mcp-adapter` and Pi 1.4.0's built-in `pi-mcp`
- fatal extension load failures

Novelty is low and the surface is about 2 source files plus tests and one design doc. Test posture is weak. `pi.models.test.ts` never asserts provider-level `compat`, and there is no Pi version-pin test, although the codex and kimi tests offer a template. The main risks are the choice of `thinkingFormat` replacement, the policy on the minimum version, and the unverified AC3 warnings.

---

## 8. External References

None named by the task. Upstream evidence was gathered from the published npm tarballs `@earendil-works/pi-coding-agent@1.4.0` (plus 1.0.0, 1.2.0, 1.3.0) and `@earendil-works/pi-ai@1.4.0` / `1.3.0`, unpacked in a scratch directory:
- `dist/core/model-config.js:145-150`: when the schema fails, it returns `new ModelConfig(new Map(), "Invalid models.json schema: ...")`, which yields an empty provider map.
- `dist/core/model-resolver.js:323-331`: ``error: `Unknown provider "${cliProvider}". Use --list-models to see available providers/models.` ``
- `pi-ai/dist/providers/compat-schema.js:139-152`: the `thinkingFormat` union (values listed in Section 6).
