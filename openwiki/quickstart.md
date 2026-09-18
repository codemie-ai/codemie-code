---
type: navigation guide
title: CodeMie Code Wiki Quickstart
description: A task-routing guide from the published CodeMie entry points to the architecture, runtime boundaries, operational lifecycle, integrations, workflows, and focused test suites needed to change the package safely.
tags: [quickstart, architecture, cli, plugins, testing]
verified:
  - by: openwiki/0.4.3
    at: 2026-08-29T08:09:18.077Z
sources:
  - id: openwiki-source-8037e2358a2c4f9b2c722a11
    resource: repo://AGENTS.md
  - id: openwiki-source-371a6d8a4fcb291e3e8d7291
    resource: repo://bin/agent-executor.js
  - id: openwiki-source-a1c6f166318281c1a37e8001
    resource: repo://bin/codemie-claude.js
  - id: openwiki-source-73aafb9bc993302f60627faa
    resource: repo://bin/codemie-mcp-proxy.js
  - id: openwiki-source-aa210045b4d9e85b7a7eb1ff
    resource: repo://bin/codemie.js
  - id: openwiki-source-5b54a58d1b51cd490b0e7162
    resource: repo://package.json
  - id: openwiki-source-23c009faa70a994252df8b77
    resource: repo://src/agents/core/AgentCLI.ts
  - id: openwiki-source-cf985357c2ea8c403c53e222
    resource: repo://src/agents/registry.ts
  - id: openwiki-source-69f1465f9bd0baca2064728f
    resource: repo://src/cli/index.ts
  - id: openwiki-source-7c7fa2026b2641d9e184ea9f
    resource: repo://src/frameworks/plugins/index.ts
  - id: openwiki-source-d1fbef09192ffbab6eff0bc2
    resource: repo://src/index.ts
  - id: openwiki-source-4e482a9888b381a021765ada
    resource: repo://src/providers/index.ts
  - id: openwiki-source-07cf75292ad1458efff13f97
    resource: repo://src/utils/config.ts
  - id: openwiki-source-ed8a2ce3d6071aa1f213f5aa
    resource: repo://src/utils/paths.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-29T08:09:18.077Z" }
---

CodeMie Code is an ESM Node.js package (`>=20`) whose public surface is both a library and a set of executable wrappers. Start from the surface the change affects, then follow the owning registry or runtime domain rather than bypassing it with a direct dependency.

## First, classify the change

| If the change concerns… | Start here | Then read |
|---|---|---|
| A published command, help text, command factory, shortcut executable, or package export | `package.json`, `bin/`, `src/cli/index.ts`, and `src/index.ts` | [CLI, Binaries, and Command Factories](/openwiki/architecture/cli-surface.md) and [Plugin Architecture and Dependency Boundaries](/openwiki/architecture/system-overview.md) |
| Profiles, `.env`, credentials, `CODEMIE_HOME`, project settings, or local persistence | `ConfigLoader` and path utilities | [Profiles, Configuration Precedence, and Local State](/openwiki/concepts/configuration-and-local-state.md) |
| Installing, launching, updating, or adapting a coding agent | `AgentRegistry`, the adapter, and `AgentCLI` | [Agent Adapters, Installation, and Runtime Injection](/openwiki/integrations/agent-plugin-system.md) and [Agent Launch, Sessions, Analytics, and Cleanup](/openwiki/workflows/agent-launch-and-session-telemetry.md) |
| A model provider, SSO/JWT, request streaming, proxy transformation, or desktop/editor connection | provider registration and SSO proxy code | [Provider Plugins, SSO, and the Streaming Local Proxy](/openwiki/integrations/provider-plugins-and-local-proxy.md) and [MCP Relay and Desktop/Editor Proxy Clients](/openwiki/integrations/mcp-and-desktop-clients.md) |
| Proxy startup, migrations, self-update, health checks, logs, or a failure that must not block a command | executable wrapper and daemon lifecycle code | [Operational Lifecycle: Daemons, Migrations, Updates, and Diagnostics](/openwiki/operations/daemon-migrations-and-diagnostics.md) |
| Session/transcript metrics, cleanup, `--task`, resume behavior, or agent process environment | `AgentCLI` and the selected adapter | [Agent Launch, Sessions, Analytics, and Cleanup](/openwiki/workflows/agent-launch-and-session-telemetry.md) |
| Hooks, assistants, skills, frameworks, or workflow scaffolding | corresponding CLI command and registry | [Hooks, Extensions, Skills, Frameworks, and Workflow Templates](/openwiki/workflows/hooks-skills-frameworks-and-automation.md) |
| A test failure or coverage for one of these boundaries | Vitest project selection and nearest representative test | [Test Projects, Isolation, and High-Risk Contracts](/openwiki/testing/test-strategy.md) |

## Entry-point map

`package.json` publishes the `codemie` root CLI, built-in and per-agent shortcuts, `codemie-mcp-proxy`, and `proxy-daemon`. The normal root path is deliberately different from the protocol bridge: `bin/codemie.js` runs pending migrations and a best-effort update check before dynamically loading `dist/cli/index.js`; the MCP wrapper validates its URL, logs to a file, and intentionally skips migrations, update checks, and plugin loading so stdout remains a clean JSON-RPC channel.

```text
published executable
  ├─ codemie → bin/codemie.js → migrations and update check → src/cli/index.ts
  │                                              ├─ provider and framework registration
  │                                              └─ commander command factories
  ├─ codemie-<agent> → AgentRegistry → AgentCLI → selected agent adapter
  ├─ codemie-mcp-proxy → StdioHttpBridge over stdio and HTTP
  └─ proxy-daemon → compiled proxy daemon
```

The root CLI imports provider and framework entry modules for registration before it adds command factories. Its `--task <task>` fast path resolves the `codemie-code` adapter through `AgentRegistry` and runs it through `AgentCLI`; otherwise it presents first-time/returning-user guidance for an argument-free invocation or lets Commander parse the requested command. Add a command through its factory and owning domain, not by reaching around those registries.

Agent shortcuts are intentionally thin wrappers: they resolve a named adapter from the registry and construct `AgentCLI`. The registry lazily registers built-in adapters once. Management callers must use its manageable-agent view, because analytics-only adapters remain registry-visible for telemetry but are excluded from install, update, uninstall, list, and doctor behavior.

## Safe change boundaries

- **Respect configuration and authentication gates.** `AgentCLI` checks installation, resolves configuration using CLI overrides, handles explicit JWT precedence, normalizes CodeMie API URLs for SSO/JWT providers, validates required configuration and provider authentication, then checks provider/model compatibility before launch. A change to flags, credentials, or adapter launch must preserve that order and its exit behavior. See [configuration](/openwiki/concepts/configuration-and-local-state.md), [agent integration](/openwiki/integrations/agent-plugin-system.md), and the [launch workflow](/openwiki/workflows/agent-launch-and-session-telemetry.md).
- **Keep local state relocatable.** `getCodemieHome()` honors `CODEMIE_HOME` and otherwise uses `~/.codemie`; callers should derive child paths through `getCodemiePath()`. `ConfigLoader` overlays defaults, global and local configuration, environment variables, and CLI overrides in that precedence order. Do not hard-code a home path or let tests write user state.
- **Preserve wrapper-specific failure semantics.** A failed normal-CLI migration only warns and a failed update check is ignored; failure to import the root CLI exits nonzero. Conversely, invalid MCP input or bridge startup failure is fatal, while shutdown tries to close the bridge. Route changes in these paths through the operational and MCP pages above.
- **Keep public API intentional.** `src/index.ts` is the package library barrel: it exposes the agent registry/adapter type, logger and process/error utilities, environment manager, SSO and proxy types, proxy-plugin registry, hook processing, and `ConfigLoader`. Changing it is a compatibility change, not merely an internal refactor.

## Focused validation route

Use the narrowest Vitest project that owns the contract. `unit` runs source tests in an isolated Node environment; `cli` runs non-agent integration tests; and `agent` runs the networked SSO/JWT integration tests after a build setup with longer timeouts and bounded workers. All receive a process-specific temporary `CODEMIE_HOME`, which protects developer state and prevents concurrent invocations sharing test logs. Package scripts expose these projects as `test:unit`, `test:integration`, and `test:integration:agent` (with `test:all` running all three).

For high-risk changes, begin with the owning page's test guidance and a nearby contract test—for example, agent shortcuts, proxy-daemon lifecycle, proxy header/normalizer behavior, session synchronization, or SSO desktop integration—rather than treating a broad suite as the specification. Repository guidance also requires tests to be written or run only when explicitly requested.

## Repository working constraints

Before modifying code, use the repository task classifier to select the relevant curated guide, then confirm behavior in source and focused tests. The project expects ESM imports with `.js` extensions, async/await, project-specific errors and logging, and the dependency direction **CLI → registry → plugin**. Avoid raw secret logging and raw `~/.codemie` paths. The generated wiki routes to the right owner; it does not replace source, tests, or the repository instructions.
