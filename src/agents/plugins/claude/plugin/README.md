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

### Optional: Sound Effects

Add audio feedback to your Claude Code sessions with the `--sounds` flag.

**Prerequisites:**

Before running sounds installation, ensure you have an audio player installed:
- **macOS**: `afplay` (built-in, no installation needed)
- **Linux**: `sudo apt install alsa-utils` (aplay) or `sudo apt install pulseaudio-utils` (paplay)
- **Windows**: `choco install mpg123`
- **Alternative**: `brew install mpg123` (macOS), `sudo apt install mpg123` (Linux)

⚠️ **Important**: Installation will fail if no audio player is found.

**Installation:**

```bash
# Enable sounds during Claude installation
codemie install claude --sounds

# Add sounds to existing Claude installation (safe to re-run)
codemie install claude --sounds
```

**What happens during installation:**
- ✅ Verifies required audio player is installed (fails if none found)
- ✅ Creates sound directories in `~/.codemie/sounds/`
- ✅ Configures hooks to play sounds on events

**Note**: The `play-random-sound.sh` script and hook configuration will be **automatically installed** to `~/.codemie/claude-plugin/` when you **first run** `codemie-claude`. This happens seamlessly in the background - you don't need to do anything manually.

**Installation Structure:**

After installation and first run, you'll have:
```
~/.codemie/
├── sounds/                           # Your sound files go here
│   ├── SessionStart/
│   ├── UserPromptSubmit/
│   ├── PermissionRequest/
│   └── Stop/
└── claude-plugin/                    # Auto-created on first run
    ├── sounds/
    │   └── play-random-sound.sh      # Hook script
    └── hooks/
        └── hooks.json                # Hook configuration
```

**Sound Events:**
- `SessionStart` - Plays when Claude Code starts
- `UserPromptSubmit` - Plays when you send a message
- `PermissionRequest` - Plays when Claude asks for clarification or permission
- `Stop` - Plays when Claude completes a task

**Adding Your Own Sounds:**

After installation, add WAV or MP3 files to these directories:
```bash
~/.codemie/sounds/SessionStart/      # Welcome sounds, greetings
~/.codemie/sounds/UserPromptSubmit/  # Acknowledgment sounds (e.g., "Roger")
~/.codemie/sounds/PermissionRequest/ # Question sounds (e.g., "Proceed?")
~/.codemie/sounds/Stop/              # Completion sounds (e.g., "Done")
```

**Popular Sound Packs:**
- Warcraft peon sounds (classic "Work work", "Yes milord")
- StarCraft unit acknowledgments
- Portal 2 GLaDOS quotes

**Where to download sounds:**
- https://x.com/delba_oliveira/status/2020515010985005255

**Troubleshooting:**

If sounds are not playing:
1. Verify audio player is installed: `which afplay` (macOS) or `which aplay` (Linux)
2. Check that sound files exist in `~/.codemie/sounds/<EventName>/`
3. Ensure sound files are in WAV or MP3 format
4. Check that `~/.codemie/claude-plugin/sounds/play-random-sound.sh` exists (created on first run)
5. If script is missing, remove `~/.codemie/claude-plugin/` directory and restart `codemie-claude`

**⚠️ WINDOWS USERS:**

After the first run of `codemie-claude`, you need to update the hooks configuration:

1. Edit `~/.codemie/claude-plugin/hooks/hooks.json`
2. Change all instances of `play-random-sound.sh` to `play-random-sound.ps1`

This is required because Windows uses PowerShell scripts (.ps1) instead of bash scripts (.sh).

To completely remove sounds:
```bash
rm -rf ~/.codemie/sounds
rm -rf ~/.codemie/claude-plugin
```

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
