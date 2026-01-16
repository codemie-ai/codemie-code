# AI/Run CodeMie CLI

[![npm version](https://img.shields.io/npm/v/@codemieai/code.svg)](https://www.npmjs.com/package/@codemieai/code)
[![Release](https://img.shields.io/github/v/release/codemie-ai/codemie-code)](https://github.com/codemie-ai/codemie-code/releases)
[![npm downloads](https://img.shields.io/npm/dm/@codemieai/code.svg)](https://www.npmjs.com/package/@codemieai/code)
[![Build Status](https://img.shields.io/github/actions/workflow/status/codemie-ai/codemie-code/ci.yml?branch=main)](https://github.com/codemie-ai/codemie-code/actions/workflows/ci.yml)
[![GitHub Stars](https://img.shields.io/github/stars/codemie-ai/codemie-code?style=social)](https://github.com/codemie-ai/codemie-code/stargazers)
[![Last Commit](https://img.shields.io/github/last-commit/codemie-ai/codemie-code)](https://github.com/codemie-ai/codemie-code/commits/main)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3%2B-blue.svg)](https://www.typescriptlang.org/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

> **Unified AI Coding Assistant CLI** - Manage Claude Code, OpenAI Codex, Google Gemini, Deep Agents, and custom AI agents from one powerful command-line interface. Multi-provider support (OpenAI, Azure OpenAI, AWS Bedrock, LiteLLM, Ollama, Enterprise SSO). Built-in LangGraph agent with file operations, command execution, and planning tools. Cross-platform support for Windows, Linux, and macOS.

---

![CodeMie CLI Demo](./assets/demo.gif)

---

## Why CodeMie CLI?

CodeMie CLI is the all-in-one AI coding assistant for developers.

- ✨ **One CLI, Multiple AI Agents** - Switch between Claude Code, Codex, Gemini, Deep Agents, and built-in agent.
- 🔄 **Multi-Provider Support** - OpenAI, Azure OpenAI, AWS Bedrock, LiteLLM, Ollama, and Enterprise SSO.
- 🚀 **Built-in Agent** - A powerful LangGraph-based assistant with file operations, command execution, and planning tools.
- 🖥️ **Cross-Platform** - Full support for Windows, Linux, and macOS with platform-specific optimizations.
- 🔐 **Enterprise Ready** - SSO authentication, audit logging, and role-based access.
- ⚡ **Productivity Boost** - Code review, refactoring, test generation, and bug fixing.
- 🎯 **Profile Management** - Manage work, personal, and team configurations separately.
- 📊 **Usage Analytics** - Track and analyze AI usage across all agents with detailed insights.
- 🔧 **CI/CD Workflows** - Automated code review, fixes, and feature implementation.

Perfect for developers seeking a powerful alternative to GitHub Copilot or Cursor.

## Quick Start

```bash
# Install globally for best experience
npm install -g @codemieai/code

# 1. Setup (interactive wizard)
codemie setup

# 2. Check system health
codemie doctor

# 3. Install an external agent (e.g., Claude Code)
codemie install claude

# 4. Use the installed agent
codemie-claude "Review my API code"

# 5. Use the built-in agent
codemie-code "Analyze this codebase"

# 6. Execute a single task and exit
codemie --task "Generate unit tests"
```

**Prefer not to install globally?** Use npx with the full package name:

```bash
npx @codemieai/code setup
npx @codemieai/code doctor
npx @codemieai/code install claude
# Note: Agent shortcuts require global installation
```

## Installation

### Global Installation (Recommended)

For the best experience with all features and agent shortcuts:

```bash
npm install -g @codemieai/code
codemie --help
```

### Local/Project Installation

For project-specific usage:

```bash
npm install @codemieai/code

# Use with npx
npx @codemieai/code --help
```

**Note:** Agent shortcuts (`codemie-claude`, `codemie-code`, etc.) require global installation.

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

**Available Tools:**
- `read_file` - Read file contents
- `write_file` - Write content to files
- `list_directory` - List files with intelligent filtering (auto-filters node_modules, .git, etc.)
- `execute_command` - Execute shell commands with progress tracking
- `write_todos` / `update_todo_status` / `append_todo` / `clear_todos` / `show_todos` - Planning and progress tracking tools

```bash
# Start an interactive conversation
codemie-code

# Start with an initial message
codemie-code "Help me refactor this component"
```

### External Agents

You can also install and use external agents like Claude Code, Codex, Gemini, and Deep Agents.

**Available Agents:**
- **Claude Code** (`codemie-claude`) - Anthropic's official CLI with advanced code understanding
- **Codex** (`codemie-codex`) - OpenAI's code generation specialist
- **Gemini CLI** (`codemie-gemini`) - Google's Gemini for coding tasks
- **Deep Agents** (`codemie-deepagents`) - Advanced multi-agent system with specialized roles

```bash
# Install an agent
codemie install claude

# Use the agent
codemie-claude "Review my API code"

# Install Python-based agent (uses pip/uv)
codemie install deepagents
codemie-deepagents "Implement a REST API"
```

For more detailed information on the available agents, see the [Agents Documentation](docs/AGENTS.md).

## Commands

The CodeMie CLI has a rich set of commands for managing agents, configuration, and more.

```bash
codemie setup            # Interactive configuration wizard
codemie list             # List all available agents
codemie install <agent>  # Install an agent
codemie update <agent>   # Update installed agents
codemie profile          # Manage provider profiles
codemie analytics        # View usage analytics (sessions, tokens, costs, tools)
codemie workflow <cmd>   # Manage CI/CD workflows
codemie doctor           # Health check and diagnostics
```

For a full command reference, see the [Commands Documentation](docs/COMMANDS.md).



## Documentation

Comprehensive guides are available in the `docs/` directory:

- **[Configuration](docs/CONFIGURATION.md)** - Setup wizard, environment variables, multi-provider profiles, manual configuration
- **[Commands](docs/COMMANDS.md)** - Complete command reference including analytics and workflow commands
- **[Agents](docs/AGENTS.md)** - Detailed information about each agent (Claude Code, Codex, Gemini, Deep Agents, built-in)
- **[Authentication](docs/AUTHENTICATION.md)** - SSO setup, token management, enterprise authentication
- **[Examples](docs/EXAMPLES.md)** - Common workflows, multi-provider examples, CI/CD integration
- **[Configuration Architecture](docs/ARCHITECTURE-CONFIGURATION.md)** - How configuration flows through the system from CLI to proxy plugins

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started.

## License

This project is licensed under the Apache-2.0 License.

## Links

- [GitHub Repository](https://github.com/codemie-ai/codemie-code)
- [Issue Tracker](https://github.com/codemie-ai/codemie-code/issues)
- [NPM Package](https://www.npmjs.com/package/@codemieai/code)
