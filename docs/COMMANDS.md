# Commands

## Core Commands

```bash
codemie --help                   # Show all commands and options
codemie --version                # Show version information
codemie --task "task"            # Execute single task with built-in agent and exit

codemie setup                    # Interactive configuration wizard
codemie profile <command>        # Manage provider profiles
codemie analytics [options]      # View usage analytics
codemie log [options]            # View and manage debug logs and sessions
codemie workflow <command>       # Manage CI/CD workflows
codemie list [options]           # List all available agents
codemie install [agent]          # Install an agent
codemie uninstall [agent]        # Uninstall an agent
codemie update [agent]           # Update installed agents
codemie self-update              # Update CodeMie CLI itself
codemie doctor [options]         # Health check and diagnostics
codemie plugin <command>         # Manage native plugins
codemie mcp-proxy <url>          # Stdio-to-HTTP MCP proxy with OAuth support
codemie version                  # Show version information
```

## Proxy Commands

```bash
codemie proxy start              # Start the local proxy daemon
codemie proxy stop               # Stop the local proxy daemon
codemie proxy status             # Show daemon status
codemie proxy connect desktop    # Configure Claude Desktop (3P) to use the local proxy
codemie proxy inspect desktop    # Inspect Desktop telemetry and sync state
```

`codemie proxy connect desktop` does more than write the gateway config. When the daemon is started through this path, CodeMie also discovers Claude Desktop 3P local session transcripts from the `Claude-3p` storage directory and syncs metrics plus conversations to CodeMie with client identity `claude-desktop`.

### Claude Desktop 3P

#### `codemie proxy connect desktop`

Connect Claude Desktop 3P to the local CodeMie proxy.

```bash
codemie proxy connect desktop
codemie proxy connect desktop --profile codemie-new
```

Behavior:
- uses the current active CodeMie profile by default
- `--profile` overrides for the current run only
- fails if the resolved profile is not a CodeMie SSO profile

Recommended setup:

```bash
codemie profile switch codemie-prod
codemie proxy connect desktop
```

After the config is written, quit and reopen Claude Desktop.

#### `codemie proxy inspect desktop`

Inspect Claude Desktop 3P proxy readiness and recent discovered sessions.

```bash
codemie proxy inspect desktop --limit 5
```

At a high level, this shows:
- whether the daemon is running
- which profile and target URL are active
- whether Claude Desktop storage was found
- recently discovered Desktop sessions
- whether sessions were ingested and whether metrics/conversation JSONL files exist

#### Troubleshooting Claude Desktop 3P

```bash
codemie profile status
codemie proxy connect desktop
codemie proxy status
codemie proxy inspect desktop --limit 5
codemie proxy stop
codemie proxy connect desktop
```

If Claude Desktop still appears connected to Anthropic subscription or another Gateway:
1. Quit Claude Desktop.
2. Sign out or clear the previous provider setup in Claude Desktop.
3. Reconnect with CodeMie.
4. Reopen Claude Desktop.

CodeMie cannot forcibly log you out from Claude Desktop. It can only write the CodeMie proxy configuration and help you inspect the current integration state.

### Global Options

```bash
--task <task>            # Execute a single task using the built-in agent and exit
-s, --silent             # Enable silent mode
--help                   # Display help for command
--version                # Output the version number
```

## Agent Shortcuts

Direct access to agents with automatic configuration.

### Common Options (All Agents)

All agent shortcuts support these options:

```bash
--help                   # Display help for agent
--version                # Show agent version
--profile <name>         # Use specific provider profile
--provider <provider>    # Override provider (ai-run-sso, litellm, ollama)
-m, --model <model>      # Override model
--api-key <key>          # Override API key
--base-url <url>         # Override base URL
--timeout <seconds>      # Override timeout (in seconds)
-s, --silent             # Enable silent mode
--task <prompt>          # Run a single task in headless (non-interactive) mode and exit
--jwt-token <token>      # JWT token for authentication (overrides config and CODEMIE_JWT_TOKEN)
```

### Built-in Agent (codemie-code)

```bash
codemie-code                     # Interactive mode
codemie-code "message"           # Start with initial message
codemie-code health              # Health check
codemie-code --help              # Show help with all options

# With configuration overrides
codemie-code --profile work-litellm "analyze codebase"
codemie-code --model claude-sonnet-4-6 "review code"
codemie-code --provider ollama --model codellama "generate tests"
```

### External Agents

All external agents share the same command pattern:

```bash
# Basic usage
codemie-claude "message"         # Claude Code agent
codemie-claude-acp               # Claude Code ACP (invoked by IDEs)
codemie-gemini "message"         # Gemini CLI agent

# Health checks
codemie-claude health
codemie-gemini health

# Note: codemie-claude-acp doesn't have interactive mode or health check
# It's designed to be invoked by IDEs via ACP protocol

# With configuration overrides
codemie-claude --model claude-sonnet-4-6 --api-key sk-... "review code"
codemie-gemini -m gemini-2.5-flash --api-key key "optimize performance"
# With profile selection
codemie-claude --profile personal-openai "review PR"
codemie-gemini --profile google-direct "analyze code"

# Agent-specific options (pass-through to underlying CLI)
codemie-claude --context large -p "review code"      # -p = print mode (non-interactive)
codemie-gemini -p "your prompt"                      # -p for gemini's non-interactive mode

# Implement planned task without asking any questions (silent mode)
codemie-claude --task "Implement task 1" --silent --dangerously-skip-permissions --output-format stream-json --verbose
```

**Note**: Configuration options (`--profile`, `--model`, etc.) are handled by CodeMie CLI wrapper. All other options are passed directly to the underlying agent binary.

## Headless Mode (`--task`)

The `--task` flag runs a single prompt non-interactively: the agent executes the task, prints the result, and exits. No user interaction is required. This is the primary way to use CodeMie agents in CI/CD pipelines and automated scripts.

### How It Works

Each agent maps `--task` to its own non-interactive mechanism:

| Agent | Underlying flag/command | Behaviour |
|-------|------------------------|-----------|
| `codemie-claude` | `-p <prompt>` (print mode) | Runs prompt, prints output, exits |
| `codemie-gemini` | `-p <prompt>` | Runs prompt, prints output, exits |
| `codemie-opencode` | `opencode run <prompt>` | Runs task via `run` subcommand, exits |

### Basic Usage

```bash
# Claude
codemie-claude --task "Summarize the recent changes in this repo"

# Gemini
codemie-gemini --task "Explain the architecture of this project"

# OpenCode
codemie-opencode --task "Review the code in src/ for security issues"
```

### With Profile or Model Override

```bash
codemie-claude --profile work --task "Fix the failing tests"
codemie-gemini --model gemini-2.5-flash --task "Generate a changelog for this release"
```

### Capturing Output

```bash
# Redirect stdout to a file
codemie-claude --task "Review this PR" > review.txt

# Capture both stdout and stderr
codemie-claude --task "Analyze codebase" > output.txt 2>&1
```

### Non-Interactive Flags (Claude-specific)

When running headless Claude tasks, combine `--task` with these pass-through flags for full automation:

```bash
codemie-claude \
  --task "Implement the changes described in SPEC.md" \
  --silent \
  --dangerously-skip-permissions \
  --output-format stream-json \
  --verbose
```

### Headless Mode with JWT Authentication

For CI/CD environments where SSO login is not possible, combine `--task` with `--jwt-token`:

```bash
# Single command — no prior setup required
codemie-claude \
  --jwt-token "$CI_JWT_TOKEN" \
  --task "Review the changes in this commit and list any issues"

# With base URL for environments not yet configured
codemie-claude \
  --jwt-token "$CI_JWT_TOKEN" \
  --base-url "https://codemie.lab.epam.com" \
  --task "Run a security review of the staged files"
```

See [JWT Bearer Authorization](./AUTHENTICATION.md#jwt-bearer-authorization) for full token setup options.

### CI/CD Examples

**GitHub Actions:**
```yaml
- name: AI Code Review
  run: |
    codemie-claude \
      --jwt-token "${{ secrets.CODEMIE_JWT_TOKEN }}" \
      --task "Review the changes in this PR and report any issues" \
      --silent
```

**GitLab CI:**
```yaml
ai-review:
  script:
    - codemie-claude
        --jwt-token "$CODEMIE_JWT_TOKEN"
        --task "Review changes in this commit"
        --silent
```

**Shell script:**
```bash
#!/bin/bash
RESULT=$(codemie-claude --jwt-token "$TOKEN" --task "Analyze src/ for bugs" 2>&1)
echo "$RESULT" > /tmp/ai-review.txt
```

## Profile Management Commands

Manage multiple provider configurations (work, personal, team, etc.) with separate profiles.

```bash
codemie profile                      # List all profiles with detailed information (default action)
codemie profile status               # Show active profile and authentication status
codemie profile switch <name>        # Switch to a different profile
codemie profile delete <name>        # Delete a profile
codemie profile rename <old> <new>   # Rename a profile
codemie profile login [--url <url>]  # Authenticate with AI/Run CodeMie SSO
codemie profile logout               # Clear SSO credentials
codemie profile refresh              # Refresh SSO credentials
```

**Note:** To create or update profiles, use `codemie setup` which provides an interactive wizard.

**Profile List Details:**
The `codemie profile` command displays comprehensive information for each profile:
- Profile name and active status
- Provider (ai-run-sso, openai, azure, bedrock, litellm, gemini)
- Base URL
- Model
- Timeout settings
- Debug mode status
- Masked API keys (for security)
- Additional provider-specific settings

**SSO Authentication:**
For profiles using AI/Run CodeMie SSO provider:
- `login` - Opens browser for SSO authentication, stores credentials securely
- `logout` - Clears stored SSO credentials
- `status` - Shows active profile with auth status, prompts for re-auth if invalid
- `refresh` - Re-authenticates with existing SSO configuration

## Analytics Commands

Track and analyze your AI agent usage across all agents.

```bash
# View analytics summary
codemie analytics                # Show all analytics with aggregated metrics

# Filter by criteria
codemie analytics --project codemie-code        # Filter by project
codemie analytics --agent claude                # Filter by agent
codemie analytics --branch main                 # Filter by branch
codemie analytics --from 2025-12-01             # Date range filter
codemie analytics --last 7d                     # Last 7 days

# Output options
codemie analytics --verbose                     # Detailed session breakdown
codemie analytics --export json                 # Export to JSON
codemie analytics --export csv -o report.csv    # Export to CSV

# View specific session
codemie analytics --session abc-123-def         # Single session details
```

**Analytics Features:**
- Hierarchical aggregation: Root → Projects → Branches → Sessions
- Session metrics: Duration, turns, tokens, costs
- Model distribution across all sessions
- Tool usage breakdown with success/failure rates
- Language/format statistics (lines added, files created/modified)
- Cache hit rates and token efficiency metrics
- Export to JSON/CSV for external analysis
- Privacy-first (local storage at `~/.codemie/metrics/`)

**Example Workflows:**

```bash
# Weekly summary
codemie analytics --last 7d

# Project-specific with details
codemie analytics --project my-project --verbose

# Cost tracking
codemie analytics --from 2025-12-01 --to 2025-12-07 --export csv -o weekly-costs.csv

# Agent comparison
codemie analytics --agent claude
codemie analytics --agent gemini
```

## Log Management Commands

View, filter, and manage debug logs and agent sessions.

```bash
# View recent logs
codemie log                             # Show last 50 lines
codemie log -n 100                      # Show last 100 lines
codemie log -v                          # Verbose mode with session IDs

# Filter logs
codemie log --session abc-123           # Filter by session ID
codemie log --agent claude              # Filter by agent
codemie log --level error               # Show only errors
codemie log --profile work              # Filter by profile

# Date filtering
codemie log --from 2026-02-01           # From specific date
codemie log --to 2026-02-04             # Until specific date
codemie log --last 7d                   # Last 7 days
codemie log --last 24h                  # Last 24 hours
codemie log --last 30m                  # Last 30 minutes

# Pattern search
codemie log --grep "error"              # Search for pattern
codemie log --grep "sync" --last 1d     # Search in recent logs

# Session management
codemie log session <id>                # View specific session details
codemie log session <id> -v             # Include conversation history
codemie log list-sessions               # List all sessions
codemie log list-sessions --agent claude --last 7d

# Real-time monitoring
codemie log follow                      # Follow logs in real-time (tail -f)
codemie log follow --level error        # Follow only errors
codemie log follow --agent claude       # Follow specific agent

# Cleanup
codemie log clean --dry-run             # Preview cleanup
codemie log clean --days 10             # Keep last 10 days
codemie log clean --days 30 --sessions  # Also clean sessions
codemie log clean --yes                 # Skip confirmation

# Export logs
codemie log --format json -o logs.json          # Export to JSON
codemie log --format jsonl -o logs.jsonl        # Export to JSONL
codemie log --last 7d --format json -o week.json
```

**Log Features:**
- Real-time log viewing with colorized output
- Multiple filtering options (session, agent, level, date, pattern)
- Session inspection with conversation history
- Live log following (tail -f style)
- Cleanup old logs and sessions
- Export to JSON/JSONL for analysis
- Graceful handling of missing/corrupted files
- Local storage at `~/.codemie/logs/` and `~/.codemie/sessions/`

**Log Levels:**
- `debug` - Detailed debugging information
- `info` - General informational messages
- `warn` - Warning messages
- `error` - Error messages

**Example Workflows:**

```bash
# Troubleshoot recent errors
codemie log --level error --last 1h

# Investigate specific session
codemie log --session abc-123-def -v

# Monitor agent activity
codemie log follow --agent claude --level info

# Weekly log analysis
codemie log --last 7d --format json -o weekly-logs.json

# Clean old logs (keep last 10 days)
codemie log clean --days 10 --dry-run
codemie log clean --days 10 --yes

# Search for specific issues
codemie log --grep "timeout" --last 24h
```

## OpenCode Metrics Commands

Process OpenCode session data to extract metrics and sync to analytics system.

```bash
# Process specific session
codemie opencode-metrics --session <session-id>

# Discover and process all recent sessions
codemie opencode-metrics --discover

# Verbose output with detailed processing info
codemie opencode-metrics --discover --verbose
```

**Options:**
- `-s, --session <id>` - Process specific OpenCode session by ID
- `-d, --discover` - Discover and process all unprocessed sessions (last 30 days)
- `-v, --verbose` - Show detailed processing output

**Features:**
- Automatic session discovery from OpenCode storage
- Token usage extraction (input, output, total)
- Cost calculation based on model pricing
- Session duration tracking
- Conversation extraction
- JSONL delta generation for sync
- Deduplication (skips recently processed sessions)

**Session Storage Locations:**
- Linux: `~/.local/share/opencode/storage/`
- macOS: `~/Library/Application Support/opencode/storage/`
- Windows: `%LOCALAPPDATA%\opencode\storage\`

**Example Workflows:**

```bash
# Process all recent OpenCode sessions
codemie opencode-metrics --discover --verbose

# Check specific session metrics
codemie opencode-metrics --session ses_abc123def456

# View results in analytics
codemie analytics --agent opencode
```

**Note:** Metrics are automatically extracted when OpenCode sessions end (via `onSessionEnd` lifecycle hook). Manual processing is useful for:
- Retroactive processing of old sessions
- Troubleshooting sync issues
- Verifying metrics extraction

## Workflow Commands

Install CI/CD workflows for automated code review and generation.

```bash
# List available workflows
codemie workflow list                    # All workflows
codemie workflow list --installed        # Only installed

# Install workflows
codemie workflow install pr-review       # PR review workflow
codemie workflow install inline-fix      # Quick fixes from comments
codemie workflow install code-ci         # Full feature implementation
codemie workflow install --interactive   # Interactive installation

# Uninstall workflows
codemie workflow uninstall pr-review     # Remove workflow
```

**Available Workflows:**
- **pr-review** - Automated code review on pull requests
- **inline-fix** - Quick code fixes from PR comments
- **code-ci** - Full feature implementation from issues

**Supported Platforms:**
- GitHub Actions (auto-detected from `.git/config`)
- GitLab CI (auto-detected from `.git/config`)

## Plugin Commands

Manage native plugins (Anthropic format) for extending CodeMie Code with reusable packages of skills, commands, agents, hooks, and MCP servers.

```bash
# List all discovered plugins
codemie plugin list [--cwd <path>]

# Install a plugin from a local path
codemie plugin install <path>

# Remove a plugin from the cache
codemie plugin uninstall <name>

# Enable a disabled plugin
codemie plugin enable <name>

# Disable a plugin without removing it
codemie plugin disable <name>
```

**Plugin Sources (priority order):**
- CLI flag `--plugin-dir` (highest)
- Project `.codemie/plugins/`
- User cache `~/.codemie/plugins/cache/`
- Config `plugins.dirs` (lowest)

For full documentation, see [Plugin System](./PLUGINS.md).

## MCP Proxy Command

Run a stdio-to-HTTP bridge that connects MCP clients (like Claude Code) to remote MCP servers, handling OAuth 2.0 authorization automatically.

```bash
codemie mcp-proxy <url>
```

**Arguments:**
- `<url>` — Remote MCP server URL (must be a valid HTTP/HTTPS URL)

**Features:**
- Stdio-to-HTTP bridge (JSON-RPC over stdio ↔ streamable HTTP transport)
- Automatic OAuth 2.0 with Dynamic Client Registration
- Per-origin cookie jar for session persistence
- Browser-based authorization with ephemeral localhost callback server
- Graceful shutdown on SIGINT/SIGTERM

### Registering with Claude Code

Use `claude mcp add` to register the proxy as an MCP server:

```bash
# Using the global binary (requires global install)
claude mcp add my-server -- codemie-mcp-proxy "https://mcp-server.example.com/sse"

# Using node directly (works without global install)
claude mcp add my-server -- node /path/to/bin/codemie-mcp-proxy.js "https://mcp-server.example.com/sse"
```

Or configure `.mcp.json` directly:

```json
{
  "mcpServers": {
    "my-server": {
      "type": "stdio",
      "command": "codemie-mcp-proxy",
      "args": ["https://mcp-server.example.com/sse"],
      "env": {
        "MCP_CLIENT_NAME": "Claude Code (my-server)"
      }
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_CLIENT_NAME` | `CodeMie CLI` | Client name used in OAuth Dynamic Client Registration |
| `MCP_PROXY_DEBUG` | (unset) | Set to `true` to enable verbose proxy logging |
| `CODEMIE_DEBUG` | (unset) | Set to `true` to enable general debug logging |

### OAuth Flow

When the remote MCP server returns `401 Unauthorized`:

1. Discover resource metadata and authorization server metadata
2. Register a client dynamically (`client_name` from `MCP_CLIENT_NAME`)
3. Open the user's browser for authorization
4. Receive the authorization code via ephemeral localhost callback server
5. Exchange the code for tokens
6. Retry the original request with the Bearer token

All state is in-memory only — re-authorization is required each session.

### Logs

Proxy logs are written to `~/.codemie/logs/mcp-proxy.log`. Enable verbose logging with `MCP_PROXY_DEBUG=true`.

### Troubleshooting

| Issue | Cause | Solution |
|-------|-------|----------|
| `Invalid MCP server URL` | URL argument is malformed | Verify the URL is a valid HTTP/HTTPS URL |
| Browser doesn't open | System `open`/`xdg-open` not available | Open the URL printed in logs manually |
| OAuth timeout | User didn't complete browser auth in 2 minutes | Re-run the command and complete auth faster |
| `ECONNREFUSED` | Remote MCP server is unreachable | Check the URL and network connectivity |
| No tools appearing | OAuth flow not completed | Check `~/.codemie/logs/mcp-proxy.log` for errors |

### Architecture

For implementation details including the SSO proxy plugin, URL rewriting, and SSRF protection, see [Proxy Architecture](./ARCHITECTURE-PROXY.md#65-mcp-auth-plugin).

## Detailed Command Reference

### `codemie setup`

Interactive configuration wizard for setting up AI providers.

**Usage:**
```bash
codemie setup [options]
```

**Features:**
- Multi-provider support (AI-Run SSO, OpenAI, Azure, Bedrock, LiteLLM, Ollama)
- Real-time model fetching and validation
- Health endpoint testing during setup
- Profile management (add new or update existing)
- Credential validation before saving

### `codemie list`

List all available AI coding agents.

**Usage:**
```bash
codemie list [options]
```

**Options:**
- `-i, --installed` - Show only installed agents

**Output:**
- Agent name and display name
- Installation status
- Version (if installed)
- Description

### `codemie install [agent]`

Install an external AI coding agent.

**Usage:**
```bash
codemie install <agent>
```

**Supported Agents:**
- `claude` - Claude Code (npm-based)
- `claude-acp` - Claude Code ACP adapter for IDE integration (npm-based)
- `gemini` - Gemini CLI (npm-based)
- `opencode` - OpenCode AI assistant (npm-based)

### `codemie uninstall [agent]`

Uninstall an external AI coding agent.

**Usage:**
```bash
codemie uninstall <agent>
```

### `codemie update [agent]`

Update installed AI coding agents to their latest versions.

**Usage:**
```bash
# Update specific agent
codemie update <agent>

# Check for updates without installing
codemie update <agent> --check

# Interactive update (checks all agents)
codemie update

# Check all agents for updates
codemie update --check
```

**Options:**
- `-c, --check` - Check for updates without installing

**Features:**
- Checks npm registry for latest versions
- Supports interactive multi-agent selection
- Shows current vs. latest version comparison
- Special handling for Claude Code (uses verified versions)
- Uses `--force` flag to handle directory conflicts during updates

**Examples:**
```bash
# Update Claude Code to latest verified version
codemie update claude

# Check if Gemini has updates
codemie update gemini --check

# Interactive: select which agents to update
codemie update
```

**Note:** This command updates external agents (Claude Code, Gemini, etc.). To update the CodeMie CLI itself, use `codemie self-update`.

### `codemie self-update`

Update CodeMie CLI to the latest version from npm.

**Usage:**
```bash
# Update CodeMie CLI
codemie self-update

# Check for updates without installing
codemie self-update --check
```

**Options:**
- `-c, --check` - Check for updates without installing

**Features:**
- Fast version check with 5-second timeout
- Automatic update on startup (configurable via `CODEMIE_AUTO_UPDATE`)
- Uses `--force` flag to handle directory conflicts
- Shows current vs. latest version comparison

**Auto-Update Behavior:**

By default, CodeMie CLI automatically checks for updates on startup with smart rate limiting:

```bash
# Default: Silent auto-update (no user interaction)
codemie --version
# First run: Checks for updates (5s max)
# Subsequent runs within 24h: Instant (skips check)

# Prompt before updating
export CODEMIE_AUTO_UPDATE=false
codemie --version

# Explicit silent auto-update
export CODEMIE_AUTO_UPDATE=true
codemie --version
```

**Performance & Rate Limiting:**
- Update checks are rate-limited to once per 24 hours by default
- First invocation may take up to 5 seconds (network check)
- Subsequent invocations within the interval are instant (no network call)
- Prevents blocking on every CLI startup
- Cache stored in `~/.codemie/.last-update-check`

**Environment Variables:**
- `CODEMIE_AUTO_UPDATE=true` (default) - Silently auto-update in background
- `CODEMIE_AUTO_UPDATE=false` - Show update prompt and ask for confirmation
- `CODEMIE_UPDATE_CHECK_INTERVAL` - Time between checks in ms (default: 86400000 = 24h)

**Examples:**
```bash
# Check for CLI updates
codemie self-update --check

# Update CLI immediately
codemie self-update

# Disable auto-update (add to ~/.bashrc or ~/.zshrc)
export CODEMIE_AUTO_UPDATE=false
```

**Note:** Auto-update checks are non-blocking and won't prevent CLI from starting if they fail. The update takes effect on the next command execution.

### `codemie doctor`

Check system health and configuration.

**Usage:**
```bash
codemie doctor [options]
```

**Options:**
- `-v, --verbose` - Enable verbose debug output with detailed API logs

**Checks:**
- Node.js version (requires >=20.0.0)
- Python version (if using Python-based agents)
- Git installation and configuration
- AWS CLI (if using Bedrock)
- Installed agents and their versions
- Provider connectivity and health endpoints
- Configuration file validity

### `codemie profile`

Manage multiple provider configurations and SSO authentication.

**Usage:**
```bash
codemie profile                         # List all profiles with details (default action)
codemie profile status                  # Show active profile and authentication status
codemie profile switch [profile]        # Switch active profile
codemie profile delete [profile]        # Delete a profile
codemie profile rename <old> <new>      # Rename a profile
codemie profile login [--url <url>]     # Authenticate with AI/Run CodeMie SSO
codemie profile logout                  # Clear SSO credentials and logout
codemie profile refresh                 # Refresh SSO credentials
```

**Profile Management:**
- Active profile indicator (●)
- Profile name
- Provider type
- Model configuration
- Base URL
- Masked API key (for security)
- Timeout and other settings

**SSO Authentication:**
- `login` - Opens browser for SSO authentication, stores credentials securely
- `logout` - Clears stored SSO credentials
- `status` - Shows active profile with auth status, prompts for re-auth if invalid
- `refresh` - Re-authenticates with existing SSO configuration

### `codemie workflow`

Manage CI/CD workflow templates for GitHub Actions and GitLab CI.

**Subcommands:**
```bash
codemie workflow list [options]                     # List available workflow templates
codemie workflow install [options] <workflow-id>    # Install a workflow template
codemie workflow uninstall [options] <workflow-id>  # Uninstall a workflow
```

**List Options:**
- `--installed` - Show only installed workflows

**Install Options:**
- `-i, --interactive` - Interactive mode with helpful prompts
- `--timeout <minutes>` - Workflow timeout (default: 15)
- `--max-turns <number>` - Maximum AI conversation turns (default: 50)
- `--environment <env>` - GitHub environment for protection rules

**Available Workflows:**
- `pr-review` - Automated code review on pull requests
- `inline-fix` - Quick fixes from PR comments mentioning @codemie
- `code-ci` - Full feature implementation from issues

### `codemie analytics`

Display aggregated metrics and analytics from agent usage sessions.

**Usage:**
```bash
codemie analytics [options]
```

**Filter Options:**
- `--session <id>` - Filter by session ID
- `--project <pattern>` - Filter by project path (basename, partial, or full path)
- `--agent <name>` - Filter by agent name (claude, gemini, etc.)
- `--branch <name>` - Filter by git branch
- `--from <date>` - Filter sessions from date (YYYY-MM-DD)
- `--to <date>` - Filter sessions to date (YYYY-MM-DD)
- `--last <duration>` - Filter sessions from last duration (e.g., 7d, 24h)

**Output Options:**
- `-v, --verbose` - Show detailed session-level breakdown
- `--export <format>` - Export to file (json or csv)
- `-o, --output <path>` - Output file path (default: ./codemie-analytics-YYYY-MM-DD.{format})

**Metrics Displayed:**
- Session count and duration
- Token usage (input/output/total)
- Cost estimates
- Model distribution
- Tool usage statistics
- Cache hit rates
- Language/format statistics

For detailed usage examples and filtering options, see the [Analytics Commands](#analytics-commands) section above.

### `codemie log`

View, filter, and manage debug logs and agent sessions.

**Usage:**
```bash
codemie log [options]              # View recent debug logs
codemie log <subcommand> [options] # Execute subcommand
```

**Main Command Options:**
- `--session <id>` - Filter by session ID
- `--agent <name>` - Filter by agent (claude, gemini, etc.)
- `--profile <name>` - Filter by profile name
- `--level <level>` - Filter by log level (debug, info, warn, error)
- `--from <date>` - Filter from date (YYYY-MM-DD)
- `--to <date>` - Filter to date (YYYY-MM-DD)
- `--last <duration>` - Filter last duration (e.g., 7d, 24h, 30m)
- `--grep <pattern>` - Search pattern (supports regex)
- `-n, --lines <number>` - Number of lines to show (default: 50)
- `-v, --verbose` - Show full details including session IDs and profiles
- `--format <format>` - Output format (text, json, jsonl)
- `--no-color` - Disable color output
- `-o, --output <path>` - Write to file instead of stdout

**Subcommands:**

**1. `codemie log debug [options]`**

View debug logs (alias for default behavior).

```bash
codemie log debug                  # Same as 'codemie log'
codemie log debug --level error    # Show only errors
codemie log debug --agent claude   # Claude logs only
```

**2. `codemie log session <id> [options]`**

View specific session details.

```bash
codemie log session abc-123-def-456        # Basic session info
codemie log session abc-123-def-456 -v     # Include conversation
codemie log session abc-123 --format json  # JSON output
```

Options:
- `-v, --verbose` - Show conversation details
- `--format <format>` - Output format (text, json)
- `--no-color` - Disable color output

**3. `codemie log list-sessions [options]`**

List all sessions with filtering and sorting.

```bash
codemie log list-sessions                  # All sessions
codemie log list-sessions --agent claude   # Claude sessions only
codemie log list-sessions --last 7d        # Last week
codemie log list-sessions --sort duration  # Sort by duration
```

Options:
- `--agent <name>` - Filter by agent
- `--from <date>` - Filter from date
- `--to <date>` - Filter to date
- `--last <duration>` - Filter last duration
- `--sort <field>` - Sort by field (time, duration, agent)
- `--reverse` - Reverse sort order
- `--format <format>` - Output format (text, json)
- `--no-color` - Disable color output

**4. `codemie log follow [options]`**

Follow logs in real-time (tail -f style).

```bash
codemie log follow                    # Follow all logs
codemie log follow --level error      # Follow errors only
codemie log follow --agent claude     # Follow Claude agent
codemie log follow --grep "timeout"   # Follow matching pattern
```

Options:
- `--agent <name>` - Filter by agent
- `--level <level>` - Filter by log level
- `--grep <pattern>` - Search pattern
- `-v, --verbose` - Show full details
- `--no-color` - Disable color output

Press Ctrl+C to stop following.

**5. `codemie log clean [options]`**

Clean up old logs and sessions.

```bash
codemie log clean --dry-run              # Preview what would be deleted
codemie log clean --days 10              # Keep last 10 days
codemie log clean --days 30 --sessions   # Also delete sessions
codemie log clean --yes                  # Skip confirmation
```

Options:
- `--days <number>` - Retention period in days (default: 5)
- `--sessions` - Also delete old sessions (not just debug logs)
- `--dry-run` - Preview without deleting
- `--yes` - Skip confirmation prompt

**Log Storage:**
- Debug logs: `~/.codemie/logs/debug-YYYY-MM-DD.log`
- Session data: `~/.codemie/sessions/`
- Automatic daily rotation
- Default retention: 5 days for logs, unlimited for sessions

**Log Format:**

Each log entry contains:
- Timestamp (ISO 8601)
- Level (DEBUG, INFO, WARN, ERROR)
- Agent name
- Session ID
- Profile (optional)
- Message

Example:
```
[2026-02-04T10:30:45.123Z] [INFO] [claude] [abc-123] [work] Session started
```

**Examples:**

```bash
# Quick troubleshooting
codemie log --level error --last 1h

# Detailed session investigation
codemie log session abc-123-def-456 -v

# Monitor specific agent
codemie log follow --agent claude --level info

# Export recent logs for analysis
codemie log --last 7d --format json -o weekly.json

# Clean old data (preview first)
codemie log clean --days 10 --dry-run
codemie log clean --days 10 --yes

# Search for specific issues
codemie log --grep "connection refused" --last 24h

# Verbose output with all context
codemie log -v -n 100 --last 1d

# List recent sessions sorted by duration
codemie log list-sessions --last 7d --sort duration --reverse
```

**Tips:**
- Use `--dry-run` before cleaning to preview deletions
- Combine filters for precise searches (`--agent --level --last`)
- Export to JSON for programmatic analysis or bug reports
- Use `follow` mode for real-time monitoring during development
- Session data is never auto-deleted (only via explicit `clean --sessions`)

### `codemie version`

Show version information for CodeMie CLI.

**Usage:**
```bash
codemie version
```

**Output:**
- CLI version
- Node.js version
- Package name and description
