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

> **Unified AI Coding Assistant CLI** - Manage Claude Code, OpenAI Codex, GitHub Copilot CLI, Google Gemini, OpenCode, Pi, Kimi Code, and custom AI agents from one powerful command-line interface. Multi-provider support (CodeMie SSO, Bearer Auth, LiteLLM, AWS Bedrock, Ollama, Anthropic Subscription, Moonshot Subscription). Built-in native agent with file operations, command execution, planning mode, and plugins. Cross-platform support for Windows, Linux, and macOS.

---

![CodeMie CLI Demo](./assets/demo.gif)

---

## Why CodeMie CLI?

CodeMie CLI is the all-in-one AI coding assistant for developers.

- ✨ **One CLI, Multiple AI Agents** - Switch between Claude Code, OpenAI Codex, GitHub Copilot CLI, Gemini, OpenCode, Pi, Kimi Code, and built-in agent.
- 🔄 **Multi-Provider Support** - CodeMie SSO, Bearer Authorization, LiteLLM, AWS Bedrock, Ollama, Anthropic Subscription, and Moonshot Subscription.
- 🚀 **Built-in Agent** - `codemie-code` ships with the CLI: file operations, command execution, planning mode, and native plugins.
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
codemie install codex --supported
codemie install copilot
codemie-claude "Review my API code"
codemie-codex "Refactor this service"
codemie-copilot --task "Summarize this module"
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

For Windows and macOS, CodeMie ships two installer options:

- **GUI installers** — a signed `.dmg` (macOS) and a `.exe` wizard (Windows) that guide you through installation with no terminal required. Download [CodeMie Connect 2.0.1 (macOS aarch64)](https://github.com/codemie-ai/codemie-code/raw/main/install/macos/CodeMie%20Connect_2.0.1_aarch64_signed.dmg) or browse the [macOS install folder](https://github.com/codemie-ai/codemie-code/tree/main/install/macos) / [Windows install folder](https://github.com/codemie-ai/codemie-code/tree/main/install/windows) and run the file.
- **Script installers** — plain shell/PowerShell scripts stored in this repo that install via npm. Prefer these for CI, headless machines, or when the GUI installer is unavailable.

The script installers are plain scripts stored in this public GitHub repo, so they do not require a Windows-built `.exe` or a private Artifactory mirror.

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

**Note:** Agent shortcuts (`codemie-claude`, `codemie-codex`, `codemie-code`, `codemie-opencode`, `codemie-pi`, `codemie-kimi`, etc.) require global installation.

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

`codemie-code` ships with the CLI — no separate install. It is a native CodeMie binary (`@codemieai/codemie-opencode`, platform-specific), pre-wired to the CodeMie proxy, with file/shell tools, planning mode, and native plugin support.

```bash
codemie-code                                  # interactive session
codemie-code "Help me refactor this component"
codemie-code --task "Generate unit tests"     # run once and exit
codemie-code --plan                           # planning mode
codemie-code --plan-only                      # plan without executing
codemie-code --plugin-dir ./my-plugins        # load native plugins
codemie-code --debug                          # debug logging
```

Providers: CodeMie SSO, Bearer Auth, LiteLLM, AWS Bedrock, Ollama.

### External Agents

CodeMie installs external agents, routes them through the CodeMie proxy, and tracks their sessions.

| Agent | Install | Shortcut | Upstream package |
|---|---|---|---|
| Claude Code | `codemie install claude --supported` | `codemie-claude` | `@anthropic-ai/claude-code` |
| Claude Code ACP | `codemie install claude-acp` | `codemie-claude-acp` | `@zed-industries/claude-code-acp` |
| OpenAI Codex | `codemie install codex --supported` | `codemie-codex` | `@openai/codex` |
| Gemini CLI | `codemie install gemini` | `codemie-gemini` | `@google/gemini-cli` |
| OpenCode | `codemie install opencode` | `codemie-opencode` | `opencode-ai` |
| Pi | `codemie install pi` | `codemie-pi` | `@earendil-works/pi-coding-agent` |
| Kimi Code | `codemie install kimi` | `codemie-kimi` | `@moonshot-ai/kimi-code` |
| Kimi Code ACP | `codemie install kimi-acp` | `codemie-kimi-acp` | `@moonshot-ai/kimi-code` (`acp` mode) |
| GitHub Copilot CLI | `codemie install copilot` | `codemie-copilot` | `@github/copilot` |

ACP agents are launched by your IDE, not directly — see [ACP Agent usage](#acp-agent-usage-in-ides-and-editors) below.

```bash
codemie install claude --supported             # install
codemie install copilot                        # install GitHub Copilot CLI
codemie-claude "Review my API code"            # one-shot task
codemie-claude                                 # interactive session
codemie-copilot --task "Refactor this auth flow"
codemie uninstall copilot                      # uninstall GitHub Copilot CLI
codemie-codex --task "Refactor this auth flow" # same shape for every agent
```

#### GitHub Copilot CLI via CodeMie

CodeMie can install and launch GitHub Copilot CLI as a managed agent while keeping the internal registry identity `copilot-cli`.

Supported managed path for this release:

- **Install:** `codemie install copilot`
- **Uninstall:** `codemie uninstall copilot`
- **Launch:** `codemie-copilot`
- **One-shot task:** `codemie-copilot --task "Explain this service"`
- **Supported providers:** CodeMie SSO and LiteLLM

Requirements and behavior:

- Use an authenticated CodeMie profile (`codemie setup`).
- Managed Copilot runs are routed through CodeMie's provider/proxy path.
- The supported managed path does **not** require GitHub login, a GitHub Copilot subscription, or a GitHub personal access token.
- CodeMie blocks fallback to ambient GitHub credentials for this managed mode.
- Copilot conversation sync is attributed under `copilot-cli` in CodeMie.

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

CodeMie manages agent versions to ensure compatibility:

```bash
codemie install claude --supported   # latest supported version (recommended)
codemie install claude 2.1.22        # pin a specific version
codemie install claude               # latest available version
```

Auto-updates are automatically disabled to maintain version control. CodeMie notifies you when running a different version than supported.

For more detailed information on the available agents, see the [Agents Documentation](docs/AGENTS.md).

### Providers

A profile binds an agent to a provider. Run `codemie setup` to create one, or `codemie profile` to manage several (work, personal, team).

| Provider | Auth | Use case |
|---|---|---|
| CodeMie SSO | enterprise SSO | Enterprise default — centralized model management, proxy routing, analytics |
| Bearer Authorization | JWT via CLI or env var | CI, service accounts, self-hosted gateways |
| LiteLLM | API key | Universal gateway to 100+ LLM providers (OpenAI, Azure, Vertex, …) |
| AWS Bedrock | AWS access key + secret | Claude, Llama, Mistral & more via Amazon Bedrock |
| Ollama | none | Local open-source models, offline work |
| Anthropic Subscription | native Claude Code login | Bring your own Claude subscription |
| Moonshot Subscription | native Kimi Code login | Bring your own Moonshot subscription (Kimi Code) |

See [Authentication](docs/AUTHENTICATION.md) and [Configuration](docs/CONFIGURATION.md) for setup details.

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

### Pi (`codemie-pi`)

Pi is an open-source coding agent harness ([`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)).

```bash
codemie install pi                            # also installs the required Pi packages
codemie-pi "Add retry logic to the HTTP client"
codemie-pi                                    # interactive session
codemie-pi --continue                         # continue the latest session
codemie-pi --resume <session-id>              # open a specific session
```

**What CodeMie configures for you:**

| What | How |
|---|---|
| **Managed agent dir** | `~/.pi/agent` is copied once to `<project>/.pi/codemie/agent`; Pi runs against the copy via `PI_CODING_AGENT_DIR`. Your skills, prompts, and extensions carry over — your Pi home is never modified. |
| **Live model catalogue** | `models.json` is regenerated each run with providers `codemie-proxy` (OpenAI-compatible) and `codemie-anthropic` (Claude). Model/provider come from your active profile. |
| **Required packages** | `pi-mcp-adapter` (Pi ships without built-in MCP), `pi-subagents`, `superpowers` — installed at setup. |
| **Session analytics** | An injected extension records tokens, tools, and models per session and syncs at session end; visible in `codemie analytics`. |

Providers: CodeMie SSO, Bearer Auth, LiteLLM.

## Claude Code Statusline

The CodeMie Statusline displays live budget usage, project name, git branch, model, context window percentage, and token counts at the bottom of every Claude Code session.

```bash
# Install (or update) the statusline
codemie install statusline

# Remove it
codemie uninstall statusline
```

Once installed, the statusline appears automatically in every claude session:

```
[my-project] $4.21/$50 (8%) | (main) | [claude-sonnet-4-5] | ctx:12% in:45.2k out:3.1k
```

The script is deployed to `~/.claude/codemie-budget-status.js` and registered as a `statusLine` command in `~/.claude/settings.json`. Budget values are cached for 60 seconds to avoid redundant API calls.

## Commands

The CodeMie CLI has a rich set of commands for managing agents, configuration, and more.

```bash
codemie setup            # Interactive configuration wizard
codemie list             # List all available agents
codemie install <name>   # Install an agent or add-on (e.g. statusline)
codemie uninstall <name> # Remove an agent or add-on
codemie update <agent>   # Update installed agents
codemie self-update      # Update CodeMie CLI itself
codemie profile          # Manage provider profiles
codemie models list      # List models available for the current provider
codemie analytics        # View usage analytics (sessions, tokens, costs, tools)
codemie analytics --report --open   # Self-contained HTML dashboard (7 views, cost, date range, light/dark, no server)
codemie analytics --report --report-format json  # Same priced report data as JSON (--report-format html | json | both)
codemie workflow <cmd>   # Manage CI/CD workflows
codemie sdk <resource>   # Manage CodeMie platform assets (assistants, workflows, datasources, integrations, skills, users)
codemie skill <cmd>      # Manage skills for CodeMie agents (list, validate, reload)
codemie skills <cmd>     # Discover/install agent skills via skills.sh + EPAM catalog
codemie plugin <cmd>     # Manage native plugins (Anthropic format)
codemie mcp add          # Add an MCP server to an agent config
codemie mcp-proxy <url>  # Stdio-to-HTTP MCP proxy with OAuth
codemie proxy <cmd>      # Manage the local CodeMie proxy and its integrations
codemie codebase ui      # Start and open Codebase Memory graph UI
codemie doctor           # Health check and diagnostics
```

For a full command reference, see the [Commands Documentation](docs/COMMANDS.md).

## Codebase Memory MCP

CodeMie can install and orchestrate `codebase-memory-mcp` with its graph visualization UI:

```bash
codemie install codebase-memory
codemie-code init codebase-memory
codemie codebase ui
```

Use `codemie codebase start|stop|status` to manage the UI process, or `codemie codebase open` to open the URL only.

## Connect VS Code BYOK via CodeMie Proxy

Configure VS Code's chat language model provider from the active SSO-backed CodeMie profile:

```bash
codemie proxy connect vscode
```

Use `--profile <name>` for a one-run profile override or `--insiders` for VS Code Insiders. The command writes that profile's model ID into `chatLanguageModels.json` and starts or reuses a transparent CodeMie proxy. The profile's project context is passed separately as `X-CodeMie-Project`.

No plaintext key or generated placeholder is written to that file. On first setup, press ⇧⌘P on macOS or Ctrl+Shift+P on Windows/Linux, run `Chat: Manage Language Models`, right-click **CodeMie Profile Model**, choose **Update API Key**, and enter the local key `codemie-proxy`. VS Code keeps it in secret storage. Reload VS Code after configuration.

## Connect Claude Desktop via CodeMie Proxy

Use Claude Desktop 3P through CodeMie proxy routing to capture `claude-desktop` metrics and synced conversations.

### Prerequisites

- `codemie` installed
- a valid CodeMie SSO profile
- Claude Desktop 3P installed — macOS, Windows, or Linux (Linux requires Claude Desktop's Ubuntu/Debian beta)

### 1. Connect Claude Desktop

```bash
codemie proxy connect desktop
```

### 2. Restart Claude Desktop

Quit and reopen Claude Desktop after the proxy configuration is written.

### 3. Inspect and troubleshoot

```bash
codemie proxy status
codemie proxy inspect desktop --limit 5
codemie proxy stop
```

### Linux

Claude Desktop's Linux app is in beta: Ubuntu 22.04+ or Debian 12+, on x86_64 or arm64. Install it from Anthropic's apt repository first — that means registering their signing key and repo, not just `apt install`, so follow [Anthropic's Linux install guide](https://code.claude.com/docs/en/desktop-linux). Then connect exactly as on macOS and Windows:

```bash
codemie proxy connect desktop --verbose
```

`--verbose` prints the config path that was written, which is the fastest way to confirm where it landed.

**Where the config goes.** Claude Desktop is an Electron app, so its config root follows the XDG convention:

| Condition | Config library |
|---|---|
| `XDG_CONFIG_HOME` set to an absolute path | `$XDG_CONFIG_HOME/Claude-3p/configLibrary/` |
| otherwise (the common case) | `~/.config/Claude-3p/configLibrary/` |

An empty or relative `XDG_CONFIG_HOME` is ignored, per the XDG spec.

**Verify the write:**

```bash
echo "${XDG_CONFIG_HOME:-(unset)}"
ls -la ~/.config/Claude-3p/configLibrary/
cat ~/.config/Claude-3p/configLibrary/_meta.json   # appliedId names the active config
codemie proxy inspect desktop --limit 5
```

Claude Desktop reads its configuration **once at launch**, so fully quit and reopen the app — not just close the window.

**If the app is launched from a desktop launcher**, it may not inherit the `XDG_CONFIG_HOME` you have exported in your shell. When that happens the CLI writes to one path and the app reads another, and the connect silently appears to do nothing. Compare the path from `--verbose` against `~/.config/Claude-3p/`.

**Managed (MDM) settings.** If `/etc/claude-desktop/managed-settings.json` exists, `codemie proxy connect desktop` warns you: Claude Desktop applies a managed source in preference to local configuration. This is not automatically fatal — a policy that sets only `disableAutoUpdates` and `autoUpdaterEnforcementHours` leaves everything else local, so the write still applies. If routing really is ignored, ask your administrator to carry the gateway settings in the managed source rather than deleting the file, which is root-owned and typically redeployed by MDM.

**WSL is not supported.** WSL reports its platform as Linux, so the config is written on the WSL side where a Windows Claude Desktop will not look for it. Run `codemie proxy connect desktop` from Windows instead.

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
- **[Analytics Report](docs/ANALYTICS-REPORT.md)** - HTML dashboard: all 8 views, filters, session drill-down, cost and efficiency metrics
- **[Agents](docs/AGENTS.md)** - Per-agent detail (built-in, Claude Code, Claude Code ACP, Gemini, OpenCode; Pi and Kimi are documented in this README)
- **[Authentication](docs/AUTHENTICATION.md)** - SSO setup, token management, enterprise authentication
- **[Plugins](docs/PLUGINS.md)** - Reusable packages of skills, commands, agents, hooks, and MCP servers (`.claude-plugin/plugin.json` format)
- **[Skills](docs/SKILLS.md)** - Injecting custom knowledge into agents via markdown + YAML frontmatter
- **[Hooks](docs/HOOKS.md)** - Shell and LLM-based hooks at agent lifecycle points
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
