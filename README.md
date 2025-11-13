# CodeMie

> CLI wrapper for managing multiple AI coding agents

CodeMie is a unified CLI tool for installing, configuring, and running multiple AI coding agents (Claude Code, Codex, etc.) from a single interface.

## ✨ Features

- 🔧 **Unified CLI** - Manage multiple AI coding agents from one interface
- 🤖 **Multi-Agent Support** - Claude Code, Codex, and more
- 🛠️ **Environment Management** - Centralized configuration for all agents
- 🚀 **Zero Hassle** - Install and run agents with simple commands
- 📦 **Provider Agnostic** - Works with any AI provider (OpenAI, Anthropic, Azure, etc.)

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
- AI/Run CodeMie (Unified gateway)
- AWS Bedrock (Claude via AWS)
- Anthropic (Direct API)
- Azure OpenAI (for GPT models and Codex)
- Custom LiteLLM Proxy

#### Method B: Manual Configuration Guide

Best for automated setups or when you have credentials ready:

```bash
# View detailed setup guide with examples
codemie env
```

### Step 3: Use Agents

#### Install an Agent

```bash
# Install Claude Code
codemie install claude

# Install Codex
codemie install codex
```

#### List Available Agents

```bash
codemie list
```

#### Run an Agent

Agents are run directly after installation. Configuration is automatically passed from `~/.codemie/config.json`.

```bash
# Run Claude
codemie run claude

# Run Codex
codemie run codex
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
- Works with any OpenAI-compatible API (AI/Run, LiteLLM, OpenAI, etc.)

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
codemie config [options]

# Show version
codemie version
```

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
  "provider": "anthropic",
  "model": "claude-4-5-sonnet",
  "anthropic": {
    "baseUrl": "https://api.anthropic.com/v1",
    "apiKey": "your-api-key",
    "timeout": 300
  }
}
```

### Supported Providers

- **anthropic** - Anthropic Claude API
- **openai** - OpenAI API
- **azure** - Azure OpenAI
- **bedrock** - AWS Bedrock
- **litellm** - LiteLLM Proxy (custom)

### Environment Variables

You can also configure via environment variables (higher priority than config file):

```bash
# Anthropic
export ANTHROPIC_BASE_URL="https://api.anthropic.com/v1"
export ANTHROPIC_API_KEY="your-api-key"
export ANTHROPIC_MODEL="claude-4-5-sonnet"

# OpenAI
export OPENAI_BASE_URL="https://api.openai.com/v1"
export OPENAI_API_KEY="your-api-key"
export OPENAI_MODEL="gpt-4"

# Generic (works with any provider)
export AI_BASE_URL="https://your-proxy.com"
export AI_API_KEY="your-api-key"
export AI_MODEL="your-model"
```

---

## 🤖 Supported Agents

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
