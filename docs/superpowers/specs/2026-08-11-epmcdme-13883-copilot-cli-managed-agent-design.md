# EPMCDME-13883 — GitHub Copilot CLI as a first-class CodeMie managed agent

## Goal

Allow developers to install and run GitHub Copilot CLI through CodeMie as a first-class managed agent, using CodeMie-managed provider configuration and governance rather than GitHub-native authentication or hosted models.

User-facing commands must include:

- `codemie install copilot`
- `codemie uninstall copilot`
- `codemie-copilot`

while preserving the existing internal product identity as `copilot-cli`.

## Problem statement

The repository already contains a `copilot-cli` plugin and session adapter, but it is analytics-only today. The current implementation explicitly refuses install, uninstall, and run operations, and the registry excludes it from manageable-agent surfaces.

This creates a gap versus other CodeMie-supported agents such as Claude, Codex, Gemini, OpenCode, and Kimi:

- Copilot CLI cannot be installed through `codemie install`
- Copilot CLI cannot be launched as `codemie-copilot`
- Copilot CLI cannot participate in normal CodeMie agent health and management flows
- Copilot sessions risk attribution/sync inconsistencies because they are not yet fully wired into managed-agent identity flows

The new implementation must promote the existing `copilot-cli` integration to a standard CodeMie-managed agent without renaming the internal agent identity.

## External behavior constraints

GitHub Copilot CLI must run in CodeMie-managed BYOK/provider mode without requiring GitHub login, GitHub Copilot subscription, or a personal access token, provided the active CodeMie profile is configured for a supported provider mode.

The implementation must not silently fall back to:

- GitHub-hosted models
- GitHub login or device-code auth
- ambient GitHub credentials already present on the machine
- a different agent identity for attribution or conversation sync

When startup conditions are invalid, the system must fail fast with a CodeMie-directed message.

## Naming and identity model

### Internal identity

The internal agent identity remains:

- agent key: `copilot-cli`
- display name: `GitHub Copilot CLI`

The existing Copilot-specific files under `src/agents/plugins/copilot-cli/` remain the implementation home.

### User-facing aliases

The CLI must support:

- `codemie install copilot`
- `codemie uninstall copilot`
- `codemie-copilot`

These aliases must resolve to the single underlying `copilot-cli` plugin.

### Why internal identity stays unchanged

Keeping `copilot-cli` avoids:

- confusion with non-CLI Copilot products
- migration work across analytics and existing identity-based logic
- avoidable breakage of anything already working under the current agent key

## High-level approach

Upgrade the existing `copilot-cli` plugin in place from analytics-only to a fully managed agent.

This means:

- keep the existing Copilot session adapter and analytics parsing code
- remove analytics-only restrictions from the practical managed path
- implement install/uninstall/run/version behavior in the same plugin
- add command aliases and direct launcher support at the CLI boundary
- extend identity/sync/customization infrastructure to recognize Copilot as a first-class agent

No duplicate `copilot` plugin should be introduced.


## Implemented core decisions as of 2026-08-11

The core slice has been implemented with the following concrete choices:

- `copilot-cli` remains the canonical registry/plugin identity.
- `copilot` is a user-facing management alias for install, uninstall, list, update, and help surfaces.
- `codemie-copilot` is a dedicated launcher binary for Copilot CLI.
- Copilot-only model UX lives in `bin/codemie-copilot.js`, not in shared `AgentCLI`:
  - `codemie-copilot --model-list` prints available Copilot-compatible CodeMie models.
  - `codemie-copilot --model` opens an interactive picker.
  - `codemie-copilot --model <name>` keeps the existing explicit-model behavior.
  - picker selections are persisted under `~/.codemie/agents/copilot-cli/model.json`.
  - model precedence is explicit CLI model, `CODEMIE_MODEL`, saved Copilot model, then auto-resolution.
- Copilot-compatible model listing and validation is intentionally restricted to GPT-family and Claude-family models only.
  Broader OpenAI-family names such as generic `openai`, `o1`, `o3`, `o4`, or standalone `codex` are not treated as Copilot-compatible unless the model name is also GPT-family.
- Default model auto-resolution ranks GPT-family models ahead of Claude-family models, while still allowing explicit Claude selection.
- GPT-5-family traffic is routed through Copilot Responses API provider mode by setting `COPILOT_PROVIDER_WIRE_API=responses`.
- Claude-family Copilot traffic uses Anthropic-shaped provider mode.
- Copilot clears ambient GitHub auth env vars before launch (`GH_TOKEN`, `GITHUB_TOKEN`, `COPILOT_TOKEN`) to avoid GitHub-native auth fallback.
- The invalid `--offline` CLI argument is not passed to Copilot; offline behavior is represented only through the provider environment (`COPILOT_OFFLINE=true`).
- `--task` is translated to Copilot CLI's `--prompt`, and non-interactive prompt runs receive `--allow-all-tools` when the user has not supplied an approval flag.
- AI/Run SSO and LiteLLM are the supported provider modes for this slice.
- The SSO proxy uses the dedicated client type `codemie-copilot` for Copilot attribution.
- Copilot startup resolves the final model before proxy startup so proxy headers and Copilot request model stay aligned.
- The Claude request normalizer strips deprecated sampling fields for Sonnet 5-style models where those fields produce runtime 400s.
- A Copilot-only encrypted-content sanitizer retries Responses API encrypted-reasoning failures once after removing replayed reasoning state. Codex keeps its original sanitizer behavior and is not opted into the Copilot retry path.

## Delivery slices

The work ships in one PR but is implemented in four logical slices.

### Slice A — Core managed agent

Scope:

- promote `copilot-cli` from analytics-only to manageable agent
- add install/uninstall support
- add `codemie-copilot` launcher
- add CLI alias support for `copilot` in install/uninstall management flows
- add supported/minimum version enforcement
- add CodeMie-only provider/model/auth routing
- add fail-fast validation for unsupported runtime conditions
- add health-check participation in the same shape as other managed agents

### Slice B — Attribution and sync correctness

Scope:

- dedicated Copilot client identity for runtime attribution
- explicit conversation-folder resolution for Copilot
- prevent fallback filing into `Claude Desktop`
- normalize Copilot identity across reporting and sync surfaces where required

### Slice C — Customization parity

Scope:

- MCP configuration support
- skills and custom agents discovery/injection
- hook routing and event mapping
- use Copilot-supported config/asset surfaces without unnecessarily writing to version-controlled project files

### Slice D — Documentation and polish

Scope:

- README updates
- agent documentation updates
- install/usage examples
- requirements/provider documentation
- explicit documentation that CodeMie-managed Copilot CLI does not require GitHub subscription/login for supported BYOK/provider paths
- optional help/setup text updates if they materially improve discoverability

## Detailed design

## Slice A — Core managed agent

### A1. Registry and management behavior

The existing `copilot-cli` plugin remains the only plugin implementation for Copilot CLI.

Required changes:

- stop excluding the Copilot plugin from manageable-agent flows
- ensure `codemie install`, `codemie uninstall`, `codemie list`, and first-run management surfaces can resolve the Copilot plugin
- keep analytics/session-adapter resolution unified with management behavior

The preferred model is one metadata source and one plugin implementation for all Copilot CLI capabilities.

### A2. Install/uninstall alias resolution

Alias resolution should occur at the CLI command boundary before registry lookup.

Required behavior:

- `codemie install copilot` resolves to agent `copilot-cli`
- `codemie uninstall copilot` resolves to agent `copilot-cli`
- error/help output should present the short command form where user-facing clarity matters

This avoids duplicating metadata or introducing a synthetic `copilot` plugin.

### A3. Direct launcher

Add a new binary entrypoint:

- `bin/codemie-copilot.js`

The launcher loads `AgentRegistry.getAgent('copilot-cli')`, instantiates `AgentCLI`, and executes through the standard managed-agent path. It also owns Copilot-only UX that should not be added to shared `AgentCLI`:

- `--model-list` prints the Copilot-compatible model catalogue.
- valueless `--model` opens an interactive picker.
- `--model <name>` continues to work as an explicit model override.
- selected picker models are saved for future Copilot launches under the CodeMie agent state directory.

This keeps model-picking behavior local to Copilot because Copilot CLI does not expose the same in-session `/model` surface as CodeMie Codex.

### A4. Plugin promotion from analytics-only

The Copilot plugin must implement standard managed-agent operations:

- `install()`
- `uninstall()`
- `run()`
- `installVersion()` if version pinning uses the shared install flow
- `getVersion()` as needed to normalize Copilot version output

The existing session adapter remains attached to the same plugin.

### A5. Version policy

Copilot must follow the same version-governance pattern as other managed agents.

Metadata must include:

- `supportedVersion`
- `minimumSupportedVersion`

Behavior:

- below minimum: startup blocked
- above supported: startup allowed with warning
- `codemie install copilot --supported` installs the verified version
- already-installed detection works for normal install flows

### A6. CodeMie-only provider/auth routing

Every managed Copilot session must run only through CodeMie-managed configuration.

Hard requirements:

- startup must use provider/auth/model settings derived from the active CodeMie profile or explicit CLI override
- startup must not depend on GitHub-native auth state
- startup must not silently use GitHub-hosted models
- startup must not silently accept ambient GitHub credentials as the operative auth path

Implementation may use environment variables, generated config, or both, but the result must force Copilot into the CodeMie-owned provider path.

### A7. Model selection and validation

Model resolution priority is:

1. explicit CLI override (`codemie-copilot --model <name>`)
2. `CODEMIE_MODEL` / profile-derived model
3. saved Copilot picker selection from `~/.codemie/agents/copilot-cli/model.json`
4. auto-resolution from the CodeMie model catalogue

Before launching Copilot CLI, the runtime must:

- resolve the final model before proxy startup
- validate it against Copilot compatibility rules
- reject unsupported models with a clear message
- pass the selected model to both Copilot provider env and the proxy model configuration

Compatibility is deliberately limited to Claude-family and GPT-family models that have tool-calling and streaming support. The user-facing model list must not include unrelated model families or generic OpenAI/o-series/Codex-only names.

The failure must name:

- requested model
- reason it is unsupported
- recommended alternatives

No silent model substitution or fallback to GitHub-hosted models is allowed.

### A8. Provider scope for this ticket

The ticket explicitly requires supported operation for:

- AI/Run SSO
- LiteLLM key mode

Other provider modes remain out of scope unless they already work incidentally through shared infrastructure and do not create extra support burden.

### A9. Health-check participation

Copilot must participate in agent health in the same shape as peer agents.

Core health scope:

- installation status
- detected version
- provider configuration readiness
- model reachability or model-configuration readiness

Customization-specific health details can be extended later under Slice C where needed.

### A10. Failure behavior

Core managed-agent startup must fail fast for:

- missing authenticated or usable CodeMie profile
- unsupported model
- installed Copilot version below minimum supported version
- configuration states that would cause GitHub-native auth/model fallback

The failure text must direct users toward CodeMie setup or supported model/version choices rather than any GitHub login flow.

## Slice B — Attribution and conversation sync

### B1. Runtime attribution identity

Runtime requests should carry a dedicated Copilot client identity suitable for attribution and backend recognition.

The exact identifier should distinguish Copilot from other agents while staying compatible with existing backend/client conventions.

### B2. Conversation folder resolution

Conversation sync logic must explicitly recognize Copilot and never file it under the generic fallback folder.

Recognition must cover at least:

- `agentName === 'copilot-cli'`
- Copilot runtime client type used by the managed launcher path

Preferred behavior when uncertain:

- skip sync safely
- do not misclassify under `Claude Desktop`

### B3. Analytics/report consistency

Any analytics/report layer that depends on agent naming or client identity should consistently treat Copilot as Copilot CLI.

The implementation must preserve existing Copilot analytics behavior while ensuring new managed-agent runs are attributed correctly.

## Slice C — Customization parity

## C1. MCP support

Copilot should expose CodeMie-managed MCP servers through Copilot-supported configuration surfaces.

Required behavior:

- support project/user MCP discovery where Copilot allows it
- integrate with existing CodeMie MCP summary/config utilities through plugin metadata where possible
- avoid ad hoc Copilot-only config reading logic when shared infrastructure already fits

### C2. Skills and custom agents

Copilot should discover CodeMie-managed skills and custom agents through Copilot-supported extension/config directories.

Required behavior:

- define `extensionsConfig` for Copilot
- map CodeMie project/global scopes into Copilot-supported personal/project locations
- preserve the single plugin identity while making extensions discoverable inside Copilot sessions

### C3. Hooks

Copilot should execute CodeMie hooks for supported equivalent session/tool events.

Required behavior:

- define hook event mapping for Copilot-supported events
- add a hook transformer if payload normalization is required
- ignore non-equivalent or unsupported events without breaking runtime behavior

### C4. Asset placement policy

Customization parity should avoid unnecessary writes into the version-controlled repository tree.

Preferred rule:

- use user-level or CodeMie-owned Copilot directories by default
- use project-scoped locations only where Copilot explicitly expects them and where that aligns with the desired user experience

## Slice D — Documentation and polish

Documentation must describe Copilot alongside other managed agents.

Required doc content:

- install command: `codemie install copilot`
- uninstall command: `codemie uninstall copilot`
- launcher: `codemie-copilot`
- supported provider modes for this feature
- requirements such as Node version and authenticated CodeMie profile
- explicit statement that supported CodeMie-managed Copilot CLI runs do not require GitHub subscription/login/PAT
- examples for interactive and single-task usage

Documentation locations should include at least the README and agent-facing docs already used for peer agents.

## File and component impact

Likely impacted areas include:

- `src/agents/plugins/copilot-cli/` — main implementation home
- `src/agents/registry.ts` — manageable-agent behavior if needed
- `src/cli/commands/install.ts` — alias resolution and listing behavior
- `src/cli/commands/uninstall.ts` — alias resolution
- `src/cli/commands/list.ts` and related management surfaces — if alias/display handling needs updates
- `src/agents/core/` shared behavior only where genuinely reusable
- `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts` — Copilot folder resolution
- health-check / doctor surfaces where managed-agent recognition is required
- `package.json` / `bin/` — `codemie-copilot` entrypoint
- README and agent docs

## Non-goals

The following remain out of scope for this ticket unless they fall out naturally with no meaningful added scope:

- ACP adapter / IDE integration for Copilot
- mid-session model-family switching
- GitHub-hosted Copilot features that depend on GitHub authentication
- support for a user's own GitHub Copilot subscription as an alternative mode
- broader provider-mode expansion beyond the explicitly requested SSO and LiteLLM paths
- changes to how CodeMie authors skills, hooks, or MCP servers
- session analytics/token-cost expansion beyond what already exists for Copilot analytics

## Risks and open implementation concerns

Key implementation risks called out by the ticket and current codebase:

- proxy wire-format support differs between GPT-family and Claude-family models
- backend/client attribution may require explicit Copilot client recognition
- Copilot-specific provider normalization is needed for Responses API encrypted reasoning replay and Claude Sonnet 5 sampling-field compatibility
- customization parity may reveal differences between Copilot-supported project/user asset locations and current CodeMie extension assumptions

Implemented mitigations so far:

- resolve model before proxy startup so the proxy and Copilot agree on the model
- route GPT-5-family Copilot sessions through Responses API provider shape
- strip deprecated Sonnet 5 sampling fields before upstream forwarding
- retry Copilot-only encrypted reasoning replay failures once without replayed reasoning state
- keep Codex sanitizer behavior separate from Copilot retry behavior

Remaining concern areas are conversation sync attribution, customization parity, and release documentation.

## Recommended implementation order

1. Slice A — core managed agent
2. Slice B — attribution and conversation sync correctness
3. Slice C — customization parity (MCP, then skills/custom agents, then hooks)
4. Slice D — docs and release polish

This order produces an incrementally testable path while still landing as a single pull request.
