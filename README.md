# AI/Run CodeMie CLI

[![npm version](https://img.shields.io/npm/v/@codemieai/code.svg)](https://www.npmjs.com/package/@codemieai/code)
[![Release](https://img.shields.io/github/v/release/codemie-ai/codemie-code)](https://github.com/codemie-ai/codemie-code/releases)
[![npm downloads](https://img.shields.io/npm/dm/@codemieai/code.svg)](https://www.npmjs.com/package/@codemieai/code)
[![Build Status](https://img.shields.io/github/actions/workflow/status/codemie-ai/codemie-code/ci.yml?branch=main)](https://github.com/codemie-ai/codemie-code/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/codemie-ai/codemie-code?style=social)](https://github.com/codemie-ai/codemie-code/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/codemie-ai/codemie-code)](https://github.com/codemie-ai/codemie-code/commits/main)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Unified AI Coding Assistant CLI** - Manage Claude Code, OpenAI Codex, Google Gemini, and custom AI agents from one powerful command-line interface. Multi-provider support (OpenAI, Azure OpenAI, AWS Bedrock, LiteLLM, Enterprise SSO). Built-in LangGraph agent with file operations, git integration, and advanced code generation.

---

![CodeMie CLI Demo](./assets/demo.gif)

---

## Why CodeMie CLI?

CodeMie CLI is the all-in-one AI coding assistant for developers.

- ✨ **One CLI, Multiple AI Agents** - Switch between Claude Code, Codex, Gemini, Deep Agents, and built-in agent.
- 🔄 **Multi-Provider Support** - OpenAI, Azure, Bedrock, LiteLLM, Google Gemini, and Enterprise SSO.
- 🚀 **Built-in Agent** - A powerful LangGraph-based assistant with file operations and git integration.
- 🔐 **Enterprise Ready** - SSO authentication, audit logging, and role-based access.
- ⚡ **Productivity Boost** - Code review, refactoring, test generation, and bug fixing.
- 🎯 **Profile Management** - Manage work, personal, and team configurations separately.
- 📊 **Usage Analytics** - Track and analyze AI usage across all agents with detailed insights.
- 🔧 **CI/CD Workflows** - Automated code review, fixes, and feature implementation.

Perfect for developers seeking a powerful alternative to GitHub Copilot or Cursor.

## Quick Start

```bash
# 1. Install globally
npm install @codemieai/code

# 2. Setup (interactive wizard)
npx codemie setup

# 3. Start coding with the built-in agent
npx codemie-code "Review my code for bugs"

# 4. Install and use other agents
npx codemie install claude
npx codemie-claude "Refactor this function"
```

## Installation

### From npm (Recommended)

```bash
# Install the package
npm install @codemieai/code

# Use with npx
npx codemie --help
```

Alternatively, for frequent use, you can install globally:

```bash
npm install --global @codemieai/code
codemie --help
```

### From Source

```bash
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code
npm install
npm run build && npm link
```

### Verify Installation

```bash
codemie --help
codemie doctor
```

## Usage

The CodeMie CLI provides two ways to interact with AI agents:

### Built-in Agent (CodeMie Native)

The built-in agent is ready to use immediately and is great for a wide range of coding tasks.

```bash
# Start an interactive conversation
codemie-code

# Start with an initial message
codemie-code "Help me refactor this component"
```

### External Agents

You can also install and use external agents like Claude Code, Codex, and Gemini.

```bash
# Install an agent
codemie install claude

# Use the agent
codemie-claude "Review my API code"
```

For more detailed information on the available agents, see the [Agents Documentation](docs/AGENTS.md).

## Commands

The CodeMie CLI has a rich set of commands for managing agents, configuration, and more.

```bash
codemie setup            # Interactive configuration wizard
codemie list             # List all available agents
codemie install <agent>  # Install an agent
codemie profile <cmd>    # Manage provider profiles
codemie auth <cmd>       # Manage SSO authentication
codemie analytics <cmd>  # View usage analytics
codemie workflow <cmd>   # Manage CI/CD workflows
codemie doctor           # Health check and diagnostics
```

For a full command reference, see the [Commands Documentation](docs/COMMANDS.md).

## Configuration

### Quick Setup

The easiest way to get started:

```bash
# Interactive setup wizard
codemie setup

# Or use environment variables
export CODEMIE_PROVIDER=openai
export CODEMIE_API_KEY=sk-...
export CODEMIE_MODEL=gpt-4
```

### Configuration Options

- **Setup Wizard** - `codemie setup` (recommended)
- **Environment Variables** - Override config for specific sessions
- **Config File** - `~/.codemie/config.json` for persistent settings
- **Multi-Provider Profiles** - Manage work, personal, and team configs

See [Configuration Documentation](docs/CONFIGURATION.md) for detailed setup, environment variables reference, and advanced configuration.

## Documentation

Comprehensive guides are available in the `docs/` directory:

- **[Configuration](docs/CONFIGURATION.md)** - Setup wizard, environment variables, multi-provider profiles, manual configuration
- **[Commands](docs/COMMANDS.md)** - Complete command reference including analytics and workflow commands
- **[Agents](docs/AGENTS.md)** - Detailed information about each agent (Claude Code, Codex, Gemini, Deep Agents, built-in)
- **[Authentication](docs/AUTHENTICATION.md)** - SSO setup, token management, enterprise authentication
- **[Examples](docs/EXAMPLES.md)** - Common workflows, multi-provider examples, CI/CD integration

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started.

## License

This project is licensed under the Apache-2.0 License.

## Links

- [GitHub Repository](https://github.com/codemie-ai/codemie-code)
- [Issue Tracker](https://github.com/codemie-ai/codemie-code/issues)
- [NPM Package](https://www.npmjs.com/package/@codemieai/code)
