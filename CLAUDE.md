# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Critical First Step: ALWAYS Read Documentation

**MANDATORY**: Before writing ANY code, you MUST:
1. Read the `README.md` file - this is your PRIMARY source of truth
2. Review this CLAUDE.md for architectural patterns and conventions
3. Study reference implementations mentioned in this guide

## Common Commands

```bash
# Installation & Setup
npm install                 # Install dependencies
npm link                    # Link globally for local testing

# Building
npm run build              # Compile TypeScript
npm run dev                # Watch mode for development

# Code Quality
npm run lint               # Check code style with ESLint (max 10 warnings)
npm run lint:fix           # Fix linting issues automatically
npm run ci                 # Run full CI pipeline (license-check + lint + build)

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation and configuration
codemie-code health        # Test built-in agent health

# Testing the Built-in Agent
codemie-code --task "test"  # Single task execution
codemie-code --debug       # Interactive with debug logging

# Direct Agent Shortcuts (bypass registry)
codemie-claude             # Direct Claude Code access
codemie-codex              # Direct Codex access
codemie-claude health      # Claude health check
codemie-codex health       # Codex health check

# Release & Publishing
git tag -a v0.0.1 -m "Release version 0.0.1"  # Create release tag
git push origin v0.0.1                         # Push tag to trigger publish
```

## Core Principles

**ALWAYS follow these fundamental principles:**

### KISS (Keep It Simple, Stupid)
- Write simple, straightforward code that's easy to understand
- Avoid over-engineering and unnecessary complexity
- Remove redundant code, scripts, and configuration
- If something can be done in fewer lines/steps, do it
- Question every piece of complexity - is it truly needed?

### DRY (Don't Repeat Yourself)
- Never duplicate code, logic, or configuration
- Extract common patterns into reusable functions/utilities
- Reuse existing utilities from \`src/utils/\` before creating new ones
- If you find yourself copying code, refactor it into a shared function
- One source of truth for each piece of knowledge

**Remember:** Simple, clean code is better than clever, complex code.

## Project Overview

**CodeMie** is a unified CLI wrapper for managing multiple AI coding agents, featuring:

1. **External Agent Management**: Install and run external agents (Claude Code, Codex)
2. **Built-in Agent**: CodeMie Native - a LangGraph-based coding assistant
3. **Configuration Management**: Unified config system supporting multiple AI providers
4. **Multiple Interfaces**: CLI commands, direct executables, and programmatic APIs

## Architecture Overview

### High-Level Structure

```
codemie-code/
├── bin/                     # Executable entry points
│   ├── codemie.js          # Main CLI entry
│   ├── codemie-code.js     # Direct built-in agent executable
│   ├── codemie-claude.js   # Claude agent wrapper
│   └── codemie-codex.js    # Codex agent wrapper
├── src/
│   ├── cli/                # CLI command implementations
│   ├── agents/             # Agent registry and adapters
│   ├── env/                # Environment and config management
│   ├── utils/              # Shared utilities
│   └── index.ts           # Main package exports
```

### Core Components

#### 1. Agent System (`src/agents/`)

- **Registry** (`registry.ts`): Central registry managing all available agents
- **Adapters** (`adapters/`): Standardized interfaces for external agents
  - `claude-code.ts`: Anthropic Claude Code integration
  - `codex.ts`: OpenAI Codex integration
  - `codemie-code.ts`: Built-in agent adapter
- **Built-in Agent** (`codemie-code/`): Full LangGraph-based agent implementation

#### 2. CLI System (`src/cli/`)

- **Main CLI** (`index.ts`): Commander.js-based CLI with all commands
- **Commands** (`commands/`): Individual command implementations
  - `setup.ts`: Interactive configuration wizard
  - `install.ts`/`uninstall.ts`: Agent management
  - `run.ts`: Agent execution with environment passing
  - `doctor.ts`: Health checks and diagnostics
  - `config.ts`: Configuration management

#### 3. Configuration System (`src/env/`)

- **EnvManager** (`manager.ts`): Global config at `~/.codemie/config.json`
- **Priority**: Environment variables override config file
- **Providers**: Anthropic, OpenAI, Azure, Bedrock, LiteLLM
- **Model Validation**: Real-time model fetching via `/v1/models` endpoints

#### 4. Built-in Agent Architecture (`src/agents/codemie-code/`)

**Multi-layered architecture:**

- **Main Interface** (`index.ts`): `CodeMieCode` class - primary API
- **Agent Core** (`agent.ts`): `CodeMieAgent` - LangGraph integration
- **Configuration** (`config.ts`): Provider config loading and validation
- **Tools System** (`tools/`): Modular tool implementations
  - `filesystem.ts`: File operations with security controls
  - `command.ts`: Shell command execution
  - `git.ts`: Git operations and status
  - `security.ts`: Security filters and validation
- **UI System** (`ui.ts`, `streaming/`): Modern terminal interfaces
- **Types** (`types.ts`): Comprehensive TypeScript definitions

### Key Architectural Patterns

#### Agent Adapter Pattern
All agents implement the `AgentAdapter` interface:
```typescript
interface AgentAdapter {
  name: string;
  displayName: string;
  description: string;
  install(): Promise<void>;
  uninstall(): Promise<void>;
  isInstalled(): Promise<boolean>;
  run(args: string[], env?: Record<string, string>): Promise<void>;
  getVersion(): Promise<string | null>;
}
```

#### Configuration Hierarchy
1. Environment variables (highest priority)
2. Global config file (`~/.codemie/config.json`)
3. Default values (lowest priority)

#### Tool System Architecture
- **Modular Design**: Each tool type in separate file
- **Security First**: All operations go through security filters
- **Type Safety**: Full TypeScript coverage with Zod validation
- **Error Handling**: Structured error types with context

#### Execution Modes
- **Interactive**: Full terminal UI with streaming responses
- **Task Mode**: Single task execution with `--task` flag
- **Health Checks**: Connection and configuration validation

### Technology Stack

- **TypeScript**: Full type safety with ES2024 + NodeNext modules
- **Commander.js**: CLI framework with subcommands
- **LangChain/LangGraph**: Agent orchestration and tool calling
- **Clack**: Modern terminal user interface
- **Chalk**: Terminal styling and colors
- **Zod**: Runtime type validation
- **ESLint**: Code quality (max 10 warnings allowed)

## Development Guidelines

### Working with Agent Shortcuts

When modifying the direct agent shortcuts (`codemie-claude`, `codemie-codex`):

1. **Configuration Override Pattern**: All shortcuts support CLI overrides for:
   - `--model`: Override model selection
   - `--provider`: Override provider
   - `--api-key`: Override API key
   - `--base-url`: Override base URL
   - `--timeout`: Override timeout

2. **Pass-through Architecture**: Use `allowUnknownOption()` and `passThroughOptions()` to forward all unrecognized options to the underlying agent

3. **Model Validation**:
   - Codex must validate OpenAI-compatible models only
   - Claude accepts both Claude and GPT models
   - Provide helpful error messages with actionable suggestions

4. **Health Check Pattern**: Each shortcut should implement a `health` subcommand that:
   - Verifies agent installation
   - Shows version information
   - Tests basic configuration

### Adding New Agent Shortcuts

To add a new direct agent shortcut (e.g., `codemie-newagent`):

1. Create `bin/codemie-newagent.js` following the existing pattern
2. Add the executable to `package.json` bin field
3. Implement the adapter in `src/agents/adapters/`
4. Register in `src/agents/registry.ts`
5. Update documentation in README.md and CLAUDE.md

### Built-in Agent Development

When working on the CodeMie Native agent (`src/agents/codemie-code/`):

- **Tools**: Add new tools in `tools/` directory with proper security filtering
- **UI**: Use Clack components for consistent terminal interface
- **Streaming**: Implement proper event handling for real-time responses
- **Configuration**: Follow the provider config pattern in `config.ts`
- **Error Handling**: Use structured error types with context information
