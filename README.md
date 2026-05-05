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

> **Unified AI Coding Assistant CLI** - Manage Claude Code, Google Gemini, OpenCode, and custom AI agents from one powerful command-line interface. Multi-provider support (OpenAI, Azure OpenAI, AWS Bedrock, LiteLLM, Ollama, Enterprise SSO, JWT Bearer Auth). Built-in LangGraph agent with file operations, command execution, and planning tools. Cross-platform support for Windows, Linux, and macOS.

---

![CodeMie CLI Demo](./assets/demo.gif)

---

## Why CodeMie CLI?

CodeMie CLI is the all-in-one AI coding assistant for developers.

- ✨ **One CLI, Multiple AI Agents** - Switch between Claude Code, Gemini, OpenCode, and built-in agent.
- 🔄 **Multi-Provider Support** - OpenAI, Azure OpenAI, AWS Bedrock, LiteLLM, Ollama, Enterprise SSO, and JWT Bearer Auth.
- 🚀 **Built-in Agent** - A powerful LangGraph-based assistant with file operations, command execution, and planning tools.
- 🖥️ **Cross-Platform** - Full support for Windows, Linux, and macOS with platform-specific optimizations.
- 🔗 **MCP Proxy** - Connect to remote MCP servers with automatic OAuth authorization.
- 🔐 **Enterprise Ready** - SSO and JWT authentication, audit logging, and role-based access.
- ⚡ **Productivity Boost** - Code review, refactoring, test generation, and bug fixing.
- 🎯 **Profile Management** - Manage work, personal, and team configurations separately.
- 🧩 **CodeMie Assistants in Claude** - Connect your available CodeMie assistants as Claude subagents or skills.
- 🛠️ **CodeMie Platform Skills** - Install CodeMie platform skills directly as Claude Code slash commands with auto-sync.
- 📊 **Usage Analytics** - Track and analyze AI usage across all agents with detailed insights.
- 🔧 **CI/CD Workflows** - Automated code review, fixes, and feature implementation.

Perfect for developers seeking a powerful alternative to GitHub Copilot or Cursor.

## Quick Start

Install CodeMie using the instructions for your shell, then run:

```bash
codemie setup
codemie doctor
codemie install claude --supported
codemie-claude "Review my API code"
codemie-code "Analyze this codebase"
codemie --task "Generate unit tests"
codemie skills find pdf                    # discover agent skills (EPAM internal + skills.sh)
claude mcp add my-server -- codemie-mcp-proxy "https://mcp-server.example.com/sse"
```

**Prefer not to install globally?** Use npx with the full package name:

```bash
npx @codemieai/code setup
npx @codemieai/code doctor
npx @codemieai/code install claude --supported
# Note: Agent shortcuts require global installation
```

## Installation

### Native Bootstrap Installers

For Windows and macOS, use the CodeMie bootstrap installers instead of installing directly with npm. The bootstrap installers are plain scripts stored in this public GitHub repo, so they do not require a Windows-built `.exe` or a private Artifactory mirror.

The bootstrap path is recommended for non-technical users and managed enterprise machines because it:

- avoids PowerShell `npm.ps1` execution-policy failures on Windows,
- avoids global npm permission errors such as macOS `EACCES`,
- installs into a user-writable location where possible,
- checks Node.js, npm, registry access, and CodeMie package visibility before installing,
- prints actionable remediation when the enterprise npm registry is not configured correctly.

The examples below use GitHub raw URLs from the `main` branch. For reproducible installs, replace `main` with a release tag such as `v0.0.57`. Enterprise teams can mirror the same scripts to Artifactory later by setting `CODEMIE_INSTALL_URL` to the mirrored script directory.

Channel selection is not implemented in the bootstrap scripts yet. To pin a version on Windows PowerShell, pass `-Version 0.0.57`. To pin a version on macOS, Linux, or WSL, set `CODEMIE_PACKAGE_VERSION=0.0.57` before running the install command.

### Windows PowerShell

The Windows bootstrapper installs CodeMie in user-local portable mode by default and calls `npm.cmd` directly, so it does not permanently change PowerShell execution policy.

```powershell
irm https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.ps1 | iex
```

To pass explicit options:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.ps1))) -RegistryUrl https://registry.npmjs.org/
```

### Windows CMD

Use this fallback when PowerShell copy-paste guidance is not practical:

```cmd
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/windows/install.cmd -o install.cmd && install.cmd && del install.cmd
```

### macOS

The macOS bootstrapper uses npm global installation only when it is user-writable. If global npm is not writable, it configures a user-local npm prefix instead.

```bash
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh | bash
```

To install a specific package version:

```bash
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh | env CODEMIE_PACKAGE_VERSION=0.0.57 bash
```

### Linux and WSL

Use the same shell bootstrapper for Linux and WSL:

```bash
curl -fsSL https://raw.githubusercontent.com/codemie-ai/codemie-code/main/install/macos/install.sh | bash
```

### npm Fallback

Use npm fallback only when Node.js 20+ and npm global installs are already configured correctly:

```bash
npm install -g @codemieai/code
codemie --help
```

### Local/Project npm Installation

For project-specific usage:

```bash
npm install @codemieai/code

# Use with npx
npx @codemieai/code --help
```

**Note:** Agent shortcuts (`codemie-claude`, `codemie-code`, `codemie-opencode`, etc.) require global installation.

### Installation Troubleshooting

If PowerShell reports that `npm.ps1` cannot be loaded, use the CodeMie bootstrap installer. It calls `npm.cmd` directly and does not permanently change your execution policy.

If npm reports `EACCES` on macOS, use the bootstrap installer or configure npm to use a user-local prefix.

If npm reports `404 Not Found`, verify that you are installing `@codemieai/code`, not `codemie`, and that your enterprise npm virtual registry exposes the `@codemieai` scope.

If the installer says `@codemieai/code` is not visible in the registry, ask IT to expose the package through the approved virtual npm repository.

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

You can also install and use external agents like Claude Code and Gemini.

**Available Agents:**
- **Claude Code** (`codemie-claude`) - Anthropic's official CLI with advanced code understanding
- **Claude Code ACP** (`codemie-claude-acp`) - Claude Code for IDE integration via ACP protocol (Zed, JetBrains, Emacs)
- **Gemini CLI** (`codemie-gemini`) - Google's Gemini for coding tasks
- **OpenCode** (`codemie-opencode`) - Open-source AI coding assistant with session analytics

```bash
# Install an agent (latest supported version)
codemie install claude --supported

# Use the agent
codemie-claude "Review my API code"

# Install Gemini
codemie install gemini
codemie-gemini "Implement a REST API"

# Install OpenCode
codemie install opencode

# Install Claude Code ACP (for IDE integration)
codemie install claude-acp
# Configure in your IDE (see docs/AGENTS.md for details)
```

#### ACP Agent usage in IDEs and Editors

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "agent_servers": {
    "claude": {
      "command": "codemie-claude-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**IntelliJ IDEA** (`~/.jetbrains/acp.json`):
```json
{
  "default_mcp_settings": {},
  "agent_servers": {
    "Claude Code via CodeMie": {
      "command": "codemie-claude-acp"
    }
  }
}
```

**Emacs** (with acp.el):
```elisp
(setq acp-claude-command "codemie-claude-acp")
(setq acp-claude-args '("--profile" "work"))
```


**Version Management:**

CodeMie manages agent versions to ensure compatibility. For Claude Code:

```bash
# Install latest supported version (recommended)
codemie install claude --supported

# Install specific version
codemie install claude 2.1.22

# Install latest available version
codemie install claude
```

Auto-updates are automatically disabled to maintain version control. CodeMie notifies you when running a different version than supported.

For more detailed information on the available agents, see the [Agents Documentation](docs/AGENTS.md).

### CodeMie Assistants as Claude Skills or Subagents

CodeMie can connect assistants available in your CodeMie account directly into Claude Code. Register them as Claude subagents and call them with `@slug`, or register them as Claude skills and invoke them with `/slug`.

```bash
# Pick assistants from your CodeMie account and choose how to register them
codemie setup assistants
```

During setup, choose:
- **Claude Subagents** - register selected assistants as `@slug`
- **Claude Skills** - register selected assistants as `/slug`
- **Manual Configuration** - choose skill or subagent per assistant

After registration, use them from Claude Code:

```text
@api-reviewer Review this authentication flow
/release-checklist prepare a release checklist for this branch
```

You can also message a registered assistant directly through CodeMie:

```bash
codemie assistants chat "assistant-id" "Review this API design"
```

### CodeMie Platform Skills in Claude

In addition to assistants, CodeMie platform skills can be installed directly as Claude Code slash commands.

```bash
# Browse and register CodeMie platform skills
codemie setup skills
```

During setup:
1. A disclaimer is shown — skills are installed **without tools or MCP servers**. If you need tools, create an assistant with the skill attached and use `codemie setup assistants` instead.
2. Choose storage scope: **Global** (available in all projects) or **Local** (project-scoped, overrides global).
3. Select which skills to register or unregister from your CodeMie account.

After registration, use them directly in Claude Code:

```text
/skill-name run the skill
```

Skills are automatically synced on every Claude agent startup, so the local SKILL.md files stay up to date with the latest content from the CodeMie platform.

> **Tip:** For skills that require MCP servers or tools, use `codemie setup assistants` instead.

### Manage skills.sh and EPAM Skills (`codemie skills`)

`codemie skills` is a SSO-gated wrapper around the upstream [skills.sh](https://skills.sh) CLI. It lets you discover, install, update, and remove agent skills from any compatible catalog while keeping CodeMie's authentication, telemetry, and EPAM-internal catalog support in one place.

```bash
# Discover skills (two-section results: EPAM Internal first, public skills.sh second)
codemie skills find pdf
codemie skills find pdf --json
codemie skills find pdf --limit 25

# Install / update / remove skills via the upstream skills CLI
codemie skills add anthropics/skills --skill pdf --agent claude-code -y
codemie skills update                      # update everything in the current scope
codemie skills remove pdf -y               # remove a specific skill

# List installed skills (use --global for user-scope)
codemie skills list
codemie skills list --global --json
```

Notes:

- **EPAM Internal catalog is opt-in.** Until your team configures the internal endpoint, `codemie skills find` shows the friendly placeholder for the internal section and returns public results from skills.sh. Enable the internal catalog by exporting `CODEMIE_SKILLS_SEARCH_URL` or by adding `skillsSearchUrl` to your CodeMie profile (`~/.codemie/codemie-cli.config.json`).
- **Authentication.** Every `codemie skills *` subcommand requires an active CodeMie SSO session. Run `codemie setup` or `codemie profile login` first.
- **Telemetry.** A single lifecycle event is recorded per invocation (`completed` or `failed`). The raw query string is never sent.
- **Pass-through.** `codemie skills find` (no query) hands off to the upstream `skills find` interactive prompt, so the existing UX still works while the two-section view becomes the default for direct queries.

### Claude Code Built-in Commands

When using Claude Code (`codemie-claude`), you get access to powerful built-in commands for project documentation:

**Project Documentation:**
```bash
# Generate AI-optimized docs (CLAUDE.md + guides). Can be added optional details after command as well
/codemie:codemie-init

# Generate project-specific subagents. Can be added optional details after command as well
/codemie:codemie-subagents
```

**Memory Management:**
```bash
# Capture important learnings
/memory-add

# Audit and update documentation
/memory-refresh
```

These commands analyze your actual codebase to create tailored documentation and specialized agents. See [Claude Plugin Documentation](src/agents/plugins/claude/plugin/README.md) for details.

### OpenCode Session Metrics

When using OpenCode, CodeMie automatically extracts and tracks session metrics:

**Manual Metrics Processing:**
```bash
# Process a specific OpenCode session
codemie opencode-metrics --session <session-id>

# Discover and process all recent sessions
codemie opencode-metrics --discover

# Verbose output with details
codemie opencode-metrics --discover --verbose
```

Metrics are automatically extracted at session end and synced to the analytics system. Use `codemie analytics` to view comprehensive usage statistics across all agents.

## Commands

The CodeMie CLI has a rich set of commands for managing agents, configuration, and more.

```bash
codemie setup            # Interactive configuration wizard
codemie list             # List all available agents
codemie install <agent>  # Install an agent
codemie update <agent>   # Update installed agents
codemie self-update      # Update CodeMie CLI itself
codemie profile          # Manage provider profiles
codemie analytics        # View usage analytics (sessions, tokens, costs, tools)
codemie workflow <cmd>   # Manage CI/CD workflows
codemie doctor           # Health check and diagnostics
codemie mcp-proxy <url>  # Stdio-to-HTTP MCP proxy with OAuth
```

For a full command reference, see the [Commands Documentation](docs/COMMANDS.md).

## Connect Claude Desktop via CodeMie Proxy

Use Claude Desktop 3P through CodeMie proxy routing to capture `claude-desktop` metrics and synced conversations.

### Prerequisites

- `codemie` installed
- a valid CodeMie SSO profile
- Claude Desktop 3P installed

### 1. Select the active CodeMie profile

```bash
codemie profile switch <e.g. codemie-prod, should be your SSO profile name>
```

### 2. Connect Claude Desktop

```bash
codemie proxy connect desktop
```

By default this uses your current active CodeMie profile. Override it for one run with ("codemie-prod" is example here):

```bash
codemie proxy connect desktop --profile codemie-prod
```

### 3. Restart Claude Desktop

Quit and reopen Claude Desktop after the proxy configuration is written.

### 4. Inspect and troubleshoot

```bash
codemie proxy status
codemie proxy inspect desktop --limit 5
codemie proxy stop
```

### If Claude Desktop was already using Anthropic subscription or another Gateway

1. Quit Claude Desktop.
2. Sign out or disconnect the previous Anthropic or Gateway provider setup in Claude Desktop.
3. Run `codemie proxy connect desktop`.
4. Reopen Claude Desktop.

CodeMie cannot safely log you out from Claude Desktop automatically. If the old provider still appears active, clear it in Claude Desktop first and then reconnect through CodeMie.



## Documentation

Comprehensive guides are available in the `docs/` directory:

- **[Configuration](docs/CONFIGURATION.md)** - Setup wizard, environment variables, multi-provider profiles, manual configuration
  - `CODEMIE_INSECURE=1` — disable SSL verification for self-signed certs or local dev environments (SSL is on by default)
- **[Commands](docs/COMMANDS.md)** - Complete command reference including analytics and workflow commands
- **[Agents](docs/AGENTS.md)** - Detailed information about each agent (Claude Code, Gemini, built-in)
- **[Authentication](docs/AUTHENTICATION.md)** - SSO setup, token management, enterprise authentication
- **[Examples](docs/EXAMPLES.md)** - Common workflows, multi-provider examples, CI/CD integration
- **[Configuration Architecture](docs/ARCHITECTURE-CONFIGURATION.md)** - How configuration flows through the system from CLI to proxy plugins
- **[Proxy Architecture](docs/ARCHITECTURE-PROXY.md)** - Proxy plugin system, MCP authorization flow
- **[Claude Code Plugin](src/agents/plugins/claude/plugin/README.md)** - Built-in commands, hooks system, and plugin architecture

## Contributing

Contributions are welcome! Please read our [Contributing Guidelines](CONTRIBUTING.md) to get started.

## License

This project is licensed under the Apache-2.0 License.

## Links

- [GitHub Repository](https://github.com/codemie-ai/codemie-code)
- [Issue Tracker](https://github.com/codemie-ai/codemie-code/issues)
- [NPM Package](https://www.npmjs.com/package/@codemieai/code)
