# Agents

## CodeMie Native (Built-in)

LangGraph-based coding assistant with no installation required.

**Features:**
- Modern terminal UI with streaming responses
- File operations with intelligent filtering
- Command execution with progress tracking
- Planning and todo management tools
- Interactive conversations with context memory
- Task-focused execution mode
- Cross-platform support (Windows, Linux, macOS)

**Available Tools:**
- `read_file` - Read file contents with progress tracking for large files
- `write_file` - Write content to files with automatic directory creation
- `list_directory` - List files and directories with intelligent filtering (auto-filters node_modules, .git, build artifacts, etc.)
- `execute_command` - Execute shell commands with security checks and progress estimation
- `write_todos` - Create or update structured todo lists for planning
- `update_todo_status` - Update status of specific todos (pending, in_progress, completed)
- `append_todo` - Add new todo items to existing lists
- `clear_todos` - Clear all todos from the list
- `show_todos` - Display current todo list with progress information

**Security Features:**
- Path traversal prevention (restricted to working directory)
- Dangerous command blocking (rm -rf, sudo, etc.)
- Configurable directory and pattern filtering
- Secure file access controls

**Usage:**
```bash
codemie-code                    # Interactive mode
codemie-code "task"             # Start with message
codemie --task "task"           # Single task execution
codemie-code health             # Health check
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

## Claude Code ACP

Claude Code adapter for IDE integration via ACP (Agent Communication Protocol).

**Installation:** `codemie install claude-acp`

**What is ACP?**
ACP (Agent Communication Protocol) is a stdio-based JSON-RPC protocol that enables AI agents to communicate with editors and IDEs. It provides a standardized way for editors like Zed, JetBrains, and Emacs to integrate with AI coding assistants.

**Requirements:**
- Node.js 20.0.0 or higher
- Supported providers: LiteLLM, AI/Run SSO, or direct Anthropic API access
- IDE with ACP support (Zed, JetBrains, Emacs, etc.)

**Features:**
- Stdio-based JSON-RPC communication
- Silent mode (no console output interfering with protocol)
- Full CodeMie proxy integration for enterprise SSO
- Profile-based configuration support
- All Claude Code capabilities via ACP protocol

**IDE Configuration:**

After installation, configure your IDE to use `codemie-claude-acp`:

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

**JetBrains** (`~/.jetbrains/acp.json`):
```json
{
  "agent_servers": {
    "Claude Code via CodeMie": {
      "command": "codemie-claude-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**Emacs** (with acp.el):
```elisp
(setq acp-claude-command "codemie-claude-acp")
(setq acp-claude-args '("--profile" "work"))
```

**Usage:**
```bash
# Install the ACP adapter
codemie install claude-acp

# The command is typically invoked by your IDE, not directly
# But you can test it manually:
codemie-claude-acp --profile work
```

**Note:** Unlike `codemie-claude`, the ACP adapter is designed to be invoked by editors, not used interactively in a terminal. All output goes through the JSON-RPC protocol.

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

**Note:** Installed via Python (pip/uv), not npm. Requires Python 3.9+ and Anthropic or OpenAI API key.

## OpenCode

Open-source AI coding assistant with comprehensive session analytics.

**Installation:** `codemie install opencode`

**Requirements:**
- Node.js 20.0.0 or higher
- Supported providers: LiteLLM, AI/Run SSO, or direct API access
- OpenCode CLI installed globally (`opencode-ai` npm package)

**Features:**
- Modern open-source AI assistant
- Multi-provider support via CodeMie proxy
- Automatic session metrics extraction
- Token usage and cost tracking
- Conversation history preservation
- SSO authentication support
- Cross-platform support (Windows, Linux, macOS)

**Session Analytics:**
OpenCode integrates with CodeMie's analytics system to automatically track:
- Token usage (input, output, total)
- Session duration and conversation turns
- Model usage and costs
- Session metadata and context

All metrics are automatically extracted at session end and viewable via:
```bash
codemie analytics --agent opencode
```

**Manual Metrics Processing:**
```bash
# Process specific session
codemie opencode-metrics --session <session-id>

# Discover and process all recent sessions
codemie opencode-metrics --discover

# Detailed processing output
codemie opencode-metrics --discover --verbose
```

**Usage:**
```bash
codemie-opencode                          # Interactive mode
codemie-opencode "your prompt"            # With initial message
codemie-opencode --model gpt-5-2-2025-12-11 "generate tests"  # Specify model
codemie-opencode health                   # Health check
```

**Session Storage:**
OpenCode sessions are stored following XDG Base Directory Specification:
- Linux: `~/.local/share/opencode/storage/`
- macOS: `~/Library/Application Support/opencode/storage/`
- Windows: `%LOCALAPPDATA%\opencode\storage\`

**Configuration:**
CodeMie automatically configures OpenCode to use the selected provider via:
- Environment variable injection (`OPENCODE_CONFIG_CONTENT`)
- Dynamic model configuration in OpenCode's native format
- SSO proxy routing for enterprise authentication

**Example Workflow:**
```bash
# Install OpenCode
codemie install opencode

# Configure provider (if not already done)
codemie setup

# Use OpenCode
codemie-opencode "Review this API implementation"

# View metrics
codemie analytics --agent opencode
```
