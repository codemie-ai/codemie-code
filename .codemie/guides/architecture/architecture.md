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

### CLI Layer - User Interface

**Purpose**: Handle user input and command orchestration

```typescript
// Source: src/cli/commands/install.ts:15-25
export async function installCommand(agentName: string): Promise<void> {
  logger.setContext('install', agentName);
  const adapter = AgentRegistry.getAgent(agentName);
  if (!adapter) {
    throw new AgentNotFoundError(agentName);
  }
  await adapter.install();
  logger.success(`Agent ${agentName} installed`);
}
```

**Does**: Argument parsing, user prompts, command routing
**Doesn't**: Business logic, direct plugin access

---

### Registry Layer - Orchestration

**Purpose**: Plugin discovery, registration, and routing

```typescript
// Source: src/agents/registry.ts:14-32
export class AgentRegistry {
  private static readonly adapters: Map<string, AgentAdapter> = new Map();

  private static initialize(): void {
    AgentRegistry.registerPlugin(new CodeMieCodePlugin());
    AgentRegistry.registerPlugin(new ClaudePlugin());
    AgentRegistry.registerPlugin(new GeminiPlugin());
    AgentRegistry.registerPlugin(new OpenCodePlugin());
  }

  static getAgent(name: string): AgentAdapter | undefined {
    AgentRegistry.initialize();
    return AgentRegistry.adapters.get(name);
  }
}
```

**Does**: Plugin management, lazy initialization, routing
**Doesn't**: Plugin implementation details, CLI handling

---

### Plugin Layer - Implementations

**Purpose**: Concrete agent/provider/framework implementations

```typescript
// Source: src/agents/plugins/claude/claude.plugin.ts:20-35
export class ClaudePlugin implements AgentAdapter {
  public readonly name = 'claude';

  async install(): Promise<void> {
    const installed = await commandExists('claude');
    if (installed) {
      logger.info('Claude CLI already installed');
      return;
    }
    await exec('npm', ['install', '-g', '@anthropic-ai/claude-cli']);
  }

  async execute(args: string[]): Promise<void> {
    await exec('claude', args);
  }
}

// Source: src/agents/plugins/opencode/opencode.plugin.ts:335-386
export class OpenCodePlugin extends BaseAgentAdapter {
  private sessionAdapter: SessionAdapter;

  constructor() {
    super(OpenCodePluginMetadata);
    this.sessionAdapter = new OpenCodeSessionAdapter(OpenCodePluginMetadata);
  }

  async isInstalled(): Promise<boolean> {
    return await commandExists(this.metadata.cliCommand || 'opencode');
  }

  getSessionAdapter(): SessionAdapter {
    return this.sessionAdapter;
  }
}
```

**Does**: Specific agent logic, external tool integration, session analytics
**Doesn't**: Generic patterns, cross-cutting concerns

---

### Core Layer - Contracts

**Purpose**: Interfaces and base classes for plugins

```typescript
// Source: src/agents/core/types.ts:10-25
export interface AgentAdapter {
  name: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  execute(args: string[], options?: ExecutionOptions): Promise<void>;
  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
}

export interface AgentAnalyticsAdapter {
  getSessionId(): string | undefined;
  getModelUsed(): string | undefined;
}
```

**Does**: Define contracts, establish patterns
**Doesn't**: Implement business logic, handle CLI

---

### Utils Layer - Foundation

**Purpose**: Shared utilities and cross-cutting concerns

```typescript
// Source: src/utils/errors.ts:15-25
export class CodeMieError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class AgentNotFoundError extends CodeMieError {
  constructor(agentName: string) {
    super(`Agent not found: ${agentName}`, 'AGENT_NOT_FOUND');
  }
}
```

**Does**: Logging, error handling, security, processes
**Doesn't**: Business logic, plugin specifics

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
// Source: src/cli/commands/execute.ts:30-40
try {
  const adapter = AgentRegistry.getAgent(agentName);
  if (!adapter) {
    throw new AgentNotFoundError(agentName);
  }
  await adapter.execute(args);
} catch (error) {
  const context = createErrorContext(error, { agentName });
  logger.error('Execution failed', context);
  console.error(formatErrorForUser(context));
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

```typescript
// Central registry manages all plugins
AgentRegistry.getAgent('claude')      // Get agent plugin
ProviderRegistry.getProvider('openai') // Get provider plugin
FrameworkRegistry.get('langgraph')     // Get framework plugin
```

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
