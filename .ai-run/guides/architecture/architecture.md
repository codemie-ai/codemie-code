# Architecture Guide

## Quick Summary

CodeMie Code architecture guide covering plugin-based 5-layer architecture and organizational patterns for CLI tools.

**Category**: Architecture
**Complexity**: Medium
**Prerequisites**: TypeScript, Node.js 20+, File system basics

---

## Directory Structure

```
codemie-code/
├── src/                Source code
│   ├── cli/            CLI commands layer
│   ├── agents/         Agent system (registry + plugins)
│   ├── providers/      LLM provider system
│   ├── frameworks/     Framework integrations
│   ├── mcp/            MCP proxy bridge & OAuth
│   ├── utils/          Shared utilities
│   ├── env/            Environment management
│   ├── workflows/      CI/CD templates
│   ├── hooks/          Hook matcher and executor
│   ├── skills/         Skill discovery and sync
│   ├── plugins/        Plugin manifest parsing and loaders
│   ├── telemetry/      Desktop telemetry runtime
│   ├── migrations/     Numbered ~/.codemie migrations
│   └── bin/            Daemon and login entry sources
├── tests/              Integration tests
├── bin/                Executable entry points
├── dist/               Build output (gitignored)
├── package.json        Dependencies & scripts
└── tsconfig.json       TypeScript configuration
```

---

## Source Organization

```
src/
├── cli/commands/         Commander.js command handlers
├── agents/
│   ├── registry.ts       Agent registry (routing)
│   ├── core/             Base classes & interfaces
│   └── plugins/          Concrete agent implementations
├── providers/
│   ├── core/             Provider interfaces
│   └── plugins/          LLM provider implementations
├── frameworks/
│   ├── core/             Framework interfaces
│   └── plugins/          Framework implementations and documentation-tool integrations
├── mcp/
│   ├── auth/             OAuth provider & callback server
│   ├── stdio-http-bridge.ts
│   ├── proxy-logger.ts
│   └── constants.ts
└── utils/
    ├── errors.ts         Error classes
    ├── logger.ts         Logging utilities
    ├── security.ts       Security utilities
    └── processes.ts      Process execution
```

---

## Plugin-Based 5-Layer Architecture

```
┌─────────────────────────────────┐
│  CLI Layer (src/cli/)           │  ← User commands
└────────────┬────────────────────┘
             ↓ calls
┌─────────────────────────────────┐
│  Registry Layer                 │  ← Plugin discovery & routing
│  (src/agents/registry.ts)       │
└────────────┬────────────────────┘
             ↓ routes to
┌─────────────────────────────────┐
│  Plugin Layer (src/*/plugins/)  │  ← Concrete implementations
└────────────┬────────────────────┘
             ↓ extends
┌─────────────────────────────────┐
│  Core Layer (src/*/core/)       │  ← Interfaces & base classes
└────────────┬────────────────────┘
             ↓ uses
┌─────────────────────────────────┐
│  Utils Layer (src/utils/)       │  ← Shared utilities
└─────────────────────────────────┘
```

---

## Layer Responsibilities

### CLI Layer — User Interface

Handles argument parsing, user prompts, and command routing. Does **not** contain business logic or direct plugin access; agent launch resolves the agent through `AgentRegistry.getAgent`. Known debt, to fix: `src/cli/commands/hook.ts`, `src/cli/commands/hook/`, `src/cli/commands/proxy/`, `src/cli/commands/analytics/`, `src/cli/commands/assistants/chat/`, `src/cli/commands/install.ts`, `src/cli/commands/setup.ts` import plugin internals directly. Evidence: `src/agents/registry.ts::AgentRegistry.getAgent`

- Reference: `src/cli/commands/install.ts::createInstallCommand`

### Registry Layer — Orchestration

Manages plugin discovery, lazy initialization, and routing. Does **not** handle CLI or plugin implementation details.

- Reference: `src/agents/registry.ts::AgentRegistry`

### Plugin Layer — Implementations

Concrete agent/provider/framework implementations. Each plugin handles specific external tool integration. Agent plugins extend the abstract `BaseAgentAdapter`, which implements `AgentAdapter`.

- Reference: `src/agents/core/BaseAgentAdapter.ts::BaseAgentAdapter`, `src/agents/plugins/claude/claude.plugin.ts::ClaudePlugin`, `src/agents/plugins/opencode/opencode.plugin.ts::OpenCodePlugin`

### Core Layer — Contracts

Defines interfaces and the base classes plugins extend. `BaseAgentAdapter` and the session pipeline under `src/agents/core/session/` carry shared behaviour, not only contracts.

- `AgentAdapter` members: `type`, `name`, `displayName`, `description`, `metadata`, `install()`, `uninstall()`, `isInstalled()`, `run(args, env?, options?)`, `getVersion(): Promise<string | null>`, `getMetricsConfig()`, plus optional resume-ownership hooks. Reference: `src/agents/core/types.ts::AgentAdapter`

### Utils Layer — Foundation

Shared utilities for logging, error handling, security, and processes. Does **not** contain business logic or plugin specifics.

- Reference: `src/utils/errors.ts::CodeMieError`, `src/utils/logger.ts`, `src/utils/security.ts`, `src/utils/processes.ts`

---

## Communication Rules

| Allowed | Not Allowed |
|---------|-------------|
| `CLI → Registry → Plugin → Core → Utils` | Skipping layers |
| Pass data via interfaces/types | Sharing mutable state |
| `async`/`await` throughout | Blocking operations |
| Plugins depend on Core | Core depends on Plugins |
| All layers → Utils | Plugin → Plugin direct calls |

**Flow**: `CLI → Registry → Plugin → Core → Utils`. Known debt, to fix: Core imports plugins in `src/agents/core/AgentCLI.ts`, `src/agents/core/BaseAgentAdapter.ts`, `src/agents/core/hook-credentials.ts`, `src/agents/core/evidence/record-store.ts`, `src/agents/core/session/BaseProcessor.ts`, `src/agents/core/session/BaseSessionAdapter.ts`, `src/agents/core/session/run-window.ts`, `src/agents/core/session/session-generation.ts`, `src/agents/core/session/stale-session-reconciliation.ts`; plugins `claude-code-otlp`, `codex` and `pi` import `src/agents/plugins/claude/session/claude-named-invocations.ts::NamedInvocationCounts`.

---

## Error Flow

Errors propagate upward; the registries hold no try/catch and add no context:

```
Plugin Error (throws)
    ↓ propagates through the registry unchanged
CLI (catches, formats for user)
```

- Reference: `src/cli/commands/shared/helpers.ts::handleSetupError` — uses `createErrorContext()` and `formatErrorForUser()` from `src/utils/errors.ts`.

---

## Test Organization

```
tests/integration/       CLI integration tests (`cli` project) and `agent-*.test.ts` (`agent` project)
src/[module]/__tests__/  Unit tests co-located with source (`unit` project)
```

Unit tests are co-located with source; integration tests live in `tests/integration/`. `tests/unit/` matches no project in `vitest.config.ts::projects`, so a test placed there never runs.

---

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Modules | kebab-case.ts; a file holding one class may be PascalCase (`BaseAgentAdapter.ts`, `SessionStore.ts`) | `session-config.ts` |
| Tests | `*.test.ts` or `__tests__/` | `registry.test.ts` |
| Plugins | `*.plugin.ts` for agents and frameworks; `<name>.template.ts` for providers | `claude.plugin.ts`, `sso.template.ts` |
| Interfaces | `types.ts` or `*.types.ts` | `types.ts` |
| Config | camelCase.json | `tsconfig.json` |

---

## Finding Code

| Need | Location |
|------|----------|
| CLI commands | `src/cli/commands/` |
| Agent plugins | `src/agents/plugins/` |
| Provider plugins | `src/providers/plugins/` |
| Core interfaces | `src/*/core/types.ts` |
| Session adapters | `src/agents/core/session/` |
| Error classes | `src/utils/errors.ts` |
| Logging | `src/utils/logger.ts` |
| Security | `src/utils/security.ts` |
| Processes | `src/utils/processes.ts` |
| Environment | `src/env/` |
| Hooks engine | `src/hooks/executor.ts::HookExecutor` |
| Migrations | `src/migrations/registry.ts::MigrationRegistry`, `src/migrations/runner.ts::MigrationRunner` |
| Plugin loading | `src/plugins/core/plugin-loader.ts::loadPlugin` |
| Skills | `src/skills/core/SkillManager.ts::SkillManager` |
| Desktop telemetry | `src/telemetry/runtime/DesktopTelemetryRuntime.ts::DesktopTelemetryRuntime` |
| Workflow templates | `src/workflows/registry.ts::getTemplate` |
| MCP bridge | `src/mcp/stdio-http-bridge.ts::StdioHttpBridge` |
| Environment | `src/env/manager.ts::EnvManager` |
| Proxy daemon entry (spawned detached by `codemie proxy start`) | `src/bin/proxy-daemon.ts::stateFile` |

---

## Plugin System Design

**Registry pattern**: each plugin system has its own registry, and they register differently.

```typescript
AgentRegistry.getAgent('claude')             // lazy initialize() registers every agent plugin
ProviderRegistry.getProvider('sso')          // each <name>.template.ts calls registerProvider() on import
FrameworkRegistry.getFramework('codegraph')  // src/frameworks/plugins/index.ts registers on import
```

**Adding a new plugin**:
1. Agents: extend `BaseAgentAdapter` and add `registerPlugin(new …)` to `AgentRegistry.initialize`; a `codemie-<agent>` shortcut also needs a `bin/` file and a `package.json` `bin` entry. Evidence: `src/agents/registry.ts::AgentRegistry.initialize`
2. Providers: export a template that calls `ProviderRegistry.registerProvider()` and import it from the provider's `index.ts`. Evidence: `src/providers/core/registry.ts::ProviderRegistry.registerProvider`
3. Frameworks: add `FrameworkRegistry.registerFramework(new …)` to `src/frameworks/plugins/index.ts`. Evidence: `src/frameworks/core/registry.ts::FrameworkRegistry.registerFramework`

---

## Testing Strategy

| Layer | Test Type | What to Mock |
|-------|-----------|--------------|
| CLI | Unit | Registry |
| Registry | Unit | Plugins |
| Plugin | Unit | External tools |
| Core | Unit | N/A |
| Utils | Unit | File system, network |
| All | Integration | Nothing |

---

## Key Design Principles

1. **Separation of Concerns** — each layer has a distinct responsibility.
2. **Dependency Inversion** — plugins depend on Core interfaces, not vice versa.
3. **Open/Closed** — extend via plugins; do not modify core.
4. **Plugin Isolation** — plugins do not depend on each other.
5. **Lazy Loading** — registry initializes plugins on first use.

---

## References

| Area | Path |
|------|------|
| CLI | `src/cli/commands/` |
| Registry | `src/agents/registry.ts`, `src/providers/core/registry.ts`, `src/frameworks/core/registry.ts` |
| Plugins | `src/*/plugins/` |
| Core | `src/*/core/` |
| Utils | `src/utils/` |
| Tests | `tests/integration/`, `src/**/__tests__/` |
| OTLP ingestion adapters | `OtlpAgentAdapter` (abstract base class, `src/agents/core/OtlpAgentAdapter.ts`) is a second, non-chat plugin type registered the same way as `AgentAdapter` — one plugin per coding tool, ingesting that tool's native hook/telemetry events into the analytics pipeline. See `docs/ARCHITECTURE-OTLP-PLUGIN.md` for the dispatch pattern and how to add a new adapter (e.g. a future Cursor/other-tool adapter). |
