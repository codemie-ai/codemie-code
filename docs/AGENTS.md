# Agents

## CodeMie Native (Built-in)

Built-in CodeMie coding assistant with no installation required.

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
- Uses `@agentclientprotocol/claude-agent-acp` — the official ACP adapter for the Claude Agent SDK (the previous `@zed-industries/claude-code-acp` package is deprecated and no longer updated)

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

**JetBrains AIR** (`~/Library/Application Support/JetBrains/Air/acp.json` on macOS):
```json
{
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

**Usage:**
```bash
# Install the ACP adapter
codemie install claude-acp

# The command is typically invoked by your IDE, not directly
# But you can test it manually:
codemie-claude-acp --profile work
```

**Note:** Unlike `codemie-claude`, the ACP adapter is designed to be invoked by editors, not used interactively in a terminal. All output goes through the JSON-RPC protocol.

## Codex ACP

OpenAI Codex adapter for IDE integration via ACP (Agent Communication Protocol).

**Installation:** `codemie install codex-acp`

**What is ACP?**
Same stdio-based JSON-RPC protocol as Claude Code ACP above — this is the Codex equivalent, for editors that want to drive OpenAI Codex directly instead of through the CLI.

**Requirements:**
- Node.js 20.0.0 or higher
- Supported providers: LiteLLM, AI/Run SSO, Ollama, or Bearer Auth
- IDE with ACP support (Zed, JetBrains, Emacs, etc.)

**Features:**
- Stdio-based JSON-RPC communication
- Silent mode (no console output interfering with protocol)
- Full CodeMie proxy integration for enterprise SSO, routed via a `codemie` custom model provider over the Responses API
- Uses `@agentclientprotocol/codex-acp` — the official ACP adapter, which bundles `@openai/codex`. Unlike plain `codemie-codex`, configuration is passed entirely through an injected `CODEX_CONFIG` environment variable rather than `--config` flags, since the adapter ignores stray CLI arguments
- Reasoning-effort tuning (`--reasoning-effort`) is **not** supported in ACP mode

**IDE Configuration:**

After installation, configure your IDE to use `codemie-codex-acp`:

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "agent_servers": {
    "codex": {
      "command": "codemie-codex-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains** (`~/.jetbrains/acp.json`):
```json
{
  "agent_servers": {
    "Codex via CodeMie": {
      "command": "codemie-codex-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains AIR** (`~/Library/Application Support/JetBrains/Air/acp.json` on macOS):
```json
{
  "agent_servers": {
    "Codex via CodeMie": {
      "command": "codemie-codex-acp"
    }
  }
}
```

**Usage:**
```bash
# Install the ACP adapter
codemie install codex-acp

# The command is typically invoked by your IDE, not directly
# But you can test it manually:
codemie-codex-acp --profile work
```

**Note:** Like `codemie-claude-acp`, the ACP adapter is designed to be invoked by editors, not used interactively in a terminal.

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

## Gemini CLI ACP

Gemini CLI adapter for IDE integration via ACP (Agent Communication Protocol).

**Installation:** `codemie install gemini-acp`

**What is ACP?**
Same stdio-based JSON-RPC protocol as Claude Code ACP above. Unlike Claude and Codex, Gemini CLI has **native** ACP support built into the same binary — `gemini --acp` — so no separate npm package is installed; `gemini-acp` reuses the exact `@google/gemini-cli` install as the regular `gemini` agent.

**Requirements:**
- Node.js 20.0.0 or higher
- A valid Google Gemini API key (same requirement as `gemini`)
- IDE with ACP support (Zed, JetBrains, Emacs, etc.)

**Features:**
- Stdio-based JSON-RPC communication
- Silent mode (no console output interfering with protocol)
- Full CodeMie proxy integration
- Same model-injection logic (`-m <model>`) as the regular Gemini CLI agent

**IDE Configuration:**

After installation, configure your IDE to use `codemie-gemini-acp`:

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "agent_servers": {
    "gemini": {
      "command": "codemie-gemini-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains** (`~/.jetbrains/acp.json`):
```json
{
  "agent_servers": {
    "Gemini CLI via CodeMie": {
      "command": "codemie-gemini-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains AIR** (`~/Library/Application Support/JetBrains/Air/acp.json` on macOS):
```json
{
  "agent_servers": {
    "Gemini CLI via CodeMie": {
      "command": "codemie-gemini-acp"
    }
  }
}
```

**Usage:**
```bash
# Install the ACP adapter (shares the gemini CLI install)
codemie install gemini-acp

# The command is typically invoked by your IDE, not directly
# But you can test it manually:
codemie-gemini-acp --profile work
```

**Note:** Like `codemie-claude-acp`, the ACP adapter is designed to be invoked by editors, not used interactively in a terminal.

## GitHub Copilot CLI

GitHub Copilot CLI managed by CodeMie for CodeMie-routed SSO and LiteLLM sessions.

**Installation:** `codemie install copilot`

**Requirements:**
- Node.js 20.0.0 or higher
- An authenticated CodeMie profile (`codemie setup`)
- Supported providers: **AI/Run SSO** or **LiteLLM**

**Managed-mode behavior:**
- Launch with `codemie-copilot`
- Uninstall with `codemie uninstall copilot`
- CodeMie routes the supported Copilot path through its own provider/proxy flow
- The supported managed path does **not** require GitHub login, a GitHub Copilot subscription, or a GitHub personal access token
- Ambient GitHub credentials are intentionally not used for managed Copilot runs

**Features:**
- Managed install/uninstall flow through CodeMie
- CodeMie profile/model routing for GPT-family and Claude-family compatible models
- Conversation sync and attribution under `copilot-cli`
- MCP, skills/custom agents, and hook discovery through Copilot-supported locations

**Usage:**
```bash
codemie install copilot
codemie-copilot                          # Interactive mode
codemie-copilot "explain this file"      # Start with message
codemie-copilot --task "review this diff"
codemie uninstall copilot
```

**Customization locations:**
- User-level Copilot home: `~/.copilot`
- User MCP config: `~/.copilot/mcp-config.json`
- User custom agents: `~/.copilot/agents/`
- User skills: `~/.copilot/skills/`
- Project MCP config: `.mcp.json` or `.github/mcp.json`
- Project agents/skills/hooks: `.github/agents/`, `.github/skills/`, `.github/hooks/`

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

# View metrics
codemie analytics --agent opencode
```

## OpenCode ACP

OpenCode adapter for IDE integration via ACP (Agent Communication Protocol).

**Installation:** `codemie install opencode-acp`

**What is ACP?**
Same stdio-based JSON-RPC protocol as Claude Code ACP above. Unlike Claude and Codex, OpenCode has **native** ACP support built into the same binary — the `opencode acp` subcommand — so no separate npm package is installed; `opencode-acp` reuses the exact `opencode-ai` install as the regular `opencode` agent.

**Requirements:**
- Node.js 20.0.0 or higher
- Supported providers: LiteLLM, AI/Run SSO, Ollama, Bedrock, or Bearer Auth (same as `opencode`)
- IDE with ACP support (Zed, JetBrains, Emacs, etc.)

**Features:**
- Stdio-based JSON-RPC communication
- Silent mode (no console output interfering with protocol)
- Same provider/model config injection (`OPENCODE_CONFIG_CONTENT`) as the regular OpenCode agent

**IDE Configuration:**

After installation, configure your IDE to use `codemie-opencode-acp`:

**Zed** (`~/.config/zed/settings.json`):
```json
{
  "agent_servers": {
    "opencode": {
      "command": "codemie-opencode-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains** (`~/.jetbrains/acp.json`):
```json
{
  "agent_servers": {
    "OpenCode via CodeMie": {
      "command": "codemie-opencode-acp",
      "args": ["--profile", "work"]
    }
  }
}
```

**JetBrains AIR** (`~/Library/Application Support/JetBrains/Air/acp.json` on macOS):
```json
{
  "agent_servers": {
    "OpenCode via CodeMie": {
      "command": "codemie-opencode-acp"
    }
  }
}
```

**Usage:**
```bash
# Install the ACP adapter (shares the opencode CLI install)
codemie install opencode-acp

# The command is typically invoked by your IDE, not directly
# But you can test it manually:
codemie-opencode-acp --profile work
```

**Note:** Like `codemie-claude-acp`, the ACP adapter is designed to be invoked by editors, not used interactively in a terminal.

## OpenWiki

OpenWiki (https://github.com/langchain-ai/openwiki) — an agent that writes and maintains a linked Markdown wiki for the current repository, kept current as the code changes. CodeMie runs it through the active profile, so it works without separate API keys.

**Installation:** `codemie install openwiki`

**Requirements:**
- Node.js 22.0.0 or higher (OpenWiki upstream requirement)
- An authenticated CodeMie profile (`codemie setup`)
- Supported providers: **AI/Run SSO**, **Bearer Auth (JWT)**, **LiteLLM**, **Ollama**, **Moonshot subscription**

**How CodeMie runs it:**
OpenWiki reads its model access from `OPENWIKI_PROVIDER=openai-compatible` plus `OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_API_KEY`/`OPENWIKI_MODEL_ID`. The CodeMie adapter maps the active profile onto those variables: SSO/JWT profiles go through the local CodeMie proxy (authentication and `X-CodeMie-*` attribution headers are injected there), other providers forward their configured base URL and key. The profile model becomes `OPENWIKI_MODEL_ID`.

**Features:**
- Generates a repo wiki under `openwiki/` (architecture, concepts, integrations, operations) with validated Mermaid diagrams
- Grounded Claims: factual pages carry versioned source evidence; `--update` re-verifies them against code changes
- Updates `AGENTS.md`/`CLAUDE.md` with a managed `OPENWIKI:START/END` block pointing agents at the wiki
- Respects `openwiki/INSTRUCTIONS.md` (user-authored brief, preserved across runs) and `.openwikiignore` (read boundary)
- Interactive graph visualizer (`visualize`), including static export for GitHub Pages/MkDocs
- Self-updating via scheduled CI (GitHub Actions, GitLab CI, Bitbucket)

**Usage:**
```bash
codemie-openwiki --init                 # Generate the repo wiki (first run)
codemie-openwiki --update               # Refresh the wiki for changes since the last run
codemie-openwiki visualize              # Explore the wiki as an interactive graph
codemie-openwiki --task "Summarize the plugin system"   # One-shot question via the profile model
codemie-openwiki --profile work --update                # Profile override
```

**Notes:**
- `--task` maps to OpenWiki's one-shot print mode (`-p`).
- OpenWiki prints a heuristic warning when the profile model ID (e.g. `claude-sonnet-5`) is not one of its known OpenAI-compatible presets; the request still works through the CodeMie gateway.
- For scheduled refresh, see the `openwiki-update.yml` workflow template in the upstream repo (`examples/`).
