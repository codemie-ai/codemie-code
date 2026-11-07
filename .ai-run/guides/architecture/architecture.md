# Architecture Guide

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: plugin registries, CLI command wiring and packaged runtime assets; logging, process and error rules live in `.ai-run/guides/development/development-practices.md`

## Structure and boundaries

### Rules
- R10. List every non-TS file read at runtime from `dist/` in `copyConfigs` or `fileConfigs` of `scripts/copy-plugins.js` (tsc copies no assets; a missing source only prints a warning, so the build still passes and the file is absent at runtime). Evidence: `scripts/copy-plugins.js::fileConfigs`
- R11. Keep workflow templates as `.yml` under `src/workflows/templates/<provider>/` and list them in that provider's `metadata.ts` (they are read from `src/` at runtime via `templateDir`, never copied to `dist/`, and `package.json` `files` ships them). Evidence: `src/workflows/templates/github/metadata.ts::templateDir`
- R13. Launch an agent through `AgentRegistry`: a new agent launch path resolves its adapter from the registry, never by importing the plugin directly (proxy and analytics commands may reach plugin-specific helpers). Evidence: `src/agents/registry.ts::AgentRegistry`

## Patterns in use

### Rules
- R6. Stop a proxied request by setting `context.metadata.blocked = true` in `onRequest`, never by throwing (`runHook` logs a thrown error and continues with the next interceptor, so the request still goes upstream). Evidence: `src/providers/plugins/sso/proxy/sso.proxy.ts::runHook`
- R7. Opt a proxy plugin out by throwing from `createInterceptor` with a message containing `disabled` or `not available` (logged at info); any other throw is logged as an error and the proxy starts without that plugin. Evidence: `src/providers/plugins/sso/proxy/plugins/registry.ts::PluginRegistry.initialize`
- R8. Build an ACP variant by extending the base plugin and overriding `metadata` with `silentMode: true` and an `enrichArgs` that prepends the ACP switch (stdout is the JSON-RPC channel; all five ACP plugins under claude/, codex/, gemini/, kimi/ and opencode/ set it). Evidence: `src/agents/plugins/gemini/gemini-acp.plugin.ts::GeminiAcpPlugin`
- R9. Write an OpenCode runtime plugin as a source-string constant whose handlers mutate `output` (OpenCode discards returned values; the string avoids compiling `@opencode-ai/plugin` types this package does not depend on). Evidence: `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts::SHELL_HOOKS_PLUGIN_SOURCE`
- R13. Expect a broken or duplicate Claude-format plugin to vanish silently: `resolvePlugins` keeps the first plugin of a name in source order (`--plugin-dir`, project `.codemie/plugins/`, user cache, settings dirs) and logs a load failure only at debug level. Evidence: `src/plugins/core/plugin-resolver.ts::resolvePlugins`

### Constraints
| Do not | Do instead | Why | Evidence |
|---|---|---|---|
| Do not copy `src/hooks/executor.ts::HookExecutor` | Change the runtime hook bridge in `src/agents/plugins/codemie-code-hooks/shell-hooks-source.ts` | `src/hooks/` has no production importer, only its own tests | `src/hooks/executor.ts::HookExecutor` |

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| adding a proxy plugin that blocks or short-circuits a request | `src/providers/plugins/sso/proxy/plugins/endpoint-blocker.plugin.ts::EndpointBlockerInterceptor` | smallest plugin: priority, interceptor, `metadata.blocked` | `src/providers/plugins/sso/proxy/plugins/__tests__/endpoint-blocker.plugin.test.ts::EndpointBlockerPlugin` |

## Extension points

### Rules
- R1. Register a new agent plugin with a `registerPlugin(new XPlugin())` line in `AgentRegistry.initialize()` and add its name to the exact name list asserted in `src/agents/__tests__/registry.test.ts` (the registry is an explicit list, not discovery; an `OtlpAgentAdapter` lands in a separate map and stays out of `getAgentNames()`). Evidence: `src/agents/registry.ts::AgentRegistry.initialize`
- R2. Register a provider at import time: `registerProvider()` in `<name>.template.ts`, setup steps and model proxy via `ProviderRegistry.register*` in its `index.ts`, and an import line in `src/providers/index.ts` (a provider missing from that import list never registers; `ProviderRegistry` has no lazy init). Evidence: `src/providers/core/decorators.ts::registerProvider`
- R3. Register a docs/framework tool with `FrameworkRegistry.registerFramework()` in `src/frameworks/plugins/index.ts`; a documentation tool sets `group: 'documentation'` so `codemie docs` lists it. Evidence: `src/frameworks/plugins/index.ts::registerFramework`
- R4. Add a config migration as `src/migrations/NNN-<slug>.migration.ts` ending in `MigrationRegistry.register(new X())`, plus an import line in `src/migrations/index.ts` (order is the id string sort; `success: false` keeps it pending and retried on every start-up, `success: true` records it permanently even when nothing changed). Evidence: `src/migrations/runner.ts::MigrationRunner.runPending`
- R5. Add a proxy plugin with a `registry.register(new XPlugin())` line in `registerCorePlugins()` and give it a numeric `priority` (execution order is ascending priority, not registration order). Evidence: `src/providers/plugins/sso/proxy/plugins/registry.ts::PluginRegistry.getEnabledPluginsSorted`
- R12. Add a CLI command as a `createXCommand(): Command` factory under `src/cli/commands/` and register it with `program.addCommand()` in `src/cli/index.ts`. Evidence: `src/cli/index.ts::addCommand`

### Read first
| When you are | Exemplar | Why this one | Tests |
|---|---|---|---|
| adding an agent shortcut binary | `bin/codemie-gemini.js::AgentCLI` | whole wrapper: registry lookup, not-found exit, `AgentCLI.run` | no covering test |
| adding a native-telemetry (OTLP) adapter or hook event | `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts::ClaudeCodeOtlpPlugin` | reference `OtlpAgentAdapter`; contract in `docs/ARCHITECTURE-OTLP-PLUGIN.md` | `src/agents/core/__tests__/OtlpAgentAdapter.test.ts::OtlpAgentAdapter` |
