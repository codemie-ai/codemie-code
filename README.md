# AI/Run CodeMie CLI

> Professional CLI wrapper for managing multiple AI coding agents

## Table of Contents

- [Synopsis](#synopsis)
- [Quick Start](#quick-start)
- [Installation](#installation)
  - [From npm (Recommended)](#from-npm-recommended)
  - [From Source (Development)](#from-source-development)
  - [Verify Installation](#verify-installation)
- [Usage](#usage)
  - [Built-in Agent (CodeMie Native)](#built-in-agent-codemie-native)
  - [External Agents](#external-agents)
- [Commands](#commands)
  - [Core Commands](#core-commands)
  - [Agent Shortcuts](#agent-shortcuts)
  - [Configuration Commands](#configuration-commands)
  - [Profile Management Commands](#profile-management-commands)
- [Configuration](#configuration)
  - [Setup Wizard (Recommended)](#setup-wizard-recommended)
  - [Multi-Provider Profiles](#multi-provider-profiles)
  - [Supported Providers](#supported-providers)
  - [Manual Configuration](#manual-configuration)
  - [Model Compatibility](#model-compatibility)
- [Authentication & SSO Management](#authentication--sso-management)
  - [AI/Run CodeMie SSO Setup](#airun-codemie-sso-setup)
  - [Token Management](#token-management)
  - [Enterprise SSO Features](#enterprise-sso-features)
- [Examples](#examples)
  - [Common Workflows](#common-workflows)
  - [Configuration Examples](#configuration-examples)
  - [Advanced Usage](#advanced-usage)
- [Agents](#agents)
  - [CodeMie Native (Built-in)](#codemie-native-built-in)
  - [Claude Code](#claude-code)
  - [Codex](#codex)
  - [Gemini CLI](#gemini-cli)
- [Troubleshooting](#troubleshooting)
  - [Command Not Found](#command-not-found)
  - [Configuration Issues](#configuration-issues)
  - [Connection Problems](#connection-problems)
  - [Agent Installation Failures](#agent-installation-failures)
  - [Model Compatibility Errors](#model-compatibility-errors)
- [Development](#development)
  - [Project Structure](#project-structure)
  - [Building](#building)
  - [Testing](#testing)
- [License](#license)
- [Links](#links)

## Synopsis

```bash
codemie [COMMAND] [OPTIONS]
codemie-code [MESSAGE|--task TASK] [OPTIONS]
codemie-claude [-p MESSAGE] [OPTIONS]
codemie-codex [MESSAGE|--task TASK] [OPTIONS]
codemie-gemini [-m MODEL] [-p MESSAGE] [OPTIONS]
```

AI/Run CodeMie CLI is a professional, unified CLI tool for installing, configuring, and running multiple AI coding agents from a single interface. It includes a built-in LangGraph-based agent (CodeMie Native) and supports external agents like Claude Code, Codex, and Gemini CLI.

## Quick Start

```bash
# 1. Install
npm install -g @codemieai/code

# 2. Setup (interactive wizard)
codemie setup

# 3. View supported agents
codemie list

# 4. Install external agents (optional)
codemie install claude   # Claude Code
codemie install codex    # OpenAI Codex
codemie install gemini   # Google Gemini CLI

# 5. Manage profiles (multi-provider support)
codemie profile list             # List all profiles
codemie profile switch work      # Switch to different profile
codemie setup                    # Add new profile or update existing

# 6. Start coding with built-in agent
codemie-code "Review my code for bugs"

# 7. Use external agents
codemie-claude "Refactor this function"
codemie-codex "Add unit tests"
codemie-gemini "Optimize performance"

# 8. Use specific profile for a task
codemie-code --profile work "Deploy to production"
```

## Installation

### From npm (Recommended)

```bash
npm install -g @codemieai/code
```

### From Source (Development)

```bash
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code
npm install && npm run build && npm link
```

### Verify Installation

```bash
codemie --help
codemie doctor
```

## Usage

### Built-in Agent (CodeMie Native)

Ready to use immediately - no installation required:

```bash
# Interactive conversation
codemie-code

# Execute single task
codemie-code --task "fix bugs in src/utils"

# Start with initial message
codemie-code "Help me refactor this component"

# Debug mode
codemie-code --debug
```

### External Agents

Install and run external agents:

```bash
# Install agents
codemie install claude
codemie install codex

# Run via shortcuts (recommended)
codemie-claude -p "Review my API code"
codemie-codex --task "Generate unit tests"

# Direct shortcuts are the recommended way
codemie-claude -p "Fix security issues"
```

## Commands

### Core Commands

```bash
codemie setup                    # Interactive configuration wizard
codemie profile <command>        # Manage provider profiles
codemie auth <command>           # Manage SSO authentication
codemie list                     # List all available agents
codemie install <agent>          # Install an agent
codemie uninstall <agent>        # Uninstall an agent
codemie doctor                   # Health check and diagnostics
codemie config <action>          # Manage configuration
codemie version                  # Show version information
```

### Agent Shortcuts

Direct access to agents with automatic configuration:

```bash
# Built-in agent
codemie-code [message]           # Interactive or with initial message
codemie-code --task "task"       # Single task execution
codemie-code health              # Health check

# External agents
codemie-claude                   # Claude Code agent (interactive)
codemie-claude -p "message"      # Claude Code agent (print mode)
codemie-codex [message]          # Codex agent
codemie-gemini                   # Gemini CLI agent

# Configuration overrides (model, API key, base URL, timeout)
codemie-claude --model claude-4-5-sonnet --api-key your-key
codemie-codex --model gpt-4.1 --base-url https://api.openai.com/v1
codemie-gemini --model gemini-2.0-flash-exp

# Profile selection (profiles contain provider + all settings)
codemie-code --profile work-litellm "task"
codemie-claude --profile personal-openai -p "message"
codemie-gemini --profile lite --model gemini-2.5-flash  # Use LiteLLM proxy
```

### Configuration Commands

```bash
codemie config show              # Show current configuration with sources
codemie config list              # List all available parameters
codemie config test              # Test connection with current configuration
codemie config init              # Initialize project-specific configuration
```

### Profile Management Commands

```bash
codemie profile list             # List all provider profiles
codemie profile switch <name>    # Switch to a different profile
codemie profile show [name]      # Show profile details (defaults to active)
codemie profile delete <name>    # Delete a profile
codemie profile rename <old> <new> # Rename a profile
```

## Configuration

### Setup Wizard (Recommended)

Run the interactive setup wizard:

```bash
codemie setup
```

The wizard will:
- Guide you through provider selection
- Test your credentials via health endpoints
- Fetch available models in real-time
- Save configuration to `~/.codemie/config.json`

**Multi-Provider Support**: If you already have profiles configured, the wizard will offer to:
- Add a new profile (prompts for unique name)
- Update an existing profile (select from list)
- Cancel without changes

This ensures you can configure multiple providers (work, personal, enterprise SSO) without losing existing configurations.

### Multi-Provider Profiles

CodeMie CLI supports multiple provider profiles, allowing you to:
- Configure different providers for different contexts (work, personal, etc.)
- Switch between profiles with a single command
- Keep all configurations without overwriting

#### Creating Multiple Profiles

```bash
# First profile - work account with LiteLLM
codemie setup
# → Choose: Add a new profile
# → Name: "work-litellm"
# → Provider: LiteLLM
# → Configure credentials...

# Second profile - personal OpenAI account
codemie setup
# → Choose: Add a new profile
# → Name: "personal-openai"
# → Provider: OpenAI
# → Configure credentials...

# Third profile - enterprise SSO
codemie setup
# → Choose: Add a new profile
# → Name: "enterprise-sso"
# → Provider: CodeMie SSO
# → Authenticate via SSO...
```

#### Using Profiles

```bash
# List all profiles (shows active profile with ●)
codemie profile list
# Output:
# ● work-litellm (litellm) - claude-4-5-sonnet
# ○ personal-openai (openai) - gpt-4.1
# ○ enterprise-sso (ai-run-sso) - claude-4-5-sonnet

# Switch active profile
codemie profile switch personal-openai

# Use active profile (default behavior)
codemie-code "analyze this code"

# Override with specific profile for one command
codemie-claude --profile work-litellm "review PR"
codemie-codex --profile personal-openai "generate tests"

# Show profile details
codemie profile show work-litellm
```

#### Profile Configuration File

Profiles are stored in `~/.codemie/config.json`:

```json
{
  "version": 2,
  "activeProfile": "work-litellm",
  "profiles": {
    "work-litellm": {
      "name": "work-litellm",
      "provider": "litellm",
      "baseUrl": "https://litellm.company.com",
      "apiKey": "sk-***",
      "model": "claude-4-5-sonnet",
      "timeout": 300
    },
    "personal-openai": {
      "name": "personal-openai",
      "provider": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "apiKey": "sk-***",
      "model": "gpt-4.1",
      "timeout": 300
    }
  }
}
```

**Legacy Configuration**: If you have an existing single-provider config, it will automatically migrate to a profile named "default" on first use.

### Supported Providers

- **ai-run-sso** - AI/Run CodeMie SSO (unified enterprise gateway)
- **gemini** - Google Gemini API (direct access)
- **openai** - OpenAI API
- **azure** - Azure OpenAI
- **bedrock** - AWS Bedrock
- **litellm** - LiteLLM Proxy

### Manual Configuration

#### Environment Variables (Highest Priority)

```bash
# Generic (works with any provider)
export CODEMIE_BASE_URL="https://your-proxy.com"
export CODEMIE_API_KEY="your-api-key"
export CODEMIE_MODEL="your-model"
export CODEMIE_PROVIDER="litellm"

# Provider-specific
export OPENAI_API_KEY="your-openai-key"
export OPENAI_BASE_URL="https://api.openai.com/v1"

# Gemini-specific
export GEMINI_API_KEY="your-gemini-key"
export GEMINI_MODEL="gemini-2.5-flash"
```

#### Configuration File

Location: `~/.codemie/config.json`

```json
{
  "provider": "litellm",
  "model": "claude-4-5-sonnet",
  "baseUrl": "https://litellm.codemie.example.com",
  "apiKey": "your-api-key",
  "timeout": 300
}
```

### Model Compatibility

AI/Run CodeMie CLI automatically validates model compatibility:

- **Codex**: OpenAI models only (gpt-4, gpt-4.1, gpt-5, etc.)
- **Claude**: Both Claude and GPT models
- **Gemini CLI**: Gemini models only (gemini-2.5-flash, gemini-2.5-pro, gemini-1.5-pro, etc.)
- **CodeMie Native**: All supported models

When incompatible models are detected, AI/Run CodeMie CLI will:
1. Fetch available models from your provider's API
2. Filter to compatible models
3. Offer to switch automatically

## Authentication & SSO Management

### AI/Run CodeMie SSO Setup

For enterprise environments with AI/Run CodeMie SSO (Single Sign-On):

#### Initial Setup via Wizard

The setup wizard automatically detects and configures AI/Run CodeMie SSO:

```bash
codemie setup
```

**The wizard will:**
1. Detect if you have access to AI/Run CodeMie SSO
2. Guide you through the authentication flow
3. Test the connection with health checks
4. Fetch and display available models
5. Save secure credentials to `~/.codemie/config.json`

#### Manual SSO Authentication

If you need to authenticate separately or refresh your credentials:

```bash
# Authenticate with AI/Run CodeMie SSO
codemie auth login --url https://your-airun-codemie-instance.com

# Check authentication status
codemie auth status

# Refresh expired tokens
codemie auth refresh

# Logout and clear credentials
codemie auth logout
```

### Token Management

SSO tokens are automatically managed but you can control them manually:

#### Token Refresh

AI/Run CodeMie CLI automatically refreshes tokens when they expire. For manual refresh:

```bash
# Refresh SSO credentials (extends session)
codemie auth refresh
```

**When to refresh manually:**
- Before long-running tasks
- After extended periods of inactivity
- When you receive authentication errors
- Before important demonstrations

#### Authentication Status

Check your current authentication state:

```bash
codemie auth status
```

**Status information includes:**
- Connection status to AI/Run CodeMie SSO
- Token validity and expiration
- Available models for your account
- Provider configuration details

#### Token Troubleshooting

Common authentication issues and solutions:

```bash
# Token expired
codemie auth refresh

# Connection issues
codemie doctor                    # Full system diagnostics
codemie auth status              # Check auth-specific issues

# Complete re-authentication
codemie auth logout
codemie auth login --url https://your-airun-codemie-instance.com

# Reset all configuration
codemie config reset
codemie setup                    # Run wizard again
```

### Enterprise SSO Features

AI/Run CodeMie SSO provides enterprise-grade features:

- **Secure Token Storage**: Credentials stored in system keychain
- **Automatic Refresh**: Seamless token renewal without interruption
- **Multi-Model Access**: Access to Claude, GPT, and other models through unified gateway
- **Audit Logging**: Enterprise audit trails for security compliance
- **Role-Based Access**: Model access based on organizational permissions

## Examples

### Common Workflows

```bash
# Code review workflow
codemie-code "Review this PR for security issues and performance"

# Bug fixing
codemie-claude -p "Fix the authentication bug in src/auth.ts"

# Test generation
codemie-codex --task "Generate comprehensive tests for the API endpoints"

# Documentation
codemie-code "Document the functions in utils/helpers.js"

# Refactoring
codemie-claude -p "Refactor this component to use React hooks"
```

### Configuration Examples

```bash
# View current configuration with sources
codemie config show

# Test connection
codemie config test

# Initialize project-specific overrides
codemie config init

# Temporary model override
codemie-claude --model claude-4-5-sonnet -p "Explain this algorithm"

# Debug mode for troubleshooting
codemie-code --debug --task "analyze performance issues"
```

### Multi-Provider Workflow Examples

```bash
# Scenario: Developer with work and personal accounts

# Setup work profile with enterprise LiteLLM
codemie setup
# → Name: "work"
# → Provider: LiteLLM
# → URL: https://litellm.company.com
# → Model: claude-4-5-sonnet

# Setup personal profile with OpenAI
codemie setup
# → Name: "personal"
# → Provider: OpenAI
# → Model: gpt-4.1

# List profiles to verify
codemie profile list
# ● work (litellm) - claude-4-5-sonnet
# ○ personal (openai) - gpt-4.1

# Use work profile during work hours
codemie-code "review company codebase"

# Switch to personal for side projects
codemie profile switch personal
codemie-code "help with my open source project"

# Or use specific profile without switching
codemie-claude --profile work "analyze security"
codemie-codex --profile personal "generate tests"

# Update work profile when credentials rotate
codemie setup
# → Choose: Update existing profile
# → Select: work
# → Update credentials...
```

### Advanced Usage

```bash
# Pass custom arguments to agents
codemie-codex --temperature 0.1 --max-tokens 2000 "Generate clean code"
codemie-claude -p "Review this code" --context large

# Health checks
codemie doctor                   # Full system check
codemie-code health             # Built-in agent check
codemie-claude health           # Claude agent check
```

## Agents

### CodeMie Native (Built-in)

LangGraph-based coding assistant with no installation required.

**Features:**
- Modern terminal UI with streaming responses
- File operations, git integration, command execution
- Clipboard support with automatic image detection
- Interactive conversations with context memory
- Task-focused execution mode
- Debug mode with comprehensive logging

**Usage:**
```bash
codemie-code                    # Interactive mode
codemie-code --task "task"      # Single task
codemie-code --debug            # Debug mode
```

### Claude Code

Anthropic's official CLI with advanced code understanding.

**Installation:** `codemie install claude`

**Features:**
- Advanced code understanding and generation
- Multi-file editing capabilities
- Project-aware context
- Interactive conversations

### Codex

OpenAI's code generation assistant optimized for completion tasks.

**Installation:** `codemie install codex`

**Features:**
- Code completion and generation
- Function generation and bug fixing
- Code explanation and documentation
- **Requires OpenAI-compatible models only**

### Gemini CLI

Google's Gemini AI coding assistant with advanced code understanding.

**Installation:** `codemie install gemini`

**Requirements:**
- **Requires a valid Google Gemini API key** from https://aistudio.google.com/apikey
- **Requires Gemini-compatible models only** (gemini-2.5-flash, gemini-2.5-pro, etc.)
- LiteLLM or AI-Run SSO API keys will **not** work with Gemini CLI

**Setup:**
```bash
# Configure Gemini with dedicated API key
codemie setup
# Select: "Google Gemini (Direct API Access)"
# Enter your Gemini API key from https://aistudio.google.com/apikey

# Or use environment variable
export GEMINI_API_KEY="your-gemini-api-key-here"
```

**Features:**
- Advanced code generation and analysis
- Multi-model support (Gemini 2.5 Flash, Pro, etc.)
- Project-aware context with directory inclusion
- JSON and streaming JSON output formats

**Usage:**
```bash
codemie-gemini                          # Interactive mode
codemie-gemini -m gemini-2.5-flash      # Specify model
codemie-gemini -p "your prompt"         # Non-interactive mode
```

## Troubleshooting

### Command Not Found

```bash
# Re-link the package
npm link
which codemie

# Check installation
npm list -g @codemieai/code
```

### Configuration Issues

```bash
# Run setup wizard
codemie setup

# Check current config
codemie config show

# View available parameters
codemie config list

# Test connection
codemie config test
```

### Connection Problems

```bash
# Run diagnostics
codemie doctor

# Test specific agent
codemie-code health
codemie-claude health

# Debug mode for detailed logs
codemie-code --debug
```

### Agent Installation Failures

```bash
# Check internet connection
curl -I https://api.github.com

# Clear npm cache
npm cache clean --force

# Retry installation
codemie install claude
```

### Model Compatibility Errors

When you see "Model not compatible" errors:

1. Check your configured model: `codemie config show`
2. Run the agent to see compatible options
3. Update your profile: `codemie setup` (choose "Update existing profile")
4. Or override temporarily: `codemie-codex --model gpt-4.1`

## Development

### Project Structure

```
codemie-code/
├── bin/                    # Executable entry points
│   ├── codemie.js         # Main CLI
│   ├── codemie-code.js    # Built-in agent
│   ├── codemie-claude.js  # Claude shortcut
│   └── codemie-codex.js   # Codex shortcut
├── src/
│   ├── agents/            # Agent registry and adapters
│   ├── cli/               # CLI command implementations
│   ├── env/               # Environment and config management
│   ├── workflows/         # Workflow management
│   ├── tools/             # VCS tools management
│   └── utils/             # Shared utilities
└── tests/                 # Test files
```

### Building

```bash
npm run build              # Compile TypeScript
npm run dev                # Watch mode
npm run lint               # Check code style
npm run test               # Run tests
npm run ci                 # Full CI pipeline
```

### Testing

```bash
npm run build && npm link
codemie --help
codemie doctor
codemie-code health
```

## License

Apache-2.0

## Links

- [GitHub Repository](https://github.com/codemie-ai/codemie-code)
- [Issue Tracker](https://github.com/codemie-ai/codemie-code/issues)
- [NPM Package](https://www.npmjs.com/package/@codemieai/code)