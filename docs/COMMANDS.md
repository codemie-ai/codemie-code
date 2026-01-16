# Commands

## Core Commands

```bash
codemie --help                   # Show all commands and options
codemie --version                # Show version information
codemie --task "task"            # Execute single task with built-in agent and exit

codemie setup                    # Interactive configuration wizard
codemie profile <command>        # Manage provider profiles
codemie analytics [options]      # View usage analytics
codemie workflow <command>       # Manage CI/CD workflows
codemie list [options]           # List all available agents
codemie install [agent]          # Install an agent
codemie uninstall [agent]        # Uninstall an agent
codemie doctor [options]         # Health check and diagnostics
codemie version                  # Show version information
```

### Global Options

```bash
--task <task>            # Execute a single task using the built-in agent and exit
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
```

### Built-in Agent (codemie-code)

```bash
codemie-code                     # Interactive mode
codemie-code "message"           # Start with initial message
codemie-code health              # Health check
codemie-code --help              # Show help with all options

# With configuration overrides
codemie-code --profile work-litellm "analyze codebase"
codemie-code --model claude-4-5-sonnet "review code"
codemie-code --provider ollama --model codellama "generate tests"
```

### External Agents

All external agents share the same command pattern:

```bash
# Basic usage
codemie-claude "message"         # Claude Code agent
codemie-codex "message"          # Codex agent
codemie-gemini "message"         # Gemini CLI agent
codemie-deepagents "message"     # Deep Agents CLI agent

# Health checks
codemie-claude health
codemie-codex health
codemie-gemini health
codemie-deepagents health

# With configuration overrides
codemie-claude --model claude-4-5-sonnet --api-key sk-... "review code"
codemie-codex --model gpt-4.1 --base-url https://api.openai.com/v1 "generate tests"
codemie-gemini -m gemini-2.5-flash --api-key key "optimize performance"

# With profile selection
codemie-claude --profile personal-openai "review PR"
codemie-codex --profile work-litellm "document code"
codemie-gemini --profile google-direct "analyze code"

# Agent-specific options (pass-through to underlying CLI)
codemie-claude --context large -p "review code"      # -p = print mode (non-interactive)
codemie-codex --temperature 0.1 "generate tests"
codemie-gemini -p "your prompt"                      # -p for gemini's non-interactive mode
```

**Note**: Configuration options (`--profile`, `--model`, etc.) are handled by CodeMie CLI wrapper. All other options are passed directly to the underlying agent binary.

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
- `codex` - OpenAI Codex (npm-based)
- `gemini` - Gemini CLI (npm-based)
- `deepagents` - Deep Agents (Python/pip-based)

### `codemie uninstall [agent]`

Uninstall an external AI coding agent.

**Usage:**
```bash
codemie uninstall <agent>
```

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
- `--agent <name>` - Filter by agent name (claude, gemini, codex, etc.)
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
