# CodeMie Plugin for Claude Code

Event-driven observability plugin for Claude Code. Captures session lifecycle events and syncs metrics/conversations to the CodeMie platform.

## What This Plugin Does

- **Session Tracking**: Captures session start/end events automatically
- **Tool Usage Monitoring**: Logs tool execution for observability
- **Metrics Collection**: Tracks tokens, tool calls, and file operations
- **Platform Sync**: Syncs data to CodeMie platform for analytics

## Installation Methods

### Method 1: Automatic (SSO Provider)

**Recommended for production use with CodeMie SSO**

When using the `ai-run-sso` provider, the plugin is automatically installed on first run:

```bash
# Setup SSO provider (one-time)
codemie setup
# Select: CodeMie SSO

# First run - plugin auto-installs to ~/.codemie/claude-plugin/
codemie-claude "implement feature X"
```

**What happens:**
1. ✅ Plugin copied to `~/.codemie/claude-plugin/` on first run
2. ✅ `--plugin-dir` flag automatically passed to Claude Code
3. ✅ Session tracking, metrics, and conversation sync enabled
4. ✅ Idempotent - safe to run multiple times

**Benefits:**
- ✅ Zero manual setup required
- ✅ Automatic updates when CLI updates
- ✅ Consistent across all developers
- ✅ Works out-of-the-box after `codemie setup`

### Method 2: Development Testing

Test the plugin during development without installing:

```bash
# From codemie-code repository root
cd /path/to/codemie-code

# Test with --plugin-dir flag
codemie-claude --plugin-dir ./src/agents/plugins/claude/plugin "implement feature X"

# Or use Claude Code directly
claude --plugin-dir ./src/agents/plugins/claude/plugin "implement feature X"
```

**Benefits:**
- ✅ No installation step required
- ✅ Changes take effect immediately
- ✅ Perfect for plugin development iteration
- ✅ Works with both `codemie-claude` and `claude` commands

### Method 3: Manual Installation

Copy the plugin to Claude's plugin directory:

```bash
# Copy from CodeMie CLI installation
cp -r ~/.codemie/node_modules/@codemieai/cli/src/agents/plugins/claude/plugin \
     ~/.claude/plugins/codemie

# Or if using npm link during development
cp -r /path/to/codemie-code/src/agents/plugins/claude/plugin ~/.claude/plugins/codemie
```

**Note:** Manual installation is only needed for non-SSO providers (litellm, bedrock, etc.)

## Usage

Once loaded, the plugin automatically:

1. **Captures Session Start**: Logs session metadata when Claude Code starts
2. **Captures Session End**: Syncs metrics and conversations when Claude Code exits
3. **Logs Tool Usage**: Tracks tool execution before/after each tool call

### Available Commands

The plugin provides several built-in commands for project documentation and memory management.

#### Documentation Generation

**`/codemie-init`** - Generate AI-optimized project documentation
```bash
# Analyze codebase and create CLAUDE.md + guides
/codemie-init

# With additional context
/codemie-init "focus on API patterns"
```

**`/codemie-subagents`** - Generate project-specific subagents
```bash
# Create tailored subagent files in .claude/agents/
/codemie-subagents
```

#### Memory Management

**`/memory-add`** - Capture important learnings
```bash
# Add knowledge to project documentation
/memory-add

# With specific context
/memory-add "auth flow requires initialization"
```

**`/memory-refresh`** - Audit and update documentation
```bash
# Verify docs match current implementation
/memory-refresh
```

#### Status

**`/codemie-status`** - Display session tracking status:

```
CodeMie Session Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session ID:     550e8400...
Started:        2026-01-12 10:30:45 (15m ago)
Metrics:        15,234 tokens | 42 tools | 23 files
Sync:           ✓ Connected (last: 30s ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

**See [commands/README.md](./commands/README.md) for detailed usage and examples.**

## Hook Events

The plugin registers the following hooks:

| Event | Command | Purpose | Timeout |
|-------|---------|---------|---------|
| `SessionStart` | `codemie hook session_start` | Initialize session tracking | 5s |
| `SessionEnd` | `codemie hook session_end` | Sync metrics/conversations | 30s |
| `PreToolUse` | `codemie hook tool_before` | Log tool execution start | 2s |
| `PostToolUse` | `codemie hook tool_after` | Log tool execution result | 2s |

## How It Works

```
Claude Code Session Start
    ↓
Plugin executes: codemie hook session_start
    ↓
Session tracking initialized
    ↓
... user works with Claude Code ...
    ↓
Claude Code Session End
    ↓
Plugin executes: codemie hook session_end
    ↓
Metrics & conversations synced to platform
```

## Troubleshooting

### Plugin Not Loading

```bash
# Verify plugin structure
ls -la src/agents/plugins/claude/plugin/.claude-plugin/plugin.json
ls -la src/agents/plugins/claude/plugin/hooks/hooks.json

# Check JSON files are valid
cat src/agents/plugins/claude/plugin/.claude-plugin/plugin.json | jq .
cat src/agents/plugins/claude/plugin/hooks/hooks.json | jq .

# Test with --plugin-dir flag
codemie-claude --plugin-dir ./src/agents/plugins/claude/plugin "test"
```

### Hooks Not Triggering

```bash
# Verify hook command is available
which codemie
codemie --version

# Test hook handler directly
echo '{"event":"SessionStart","sessionId":"test","workingDirectory":"/tmp"}' | \
  codemie hook session_start

# Check hook structure
jq '.hooks' src/agents/plugins/claude/plugin/hooks/hooks.json
```

### Hook Handler Fails

```bash
# Test with minimal JSON
echo '{"event":"SessionStart","sessionId":"123","workingDirectory":"/tmp"}' | \
  codemie hook session_start
echo $?  # Should output 0

# Check exit codes
# 0 = success
# 1 = non-blocking warning
# 2 = blocking error (stops agent)
```

## Architecture

This plugin is part of the CodeMie CLI's hooks-based architecture:

- **Plugin Location**: Bundled with CLI at `src/agents/plugins/claude/plugin/`
- **Hook Handlers**: CLI commands at `src/cli/commands/hook.ts`
- **Event Flow**: Claude Code → Plugin → CLI Hook Command → CodeMie Platform
- **Data Format**: JSON passed via stdin

See `docs/ARCHITECTURE-HOOKS-SYSTEM.md` for complete architecture documentation.

## Local Installation to Working Directory

The plugin supports copying template files to your project's working directory (`.codemie/` by default). This is useful for:

- **Project-specific templates**: Custom Claude templates per project
- **Offline usage**: Templates available without global installation
- **Version control**: Commit templates with your project

### Configuration

Local installation is configured via `.claude-plugin/local-install.json`:

```json
{
  "enabled": true,
  "strategy": "hybrid",
  "includes": [
    "claude-templates/**"
  ],
  "excludes": [
    "**/*.test.js",
    "**/.DS_Store",
    "**/node_modules/**"
  ],
  "targetDir": ".codemie",
  "preserveStructure": true,
  "overwritePolicy": "newer"
}
```

**Configuration Options:**

- `enabled`: Enable/disable local copy (default: `true`)
- `strategy`: Pattern matching strategy
  - `whitelist`: Only copy files matching `includes`
  - `blacklist`: Copy all files except those matching `excludes`
  - `hybrid`: Copy files matching `includes`, then apply `excludes`
- `includes`: Glob patterns for files to include
- `excludes`: Glob patterns for files to exclude
- `targetDir`: Target directory name (relative to working directory)
- `preserveStructure`: Preserve directory structure (default: `true`)
- `overwritePolicy`: File overwrite behavior
  - `always`: Always overwrite existing files
  - `never`: Never overwrite existing files
  - `newer`: Only overwrite if source is newer (default)

### How It Works

When the plugin is installed globally (via SSO provider), it also:

1. Checks if local installation is enabled
2. Copies matching files to working directory
3. Tracks version to avoid redundant copies
4. Skips up-to-date files based on `overwritePolicy`

**Example:**
```bash
# Plugin installed to ~/.codemie/claude-plugin/ (global)
# Templates copied to ./codemie/claude-templates/ (local)
# Your project can now use templates without global lookup
```

### Disabling Local Installation

To disable local copying, set `enabled: false` in `local-install.json`:

```json
{
  "enabled": false
}
```

## Development

### Plugin Structure

```
plugin/
├── .claude-plugin/
│   ├── plugin.json          # Plugin manifest (name, description, author)
│   └── local-install.json   # Local installation configuration
├── hooks/
│   └── hooks.json           # Hooks configuration (event → command mapping)
├── commands/
│   └── status.md            # /codemie-status command
├── claude-templates/        # Templates for local copy
└── README.md                # This file
```

### Testing Changes

```bash
# From codemie-code repository root
npm run build

# Test plugin with changes
codemie-claude --plugin-dir ./src/agents/plugins/claude/plugin "test task"

# Verify hooks execute
# Expected output:
# [SessionStart] session=550e8400 cwd=/path/to/project
# ... agent execution ...
# [SessionEnd] session=550e8400 exit=0 duration=30000ms
```

## References

- **Architecture Doc**: `docs/ARCHITECTURE-HOOKS-SYSTEM.md`
- **CLI Commands**: `src/cli/commands/hook.ts`
- **Agent Plugin**: `src/agents/plugins/claude/claude.plugin.ts`
- **Session Adapter**: `src/agents/plugins/claude/claude.session.ts`
- **Hookify Example**: https://github.com/anthropics/claude-plugins-official/tree/main/plugins/hookify
- **Claude Code Hooks API**: https://code.claude.com/docs/en/hooks
