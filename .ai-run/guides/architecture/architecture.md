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
│   └── analytics/      Usage tracking
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
├── cli/                CLI Layer - User interface
│   └── commands/       Commander.js command handlers
├── agents/             Agent System
│   ├── registry.ts     Agent registry (routing)
│   ├── core/           Base classes & interfaces
│   └── plugins/        Concrete agent implementations
├── providers/          Provider System
│   ├── core/           Provider interfaces
│   └── plugins/        LLM provider implementations
├── frameworks/         Framework System
│   ├── core/           Framework interfaces
│   └── plugins/        Framework implementations (LangGraph)
├── mcp/                MCP Proxy System
│   ├── auth/           OAuth provider & callback server
│   ├── stdio-http-bridge.ts  Stdio-to-HTTP bridge
│   ├── proxy-logger.ts       File-based proxy logger
│   └── constants.ts          MCP proxy constants
└── utils/              Utilities Layer
    ├── errors.ts       Error classes
    ├── logger.ts       Logging utilities
    ├── security.ts     Security utilities
    └── processes.ts    Process execution
```

---

## Plugin-Based 5-Layer Architecture

```
┌─────────────────────────────────┐
│  CLI Layer (src/cli/)           │  ← User commands
│  Commander.js handlers          │
└────────────┬────────────────────┘
             ↓ calls
┌─────────────────────────────────┐
│  Registry Layer                 │  ← Plugin discovery & routing
│  (src/agents/registry.ts)       │
└────────────┬────────────────────┘
             ↓ routes to
┌─────────────────────────────────┐
│  Plugin Layer                   │  ← Concrete implementations
│  (src/*/plugins/)               │     (agents, providers, frameworks)
└────────────┬────────────────────┘
             ↓ extends
┌─────────────────────────────────┐
│  Core Layer (src/*/core/)       │  ← Interfaces & base classes
│  Contracts & abstractions        │
└────────────┬────────────────────┘
             ↓ uses
┌─────────────────────────────────┐
│  Utils Layer (src/utils/)       │  ← Shared utilities
│  Errors, logging, security      │
└─────────────────────────────────┘
```

---

## Layer Responsibilities

| Layer | Responsibility | Evidence |
|---|---|---|
| CLI | Parse commands, prompt users, route to registries | `src/cli/index.ts:72`, `src/cli/commands/install.ts:11` |
| Registry | Discover and return concrete plugins by name | `src/agents/registry.ts:17`, `src/providers/core/registry.ts:19` |
| Plugin | Implement agent, provider, framework, and proxy behavior | `src/agents/plugins/codemie-code.plugin.ts:458`, `src/agents/plugins/codex/codex.plugin.ts:435` |
| Core | Define contracts, base adapters, lifecycle helpers, sessions | `src/agents/core/types.ts:574`, `src/agents/core/BaseAgentAdapter.ts:36` |
| Utils | Provide typed errors, logging, path/security, process helpers | `src/utils/errors.ts:1`, `src/utils/security.ts:77`, `src/utils/processes.ts:1` |

| Avoid | Prefer |
|---|---|
| CLI commands importing implementation details directly | Route through registries and adapter contracts |
| Cross-plugin direct calls | Shared contracts in `src/*/core/` and lifecycle hooks |
| Generic process or logging logic inside plugins | Utilities in `src/utils/` |
| Provider-specific code inside every agent | Provider hooks resolved by `lifecycle-helpers` |

---

## Communication Rules

| ✅ Allowed | ❌ Not Allowed |
|-----------|---------------|
| CLI → Registry → Plugin → Core → Utils | Skip layers |
| Pass data via interfaces/types | Share mutable state |
| Async/await throughout | Blocking operations |
| Plugins depend on Core | Core depends on Plugins |

**Flow**: `CLI → Registry → Plugin → Core → Utils` (Never skip layers)

---

## Module Boundaries

```
CLI (Top)
    ↓
Registry (Orchestration)
    ↓
Plugin (Implementation)
    ↓
Core (Contracts)
    ↓
Utils (Foundation)
```

**Rules**:
- ✅ Upper layers → Lower layers
- ✅ All layers → Utils
- ❌ Lower layers → Upper layers
- ❌ Circular dependencies
- ❌ Plugin → Plugin direct calls

---

## Error Flow

```
Plugin Error (throws)
    ↓ propagates
Registry (catches, adds context)
    ↓ re-throws
CLI (catches, formats for user)
```

**Example**:
```typescript
// Source: src/cli/commands/assistants/chat/index.ts:52-58
try {
  await chatWithAssistant(assistantId, message, options);
} catch (error: unknown) {
  const context = createErrorContext(error);
  logger.error('Failed to chat with assistant', context);
  console.error(formatErrorForUser(context));
  process.exit(1);
}
```

---

## Test Organization

```
tests/
├── integration/        Feature-level tests
│   ├── agents/
│   ├── providers/
│   └── workflows/
src/
└── [module]/
    └── __tests__/      Unit tests co-located with source
```

**Pattern**: Unit tests co-located with source files, integration tests separate.

---

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Modules | kebab-case.ts | `agent-registry.ts` |
| Tests | *.test.ts or __tests__/ | `registry.test.ts` |
| Plugins | *.plugin.ts | `claude.plugin.ts` |
| Interfaces | types.ts or *.types.ts | `types.ts` |
| Config | camelCase.json | `tsconfig.json` |

---

## Finding Code

| Need | Location |
|------|----------|
| CLI commands | `src/cli/commands/` |
| Agent plugins | `src/agents/plugins/` (claude, gemini, opencode, codemie-code) |
| Provider plugins | `src/providers/plugins/` |
| Core interfaces | `src/*/core/types.ts` |
| Session adapters | `src/agents/core/session/` |
| Error classes | `src/utils/errors.ts` |
| Logging | `src/utils/logger.ts` |
| Security | `src/utils/security.ts` |
| Processes | `src/utils/processes.ts` |
| Environment | `src/env/` |
| Configuration | `~/.codemie/` (runtime) |

---

## Plugin System Design

### Registry Pattern

The registry pattern is the main extension mechanism. Agent, provider, and framework plugins are looked up by name through registries instead of being called directly from CLI command handlers.

| Registry | Scope | Evidence |
|---|---|---|
| `AgentRegistry` | Claude, Gemini, OpenCode, Codex, CodeMie Code agents | `src/agents/registry.ts:17`, `src/agents/registry.ts:30` |
| `ProviderRegistry` | OpenAI-compatible, SSO, Bedrock, and other provider plugins | `src/providers/core/registry.ts:19` |
| `FrameworkRegistry` | Framework adapters such as BMAD and SpecKit | `src/frameworks/core/registry.ts:10` |

### Plugin Discovery

1. Registry initializes on first access (lazy)
2. Plugins register themselves in registry constructor
3. CLI queries registry by plugin name
4. Registry returns plugin instance or undefined

### Adding New Plugins

1. Implement interface from `core/types.ts`
2. Add plugin to registry initialization
3. No changes needed to CLI layer
4. Plugin is discoverable automatically

---

## Hook-Based Loose Coupling

CodeMie Code uses plugin architecture plus lifecycle hooks to keep integrations loosely coupled. Agents define defaults; providers can override or extend behavior through hook resolution without embedding provider-specific branches into every agent.

| Hook Point | Purpose | Evidence |
|---|---|---|
| `onSessionStart` | Create session state and emit start metrics | `src/agents/core/lifecycle-helpers.ts:141`, `src/agents/plugins/codex/codex.plugin.ts:170` |
| `beforeRun` | Prepare environment before spawning an agent | `src/agents/core/lifecycle-helpers.ts:176`, `src/agents/plugins/codemie-code.plugin.ts:235` |
| `enrichArgs` | Adjust CLI arguments after environment setup | `src/agents/core/lifecycle-helpers.ts:205`, `src/agents/plugins/gemini/gemini.plugin.ts:133` |
| `onSessionEnd` | Process transcript, metrics, cleanup, and sync | `src/agents/core/lifecycle-helpers.ts:233`, `src/agents/plugins/codex/codex.plugin.ts:314` |
| `afterRun` | Final lifecycle cleanup after session end | `src/agents/core/lifecycle-helpers.ts:267` |

### Resolution Rules

| Avoid | Prefer |
|---|---|
| Hardcoding provider behavior in each agent plugin | Provider `agentHooks` resolved by `resolveHook()` |
| Replacing agent defaults when provider customization is needed | Wildcard hook plus agent-specific hook chaining |
| Throwing from hook processing in a way that blocks the agent | Log and continue for non-critical session extraction paths |
| Treating hook payloads from all agents as identical | Use hook transformers such as `GeminiHookTransformer` |

### Proxy Plugin Interceptors

The SSO proxy follows the same loose-coupling principle. Proxy behaviors are registered as plugins, ordered by priority, and exposed as interceptors.

| Proxy Concern | Plugin Evidence |
|---|---|
| MCP OAuth relay and SSRF protection | `src/providers/plugins/sso/proxy/plugins/mcp-auth.plugin.ts:266` |
| Endpoint blocking | `src/providers/plugins/sso/proxy/plugins/endpoint-blocker.plugin.ts:25` |
| Gateway auth | `src/providers/plugins/sso/proxy/plugins/gateway-key.plugin.ts:8` |
| Request sanitization | `src/providers/plugins/sso/proxy/plugins/request-sanitizer.plugin.ts:36` |
| Header injection | `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:14` |
| Session sync | `src/providers/plugins/sso/proxy/plugins/sso.session-sync.plugin.ts:31` |

### Extension Rule

New behavior should attach at the nearest extension point: agent registry for a new agent, provider registry for a new provider, lifecycle hook for provider-specific runtime behavior, and proxy plugin interceptor for request/response concerns. Do not bypass those seams with direct imports between concrete plugins.

---

## Testing Strategy

| Layer | Test Type | Mock |
|-------|-----------|------|
| CLI | Unit | Registry |
| Registry | Unit | Plugins |
| Plugin | Unit | External tools |
| Core | Unit (interfaces) | N/A |
| Utils | Unit | File system, network |
| All | Integration | Nothing |

---

## Key Design Principles

1. **Separation of Concerns**: Each layer has distinct responsibility
2. **Dependency Inversion**: Plugins depend on Core interfaces, not vice versa
3. **Open/Closed**: Extend via plugins, don't modify core
4. **Plugin Isolation**: Plugins don't depend on each other
5. **Lazy Loading**: Registry initializes plugins on first use

---

## References

- **CLI**: `src/cli/commands/`
- **Registry**: `src/agents/registry.ts`, `src/providers/registry.ts`, `src/frameworks/registry.ts`
- **Plugins**: `src/*/plugins/`
- **Core**: `src/*/core/`
- **Utils**: `src/utils/`
- **Source**: `src/`
- **Tests**: `tests/integration/`, `src/**/__tests__/`

---
