# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

This project is **AI/Run CodeMie CLI** - a professional, unified CLI tool for managing multiple AI coding agents.

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

# Testing
npm run test               # Run tests with Vitest
npm run test:ui            # Run tests with interactive UI
npm run test:run           # Run tests once (no watch mode)

# Code Quality
npm run lint               # Check code style with ESLint (max 10 warnings)
npm run lint:fix           # Fix linting issues automatically
npm run ci                 # Run full CI pipeline (license-check + lint + build)

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation and configuration
codemie-code health        # Test built-in agent health

# Testing the Built-in Agent
codemie-code --task "test"          # Single task execution
codemie-code --debug                # Interactive with debug logging
codemie-code --plan                 # Enable structured planning mode with visual todo tracking
codemie-code --plan-only            # Generate plan without execution (planning phase only)
codemie-code --task "test" --plan   # Task execution with planning phase

# Direct Agent Shortcuts (bypass registry)
codemie-claude             # Direct Claude Code access
codemie-codex              # Direct Codex access
codemie-claude health      # Claude health check
codemie-codex health       # Codex health check

# Profile Management (Multi-Provider Support)
codemie setup              # Add new profile or update existing
codemie profile list       # List all provider profiles
codemie profile switch <name>  # Switch to different profile
codemie profile show [name]    # Show profile details
codemie profile delete <name>  # Delete a profile
codemie-code --profile work "task"  # Use specific profile

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

### Clean Variable Management
- **Avoid unused variables entirely** - remove variables that are not used
- **Never prefix with underscore** (`_variable`) unless absolutely necessary
- **Only use underscore prefix when:**
  - Required by external API or framework (destructuring with some unused parameters)
  - TypeScript/ESLint requires it for valid syntax in edge cases
  - Part of a pattern where the variable must exist but isn't used in current implementation
- **Prefer refactoring over underscore prefixes:**
  - Remove unused parameters from function signatures
  - Use object destructuring with only needed properties
  - Extract only required values from arrays/objects
- **Example of proper approach:**
  ```typescript
  // ❌ Avoid - unused variable with underscore
  const [first, _second, third] = array;

  // ✅ Better - only destructure what you need
  const [first, , third] = array;  // Use empty slot for unused middle element

  // ✅ Or restructure to avoid unused variables
  const first = array[0];
  const third = array[2];
  ```

**Remember:** Simple, clean code is better than clever, complex code.

## Project Overview

**AI/Run CodeMie CLI** is a professional, unified CLI wrapper for managing multiple AI coding agents, featuring:

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
│   ├── workflows/          # Workflow/action management
│   ├── tools/              # VCS tools management (gh/glab)
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

- **Types** (`types.ts`): Multi-provider configuration types and type guards
- **ConfigLoader** (`utils/config-loader.ts`): Multi-provider profile management
  - Supports both legacy (v1) and multi-provider (v2) configs
  - Automatic migration from legacy to profile-based format
  - Profile CRUD: add, update, delete, rename, switch, list
- **Priority**: CLI args > Env vars > Project config > Global config > Defaults
- **Providers**: AI-Run SSO, LiteLLM, OpenAI, Azure, Bedrock
- **Model Validation**: Real-time model fetching via `/v1/models` endpoints

#### 4. Workflow Management System (`src/workflows/`)

- **Registry** (`registry.ts`): Manages workflow templates (GitHub Actions, GitLab CI)
- **Detector** (`detector.ts`): Auto-detects VCS provider from git remote
- **Installer** (`installer.ts`): Installs and customizes workflow templates
- **Templates** (`templates/`): Pre-built workflow templates
  - `github/`: GitHub Actions workflows (pr-review, inline-fix, code-ci)
  - `gitlab/`: GitLab CI workflows
- **Types** (`types.ts`): TypeScript definitions for workflows

#### 5. VCS Tools Management (`src/tools/`)

- **Registry** (`registry.ts`): Tool definitions (gh, glab)
- **Detector** (`detector.ts`): Check tool installation and authentication
- **Manager** (`manager.ts`): Install/uninstall/update tools via npm
- **npm-only**: Tools are installed via npm packages only (no system packages)

#### 6. Client Adapters System (`src/clients/`)

- **Registry** (`registry.ts`): Manages client adapters for different platforms
- **Adapters** (`adapters/`): Platform-specific implementations
  - `github.ts`: GitHub API integration
  - `gitlab.ts`: GitLab API integration

#### 7. SSO Gateway System (`src/utils/sso-gateway.ts`)

- **Local Proxy**: Creates HTTP server that proxies requests from external binaries
- **Authentication**: Automatically injects SSO cookies into API requests
- **Dynamic Ports**: Finds available ports and handles EADDRINUSE errors
- **Request Forwarding**: Streams request/response bodies for compatibility
- **Debug Logging**: Comprehensive request/response logging for development

#### 8. Built-in Agent Architecture (`src/agents/codemie-code/`)

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
1. CLI arguments (`--profile`, `--model`, etc.) - highest priority
2. Environment variables (`CODEMIE_*`, `OPENAI_*`, etc.)
3. Project-local config (`.codemie/config.json`)
4. Global config file (`~/.codemie/config.json`)
5. Default values - lowest priority

#### Multi-Provider Profile System
- **Configuration Format**: Version 2 supports multiple named profiles
- **Profile Storage**: `~/.codemie/config.json` with `version: 2` field
- **Active Profile**: One profile marked as active, used by default
- **Profile Selection**: Use `--profile <name>` flag to override active profile
- **Automatic Migration**: Legacy (v1) configs auto-convert to "default" profile
- **Non-Destructive Setup**: `codemie setup` offers "Add new" or "Update existing"

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

- **Node.js**: Requires Node.js >=24.0.0 for ES2024 features
- **TypeScript**: Full type safety with ES2024 + NodeNext modules
- **Commander.js**: CLI framework with subcommands
- **LangChain/LangGraph**: Agent orchestration and tool calling
- **Clack**: Modern terminal user interface
- **Chalk**: Terminal styling and colors
- **Zod**: Runtime type validation
- **Vitest**: Modern testing framework
- **ESLint**: Code quality (max 10 warnings allowed)

## Development Guidelines

### Working with Multi-Provider Configuration

When working with the configuration system:

1. **Profile Management Pattern**:
   - Use `ConfigLoader.saveProfile(name, profile)` to add/update profiles
   - Use `ConfigLoader.switchProfile(name)` to change active profile
   - Use `ConfigLoader.listProfiles()` to get all profiles with active status
   - Never directly overwrite `~/.codemie/config.json` - use ConfigLoader methods

2. **Configuration Loading Priority**:
   ```typescript
   // Load with profile support
   const config = await ConfigLoader.load(process.cwd(), {
     name: profileName,  // Optional profile selection
     model: cliModel,    // Optional CLI overrides
     provider: cliProvider
   });
   ```

3. **Migration Pattern**:
   - Use `loadMultiProviderConfig()` which auto-migrates legacy configs
   - Type guards: `isMultiProviderConfig()` and `isLegacyConfig()`
   - Legacy configs become "default" profile automatically

4. **Setup Wizard Pattern** (`setup.ts`):
   - Check existing profiles with `ConfigLoader.listProfiles()`
   - Offer "Add new" or "Update existing" options
   - Prompt for unique profile name when adding
   - Use `ConfigLoader.saveProfile()` instead of `saveGlobalConfig()`

### Working with Agent Shortcuts

When modifying the direct agent shortcuts (`codemie-claude`, `codemie-codex`):

1. **Configuration Override Pattern**: All shortcuts support CLI overrides for:
   - `--profile`: Select specific provider profile (contains all provider settings)
   - `--model`: Override model selection
   - `--api-key`: Override API key
   - `--base-url`: Override base URL
   - `--timeout`: Override timeout

   Note: Provider is NOT overridable via CLI flag - it's part of the profile configuration

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

When working on the AI/Run CodeMie Native agent (`src/agents/codemie-code/`):

- **Tools**: Add new tools in `tools/` directory with proper security filtering
- **UI**: Use Clack components for consistent terminal interface
- **Streaming**: Implement proper event handling for real-time responses
- **Configuration**: Follow the provider config pattern in `config.ts`
- **Error Handling**: Use structured error types with context information
- **Planning Modes**: Leverage structured todo-based planning system with progress tracking
  - `modes/planMode.ts`: Core planning implementation with quality validation
  - `modes/contextAwarePlanning.ts`: Context-aware planning that explores codebase first
  - `ui/todoPanel.ts`: Visual todo tracking with progress indicators
  - `utils/todoValidator.ts`: Todo quality scoring and validation
  - `storage/todoStorage.ts`: Persistent todo state management

### Workflow and Tools Management

#### VCS Tools Management

The `src/tools/` module manages VCS CLI tools (GitHub CLI, GitLab CLI):

**Key Features:**
- npm-only installation (no system package managers)
- Tool detection and version checking
- Authentication status checking
- Installation, uninstallation, and updates via npm

**Available Commands:**
```bash
codemie tools check           # Check status of all VCS tools
codemie tools install gh      # Install GitHub CLI via npm
codemie tools install glab    # Install GitLab CLI via npm
codemie tools auth gh         # Authenticate GitHub CLI
codemie tools auth-status     # Check authentication status
codemie tools list            # List all available tools
```

**Adding New Tools:**
1. Add tool info to `src/tools/registry.ts`
2. Update `VCSTool` type in `src/tools/types.ts`
3. Ensure npm package exists for the tool
4. Update documentation

#### Workflow Installation System

The `src/workflows/` module manages CI/CD workflow installation:

**Key Features:**
- Auto-detect VCS provider (GitHub/GitLab) from git remote
- Template-based workflow installation
- Customizable configurations (timeout, max-turns, environment)
- Dependency validation
- Interactive and non-interactive modes

**Available Commands:**
```bash
codemie workflow list                    # List available workflows
codemie workflow list --installed        # Show only installed workflows
codemie workflow install pr-review       # Install PR review workflow
codemie workflow install --interactive   # Interactive installation
codemie workflow uninstall pr-review     # Uninstall workflow
```

**Available Workflows:**
- **pr-review**: Automated code review on pull requests
- **inline-fix**: Quick code fixes from PR comments
- **code-ci**: Full feature implementation from issues

**Adding New Workflows:**

1. **Create Template File:**
   - GitHub: `src/workflows/templates/github/your-workflow.yml`
   - GitLab: `src/workflows/templates/gitlab/your-workflow.yml`

2. **Register Template:**
   ```typescript
   // In src/workflows/templates/github/metadata.ts (or gitlab)
   {
     id: 'your-workflow',
     name: 'Your Workflow Name',
     description: 'Workflow description',
     provider: 'github',
     version: '1.0.0',
     category: 'code-review', // or 'automation', 'ci-cd', 'security'
     triggers: [...],
     permissions: {...},
     config: {...},
     templatePath: path.join(__dirname, 'your-workflow.yml'),
     dependencies: {...}
   }
   ```

3. **Template Variables:**
   Templates support the following customizable variables:
   - `timeout-minutes`: Workflow timeout
   - `MAX_TURNS`: Maximum AI turns
   - `environment`: GitHub environment name

4. **Test Installation:**
   ```bash
   npm run build && npm link
   codemie workflow install your-workflow --dry-run
   ```

**VCS Detection:**
- Automatically detects GitHub/GitLab from `.git/config` remote URL
- Override with `--github` or `--gitlab` flags
- Validates workflow directory exists/creates if needed

**Dependency Validation:**
- Checks for required VCS CLI tools (gh/glab)
- Offers to install missing tools
- Warns about required secrets
- Lists optional configuration

