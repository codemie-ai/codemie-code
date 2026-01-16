# Layered Architecture

## Quick Summary

CodeMie Code implements plugin-based 5-layer architecture: CLI → Registry → Plugins → Core → Utils.

**Category**: Architecture
**Complexity**: Medium
**Prerequisites**: TypeScript, Node.js, Plugin pattern basics

---

## Architecture Overview

```
┌─────────────────────────────────────┐
│  CLI Layer (src/cli/commands/)      │  ← User interface
│  Command handling & UI              │
└────────────┬────────────────────────┘
             ↓ calls
┌─────────────────────────────────────┐
│  Registry Layer (*/registry.ts)     │  ← Orchestration
│  Plugin discovery & routing         │
└────────────┬────────────────────────┘
             ↓ delegates to
┌─────────────────────────────────────┐
│  Plugin Layer (*/plugins/)          │  ← Implementation
│  Concrete implementations           │
└────────────┬────────────────────────┘
             ↓ extends
┌─────────────────────────────────────┐
│  Core Layer (*/core/)               │  ← Abstraction
│  Base classes & contracts           │
└────────────┬────────────────────────┘
             ↓ uses
┌─────────────────────────────────────┐
│  Utils Layer (src/utils/)           │  ← Foundation
│  Shared utilities                   │
└─────────────────────────────────────┘
```

---

## Layer Responsibilities

### Layer 1 - CLI Commands

**Location**: `src/cli/commands/`

**Purpose**: Handle user input, display output, orchestrate workflows

```typescript
// Source: src/cli/commands/setup.ts:17-25
export function createSetupCommand(): Command {
  const command = new Command('setup');

  command
    .description('Interactive setup wizard')
    .option('--force', 'Force re-setup')
    .action(async (options) => {
      await runSetupWizard(options.force);
    });
}
```

**Does**:
- Parse CLI arguments (Commander.js)
- Display UI (Inquirer, Chalk, Ora spinners)
- Call registry layer for operations
- Handle errors and display to user
- Coordinate workflows (setup, install, doctor)

**Doesn't**:
- Implement agent/provider logic
- Make direct API calls
- Access file system directly (use utils)
- Manage state beyond command execution

---

### Layer 2 - Registry/Orchestration

**Location**: `src/agents/registry.ts`, `src/providers/core/registry.ts`

**Purpose**: Register plugins, route requests, manage lifecycle

```typescript
// Source: src/providers/core/registry.ts:19-31
export class ProviderRegistry {
  private static providers: Map<string, ProviderTemplate> = new Map();

  static registerProvider<T extends ProviderTemplate>(template: T): T {
    this.providers.set(template.name, template);
    return template;
  }

  static getProvider(name: string): ProviderTemplate | undefined {
    return this.providers.get(name);
  }
}
```

**Does**:
- Maintain plugin registries
- Route requests to appropriate plugins
- Manage plugin discovery
- Handle plugin lifecycle events
- Provide lookup/query APIs

**Doesn't**:
- Implement provider-specific logic
- Display UI to user
- Handle CLI arguments directly
- Make external API calls

---

### Layer 3 - Plugin Implementation

**Location**: `src/agents/plugins/`, `src/providers/plugins/`, `src/frameworks/plugins/`

**Purpose**: Concrete implementations of agents, providers, frameworks

```typescript
// Source: src/agents/plugins/claude/claude.plugin.ts:25-35
export class ClaudePlugin extends BaseAgentAdapter {
  constructor(config: AgentPluginConfig) {
    super('claude', config);
  }

  async start(message?: string): Promise<void> {
    // Claude-specific implementation
    const args = this.buildClaudeArgs(message);
    await this.executeAgent(args);
  }
}
```

**Does**:
- Extend base classes from Core layer
- Implement plugin-specific logic
- Handle external API calls (via utils)
- Manage plugin-specific state
- Process data specific to the plugin

**Doesn't**:
- Register itself (done by registry layer)
- Parse CLI arguments (done by CLI layer)
- Reimplement common functionality (use Core layer)

---

### Layer 4 - Core/Base Classes

**Location**: `src/agents/core/`, `src/providers/core/base/`, `src/frameworks/core/`

**Purpose**: Abstract base classes, shared interfaces, common functionality

```typescript
// Source: src/agents/core/BaseAgentAdapter.ts:20-35
export abstract class BaseAgentAdapter implements AgentAdapter {
  protected name: string;
  protected config: AgentPluginConfig;

  constructor(name: string, config: AgentPluginConfig) {
    this.name = name;
    this.config = config;
  }

  abstract start(message?: string): Promise<void>;

  getName(): string {
    return this.name;
  }
}
```

**Does**:
- Define contracts (interfaces)
- Provide shared functionality (base methods)
- Enforce patterns via abstract classes
- Manage common state
- Provide lifecycle hooks

**Doesn't**:
- Implement plugin-specific logic
- Make external API calls directly
- Handle user input
- Register plugins

---

### Layer 5 - Utils Foundation

**Location**: `src/utils/`

**Purpose**: Shared utilities for all layers

```typescript
// Source: src/utils/processes.ts:45-52
export async function exec(
  command: string,
  args?: string[],
  options?: ExecOptions
): Promise<ExecResult> {
  // Low-level command execution
  return new Promise((resolve, reject) => { ... });
}
```

**Does**:
- Command execution (exec, npm, git)
- File system operations (paths)
- Error handling (custom errors)
- Logging (logger singleton)
- Configuration (ConfigLoader)
- Security (sanitization, credential storage)

**Doesn't**:
- Call upper layers
- Implement business logic
- Handle CLI arguments
- Register plugins

---

## Communication Rules

| ✅ Allowed | ❌ Not Allowed | Reason |
|-----------|---------------|---------|
| CLI → Registry → Plugins | Skip layers | Maintains separation of concerns |
| Plugins → Core (extends) | Core → Plugins | Dependency inversion |
| All layers → Utils | Utils → Any layer | Utils are foundation |
| Pass data via interfaces | Shared global state | Testability & maintainability |
| Async/await throughout | Blocking sync calls | Node.js best practices |

---

## Data Flow Example

### User Installs Agent

```
1. User: codemie install claude
           ↓
2. CLI: src/cli/commands/install.ts
   - Parse command
   - Display UI
           ↓
3. Registry: src/agents/registry.ts
   - Lookup 'claude' plugin
   - Get installer
           ↓
4. Plugin: src/agents/plugins/claude/claude.plugin-installer.ts
   - Extend BaseAgentInstaller
   - Execute npm install @claude/code
           ↓
5. Utils: src/utils/processes.ts
   - exec('npm', ['install', '@claude/code'])
           ↓
6. Result bubbles back up:
   Utils → Plugin → Registry → CLI → User
```

---

## Error Flow

```
Utils Layer Error (exec failed)
    ↓ throw NpmError
Plugin Layer (catches, adds context)
    ↓ throw AgentInstallationError
Registry Layer (passes through)
    ↓ throw
CLI Layer (catches, displays to user)
    ↓ console.error + formatErrorForUser
User sees friendly error message
```

**Example**: src/utils/errors.ts:74-119 (parseNpmError)

---

## Dependency Rules

### Allowed Dependencies

```
CLI Layer:
  ✅ Registry layer
  ✅ Utils layer
  ❌ Plugin layer (must go through registry)
  ❌ Core layer (use via registry)

Registry Layer:
  ✅ Core layer (interfaces)
  ✅ Utils layer
  ✅ Plugin layer (for registration)
  ❌ CLI layer

Plugin Layer:
  ✅ Core layer (extends)
  ✅ Utils layer
  ❌ Registry layer
  ❌ CLI layer

Core Layer:
  ✅ Utils layer (for types, errors)
  ❌ All other layers

Utils Layer:
  ✅ Node.js stdlib
  ✅ External libraries
  ❌ All project layers
```

---

## Testing Strategy

| Layer | Test Type | Mock Dependencies | Location |
|-------|-----------|-------------------|----------|
| **CLI** | Unit | Registry, Utils | src/cli/commands/__tests__/ |
| **Registry** | Unit | Plugins | src/agents/__tests__/, src/providers/core/__tests__/ |
| **Plugins** | Unit | Core, Utils, External APIs | src/agents/plugins/*/__tests__/ |
| **Core** | Unit | Utils | src/agents/core/__tests__/ |
| **Utils** | Unit | External deps only | src/utils/__tests__/ |
| **All** | Integration | Nothing (real dependencies) | tests/integration/ |

**Testing Pattern**: Use dynamic imports for better mock control (see src/utils/__tests__/ examples)

---

## Module Boundaries

### Cross-Cutting Concerns

Some patterns span multiple layers:

| Concern | Implementation |
|---------|----------------|
| **Session Management** | Plugin layer (src/agents/plugins/claude/session/) |
| **Metrics Collection** | Plugin layer (src/agents/core/metrics/) |
| **Migration System** | Separate subsystem (src/migrations/) |
| **Analytics** | Separate subsystem (src/analytics/) |
| **Workflows** | Separate subsystem (src/workflows/) |

These are **domain-specific subsystems** that follow the same layering principles internally.

---

## Anti-Patterns to Avoid

| ❌ Anti-Pattern | ✅ Correct Pattern | Why |
|----------------|-------------------|-----|
| CLI directly calls plugin | CLI → Registry → Plugin | Registry manages lifecycle |
| Plugin calls CLI | Use callbacks/events | Inverts dependency flow |
| Utils import from src/agents/ | Utils stays independent | Utils are foundation |
| Skip registry, access plugins directly | Always use registry | Breaks plugin system |
| Global state between layers | Pass data via args | Testability |

---

## Common Patterns by Layer

| Layer | Key Patterns |
|-------|-------------|
| **CLI** | Commander.js commands, Inquirer prompts, Chalk/Ora UI, formatErrorForUser |
| **Registry** | Static class, Map storage, Type-safe registration, Lazy loading |
| **Plugins** | Extend base class, Self-registration, Config-driven, Decorator pattern |
| **Core** | Abstract base classes, Interface segregation, Template method |
| **Utils** | Pure functions, Logger singleton, Error-first design, Promisify async |

---

## References

- **CLI Layer**: `src/cli/commands/`
- **Registry Layer**: `src/agents/registry.ts`, `src/providers/core/registry.ts`
- **Plugin Layer**: `src/agents/plugins/`, `src/providers/plugins/`
- **Core Layer**: `src/agents/core/`, `src/providers/core/base/`
- **Utils Layer**: `src/utils/`
- **Testing Examples**: `src/utils/__tests__/` (best practices for dynamic imports)

---

## Related Guides

- Project Structure: .codemie/guides/architecture/project-structure.md
- Testing Patterns: .codemie/guides/testing/testing-patterns.md
- Code Quality: .codemie/guides/standards/code-quality.md
