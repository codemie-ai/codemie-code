# Project Structure

## Quick Summary

CodeMie Code directory layout and organization guide.

**Category**: Architecture
**Complexity**: Simple
**Prerequisites**: File system basics

---

## Directory Structure

```
codemie-code/
├── src/                Source code (TypeScript)
├── tests/              Integration tests
├── dist/               Compiled JavaScript (gitignored)
├── bin/                Executable entry points
├── docs/               User documentation
├── scripts/            Build and utility scripts
├── .github/            CI/CD workflows
├── .codemie/           CodeMie configuration and templates
├── .gitignore
├── package.json        Dependencies and scripts
├── tsconfig.json       TypeScript configuration
├── vitest.config.ts    Test configuration
├── eslint.config.mjs   Linting rules
└── README.md
```

---

## Source Organization

```
src/
├── agents/             Agent system (core + plugins)
│   ├── core/          Base classes, registries, session mgmt
│   ├── plugins/       Agent plugins (claude, gemini, codemie-code)
│   └── registry.ts    Agent registry
├── providers/          LLM provider integrations
│   ├── core/          Base classes and registry
│   └── plugins/       Provider plugins (bedrock, sso, ollama, litellm)
├── cli/                CLI commands (Commander.js)
│   └── commands/      Individual command implementations
├── workflows/          CI/CD workflow templates
│   └── templates/     GitHub/GitLab workflow definitions
├── migrations/         Config/schema migration system
├── analytics/          Usage analytics and tracking
├── utils/              Shared utilities
│   ├── errors.ts      Error classes and handling
│   ├── logger.ts      Logging utilities
│   ├── processes.ts   Command execution (npm, git)
│   ├── config.ts      Configuration management
│   ├── security.ts    Credential storage, sanitization
│   └── paths.ts       Path utilities
├── env/                Environment management
└── frameworks/         Framework integrations
    ├── core/          Base classes
    └── plugins/       Framework plugins (bmad, speckit)
```

---

## Test Organization

```
tests/
├── integration/                Integration tests
│   ├── cli-commands/          CLI command tests
│   ├── metrics/               Analytics tracking tests
│   │   └── fixtures/          Test data
│   ├── session/               Session management tests
│   │   └── fixtures/          Test data
│   └── orchestrator/          Multi-agent orchestration tests
└── helpers/                    Test utilities

Note: Unit tests are co-located with source in __tests__/ directories
```

---

## File Naming

| Type | Convention | Example |
|------|------------|---------|
| Source files | kebab-case.ts | `agent-executor.ts` |
| Tests (unit) | *.test.ts | `flag-transform.test.ts` |
| Tests (integration) | descriptive-name.test.ts | `incremental-conversation-processing.test.ts` |
| Config | kebab-case.json | `config.example.json` |
| Entry points | kebab-case.js | `codemie-claude.js` |
| Types | PascalCase interface/type | `AgentAdapter`, `ProviderTemplate` |
| Classes | PascalCase | `AgentRegistry`, `CodeMieAgent` |

---

## Module Boundaries

```
CLI Commands (Top)
    ↓
Agent/Provider Registry (Orchestration)
    ↓
Agent Plugins / Provider Plugins (Implementation)
    ↓
Core Base Classes (Abstraction)
    ↓
Utils (Foundation)
```

**Rules**:
- ✅ Upper → Lower layers
- ✅ All layers → Utils
- ✅ Plugins → Core base classes
- ❌ Lower → Upper layers
- ❌ Circular dependencies
- ❌ Utils → Any other layer

**Example**: CLI commands can call AgentRegistry, which uses agent plugins, which extend BaseAgentAdapter, which uses utils.

---

## Finding Code

| Need | Location | Key Files |
|------|----------|-----------|
| **CLI entry point** | `bin/` | `codemie.js`, `codemie-claude.js`, `codemie-gemini.js` |
| **CLI commands** | `src/cli/commands/` | `setup.ts`, `install.ts`, `analytics.ts`, `doctor/` |
| **Agent system** | `src/agents/` | `registry.ts`, `core/`, `plugins/` |
| **Built-in agent** | `src/agents/codemie-code/` | `agent.ts`, `tools/`, `prompts.ts` |
| **Provider plugins** | `src/providers/plugins/` | `sso/`, `bedrock/`, `ollama/`, `litellm/` |
| **Error classes** | `src/utils/errors.ts` | All custom error types |
| **Configuration** | `src/utils/config.ts` | `ConfigLoader` class |
| **Logging** | `src/utils/logger.ts` | `logger` singleton |
| **Process utilities** | `src/utils/processes.ts` | `exec`, npm/git helpers |
| **Migrations** | `src/migrations/` | `runner.ts`, `registry.ts` |
| **Analytics** | `src/analytics/` | Usage tracking |
| **Workflows** | `src/workflows/` | CI/CD template management |
| **Tests** | `tests/integration/` | Integration test suites |
| **Unit tests** | `src/**/__tests__/` | Co-located with source |

---

## Key Architectural Patterns

### Plugin Pattern
- **Location**: `src/agents/plugins/`, `src/providers/plugins/`, `src/frameworks/plugins/`
- **Purpose**: Extensible agent and provider system
- **Example**: src/agents/plugins/claude/claude.plugin.ts:15-45

### Registry Pattern
- **Location**: `src/agents/registry.ts`, `src/providers/core/registry.ts`
- **Purpose**: Central registration and lookup for plugins
- **Example**: src/providers/core/registry.ts:19-31

### Base Class Pattern
- **Location**: `src/agents/core/BaseAgentAdapter.ts`, `src/providers/core/base/`
- **Purpose**: Shared functionality and contracts
- **Example**: src/agents/core/BaseAgentAdapter.ts:20-50

### Migration Pattern
- **Location**: `src/migrations/`
- **Purpose**: Version config/schema transformations
- **Example**: src/migrations/001-config-rename.migration.ts

---

## Import Path Guidelines

**Absolute imports**: Not used (rely on relative imports)

**Relative imports**: Use `.js` extension for ESM compatibility

```typescript
// ✅ Correct
import { AgentRegistry } from './agents/registry.js';
import { logger } from '../utils/logger.js';

// ❌ Wrong
import { AgentRegistry } from './agents/registry';
import { logger } from '../utils/logger.ts';
```

**Type imports**: Use `type` keyword for type-only imports

```typescript
// ✅ Correct
import type { AgentAdapter } from './agents/registry.js';

// ❌ Wrong
import { AgentAdapter } from './agents/registry.js';
```

---

## Entry Points

| Binary | File | Purpose |
|--------|------|---------|
| `codemie` | `bin/codemie.js` | Main CLI entry (setup, install, etc.) |
| `codemie-code` | `bin/agent-executor.js` | Built-in agent (LangGraph) |
| `codemie-claude` | `bin/codemie-claude.js` | Claude Code wrapper |
| `codemie-gemini` | `bin/codemie-gemini.js` | Gemini CLI wrapper |

All binaries are Node.js scripts with shebang: `#!/usr/bin/env node`

---

## Build Output

```
dist/                   Compiled JavaScript (mirrors src/)
├── agents/
├── providers/
├── cli/
├── utils/
└── index.js            Main export

Generated by: npm run build (tsc)
Gitignored: Yes
```

---

## Configuration Files

| File | Purpose |
|------|---------|
| `package.json` | Dependencies, scripts, metadata |
| `tsconfig.json` | TypeScript compiler options |
| `vitest.config.ts` | Test runner configuration |
| `eslint.config.mjs` | ESLint rules (flat config format) |
| `commitlint.config.cjs` | Commit message validation |
| `.gitignore` | Git exclusions |
| `.npmignore` | npm package exclusions |

---

## Documentation Structure

```
docs/
├── CONFIGURATION.md        Setup and config guide
├── COMMANDS.md             CLI command reference
├── AGENTS.md               Agent system overview
├── AUTHENTICATION.md       SSO and auth setup
├── EXAMPLES.md             Usage examples
└── ARCHITECTURE-CONFIGURATION.md  Config flow architecture
```

---

## Special Directories

### .codemie/
CodeMie-specific configuration and templates

```
.codemie/
├── guides/                 AI-optimized documentation (this file)
└── claude-templates/       Template library for code generation
    └── templates/
        ├── CLAUDE.md.template
        └── guides/         Guide templates
```

### .github/
CI/CD workflows and GitHub configuration

```
.github/
└── workflows/
    └── ci.yml              Build, test, lint pipeline
```

---

## Hidden Files & Directories (Development)

```
.claude/                Claude Code session data (gitignored)
.gemini/                Gemini CLI session data (gitignored)
.idea/                  JetBrains IDE config (gitignored)
node_modules/           npm dependencies (gitignored)
dist/                   Build output (gitignored)
```

---

## Package Structure (npm publish)

Only these files are included in the published package (see package.json `files`):

```
@codemieai/code/
├── dist/               Compiled source
├── bin/                Executable scripts
├── scripts/            Build scripts
├── src/workflows/templates/  Workflow YAML files
├── README.md
└── LICENSE
```

**Note**: Source TypeScript (`src/`) is NOT published, only compiled JavaScript (`dist/`)

---

## Quick Navigation Tips

**Finding a feature**:
1. Check CLI command: `src/cli/commands/[feature].ts`
2. Check agent plugin: `src/agents/plugins/[agent]/`
3. Check provider plugin: `src/providers/plugins/[provider]/`
4. Check utils: `src/utils/[domain].ts`

**Finding tests**:
1. Unit tests: `src/[module]/__tests__/[file].test.ts`
2. Integration tests: `tests/integration/[feature]/`

**Finding types**:
1. Check `types.ts` in the relevant module directory
2. Example: `src/agents/core/types.ts`, `src/providers/core/types.ts`

---

## References

- **Source**: `src/`
- **Tests**: `tests/` + `src/**/__tests__/`
- **Documentation**: `docs/`
- **Templates**: `.codemie/claude-templates/`
- **Main export**: `src/index.ts`
