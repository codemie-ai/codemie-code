# EPMCDME-13883 Copilot CLI Managed Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the existing `copilot-cli` integration from analytics-only to a first-class CodeMie-managed agent, while preserving its internal identity and adding the user-facing commands `codemie install copilot`, `codemie uninstall copilot`, and `codemie-copilot`.

**Architecture:** Reuse the existing `src/agents/plugins/copilot-cli/` implementation as the single source of truth and extend the normal managed-agent path around it. Resolve `copilot` as a CLI alias at management-command boundaries, keep the internal registry key as `copilot-cli`, and incrementally wire provider routing, attribution, customization parity, and docs in four logical slices that can land in one PR.

**Tech Stack:** TypeScript, Commander.js, existing `AgentRegistry` / `BaseAgentAdapter` / `AgentCLI` infrastructure, CodeMie provider and session-sync infrastructure, npm-based installation flow.

## Global Constraints

- Keep internal agent identity as `copilot-cli`; do not introduce a second managed `copilot` plugin.
- Support user-facing commands `codemie install copilot`, `codemie uninstall copilot`, and `codemie-copilot`.
- Preserve guide-first architecture: CLI → Registry → Plugin → Core → Utils.
- Tests were initially deferred per repository policy; the user later explicitly requested tests, so focused regression tests are now in scope.
- Do not perform additional git operations unless explicitly requested by the user.
- Fail fast when startup would fall back to GitHub login, GitHub-hosted models, or ambient GitHub credentials instead of CodeMie-managed routing.
- Restrict in-scope provider modes to the ticket requirements: AI/Run SSO and LiteLLM.
- Avoid unnecessary writes into version-controlled project files for Copilot customization assets.
- Keep Copilot-specific implementation in `src/agents/plugins/copilot-cli/` and `bin/codemie-copilot.js` unless a shared abstraction clearly benefits multiple agents.

---


## Actual implementation status — 2026-08-11

### Implemented in the core slice

- [x] Promoted `copilot-cli` from analytics-only to a managed npm-installed agent using `@github/copilot`.
- [x] Preserved the canonical internal identity `copilot-cli` and added user-facing alias helpers for `copilot`.
- [x] Added `codemie-copilot` package binary and launcher.
- [x] Added Copilot-only launcher UX for `--model-list`, valueless `--model` picker, explicit `--model <name>`, and saved model persistence.
- [x] Kept Copilot model UX out of shared `AgentCLI`.
- [x] Added CodeMie-only provider env mapping for Copilot BYOK mode.
- [x] Removed the invalid Copilot CLI `--offline` argument and retained `COPILOT_OFFLINE=true` as env configuration.
- [x] Translated CodeMie `--task` to Copilot `--prompt` and added `--allow-all-tools` for non-interactive task runs when needed.
- [x] Added supported/minimum Copilot CLI version metadata.
- [x] Limited supported providers to AI/Run SSO and LiteLLM for this ticket.
- [x] Added model auto-resolution before proxy startup so selected model and proxy headers match.
- [x] Restricted Copilot model listing/validation to GPT-family and Claude-family models only.
- [x] Ranked GPT-family defaults ahead of Claude-family defaults while preserving explicit Claude selection.
- [x] Added Sonnet 5 request normalization for deprecated sampling fields.
- [x] Added Copilot-only Responses API encrypted-content retry sanitizer.
- [x] Kept Codex encrypted-content sanitizer behavior separate from the Copilot retry sanitizer.

### Focused regression tests added/updated

- `src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts` verifies Copilot is managed while retaining session-adapter registration.
- `src/agents/plugins/copilot-cli/__tests__/copilot-cli.models.test.ts` verifies GPT/Claude-only model filtering and explicit unsupported-model rejection.
- `src/agents/core/__tests__/agent-aliases.test.ts` verifies `copilot` alias and `codemie-copilot` launcher naming.
- `src/providers/plugins/sso/proxy/plugins/__tests__/copilot-encrypted-content-sanitizer.plugin.test.ts` verifies the Copilot-only retry sanitizer behavior and scoping.

### Still pending after core slice

- [ ] Conversation sync/folder attribution hardening so Copilot never falls through to `Claude Desktop`.
- [ ] MCP configuration parity.
- [ ] Skills/custom agents discovery/injection parity.
- [ ] Hook event mapping/routing parity.
- [ ] README and public agent documentation updates.

## File Structure

**Create:**
- `bin/codemie-copilot.js` — direct launcher that resolves `copilot-cli` through `AgentRegistry`
- `src/agents/plugins/copilot-cli/copilot-cli.models.ts` — Copilot-specific model validation/recommendation rules if they do not fit cleanly in the plugin file
- `src/agents/plugins/copilot-cli/copilot-cli.hook-transformer.ts` — only if Copilot hook payloads need normalization beyond simple event-name mapping
- `docs/agents/copilot*.md` or the repo’s existing agent-doc path — Copilot user docs if no appropriate doc file exists yet

**Modify:**
- `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts` — convert from analytics-only to managed agent, add metadata, lifecycle, install/run/version logic
- `src/agents/plugins/copilot-cli/copilot-cli.constants.ts` — shared names/client-type constants if needed
- `src/agents/plugins/copilot-cli/index.ts` — re-export any new Copilot helpers/constants
- `src/agents/registry.ts` — stop excluding Copilot from manageable paths if `analyticsOnly` is removed or if another safe gating mechanism is adopted
- `src/cli/commands/install.ts` — resolve `copilot` alias to `copilot-cli`, show Copilot in the available-agents list using the short command form
- `src/cli/commands/uninstall.ts` — resolve `copilot` alias to `copilot-cli`
- `src/cli/commands/list.ts` — ensure Copilot appears correctly in list output if needed
- `src/agents/core/AgentCLI.ts` — install/run help text should present `copilot` alias or `codemie-copilot` launcher where user-facing UX would otherwise show `copilot-cli`
- `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` — map Copilot conversations to a Copilot folder rather than the fallback `Claude Desktop`
- `package.json` — add the `codemie-copilot` bin entry
- `README.md` — document install/uninstall/run commands, provider scope, and no-GitHub-auth behavior
- Any existing agent docs index/overview that lists supported agents
- Existing Copilot registry tests/docs that assert analytics-only behavior

**Inspect closely while implementing:**
- `src/agents/core/BaseAgentAdapter.ts` — shared version/install/run behavior and lifecycle hooks
- `src/agents/core/types.ts` — metadata fields already available for versioning, MCP, extensions, hooks, supported providers, model recommendations
- `src/agents/plugins/codex/codex.plugin.ts` — reference for provider-managed CLI routing, version gating, lifecycle wiring, and clientType handling
- `src/agents/plugins/gemini/gemini.plugin.ts` — reference for npm-installed agent metadata, MCP config, extensions config, and hook mapping
- `src/agents/plugins/kimi/kimi.plugin.ts` — reference for explicit model validation and hook transformer wiring
- `src/cli/commands/doctor/index.ts` and related checks — understand how managed agents are surfaced in health/doctor flows

## Task Structure

### Task 1 (implemented in core slice; commit deferred): Convert Copilot from analytics-only to a manageable agent

**Files:**
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.constants.ts`
- Modify: `src/agents/plugins/copilot-cli/index.ts`
- Modify: `src/agents/registry.ts`

**Interfaces:**
- Consumes: `AgentMetadata`, `BaseAgentAdapter`, `SessionAdapter`, `AgentRegistry.getManageableAgents(): AgentAdapter[]`
- Produces: managed Copilot metadata with concrete `install()`, `uninstall()`, `run(args, env)`, `getVersion()`, optional `installVersion(version?)`, plus a registry entry that management surfaces can return without special-casing a second plugin

- [x] **Step 1: Write the failing test**

Document the expected behavior first in a targeted note or future test draft so implementation is grounded:

```ts
// Intended assertions after implementation:
expect(AgentRegistry.getManageableAgents().map((a) => a.name)).toContain('copilot-cli');
expect(AgentRegistry.getAgent('copilot-cli')!.metadata.analyticsOnly).not.toBe(true);
expect(AgentRegistry.getAgent('copilot-cli')!.metadata.npmPackage).toBe('@github/copilot');
```

- [x] **Step 2: Run test to verify it fails**

Before the user requested tests, this was verified by source inspection rather than running the suite:

- `copilot-cli.plugin.ts` throws `NOT_MANAGED` from `install()`, `uninstall()`, and `run()`
- `npmPackage` is `null`
- `analyticsOnly` is `true`
- `registry.ts` filters analytics-only agents out of `getManageableAgents()`

Expected: source inspection shows the current implementation cannot satisfy the intended behavior.

- [x] **Step 3: Write minimal implementation**

Implement managed-agent metadata and behavior in `copilot-cli.plugin.ts`:

```ts
export const CopilotCliPluginMetadata: AgentMetadata = {
  name: COPILOT_CLI_AGENT_NAME,
  displayName: COPILOT_CLI_DISPLAY_NAME,
  description: 'GitHub Copilot CLI - AI coding agent managed by CodeMie',
  npmPackage: '@github/copilot',
  cliCommand: process.env.CODEMIE_COPILOT_BIN || 'copilot',
  supportedVersion: COPILOT_SUPPORTED_VERSION,
  minimumSupportedVersion: COPILOT_MINIMUM_SUPPORTED_VERSION,
  dataPaths: { home: '.copilot' },
  envMapping: { baseUrl: [], apiKey: [], model: [] },
  supportedProviders: ['ai-run-sso', 'litellm'],
  recommendedModels: [...],
  blockedModelPatterns: [...],
  ssoConfig: { enabled: true, clientType: 'codemie-copilot' },
  // plus mcp/extensions/hook config as slices progress
};
```

Then replace refusal-only lifecycle methods with real behavior, keeping `getSessionAdapter()` intact.

- [x] **Step 4: Run test to verify it passes**

After implementation, verify by code inspection and, once tests are explicitly requested, with focused regression tests that:

- Copilot metadata is no longer analytics-only
- `npmPackage` is set
- `install()`/`uninstall()` no longer throw `NOT_MANAGED`
- `registry.ts` can now include Copilot in manageable-agent surfaces

Expected: the source now matches the intended assertions.

- [ ] **Step 5: Commit (deferred until explicitly requested)**

```bash
git add src/agents/plugins/copilot-cli/copilot-cli.plugin.ts src/agents/plugins/copilot-cli/copilot-cli.constants.ts src/agents/plugins/copilot-cli/index.ts src/agents/registry.ts
git commit -m "feat(agents): promote copilot cli to managed agent"
```

### Task 2 (implemented in core slice; commit deferred): Add command aliases and direct launcher support

**Files:**
- Create: `bin/codemie-copilot.js`
- Modify: `package.json`
- Modify: `src/cli/commands/install.ts`
- Modify: `src/cli/commands/uninstall.ts`
- Modify: `src/cli/commands/list.ts`
- Modify: `src/agents/core/AgentCLI.ts`

**Interfaces:**
- Consumes: `AgentRegistry.getAgent(name): AgentAdapter | undefined`, install/uninstall command argument parsing, `package.json.bin`
- Produces: `resolveManagedAgentAlias(name: string): string`-style behavior at CLI boundaries and a user-launchable `codemie-copilot` binary that loads `copilot-cli`

- [x] **Step 1: Write the failing test**

Capture the desired alias behavior as concrete expectations:

```ts
// Intended behavior after implementation:
expect(resolveInstallTarget('copilot')).toBe('copilot-cli');
expect(bin['codemie-copilot']).toBe('./bin/codemie-copilot.js');
expect(helpText).toContain('codemie install copilot');
```

- [x] **Step 2: Run test to verify it fails**

Initial source state confirmed before implementation:

- `package.json.bin` has no `codemie-copilot`
- `bin/` has no `codemie-copilot.js`
- `install.ts` and `uninstall.ts` perform direct `AgentRegistry.getAgent(name)` lookup, so `copilot` does not resolve
- `AgentCLI` prints install help using `this.adapter.name`, which would expose `copilot-cli`

Expected: current UX does not support the required commands.

- [x] **Step 3: Write minimal implementation**

Implement alias resolution at the CLI command boundary and add the launcher:

```js
// bin/codemie-copilot.js
#!/usr/bin/env node
import { AgentCLI } from '../dist/agents/core/AgentCLI.js';
import { AgentRegistry } from '../dist/agents/registry.js';
const agent = AgentRegistry.getAgent('copilot-cli');
if (!agent) process.exit(1);
await new AgentCLI(agent).run(process.argv);
```

In install/uninstall/list/help paths, resolve `copilot` to `copilot-cli` before registry lookup, but keep user-facing output on the short form where appropriate.

- [x] **Step 4: Run test to verify it passes**

Verify by inspection that:

- `codemie-copilot` exists in `package.json.bin`
- the new bin file loads `copilot-cli`
- install/uninstall accept `copilot`
- help/next-step text points users to `codemie install copilot` and `codemie-copilot` rather than exposing internal names unnecessarily

Expected: the required user commands are now represented in code.

- [ ] **Step 5: Commit (deferred until explicitly requested)**

```bash
git add bin/codemie-copilot.js package.json src/cli/commands/install.ts src/cli/commands/uninstall.ts src/cli/commands/list.ts src/agents/core/AgentCLI.ts
git commit -m "feat(cli): add copilot command aliases and launcher"
```

### Task 3 (implemented in core slice; commit deferred): Implement CodeMie-only runtime routing, version gating, and fail-fast validation

**Files:**
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`
- Create: `src/agents/plugins/copilot-cli/copilot-cli.models.ts` (if needed)
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.constants.ts`
- Inspect/modify only if necessary: shared provider/model helper modules already used by Codex/Kimi/Gemini

**Actual implementation notes:**

- `src/agents/plugins/copilot-cli/copilot-cli.models.ts` resolves the CodeMie model catalogue and filters to GPT-family/Claude-family models only.
- `CopilotCliPlugin.setupProxy()` resolves the effective model before proxy startup and stores the available model list in `CODEMIE_COPILOT_AVAILABLE_MODELS` for explicit override validation.
- `buildCopilotProviderEnv()` writes Copilot BYOK provider variables and uses `COPILOT_PROVIDER_WIRE_API=responses` for GPT-5-family models.
- `lifecycle.beforeRun` clears ambient GitHub token env vars and applies Copilot provider env.
- `lifecycle.enrichArgs` maps task/prompt behavior without passing invalid `--offline`.
- `src/providers/plugins/sso/proxy/plugins/claude-request-normalizer.plugin.ts` strips deprecated Sonnet 5 sampling params.
- `src/providers/plugins/sso/proxy/plugins/copilot-encrypted-content-sanitizer.plugin.ts` performs the Copilot-only one-shot retry after encrypted reasoning rejection.


**Interfaces:**
- Consumes: `AgentConfig`, `BaseAgentAdapter` lifecycle hooks, provider metadata, profile-derived config from `AgentCLI.handleRun`, version compatibility helpers from `BaseAgentAdapter`
- Produces: Copilot launch behavior that accepts only CodeMie-managed SSO/LiteLLM paths, validates requested models, and blocks GitHub fallback/login behavior with clear errors

- [x] **Step 1: Write the failing test**

State the intended validations concretely:

```ts
// Intended behavior after implementation:
expect(() => assertCopilotProviderSupported('bearer-auth')).toThrow(/supported provider/i);
expect(() => assertExplicitCopilotModelAllowed('unsupported-model', ['gpt-5.5'])).toThrow(/recommended/i);
expect(metadata.minimumSupportedVersion).toBeDefined();
```

- [x] **Step 2: Run test to verify it fails**

Initial Copilot plugin state confirmed before implementation:

- supported/minimum version metadata
- provider gating for SSO/LiteLLM only
- explicit model validation
- any runtime protection against GitHub-native auth fallback

Expected: current source cannot enforce the ticket’s startup rules.

- [x] **Step 3: Write minimal implementation**

Implement Copilot-specific runtime checks and lifecycle wiring, modeled after Codex/Kimi patterns:

```ts
function assertCopilotProviderSupported(provider?: string): void {
  if (!provider || !['ai-run-sso', 'litellm'].includes(provider)) {
    throw new ConfigurationError('GitHub Copilot CLI via CodeMie currently supports only AI/Run SSO and LiteLLM profiles.');
  }
}

function assertExplicitCopilotModelAllowed(model: string, available: string[]): void {
  // reject unsupported/fallback-prone models; recommend supported ones
}
```

Then wire these checks into `lifecycle.beforeRun`, `lifecycle.enrichArgs`, or `run()` so they execute before Copilot is spawned.

- [x] **Step 4: Run test to verify it passes**

Verify by code inspection that:

- metadata contains `supportedVersion` and `minimumSupportedVersion`
- only `ai-run-sso` and `litellm` are declared supported
- model validation happens before launch
- failure messages direct users to CodeMie setup/support paths rather than GitHub login

Expected: source now encodes the ticket’s core failure behavior.

- [ ] **Step 5: Commit (deferred until explicitly requested)**

```bash
git add src/agents/plugins/copilot-cli/copilot-cli.plugin.ts src/agents/plugins/copilot-cli/copilot-cli.constants.ts src/agents/plugins/copilot-cli/copilot-cli.models.ts
git commit -m "feat(agents): enforce codemie routing for copilot cli"
```

### Task 4 (pending): Wire Copilot into health, attribution, and conversation sync

**Files:**
- Modify: `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts`
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`
- Modify: any doctor/health files only if managed-agent display or checks require explicit Copilot handling
- Modify: analytics/report identity helpers only if a mismatch exists between `copilot-cli` and `codemie-copilot`

**Interfaces:**
- Consumes: `resolveConversationFolder(clientType?: string, agentName?: string): string`, AgentCLI `health` command path, managed agent metadata `ssoConfig.clientType`
- Produces: Copilot sessions attributed to Copilot-specific client identity and conversation folder, never the `Claude Desktop` fallback

- [ ] **Step 1: Write the failing test**

Record the expected sync mapping:

```ts
expect(resolveConversationFolder('codemie-copilot', undefined)).toBe('copilot-cli');
expect(resolveConversationFolder(undefined, 'copilot-cli')).toBe('copilot-cli');
expect(resolveConversationFolder('unknown', 'copilot-cli')).not.toBe('Claude Desktop');
```

- [ ] **Step 2: Run test to verify it fails**

Confirm current source only maps codex/gemini/claude/opencode/pi and otherwise falls back to `DEFAULT_CONVERSATION_FOLDER`.

Expected: Copilot would currently fall through to the fallback bucket.

- [ ] **Step 3: Write minimal implementation**

Add explicit Copilot mapping in conversation sync and ensure runtime metadata uses a dedicated client type:

```ts
if (clientType === 'codemie-copilot' || agentName === 'copilot-cli') {
  return 'copilot-cli';
}
```

If doctor/health surfaces need explicit display normalization, update them to show the agent as GitHub Copilot CLI while preserving internal keying.

- [ ] **Step 4: Run test to verify it passes**

Verify by inspection that:

- Copilot now resolves to a dedicated conversation folder
- Copilot no longer falls back to `Claude Desktop`
- runtime metadata/clientType and any health output paths are aligned with that identity

Expected: attribution and sync correctness is guaranteed in source.

- [ ] **Step 5: Commit**

```bash
git add src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts src/agents/plugins/copilot-cli/copilot-cli.plugin.ts
git commit -m "fix(providers): map copilot conversations and attribution"
```

### Task 5 (pending): Add customization parity metadata and runtime support for MCP, skills/custom agents, and hooks

**Files:**
- Modify: `src/agents/plugins/copilot-cli/copilot-cli.plugin.ts`
- Create: `src/agents/plugins/copilot-cli/copilot-cli.hook-transformer.ts` (only if needed)
- Modify: `src/agents/plugins/copilot-cli/index.ts`
- Modify any shared extension/MCP helper usage only when Copilot needs metadata-driven integration points

**Interfaces:**
- Consumes: `AgentMetadata.mcpConfig`, `AgentMetadata.extensionsConfig`, `AgentMetadata.hookConfig`, optional `getHookTransformer(): HookTransformer`, shared MCP/extensions scan utilities
- Produces: Copilot metadata/runtime capable of discovering/injecting MCP servers, skills/custom agents, and supported hook events through Copilot-supported locations

- [ ] **Step 1: Write the failing test**

Write down the intended metadata shape:

```ts
expect(CopilotCliPluginMetadata.mcpConfig).toBeDefined();
expect(CopilotCliPluginMetadata.extensionsConfig?.skillsEntryFile).toBe('SKILL.md');
expect(CopilotCliPluginMetadata.hookConfig?.eventNameMapping?.SessionStart).toBe('SessionStart');
```

- [ ] **Step 2: Run test to verify it fails**

Confirm current Copilot metadata has no MCP config, extensions config, or hook mapping.

Expected: customization parity is absent today.

- [ ] **Step 3: Write minimal implementation**

Add metadata and helper wiring consistent with Copilot’s supported surfaces:

```ts
extensionsConfig: {
  project: '.github/copilot',
  global: '~/.copilot',
  skillsEntryFile: 'SKILL.md',
},
hookConfig: {
  eventNameMapping: {
    SessionStart: 'SessionStart',
    SessionEnd: 'SessionEnd',
    UserPromptSubmit: 'UserPromptSubmit',
    PreToolUse: 'PreToolUse',
    PostToolUse: 'PostToolUse',
    Stop: 'Stop',
    ErrorOccurred: 'PermissionRequest',
  },
},
```

Adjust the exact paths/event mapping to Copilot’s real supported locations and semantics, preferring CodeMie-owned/user-level placement over version-controlled project writes where possible.

- [ ] **Step 4: Run test to verify it passes**

Verify by inspection that:

- Copilot metadata now advertises MCP/extensions/hook support
- any hook transformer is only introduced if payload normalization is truly required
- project/global asset paths align with the chosen non-invasive placement strategy

Expected: customization parity is represented in code and ready for runtime use.

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/copilot-cli/copilot-cli.plugin.ts src/agents/plugins/copilot-cli/index.ts src/agents/plugins/copilot-cli/copilot-cli.hook-transformer.ts
git commit -m "feat(agents): add copilot customization parity"
```

### Task 6 (pending): Update docs and user-facing guidance

**Files:**
- Modify: `README.md`
- Modify/Create: agent docs files that enumerate supported agents and usage examples
- Modify: any help/overview docs that should mention `copilot`

**Interfaces:**
- Consumes: approved design decisions, final command surface, supported provider scope
- Produces: user docs that show install/uninstall/run commands, provider requirements, and the no-GitHub-login/subscription expectation for CodeMie-managed Copilot CLI

- [ ] **Step 1: Write the failing test**

Define the minimum doc expectations:

```md
- README mentions `codemie install copilot`
- README mentions `codemie-copilot`
- Docs state that supported CodeMie-managed Copilot CLI runs do not require GitHub login/subscription
```

- [ ] **Step 2: Run test to verify it fails**

Inspect current docs and confirm Copilot is not documented alongside other managed agents.

Expected: the current docs do not satisfy the acceptance criteria.

- [ ] **Step 3: Write minimal implementation**

Add concise documentation covering:

- install: `codemie install copilot`
- uninstall: `codemie uninstall copilot`
- run: `codemie-copilot` and `codemie-copilot --task "..."`
- supported provider modes in scope
- requirement for an authenticated CodeMie profile
- explicit statement that GitHub login/subscription/PAT is not required in the supported CodeMie-managed path

- [ ] **Step 4: Run test to verify it passes**

Verify by reading the edited docs that all required commands and expectations are present and consistent with implementation naming.

Expected: docs satisfy the ticket’s release criteria.

- [ ] **Step 5: Commit**

```bash
git add README.md docs/agents/*.md
git commit -m "docs(agents): document codemie managed copilot cli"
```

## Self-Review

### 1. Spec coverage

- Managed-agent promotion: covered by Tasks 1–3.
- `copilot` alias support and `codemie-copilot` launcher: covered by Task 2.
- Version gating and fail-fast routing: covered by Task 3.
- Attribution and conversation sync correctness: covered by Task 4.
- MCP / skills / custom agents / hooks parity: covered by Task 5.
- README and agent docs updates: covered by Task 6.

No uncovered approved-design requirement remains.

### 2. Placeholder scan

Checked for red-flag placeholders such as “TODO”, “implement later”, or vague “add error handling” without concrete location/action. The plan uses explicit files, concrete intended behaviors, and concrete command blocks.

### 3. Type consistency

- Internal key remains `copilot-cli` everywhere in produced interfaces.
- User-facing alias is consistently `copilot` only at command boundaries.
- Client identity is consistently referred to as `codemie-copilot`.
- Conversation folder expectation is consistently `copilot-cli`.


### Task 7 (completed): Add focused regression tests for implemented core behavior

**Files:**
- Create: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.models.test.ts`
- Create: `src/agents/core/__tests__/agent-aliases.test.ts`
- Create: `src/providers/plugins/sso/proxy/plugins/__tests__/copilot-encrypted-content-sanitizer.plugin.test.ts`
- Modify: `src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts`

**Implemented assertions:**

- [x] Copilot appears in manageable agent surfaces and retains analytics/session adapter registration.
- [x] `copilot` resolves to internal `copilot-cli`, while launcher/help commands render as `codemie-copilot` and `codemie install copilot`.
- [x] Copilot model list excludes generic OpenAI/o-series/Codex-only/non-Claude/non-GPT model names.
- [x] Explicit unsupported model overrides fail with Copilot-specific GPT/Claude guidance.
- [x] Copilot encrypted-content retry sanitizer is scoped to `codemie-copilot` and does not apply to Codex.
- [x] Copilot encrypted-content retry removes replayed reasoning state and `reasoning.encrypted_content` includes before retrying.

**Verification command:**

```bash
npx vitest run --project unit   src/agents/plugins/copilot-cli/__tests__/copilot-cli.registry.test.ts   src/agents/plugins/copilot-cli/__tests__/copilot-cli.models.test.ts   src/agents/core/__tests__/agent-aliases.test.ts   src/providers/plugins/sso/proxy/plugins/__tests__/copilot-encrypted-content-sanitizer.plugin.test.ts
```
