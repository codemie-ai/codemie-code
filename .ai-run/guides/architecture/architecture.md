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
│   └── plugins/          Framework implementations (LangGraph)
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

Handles argument parsing, user prompts, and command routing. Does **not** contain business logic or direct plugin access.

- Reference: `src/cli/commands/install.ts:15`

### Registry Layer — Orchestration

Manages plugin discovery, lazy initialization, and routing. Does **not** handle CLI or plugin implementation details.

- Reference: `src/agents/registry.ts:14`

### Plugin Layer — Implementations

Concrete agent/provider/framework implementations. Each plugin handles specific external tool integration.

```typescript
// src/agents/plugins/claude/claude.plugin.ts:20
export class ClaudePlugin implements AgentAdapter {
  async install(): Promise<void> { /* npm install -g @anthropic-ai/claude-cli */ }
  async execute(args: string[]): Promise<void> { await exec('claude', args); }
}
```

- Reference: `src/agents/plugins/opencode/opencode.plugin.ts:335`

### Core Layer — Contracts

Defines interfaces and base classes that all plugins implement. Does **not** contain business logic.

```typescript
// src/agents/core/types.ts:10
export interface AgentAdapter {
  name: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  execute(args: string[], options?: ExecutionOptions): Promise<void>;
  isInstalled(): Promise<boolean>;
  getVersion(): Promise<string | undefined>;
  installVersion?(version: string): Promise<string | null>; // returns verified installed version; null = binary not yet on PATH
}
```

### Utils Layer — Foundation

Shared utilities for logging, error handling, security, and processes. Does **not** contain business logic or plugin specifics.

- Reference: `src/utils/errors.ts:15`, `src/utils/logger.ts`, `src/utils/security.ts`, `src/utils/processes.ts`

---

## Communication Rules

| Allowed | Not Allowed |
|---------|-------------|
| `CLI → Registry → Plugin → Core → Utils` | Skipping layers |
| Pass data via interfaces/types | Sharing mutable state |
| `async`/`await` throughout | Blocking operations |
| Plugins depend on Core | Core depends on Plugins |
| All layers → Utils | Plugin → Plugin direct calls |

**Flow**: `CLI → Registry → Plugin → Core → Utils` — never skip layers, never reverse direction.

---

## Error Flow

Errors propagate upward with context added at each layer:

```
Plugin Error (throws)
    ↓ propagates
Registry (catches, adds context)
    ↓ re-throws
CLI (catches, formats for user)
```

- Reference: `src/cli/commands/execute.ts:30` — uses `createErrorContext()` and `formatErrorForUser()` from `src/utils/errors.ts`.

---

## Test Organization

```
tests/integration/       Feature-level integration tests
src/[module]/__tests__/  Unit tests co-located with source
```

Unit tests are co-located with source; integration tests live in `tests/`.

---

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Modules | kebab-case.ts | `agent-registry.ts` |
| Tests | `*.test.ts` or `__tests__/` | `registry.test.ts` |
| Plugins | `*.plugin.ts` | `claude.plugin.ts` |
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

---

## Plugin System Design

**Registry pattern**: All plugin systems follow the same lazy-init registry approach.

```typescript
AgentRegistry.getAgent('claude')       // src/agents/registry.ts
ProviderRegistry.getProvider('openai') // src/providers/registry.ts
FrameworkRegistry.get('langgraph')     // src/frameworks/registry.ts
```

**Plugin discovery**:
1. Registry initializes on first access (lazy).
2. Plugins register in registry constructor.
3. CLI queries registry by name; registry returns instance or `undefined`.

**Adding a new plugin**:
1. Implement the interface from `core/types.ts`.
2. Register the plugin in the registry's `initialize()` method.
3. No CLI layer changes required — the plugin is auto-discoverable.

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
| Registry | `src/agents/registry.ts`, `src/providers/registry.ts`, `src/frameworks/registry.ts` |
| Plugins | `src/*/plugins/` |
| Core | `src/*/core/` |
| Utils | `src/utils/` |
| Tests | `tests/integration/`, `src/**/__tests__/` |
