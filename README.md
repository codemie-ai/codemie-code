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
- [Configuration](#configuration)
  - [Setup Wizard (Recommended)](#setup-wizard-recommended)
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
```

AI/Run CodeMie CLI is a professional, unified CLI tool for installing, configuring, and running multiple AI coding agents from a single interface. It includes a built-in LangGraph-based agent (CodeMie Native) and supports external agents like Claude Code and Codex.

## Quick Start

```bash
# 1. Install
npm install -g @codemieai/code

# 2. Setup (interactive wizard)
codemie setup

# 3. Start coding with built-in agent
codemie-code "Review my code for bugs"
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

# Or run through main CLI
codemie run claude --task "Fix security issues"
```

## Commands

### Core Commands

```bash
codemie setup                    # Interactive configuration wizard
codemie auth <command>           # Manage SSO authentication
codemie list                     # List all available agents
codemie install <agent>          # Install an agent
codemie uninstall <agent>        # Uninstall an agent
codemie run <agent> [args...]    # Run an agent
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

# Configuration overrides
codemie-claude --model claude-4-5-sonnet --api-key your-key
codemie-codex --model gpt-4o --provider openai
```

### Configuration Commands

```bash
codemie config list              # Show all configuration
codemie config get <key>         # Get specific value
codemie config set <key> <value> # Set configuration value
codemie config reset             # Reset to defaults
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

### Supported Providers

- **ai-run-sso** - AI/Run CodeMie SSO (unified enterprise gateway)
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

- **Codex**: OpenAI models only (gpt-4, gpt-4o, gpt-5, etc.)
- **Claude**: Both Claude and GPT models
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
# Setup with different providers
codemie config set provider openai
codemie config set model gpt-4o
codemie config set apiKey sk-your-key

# Temporary model override
codemie-claude --model claude-4-5-sonnet -p "Explain this algorithm"

# Debug mode for troubleshooting
codemie-code --debug --task "analyze performance issues"
```

### Advanced Usage

```bash
# Run specific agent versions
codemie run claude --version latest

# Pass custom arguments
codemie-codex --temperature 0.1 --max-tokens 2000 "Generate clean code"

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
codemie config list

# Reset if needed
codemie config reset
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

1. Check your configured model: `codemie config get model`
2. Run the agent to see compatible options
3. Set a compatible model: `codemie config set model gpt-4o`
4. Or override temporarily: `codemie-codex --model gpt-4o`

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