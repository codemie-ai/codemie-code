# CodeMie

> CLI wrapper for managing multiple AI coding agents

CodeMie is a unified CLI tool for installing, configuring, and running multiple AI coding agents (Claude Code, Codex, etc.) from a single interface.

## ✨ Features

- 🔧 **Unified CLI** - Manage multiple AI coding agents from one interface
- ⭐ **Built-in Agent** - CodeMie Native ready to use immediately (no installation required)
- 🤖 **Multi-Agent Support** - Claude Code, Codex, and more
- 🛠️ **Environment Management** - Centralized configuration for all agents
- 🚀 **Zero Hassle** - Install and run agents with simple commands
- 📦 **Provider Agnostic** - Works with any AI provider (OpenAI, Anthropic, Azure, etc.)
- 🎯 **Task Execution** - Single task mode with `--task` flag for automation
- 🖼️ **Clipboard Integration** - Automatic image detection from system clipboard

---

## 📦 Installation

### From npm (when published)

```bash
npm install -g @codemieai/code
```

### From Source (Development)

```bash
# Clone the repository
git clone https://github.com/codemie-ai/codemie-code.git
cd codemie-code

# Install dependencies
npm install

# Build the project
npm run build

# Link globally for testing
npm link
```

### Verify Installation

```bash
# Check if command is available
codemie --help

# Run health check
codemie doctor
```

---

## 🚀 Quick Start

### Installation → Setup → Use

CodeMie follows a simple three-step workflow:

```
1. Install → 2. Setup (Wizard OR Manual) → 3. Use (Install & Run Agents)
```

### Step 1: Install

```bash
npm install -g @codemieai/code
```

### Step 2: Setup (Choose One Method)

#### Method A: Interactive Setup Wizard (Recommended)

Best for most users - guided configuration with connection testing:

```bash
codemie setup
```

**What it does:**
- ✅ Guides you through provider selection
- ✅ Prompts for credentials
- ✅ **Validates credentials** via `/health` endpoint
- ✅ **Fetches available models** via `/v1/models` endpoint
- ✅ Shows real-time model list (no hardcoded options)
- ✅ Saves to `~/.codemie/config.json`

**Supported Providers:**
- CodeMie SSO (Unified gateway)
- AWS Bedrock (Claude via AWS)
- Azure OpenAI (for GPT models and Codex)
- Custom LiteLLM Proxy

#### Method B: Manual Configuration Guide

Best for automated setups or when you have credentials ready:

```bash
# View detailed setup guide with examples
codemie env
```

### Step 3: Use Agents

#### Try the Built-in Agent (Recommended for New Users)

**CodeMie Native** is built-in and ready to use immediately:

```bash
# Start interactive session
codemie-code

# Execute single task
codemie-code --task "explore current repository"

# With initial message
codemie-code "Review my code for bugs"
```

#### Install Additional Agents

```bash
# Install Claude Code
codemie install claude

# Install Codex
codemie install codex

# Uninstall an agent
codemie uninstall claude
codemie uninstall codex
```

#### List Available Agents

```bash
codemie list
```

#### Run an Agent

Use the direct agent shortcuts for the best experience. Configuration is automatically passed from `~/.codemie/config.json`.

```bash
# Run built-in CodeMie Native
codemie-code                                    # Interactive mode
codemie-code --task "explore current repository" # Single task

# Run Claude
codemie-claude                                  # Interactive mode
codemie-claude --task "Review my code"          # Single task

# Run Codex
codemie-codex                                   # Interactive mode
codemie-codex --task "Generate tests"           # Single task
```

**Automatic Model Validation:**

CodeMie automatically validates model compatibility:
- **Codex** only accepts OpenAI models (gpt-5, gpt-4.1, gpt-4o, etc.)
- **Claude** accepts both Claude and GPT models

If you try to run Codex with a Claude model, CodeMie will:
1. Detect the incompatibility
2. **Fetch available models** from your provider's `/v1/models` API endpoint
3. Filter to show only compatible models
4. Offer to switch to a compatible GPT model
5. Optionally save your choice

**Dynamic Model Discovery:**
- Models are fetched in real-time from your configured provider
- No hardcoded lists - always shows what's actually available
- Results are cached for 5 minutes to improve performance
- Works with any OpenAI-compatible API (LiteLLM, OpenAI, etc.)

---

## 📚 Available Commands

### Core Commands

```bash
# Setup wizard (interactive configuration)
codemie setup

# Environment configuration guide
codemie env

# List all available agents
codemie list

# Install an agent
codemie install <agent>

# Uninstall an agent
codemie uninstall <agent>

# Check installation and configuration
codemie doctor

# Manage configuration
codemie config

# Show version
codemie version
```

### Agent Shortcuts (Recommended)

```bash
# Run built-in agent
codemie-code                                    # Interactive mode
codemie-code --task "explore current repository" # Single task

# Run Claude agent
codemie-claude                                  # Interactive mode
codemie-claude --task "Review my code"          # Single task

# Run Codex agent
codemie-codex                                   # Interactive mode
codemie-codex --task "Generate tests"           # Single task
```

### Built-in Agent Commands

```bash
# CodeMie Native - Interactive mode (start a conversation)
codemie-code

# CodeMie Native - Single task execution (run and exit)
codemie-code --task "explore current repository"
codemie-code --task "Fix bugs in src/utils"

# CodeMie Native - With initial message (start with context)
codemie-code "Review my code for bugs"

# CodeMie Native - Health check
codemie-code health

# CodeMie Native - Debug mode (detailed logging)
codemie-code --debug
```

### Direct Agent Shortcuts

Quick access to external agents with configuration overrides:

```bash
# Claude Code (direct shortcut)
codemie-claude                              # Interactive mode
codemie-claude --model claude-4-5-sonnet    # Override model
codemie-claude --api-key your-key           # Override API key
codemie-claude health                       # Health check

# Codex (direct shortcut)
codemie-codex                               # Interactive mode
codemie-codex --model gpt-4o                # Override model (OpenAI only)
codemie-codex --provider openai             # Override provider
codemie-codex health                        # Health check
```

**Features of Direct Shortcuts:**
- Bypass the registry system for faster startup
- Support all original agent options and arguments
- Allow configuration overrides via CLI flags
- Include health check commands
- Pass through unknown options to the underlying agent

### Configuration Commands

```bash
# Set a configuration value
codemie config set <key> <value>

# Get a configuration value
codemie config get <key>

# List all configuration
codemie config list

# Reset configuration
codemie config reset

# Advanced: Change timeout (default: 300 seconds)
codemie config set timeout 600
```

---

## ⚙️ Configuration

CodeMie stores configuration in `~/.codemie/config.json`:

```json
{
  "provider": "litellm",
  "model": "claude-4-5-sonnet",
  "baseUrl": "https://litellm.codemie.example.com",
  "apiKey": "your-api-key",
  "timeout": 300
}
```

### Supported Providers

- **openai** - OpenAI API
- **azure** - Azure OpenAI
- **bedrock** - AWS Bedrock
- **litellm** - LiteLLM Proxy (custom)

### Environment Variables

You can also configure via environment variables (higher priority than config file):

```bash
# OpenAI
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="gpt-4"

# Generic (works with any provider)
export CODEMIE_BASE_URL="https://your-proxy.com"
export CODEMIE_API_KEY="your-api-key"
export CODEMIE_MODEL="your-model"
```

---

## 🤖 Supported Agents

### CodeMie Native (Built-in) ⭐

**NEW:** CodeMie's built-in LangGraph-based coding assistant. No external installation required!

**Usage:**
```bash
# Interactive mode (recommended) - start a conversation
codemie-code

# Single task execution - run and exit
codemie-code --task "explore current repository"
codemie-code --task "Fix the bug in utils.js"

# With initial message - start with context
codemie-code "Help me refactor this component"
```

**Features:**
- 🔧 **Built-in**: No installation required - ready to use immediately
- 🚀 **Modern UI**: Beautiful terminal interface with real-time streaming
- 🎯 **Task-focused**: Execute single tasks or start interactive sessions
- 🔍 **Debug Mode**: Comprehensive logging with `--debug` flag
- 📋 **Clipboard Support**: Automatic image detection from clipboard
- 🛠️ **System Tools**: File operations, git integration, and command execution
- 💬 **Interactive Chat**: Continuous conversations with context memory
- 📊 **Usage Statistics**: Token tracking and cost monitoring

**Direct Commands:**
```bash
# Health check
codemie-code health

# Interactive mode with debug
codemie-code --debug

# Execute task and exit
codemie-code --task "Run tests and fix any failures"
```

### Claude Code

Anthropic's official CLI for Claude AI. Provides advanced code understanding, generation, and refactoring capabilities.

**Installation:**
```bash
codemie install claude
```

**Features:**
- Advanced code understanding
- Multi-file editing
- Interactive conversations
- Project-aware context

### Codex

OpenAI's code generation assistant. Optimized for code completion and generation tasks.

**Installation:**
```bash
codemie install codex
```

**Features:**
- Code completion
- Function generation
- Bug fixing
- Code explanation

**Model Compatibility:**
- ✅ Supports: GPT models (gpt-5, gpt-5-codex, gpt-4.1, gpt-4o)
- ❌ Not supported: Claude/Anthropic models (API incompatibility)

> **Note:** Codex requires OpenAI-compatible models. If you configure a Claude model, CodeMie will automatically prompt you to switch to a compatible GPT model.

---

## 🛠️ Development

### Project Structure

```
codemie-code/
├── bin/
│   └── codemie.js               # CLI entry point
├── src/
│   ├── agents/                  # Agent adapters
│   │   ├── registry.ts          # Agent registry
│   │   └── adapters/            # Agent implementations
│   ├── cli/                     # CLI commands
│   │   ├── index.ts             # CLI setup
│   │   └── commands/            # Command implementations
│   ├── env/                     # Environment management
│   └── utils/                   # Utilities
├── package.json
└── README.md
```

### Building

```bash
npm run build       # Compile TypeScript
npm run dev         # Watch mode for development
npm run lint        # Check code style
npm run lint:fix    # Fix linting issues
```

### Testing

After building, test the CLI locally:

```bash
# Build and link
npm run build && npm link

# Test commands
codemie --help
codemie list
codemie doctor
```

---

## 🐛 Troubleshooting

### Command not found after installation

Re-link the package:
```bash
npm link
which codemie
```

### Configuration not found

Run the setup wizard:
```bash
codemie setup
```

Or check your configuration:
```bash
codemie config list
```

### Agent installation fails

Check your internet connection and try again:
```bash
codemie install <agent>
```

### Connection issues

Verify your configuration:
```bash
codemie doctor
```

---

## 📄 License

Apache-2.0

---

## 🤝 Contributing

Contributions are welcome! Please read our contributing guidelines before submitting PRs.

---

## 🔗 Links

- [GitHub Repository](https://github.com/codemie-ai/codemie-code)
- [Issue Tracker](https://github.com/codemie-ai/codemie-code/issues)
- [NPM Package](https://www.npmjs.com/package/@codemieai/code)
