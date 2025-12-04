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
npm install                 # Install all dependencies
npm link                    # Link globally for local development

# Building
npm run build              # Compile TypeScript
npm run dev                # Watch mode for development

# Testing
npm run test               # Run tests with Vitest
npm run test:ui            # Run tests with interactive UI
npm run test:run           # Run tests once (no watch mode)

# Code Quality & Validation
npm run lint               # Check code style with ESLint (max 0 warnings)
npm run lint:fix           # Fix linting issues automatically
npm run validate:commit    # Validate last commit message (Conventional Commits)
npm run validate:secrets   # Check for exposed secrets (requires Docker)
npm run license-check      # Check dependency licenses
npm run ci                 # Run full CI: commit validation + license + lint + build + tests
npm run ci:full            # CI + secrets detection (requires Docker)

# Development Workflow
npm run build && npm link  # Build and link for testing
codemie doctor             # Verify installation and configuration
codemie-code health        # Test built-in agent health

# Direct Agent Shortcuts
codemie-code "message"     # Built-in agent
codemie-claude "message"   # Claude Code agent
codemie-codex "message"    # Codex agent
codemie-gemini "message"   # Gemini CLI agent
codemie-claude health      # Health checks
codemie-codex health
codemie-gemini health

# Profile Management (Multi-Provider Support)
codemie setup              # Add new profile or update existing
codemie profile list       # List all profiles with detailed information
codemie profile switch <name>  # Switch to different profile
codemie profile delete <name>  # Delete a profile
codemie profile rename <old> <new>  # Rename a profile
codemie-code --profile work "task"  # Use specific profile

# Analytics Commands
codemie analytics                  # Show configuration and available commands
codemie analytics enable           # Enable analytics collection
codemie analytics disable          # Disable analytics collection
codemie analytics show             # Show analytics from all agents
codemie analytics show --from 2025-11-01 --to 2025-11-30  # Custom date range
codemie analytics show --agent claude  # Filter by agent
codemie analytics show --verbose   # Show detailed stats with raw model names and additional metrics

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
- **Example**: Use plugin pattern instead of individual adapter files for each agent

### DRY (Don't Repeat Yourself)
- Never duplicate code, logic, or configuration
- Extract common patterns into reusable functions/utilities
- Reuse existing utilities from `src/utils/` before creating new ones
- If you find yourself copying code, refactor it into a shared function
- One source of truth for each piece of knowledge
- **Example**: `agent-executor.js` handles all agent shortcuts instead of separate bin files

### Extensibility
- Design for easy addition of new features without modifying existing code
- Use plugin/adapter patterns for agent integration
- Define clear interfaces that new implementations can follow
- Separate concerns: core logic from specific implementations
- **Example**: Add new agents by creating a plugin, not modifying registry

### Reusability
- Write modular, composable functions with single responsibilities
- Avoid tight coupling between components
- Use dependency injection for testability
- Create generic utilities that work across different contexts
- **Example**: `ConfigLoader` works for all providers, not provider-specific loaders

### Maintainability
- Clear naming conventions that reflect purpose
- Comprehensive type definitions with TypeScript
- Consistent error handling patterns
- Well-structured directory organization
- **Example**: `src/agents/plugins/` contains all agent implementations

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

### Testing Philosophy

**Favor integration tests over unit tests** - Test real behavior, not implementation details.

#### Core Principles

1. **Integration Tests First**
   - Test the actual user experience end-to-end
   - Run real commands and verify actual output
   - Cover critical user workflows
   - Example: `tests/integration/cli-commands.test.ts`

2. **Minimal Unit Tests**
   - Only unit test complex algorithms or utilities
   - Avoid testing implementation details
   - Don't mock everything - use real dependencies when possible
   - Example: Type guards, configuration parsers

3. **Quality Over Quantity**
   - 1 good integration test > 10 fragile unit tests
   - Test what matters to users, not internal functions
   - Keep tests simple and maintainable
   - Tests should be obvious and easy to understand

4. **Test Structure**
   - `tests/integration/` - End-to-end tests of CLI commands
   - `src/**/__tests__/` - Unit tests only when necessary
   - Integration tests verify real behavior
   - Unit tests verify isolated logic

#### When to Write Tests

**Always write integration tests for:**
- New CLI commands
- New agent shortcuts
- Critical user workflows
- Doctor health checks

**Only write unit tests for:**
- Complex algorithms
- Type guards and validators
- Utility functions with edge cases
- Pure functions with clear inputs/outputs

**Don't write tests for:**
- Trivial getters/setters
- Simple pass-through functions
- Code that's tested via integration tests

#### Example: Doctor Command Testing

```typescript
// ✅ Good - Integration test
it('should check Python', () => {
  const result = cli.runSilent('doctor');
  expect(result.output).toMatch(/Python/i);
});

// ❌ Avoid - Unnecessary unit test
it('should create PythonCheck instance', () => {
  const check = new PythonCheck();
  expect(check.name).toBe('Python');
});
```

**Remember:** Tests should give confidence, not false security. Integration tests catch real bugs.

## Project Overview

**AI/Run CodeMie CLI** is a professional, unified CLI wrapper for managing multiple AI coding agents, featuring:

1. **External Agent Management**: Install and run external agents (Claude Code, Codex)
2. **Built-in Agent**: CodeMie Native - a LangGraph-based coding assistant
3. **Configuration Management**: Unified config system supporting multiple AI providers
4. **Multiple Interfaces**: CLI commands, direct executables, and programmatic APIs
5. **Unified Analytics**: Agent-agnostic analytics system tracking usage across all agents

## Architecture Overview

### High-Level Structure

```
codemie-code/
├── bin/                       # Executable entry points
│   ├── codemie.js            # Main CLI (commands: setup, install, doctor, etc.)
│   └── agent-executor.js     # Universal agent executor (all shortcuts: codemie-*)
├── src/
│   ├── cli/                  # CLI commands
│   │   └── commands/         # Individual command modules
│   ├── agents/               # Agent system (plugin-based)
│   │   ├── core/            # Core abstractions (AgentAdapter, AgentCLI)
│   │   ├── plugins/         # Agent plugins (claude, codex, gemini, codemie-code)
│   │   ├── codemie-code/    # Built-in agent implementation
│   │   └── registry.ts      # Central agent registry
│   ├── analytics/            # Unified analytics system
│   │   ├── index.ts         # Main Analytics class
│   │   ├── types.ts         # TypeScript types
│   │   ├── collector.ts     # Event buffering
│   │   ├── writer.ts        # JSONL file writer
│   │   ├── session.ts       # Session management
│   │   ├── privacy.ts       # Privacy utilities
│   │   └── config.ts        # Config loading
│   ├── workflows/            # CI/CD workflow management
│   ├── env/                  # Configuration system
│   ├── utils/                # Shared utilities
│   └── index.ts             # Main package exports
```

### Core Components

#### 1. Agent System (`src/agents/`) - **Plugin-Based Architecture**

- **Registry** (`registry.ts`): Centralized registration of all agent plugins
- **Core** (`core/`): Base abstractions for extensibility
  - `AgentAdapter`: Interface that all agents implement
  - `AgentCLI`: Universal CLI builder from agent metadata
  - `BaseAgentAdapter`: Shared implementation for external agents
- **Plugins** (`plugins/`): Self-contained agent implementations
  - `claude.plugin.ts`: Claude Code plugin with metadata
  - `codex.plugin.ts`: Codex plugin with OpenAI model validation
  - `gemini.plugin.ts`: Gemini CLI plugin
  - `codemie-code.plugin.ts`: Built-in agent plugin wrapper
- **Built-in Agent** (`codemie-code/`): Full LangGraph-based implementation
- **Universal Executor** (`bin/agent-executor.js`): Single entry point for all agent shortcuts

#### 2. CLI System (`src/cli/`) - **Modular Command Pattern**

- **Main CLI** (`index.ts`): Commander.js orchestrator - minimal, delegates to commands
- **Commands** (`commands/`): Self-contained command modules
  - `setup.ts`: Interactive multi-provider configuration wizard
  - `install.ts`/`uninstall.ts`: Agent lifecycle management
  - `doctor/`: Extensible health check system with provider-specific checks
  - `profile.ts`: Profile management (list, switch, delete, rename)
  - `workflow.ts`: CI/CD workflow installation
  - `auth.ts`: SSO authentication management
  - `analytics.ts`: Usage analytics and reporting
  - `version.ts`: Version information

**Pattern**: Each command is a factory function (`createXCommand()`) returning a Commander instance

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

#### 5. CodeMie Proxy System - **Plugin Architecture**

**True streaming proxy with zero buffering** - refactored from monolithic to plugin-based architecture.

**Core Architecture** (`src/utils/codemie-proxy.ts`):
- **Zero Buffering**: Streams responses directly to client (no body buffering)
- **Plugin System**: Extensible via plugin registry (`src/utils/proxy/plugins/`)
- **Priority-Based Execution**: Plugins run in order based on priority (0-1000)
- **Graceful Degradation**: Plugin failures don't break proxy flow
- **Lifecycle Hooks**: onRequest, onResponseHeaders, onResponseChunk, onResponseComplete, onError

**Core Plugins** (`src/proxy/plugins/`):
- **SSO Auth Plugin** (`sso-auth.plugin.ts`) - Priority 10: Injects SSO authentication cookies
- **Header Injection Plugin** (`header-injection.plugin.ts`) - Priority 20: Adds CodeMie-specific headers
- **Logging Plugin** (`logging.plugin.ts`) - Priority 50: Logs detailed request/response info to log files at INFO level (`~/.codemie/logs/`)

**Plugin Registry** (`plugins/registry.ts`):
- Auto-discovery and initialization of plugins
- Runtime enable/disable support
- Priority-based sorting for execution order
- Dependency injection via PluginContext

**Key Features**:
- **Performance**: ~90% less memory usage (no buffering)
- **Extensibility**: Add plugins via registry without modifying proxy core
- **Streaming**: True HTTP streaming with optional chunk transformation hooks
- **SOLID Principles**: Single responsibility per plugin, Open/Closed for extensions
- **Dynamic Ports**: Finds available ports and handles EADDRINUSE errors
- **SSL/TLS Handling**: Supports enterprise certificates with self-signed certificate support

#### 6. Built-in Agent Architecture (`src/agents/codemie-code/`)

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

#### 7. Analytics System (`src/analytics/`) - **Unified Tracking**

**OpenTelemetry-inspired analytics across all agents:**

- **Main Analytics** (`index.ts`): `Analytics` class - primary API with singleton pattern
- **Event Collector** (`collector.ts`): Buffers events, auto-flushes on size or interval
- **Writer** (`writer.ts`): Writes JSONL files to `~/.codemie/analytics/YYYY-MM-DD.jsonl`
- **Session Manager** (`session.ts`): Tracks session lifecycle and metadata
- **Privacy** (`privacy.ts`): Sensitive data redaction
- **Configuration** (`config.ts`): Environment-aware config loading

**Key Features:**
- **Agent-Agnostic**: Single analytics system works across all 5+ agents
- **Multi-Format Support**: Extracts tool calls from Anthropic, OpenAI/GPT, and Google Gemini API formats
- **Privacy-First**: Sensitive data auto-redacted
- **Minimal Overhead**: Async buffering (< 5ms per event), non-blocking writes
- **JSONL Format**: One JSON event per line, daily log files
- **Auto-Integration**: AgentCLI automatically initializes and tracks sessions

**Configuration:**
```json
{
  "analytics": {
    "enabled": true,
    "target": "local",
    "localPath": "~/.codemie/analytics",
    "flushInterval": 5000,
    "maxBufferSize": 100
  }
}
```

**Environment Variables:**
- `CODEMIE_ANALYTICS_ENABLED` - Enable/disable (true/false/1/0)
- `CODEMIE_ANALYTICS_TARGET` - Storage target (local/remote/both)
- `CODEMIE_ANALYTICS_ENDPOINT` - Remote endpoint URL (optional)
- `CODEMIE_ANALYTICS_PATH` - Custom local path

**Event Types Tracked:**
- Session lifecycle (start, end, error)
- User interactions (prompts, responses)
- API interactions (requests, responses, errors)
- Configuration changes (profile switches, model changes)
- Performance metrics (latency)

**Example Events:**
```jsonl
{"timestamp":"2025-11-29T10:30:00.000Z","eventType":"session_start","sessionId":"uuid","installationId":"inst-123","agent":"claude","agentVersion":"1.0.0","cliVersion":"0.0.11","profile":"work","provider":"ai-run-sso","model":"claude-4-5-sonnet","attributes":{"workingDir":"/path","interactive":true}}
{"timestamp":"2025-11-29T10:30:15.000Z","eventType":"api_response","sessionId":"uuid","agent":"claude","metrics":{"latencyMs":2340}}
```

**Integration Points:**
- `AgentCLI.handleRun()`: Auto-initializes analytics, tracks session lifecycle
- `Analytics.trackAPIResponse()`: Tracks API requests and responses with latency metrics
- Built-in agent: Uses LangChain streaming API
- External agents: Session tracking via universal executor

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
- **ESLint**: Code quality (max 0 warnings allowed)

## Practical Code Patterns

### 1. Plugin Pattern for Extensibility

**Use Case**: Adding new agents without modifying existing code

**Implementation**:
```typescript
// Define metadata (declarative, no logic)
export const AgentMetadata: AgentMetadata = {
  name: 'agent-name',
  // ... configuration
};

// Implement adapter (reuses BaseAgentAdapter)
export class AgentPlugin extends BaseAgentAdapter {
  constructor() {
    super(AgentMetadata);
  }
}

// Register in one place
AgentRegistry.adapters.set('agent-name', new AgentPlugin());
```

**Benefits**: Open/Closed Principle - open for extension, closed for modification

### 2. Configuration Loader Pattern for Reusability

**Use Case**: Loading configuration from multiple sources with priority

**Implementation**:
```typescript
// Single loader handles all scenarios
const config = await ConfigLoader.load(workingDir, {
  name: profileName,     // Optional profile selection
  model: cliModel,       // Optional CLI overrides
  provider: cliProvider
});

// Priority: CLI > Env > Project > Global > Default
```

**Benefits**: Single source of truth, consistent behavior across all commands

### 3. Factory Pattern for Commands

**Use Case**: Creating modular, testable CLI commands

**Implementation**:
```typescript
export function createSetupCommand(): Command {
  return new Command('setup')
    .description('...')
    .action(async () => {
      // Command logic here
    });
}

// In main CLI
program.addCommand(createSetupCommand());
```

**Benefits**: Easy to test, compose, and maintain independently

### 4. Adapter Pattern for Agent Integration

**Use Case**: Uniform interface for different external agents

**Implementation**:
```typescript
// All agents implement same interface
interface AgentAdapter {
  install(): Promise<void>;
  run(args: string[], env?: Record<string, string>): Promise<void>;
  // ... other methods
}

// Client code works with any agent
const agent = AgentRegistry.getAgent(name);
await agent.run(args, env);
```

**Benefits**: Decouples CLI from specific agent implementations

### 5. Type Guards for Type Safety

**Use Case**: Runtime validation of configuration formats

**Implementation**:
```typescript
export function isMultiProviderConfig(config: unknown): config is MultiProviderConfig {
  return (
    typeof config === 'object' &&
    config !== null &&
    'version' in config &&
    config.version === 2
  );
}

// Usage
if (isMultiProviderConfig(rawConfig)) {
  // TypeScript knows it's MultiProviderConfig
  const profile = rawConfig.profiles[rawConfig.activeProfile];
}
```

**Benefits**: Type-safe with runtime checks, prevents errors

### 6. Universal Executor Pattern for DRY

**Use Case**: Single bin file handles multiple executables

**Implementation**:
```typescript
// Detects agent from executable name
const executableName = basename(process.argv[1]);
const agentName = executableName.replace('codemie-', '');

// Loads appropriate plugin
const agent = AgentRegistry.getAgent(agentName);
const cli = new AgentCLI(agent);
await cli.run(process.argv);
```

**Benefits**: One implementation for all shortcuts, reduces duplication

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
   - `--provider`: Override provider (ai-run-sso, litellm, openai, azure, bedrock)
   - `--model`: Override model selection
   - `--api-key`: Override API key
   - `--base-url`: Override base URL
   - `--timeout`: Override timeout

   Note: These flags are config-only and will not be passed to the underlying agent binary

2. **Pass-through Architecture**: Use `allowUnknownOption()` to allow unknown options, and `collectPassThroughArgs()` method filters out known config options before forwarding to the underlying agent

3. **Model Validation**:
   - Codex must validate OpenAI-compatible models only
   - Claude accepts both Claude and GPT models
   - Provide helpful error messages with actionable suggestions

4. **Health Check Pattern**: Each shortcut should implement a `health` subcommand that:
   - Verifies agent installation
   - Shows version information
   - Tests basic configuration

### Adding New Agents - **Plugin Pattern (Extensibility)**

**See complete guide**: @.codemie/guides/agent-plugin-development.md

The plugin pattern makes adding new agents straightforward without modifying core code.

**Quick Start (4 Steps)**:
1. Create plugin file: `src/agents/plugins/{name}.plugin.ts`
2. Register in: `src/agents/registry.ts`
3. Add binary: `package.json` → `bin` section
4. Build & test: `npm run build && npm link`

**Reference Implementations**:
- `claude.plugin.ts` - SSO support, feature flags
- `codex.plugin.ts` - Model injection, config setup
- `gemini.plugin.ts` - Project mapping, multi-var fallbacks
- `deepagents.plugin.ts` - Python/pip installation

**Why This Works**: `agent-executor.js` automatically discovers plugins by name, enabling zero-config integration.

### Adding New Providers - **Plugin Pattern (Extensibility)**

**See complete guide**: @.codemie/guides/provider-plugin-development.md

The plugin pattern makes adding new AI providers straightforward without modifying core code.

**Quick Start (3 Steps)**:
1. Create provider plugin: `src/providers/plugins/{name}/`
2. Register components (auto-registered via imports)
3. Build & test: `npm run build && npm link`

**Reference Implementations**:
- `ollama/` - Local provider with model installation
- `sso/` - SSO authentication with browser login
- `litellm/` - Universal proxy with minimal setup

**Why This Works**: Auto-registration via decorators and imports enables zero-config integration with setup wizard and health checks.

### Analytics Integration - **Automatic Plugin Discovery**

The analytics system is **already integrated** with the plugin system, providing automatic discovery and display of agent stats without additional code.

#### How It Works

**Automatic Agent Discovery**:
- `calculateStats()` function queries `AgentRegistry` to get display names
- Agent filters are validated against registered plugins
- Display names are shown instead of internal IDs (e.g., "Claude Code" instead of "claude")

**Key Features**:
1. **Agent Validation**: All analytics commands validate agent filters against the registry
   ```bash
   # Shows error with available agents if invalid
   codemie analytics show --agent invalid
   # Available agents: codemie-code (CodeMie Native), claude (Claude Code), ...
   ```

2. **Display Name Integration**: Analytics automatically show friendly names
   ```
   🤖 Breakdown by Agent

   Claude Code         15 prompts   3 sessions   45 API calls  (65.2%)
   CodeMie Native       8 prompts   2 sessions   20 API calls  (34.8%)
   ```

3. **No Code Changes Required**: Adding a new plugin automatically includes it in analytics

**Commands with Plugin Integration**:
- `codemie analytics show` - Shows agent activity with display names
- `codemie analytics show --agent <name>` - Validates and filters by agent

**Implementation Details** (for reference):
- `src/utils/analytics-reader.ts`: Queries `AgentRegistry.getAgent()` for display names
- `src/cli/commands/analytics.ts`: Validates filters with `AgentRegistry.getAgentNames()`
- Auto-enriches agent stats with `displayName` field from plugin metadata

**Benefits**:
✅ **Extensible**: New plugins automatically appear in stats
✅ **Type-Safe**: Uses existing plugin metadata
✅ **User-Friendly**: Shows display names, not internal IDs
✅ **Validated**: Prevents invalid agent filters with helpful error messages

### Built-in Agent Development - **LangGraph Architecture**

When working on CodeMie Native (`src/agents/codemie-code/`):

- **Tools** (`tools/`): Modular tool implementations
  - Add new tools in separate files with clear interfaces
  - Implement security filtering (e.g., path traversal prevention)
  - Follow function-as-tool pattern for LangChain integration
  - Example: `filesystem.ts`, `command.ts`, `git.ts`

- **UI System** (`ui.ts`, `streaming/`): Terminal interface
  - Use Clack components for consistency
  - Implement streaming event handlers for real-time updates
  - Separate UI concerns from business logic

- **Configuration** (`config.ts`): Provider-agnostic config loading
  - Use `ConfigLoader` for multi-provider support
  - Validate configuration before agent initialization
  - Support CLI overrides and environment variables

- **Error Handling**: Structured, contextual errors
  - Create specific error classes for different failure modes
  - Include actionable error messages with suggestions
  - Log errors appropriately for debugging

- **Planning** (`modes/`): Planning system architecture (optional feature)
  - Context-aware planning that explores codebase first
  - Todo-based tracking with quality validation
  - Persistent state management across sessions

### Workflow Management

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

---

## Quick Reference: Best Practices Checklist

When writing code for this project, ask yourself:

✅ **KISS**: Is this the simplest solution? Can I remove any complexity?
✅ **DRY**: Am I duplicating code? Can I extract common patterns?
✅ **Extensibility**: Can new features be added without modifying existing code?
✅ **Reusability**: Are components modular and composable?
✅ **Maintainability**: Will others understand this in 6 months?
✅ **Plugin Pattern**: Should this be a plugin instead of core modification?
✅ **Type Safety**: Are types defined and validated?
✅ **Error Handling**: Are error messages actionable?
✅ **Testing**: Integration test > unit test? (1 good integration test > 10 unit tests)
✅ **Documentation**: Will this require doc updates?