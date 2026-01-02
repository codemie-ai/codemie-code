# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project is **AI/Run CodeMie CLI** - a professional, unified CLI tool for managing multiple AI coding agents.

---

## Navigation: Hierarchical Documentation

**This project uses hierarchical CLAUDE.md files** for token-efficient, context-aware documentation:

- **Root CLAUDE.md** (this file): Always loaded - provides project overview, core principles, and navigation
- **Subdirectory CLAUDE.md files**: Auto-loaded when working in specific areas

### Where to Find Detailed Context

| Working in... | Auto-loads... | Contains... |
|--------------|---------------|-------------|
| `src/agents/**` | `src/agents/CLAUDE.md` | Agent plugin development, lifecycle hooks, integration patterns |
| `src/providers/**` | `src/providers/CLAUDE.md` | Provider plugin development, agent hooks, setup wizard patterns |
| `src/cli/**` | `src/cli/CLAUDE.md` | CLI command patterns, factory pattern, testing |
| `src/analytics/**` | `src/analytics/CLAUDE.md` | Analytics system, aggregation, metrics, CLI usage |
| `src/workflows/**` | `src/workflows/CLAUDE.md` | Workflow management, template development, VCS integration |
| `tests/integration/**` | `tests/integration/CLAUDE.md` | Integration testing patterns, performance optimization, fixture management |
| `tests/integration/metrics/**` | `tests/integration/metrics/CLAUDE.md` | Agent metrics testing with full verification suite, golden dataset validation |

**Token Savings**: This structure reduces context by 30-70% depending on work location, enabling faster responses and more focused guidance.

### Memory Maintenance Commands

Keep CLAUDE.md files accurate and efficient with these commands:

- `/memory-add` - Capture session learnings at end of work
- `/memory-init [dir]` - Document directory architecture when starting new work
- `/memory-refresh` - Monthly audit of all CLAUDE.md files for accuracy

See `.claude/commands/README.md` for complete usage guide.

---

## Critical First Step: ALWAYS Read Documentation

**MANDATORY**: Before writing ANY code, you MUST:
1. Read the `README.md` file - this is your PRIMARY source of truth
2. Review this CLAUDE.md for architectural patterns and conventions
3. Check if a subdirectory CLAUDE.md exists for your working area
4. Study reference implementations mentioned in this guide

---

## Common Commands

```bash
# Installation & Setup
npm install                 # Install all dependencies
npm link                    # Link globally for local development

# Building
npm run build              # Compile TypeScript
npm run dev                # Watch mode for development

# Testing
npm run test               # Run tests with Vitest
npm run test:ui            # Run tests with interactive UI

# Code Quality
npm run lint               # Check code style (max 0 warnings)
npm run lint:fix           # Fix linting issues
npm run ci                 # Run full CI pipeline

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation
codemie-code health        # Test built-in agent

# Agent Shortcuts
codemie-claude "message"   # Claude Code
codemie-codex "message"    # Codex
codemie-gemini "message"   # Gemini CLI
codemie-deepagents "message" # Deep Agents

# Profile Management
codemie setup              # Configure provider
codemie profile            # List profiles
codemie-code --profile work "task"  # Use specific profile

# Analytics
codemie analytics          # View usage metrics
codemie analytics --agent claude --last 7d  # Filtered view

# Workflows
codemie workflow list      # List CI/CD workflows
codemie workflow install pr-review  # Install workflow
```

---

## Core Principles

**ALWAYS follow these fundamental principles:**

### KISS (Keep It Simple, Stupid)
- Write simple, straightforward code that's easy to understand
- Avoid over-engineering and unnecessary complexity
- Remove redundant code, scripts, and configuration
- Question every piece of complexity - is it truly needed?
- **Example**: Use plugin pattern instead of individual adapter files for each agent

### DRY (Don't Repeat Yourself)
- Never duplicate code, logic, or configuration
- Extract common patterns into reusable functions/utilities
- Reuse existing utilities from `src/utils/` before creating new ones
- One source of truth for each piece of knowledge
- **Example**: `agent-executor.js` handles all agent shortcuts instead of separate bin files

### Extensibility
- Design for easy addition of new features without modifying existing code
- Use plugin/adapter patterns for agent integration
- Define clear interfaces that new implementations can follow
- **Example**: Add new agents by creating a plugin, not modifying registry

### Reusability
- Write modular, composable functions with single responsibilities
- Avoid tight coupling between components
- Use dependency injection for testability
- **Example**: `ConfigLoader` works for all providers, not provider-specific loaders

### Maintainability
- Clear naming conventions that reflect purpose
- Comprehensive type definitions with TypeScript
- Consistent error handling patterns
- **Example**: `src/agents/plugins/` contains all agent implementations

### Clean Variable Management
- **Avoid unused variables entirely** - remove variables that are not used
- **Never prefix with underscore** (`_variable`) unless absolutely necessary
- **Only use underscore when**: Required by external API or framework
- **Prefer refactoring**: Remove unused parameters, use only needed properties

**Remember:** Simple, clean code is better than clever, complex code.

### Testing Philosophy

**Favor integration tests over unit tests** - Test real behavior, not implementation details.

- **Integration Tests First**: Test actual user experience end-to-end
- **Minimal Unit Tests**: Only for complex algorithms or utilities
- **Quality Over Quantity**: 1 good integration test > 10 fragile unit tests

---

## Project Overview

**AI/Run CodeMie CLI** is a professional, unified CLI wrapper for managing multiple AI coding agents:

1. **External Agent Management**: Install and run external agents (Claude Code, Codex, Gemini, Deep Agents)
2. **Built-in Agent**: CodeMie Native - a LangGraph-based coding assistant
3. **Configuration Management**: Unified config supporting multiple AI providers
4. **Multiple Interfaces**: CLI commands, direct executables, and programmatic APIs
5. **Cross-Platform**: Full support for Windows, Linux, and macOS
6. **Analytics**: Track usage, tokens, costs, and tool usage across all agents

---

## High-Level Architecture

### Core Components

```
codemie-code/
├── bin/                       # Executable entry points
│   ├── codemie.js            # Main CLI
│   ├── agent-executor.js     # CodeMie Native (built-in) agent
│   ├── codemie-claude.js     # Claude Code agent entry
│   ├── codemie-codex.js      # Codex agent entry
│   ├── codemie-gemini.js     # Gemini agent entry
│   └── codemie-deepagents.js # Deep Agents entry
├── src/
│   ├── cli/                  # CLI commands → See src/cli/CLAUDE.md
│   ├── agents/               # Agent system → See src/agents/CLAUDE.md
│   ├── providers/            # Provider system → See src/providers/CLAUDE.md
│   ├── analytics/            # Analytics system → See src/analytics/CLAUDE.md
│   ├── workflows/            # Workflow management → See src/workflows/CLAUDE.md
│   ├── frameworks/           # Framework integrations (BMAD, SpecKit)
│   ├── env/                  # Configuration system
│   ├── migrations/           # Config migration framework
│   └── utils/                # Shared utilities
```

### Key Patterns

#### 1. Plugin Pattern (Agents & Providers)
- Agents and providers are plugins, not hardcoded
- Auto-registration via decorators
- Open/Closed Principle: open for extension, closed for modification

#### 2. Lifecycle Hooks (Loose Coupling)
- Agents are provider-agnostic
- Providers customize agents via hooks at runtime
- Automatic hook chaining (wildcard → agent-specific)
- Zero compile-time dependencies

#### 3. Configuration Hierarchy
1. CLI arguments (highest priority)
2. Environment variables
3. Project config (`.codemie/`)
4. Global config (`~/.codemie/`)
5. Default values (lowest priority)

#### 4. Multi-Provider Profiles
- Version 2 config supports multiple named profiles
- One active profile used by default
- Use `--profile <name>` to override
- Automatic migration from legacy v1 configs

---

## Technology Stack

- **Node.js**: Requires >=24.0.0 for ES2024 features
- **TypeScript**: Full type safety with ES2024 + NodeNext modules
- **Commander.js**: CLI framework with subcommands
- **LangChain/LangGraph**: Agent orchestration (built-in agent)
- **Clack**: Modern terminal UI
- **Vitest**: Modern testing framework
- **ESLint**: Code quality (max 0 warnings allowed)

---

## Cross-Platform Support

CodeMie CLI is fully tested on Windows, Linux, and macOS:

- **Windows Fix (v0.0.15+)**: Dedicated entry points per agent
- **Path Handling**: All tools use Node.js `path` module
- **Process Execution**: Platform-agnostic spawning
- **Line Endings**: Automatic CRLF/LF handling

**Testing**:
```bash
npm run build && npm link
codemie doctor
codemie-{agent} health  # Test all agents
```

---

## Development Guidelines

### Working with Multi-Provider Configuration

1. **Profile Management**:
   - Use `ConfigLoader.saveProfile(name, profile)` to add/update
   - Use `ConfigLoader.switchProfile(name)` to change active
   - Never directly overwrite config files - use ConfigLoader methods

2. **Configuration Loading**:
   ```typescript
   const config = await ConfigLoader.load(process.cwd(), {
     name: profileName,  // Optional profile selection
     model: cliModel,    // Optional CLI overrides
     provider: cliProvider
   });
   ```

3. **Migration**: Use `loadMultiProviderConfig()` which auto-migrates legacy configs

### Working with Agent Shortcuts

All shortcuts support CLI overrides:
- `--profile`: Select provider profile
- `--provider`: Override provider
- `--model`: Override model
- `--api-key`: Override API key
- `--base-url`: Override base URL

**Pass-through**: Use `allowUnknownOption()` and filter known config options before forwarding to agent.

### Git Commits and Pull Requests

**CRITICAL: Keep commits and PRs simple and focused**

1. **Commit Messages**:
   - **1-2 sentences maximum** - Brief summary of what changed
   - Follow conventional commit format: `type(scope): description`
   - Examples:
     - ✅ `feat(agents): add codex metrics support`
     - ✅ `fix(cli): resolve path handling on Windows`
     - ❌ Multi-paragraph explanations with implementation details

2. **Pull Request Descriptions**:
   - **Strictly follow the PR template** (`.github/PULL_REQUEST_TEMPLATE.md`)
   - Summary: 1-2 sentences describing the change
   - Complete the checklist items
   - Do NOT add extensive implementation details or feature lists
   - Let code and tests speak for themselves

3. **PR Template Structure**:
   ```markdown
   ## Summary
   <!-- 1-2 sentences only -->

   ## Checklist
   - [ ] Self-reviewed
   - [ ] Manual testing performed
   - [ ] Documentation updated (if needed)
   ```

**Remember**: Simple, concise descriptions are better than verbose explanations.

### Cross-Module Development

When working across multiple modules:

1. **Read subdirectory CLAUDE.md** for context-specific guidance
2. **Follow plugin patterns** described in module documentation
3. **Use existing utilities** from `src/utils/` before creating new ones
4. **Maintain loose coupling** via hooks and interfaces

---

## Quick Reference: Best Practices Checklist

When writing code for this project, ask yourself:

✅ **KISS**: Is this the simplest solution? Can I remove any complexity?
✅ **DRY**: Am I duplicating code? Can I extract common patterns?
✅ **Extensibility**: Can new features be added without modifying existing code?
✅ **Reusability**: Are components modular and composable?
✅ **Maintainability**: Will others understand this in 6 months?
✅ **Plugin Pattern**: Should this be a plugin instead of core modification?
✅ **Loose Coupling**: Are agents provider-agnostic? Do providers use hooks?
✅ **Type Safety**: Are types defined and validated?
✅ **Error Handling**: Are error messages actionable?
✅ **Testing**: Integration test > unit test?
✅ **Documentation**: Will this require doc updates?
✅ **Commits & PRs**: Are commit messages 1-2 sentences? Does PR follow template?

---

## Additional Documentation

### User-Facing Documentation (`docs/`)

- **[CONFIGURATION.md](docs/CONFIGURATION.md)** - Setup wizard, environment variables, profiles
- **[COMMANDS.md](docs/COMMANDS.md)** - Complete command reference
- **[AGENTS.md](docs/AGENTS.md)** - Detailed agent documentation
- **[AUTHENTICATION.md](docs/AUTHENTICATION.md)** - SSO setup, token management
- **[EXAMPLES.md](docs/EXAMPLES.md)** - Common workflows and examples

### Architecture Documentation (`docs/`)

- **[ARCHITECTURE-CONFIGURATION.md](docs/ARCHITECTURE-CONFIGURATION.md)** - Configuration flow architecture
- **[ARCHITECTURE-PROXY.md](docs/ARCHITECTURE-PROXY.md)** - SSO proxy system architecture

### Developer Guides (Subdirectories)

- **[src/agents/CLAUDE.md](src/agents/CLAUDE.md)** - Agent plugin development (auto-loads)
- **[src/providers/CLAUDE.md](src/providers/CLAUDE.md)** - Provider plugin development (auto-loads)
- **[src/cli/CLAUDE.md](src/cli/CLAUDE.md)** - CLI command development (auto-loads)
- **[src/analytics/CLAUDE.md](src/analytics/CLAUDE.md)** - Analytics system (auto-loads)
- **[src/workflows/CLAUDE.md](src/workflows/CLAUDE.md)** - Workflow management (auto-loads)

---

## Summary: Hooks-Based Architecture

The CodeMie CLI architecture is built on a **hooks-based plugin system** that achieves complete separation of concerns:

**Core Principles:**
1. **Agents are provider-agnostic** - No hardcoded provider logic in agent code
2. **Providers customize agents via hooks** - Registered in `ProviderTemplate.agentHooks`
3. **Runtime resolution** - `lifecycle-helpers.ts` resolves hooks based on active provider
4. **Automatic chaining** - Wildcard hooks run first, agent-specific hooks run second
5. **Zero dependencies** - Agents and providers never import each other

**Benefits:**
- ✅ Testability: Components test independently
- ✅ Maintainability: Provider changes don't affect agent code
- ✅ Extensibility: Add providers/agents without modifying existing code
- ✅ Flexibility: Different providers can customize same agent differently
- ✅ Clarity: Clear separation of responsibilities

**Example**: Bedrock provider uses wildcard hook to transform AWS credentials for ALL agents, then Claude-specific hook enables Bedrock mode. Claude agent has zero knowledge of Bedrock.

---

## Local Development Notes

For personal notes, create `CLAUDE.local.md` (gitignored):
- Sandbox URLs and credentials
- Local configurations
- WIP features and experiments
- Personal reminders

This file is automatically ignored and won't be committed to the repository.
