# Agents

## CodeMie Native (Built-in)

LangGraph-based coding assistant with no installation required.

**Features:**
- Modern terminal UI with streaming responses
- File operations, git integration, command execution
- Clipboard support with automatic image detection
- Interactive conversations with context memory
- Task-focused execution mode

**Usage:**
```bash
codemie-code                    # Interactive mode
codemie-code "task"             # Start with message
codemie --task "task"           # Single task execution
```

## Claude Code

Anthropic's official CLI with advanced code understanding.

**Installation:** `codemie install claude`

**Features:**
- Advanced code understanding and generation
- Multi-file editing capabilities
- Project-aware context
- Interactive conversations
- Non-interactive mode with `-p` flag

**Usage:**
```bash
codemie-claude                   # Interactive mode
codemie-claude "message"         # Start with message
codemie-claude -p "message"      # Non-interactive/print mode
codemie-claude health            # Health check
```

## Codex

OpenAI's code generation assistant optimized for completion tasks.

**Installation:** `codemie install codex`

**Features:**
- Code completion and generation
- Function generation and bug fixing
- Code explanation and documentation
- Non-interactive mode with `-p` flag
- **Requires OpenAI-compatible models only**

**Usage:**
```bash
codemie-codex                    # Interactive mode
codemie-codex "message"          # Start with message
codemie-codex -p "message"       # Non-interactive mode
codemie-codex health             # Health check
```

## Gemini CLI

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
codemie-gemini "your prompt"            # With initial message
codemie-gemini -p "your prompt"         # Non-interactive mode (Gemini-specific)
codemie-gemini -m gemini-2.5-flash      # Specify model (Gemini-specific)
codemie-gemini --model gemini-2.5-flash "analyze code"  # With config override
```

## Deep Agents CLI

LangChain's terminal interface for building agents with persistent memory. Built on LangGraph with planning capabilities, file system tools, and subagent delegation.

**Installation:** `codemie install deepagents`

**Links:**
- [Documentation](https://docs.langchain.com/oss/javascript/deepagents/cli)
- [Overview](https://docs.langchain.com/oss/javascript/deepagents/overview)
- [Middleware](https://docs.langchain.com/oss/javascript/deepagents/middleware)
- [Subagents](https://docs.langchain.com/oss/javascript/deepagents/subagents)
- [Customization](https://docs.langchain.com/oss/javascript/deepagents/customization)

**Usage:**
```bash
codemie-deepagents                   # Interactive mode
codemie-deepagents "your task"       # Start with message
codemie-deepagents health            # Health check
```

**Note:** Installed via Python (pip/uv), not npm. Requires Python 3.9+ and Anthropic or OpenAI API key.
