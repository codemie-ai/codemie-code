# Commands

## Core Commands

```bash
codemie setup                    # Interactive configuration wizard
codemie profile <command>        # Manage provider profiles
codemie auth <command>           # Manage SSO authentication
codemie analytics <command>      # View usage analytics
codemie workflow <command>       # Manage CI/CD workflows
codemie list                     # List all available agents
codemie install <agent>          # Install an agent
codemie uninstall <agent>        # Uninstall an agent
codemie doctor                   # Health check and diagnostics
codemie version                  # Show version information
```

## Agent Shortcuts

Direct access to agents with automatic configuration:

```bash
# Built-in agent
codemie-code                     # Interactive mode
codemie-code "message"           # Start with initial message
codemie-code health              # Health check

# External agents (direct invocation)
codemie-claude "message"         # Claude Code agent (interactive)
codemie-claude -p "message"      # Claude Code agent (non-interactive/print mode)
codemie-codex "message"          # Codex agent (interactive)
codemie-codex -p "message"       # Codex agent (non-interactive mode)
codemie-gemini "message"         # Gemini CLI agent
codemie-deepagents "message"     # Deep Agents CLI agent

# With agent-specific options (pass-through to underlying CLI)
codemie-claude --context large -p "review code"
codemie-codex --temperature 0.1 -p "generate tests"
codemie-gemini -p "your prompt"  # Gemini's non-interactive mode

# Configuration overrides (model, API key, base URL, timeout)
codemie-claude --model claude-4-5-sonnet --api-key your-key "review code"
codemie-codex --model gpt-4.1 --base-url https://api.openai.com/v1 "generate tests"
codemie-gemini -m gemini-2.5-flash "optimize performance"

# Profile selection (profiles contain provider + all settings)
codemie-code --profile work-litellm "analyze codebase"
codemie-claude --profile personal-openai "review PR"
codemie-gemini --profile lite --model gemini-2.5-flash "document code"
```

## Profile Management Commands

Manage multiple provider configurations (work, personal, team, etc.) with separate profiles.

```bash
codemie profile list             # List all profiles with detailed information
codemie profile switch <name>    # Switch to a different profile
codemie profile delete <name>    # Delete a profile
codemie profile rename <old> <new> # Rename a profile
```

**Note:** To create or update profiles, use `codemie setup` which provides an interactive wizard.

**Profile List Details:**
The `codemie profile list` command displays comprehensive information for each profile:
- Profile name and active status
- Provider (ai-run-sso, openai, azure, bedrock, litellm, gemini)
- Base URL
- Model
- Timeout settings
- Debug mode status
- Masked API keys (for security)
- Additional provider-specific settings

## Analytics Commands

Track and analyze your AI agent usage across all agents.

> **📊 For comprehensive documentation**, see the [Analytics Command Guide](../.codemie/guides/analytics-command.md)

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
