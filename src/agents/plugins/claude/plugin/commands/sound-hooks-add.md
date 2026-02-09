---
description: Install Fun Sounds system for Claude hooks. Creates hook directories, configures play-random-sound.sh script, and updates settings.json to play sounds on SessionStart, UserPromptSubmit, PermissionRequest, and Stop events.
allowed-tools: Bash(mkdir:*), Bash(cp:*), Bash(chmod:*), Bash(find:*), Bash(grep:*), Bash(cat:*), Bash(command:*), Bash(wc:*)
---

# Fun Sounds Installer

**Command Name**: `sound-hooks-add`
**Category**: Productivity & Customization

---

## Purpose

Set up audio feedback for Claude Code using the hooks system. Plays random sounds from designated directories on key events (SessionStart, UserPromptSubmit, PermissionRequest, Stop).

---

## Prerequisites

- [ ] Audio player available (afplay, aplay, paplay, or mpg123)
- [ ] Write access to ~/.claude/ directory
- [ ] play-random-sound.sh script available in plugin

---

## Pre-flight Checks

Before installation:

### 1. Check Platform Audio Support

```bash
if command -v afplay &> /dev/null; then
    echo "✅ macOS (afplay detected)"
elif command -v aplay &> /dev/null; then
    echo "✅ Linux ALSA (aplay detected)"
elif command -v paplay &> /dev/null; then
    echo "✅ Linux PulseAudio (paplay detected)"
elif command -v mpg123 &> /dev/null; then
    echo "✅ mpg123 detected"
else
    echo "❌ No audio player found"
    echo "Install: afplay (macOS), aplay, paplay, or mpg123"
    exit 1
fi
```

### 2. Check Existing Hooks Configuration

```bash
if [ -f ~/.claude/settings.json ]; then
    grep -q '"hooks"' ~/.claude/settings.json && echo "⚠️  Hooks already configured" || echo "✅ No hooks configured"
fi
```

---

## Installation Steps

### Step 1: Create Hook Directories

Create the directory structure for sound files:

```bash
mkdir -p ~/.claude/hooks/SessionStart
mkdir -p ~/.claude/hooks/UserPromptSubmit
mkdir -p ~/.claude/hooks/PermissionRequest
mkdir -p ~/.claude/hooks/Stop

echo "✅ Created hook directories in ~/.claude/hooks/"
```

### Step 2: Install Sound Player Script

Copy the play-random-sound.sh script from the plugin to the hooks directory:

```bash
# Script is bundled with the plugin
SCRIPT_SOURCE="$HOME/.codemie/claude-plugin/scripts/play-random-sound.sh"

# Fallback to development path if plugin not installed
if [ ! -f "$SCRIPT_SOURCE" ]; then
    SCRIPT_SOURCE="./src/agents/plugins/claude/plugin/scripts/play-random-sound.sh"
fi

# Copy to hooks directory
cp "$SCRIPT_SOURCE" ~/.claude/hooks/play-random-sound.sh

# Make executable
chmod +x ~/.claude/hooks/play-random-sound.sh

echo "✅ Installed play-random-sound.sh to ~/.claude/hooks/"
```

### Step 3: Request User Permission

**IMPORTANT**: Before configuring hooks, explain permissions to the user:

```
🔐 Permission Request

The Fun Sounds system needs permission to run the following command:
  ~/.claude/hooks/play-random-sound.sh <directory>

This script will:
- Find random WAV/MP3 files in the specified directory
- Play them using your system's audio player (afplay, aplay, paplay, or mpg123)
- Run in the background (non-blocking)

Would you like to grant permission for this command to run on:
- SessionStart (when you start a conversation)
- UserPromptSubmit (when you send a message)
- PermissionRequest (when Claude asks for permission)
- Stop (when Claude finishes a task)

The script is safe and only plays audio files from directories you control.
```

**Wait for user confirmation before proceeding.**

### Step 4: Update settings.json

After receiving permission, update ~/.claude/settings.json with hook configuration:

```bash
# Backup existing settings
if [ -f ~/.claude/settings.json ]; then
    cp ~/.claude/settings.json ~/.claude/settings.json.backup
    echo "✅ Backed up existing settings to ~/.claude/settings.json.backup"
fi
```

**Hooks Configuration:**

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/UserPromptSubmit"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/PermissionRequest"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/Stop"
          }
        ]
      }
    ]
  }
}
```

**Merge Strategy:**

```bash
# Path to settings file
SETTINGS_FILE=~/.claude/settings.json

# Use jq if available for safe merging
if command -v jq &> /dev/null; then
    # Create hooks config file
    cat > /tmp/hooks-config.json <<'EOF'
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/UserPromptSubmit"
          }
        ]
      }
    ],
    "PermissionRequest": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/PermissionRequest"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/Stop"
          }
        ]
      }
    ]
  }
}
EOF

    # Merge configurations
    jq -s '.[0] * .[1]' "$SETTINGS_FILE" /tmp/hooks-config.json > "$SETTINGS_FILE.tmp"
    mv "$SETTINGS_FILE.tmp" "$SETTINGS_FILE"
    rm /tmp/hooks-config.json

    echo "✅ Updated settings.json with hooks configuration"
else
    echo "⚠️  jq not found. Please manually add the hooks configuration to ~/.claude/settings.json"
    echo "See configuration above"
fi
```

### Step 5: Verify Installation

Test the installation:

```bash
echo "=== Installation Verification ==="
echo ""

# Check directories
echo "📂 Hook Directories:"
for dir in SessionStart UserPromptSubmit PermissionRequest Stop; do
    count=$(find ~/.claude/hooks/$dir -type f \( -iname "*.wav" -o -iname "*.mp3" \) 2>/dev/null | wc -l | tr -d ' ')
    if [ -d ~/.claude/hooks/$dir ]; then
        echo "  ✅ $dir: ready ($count sound files)"
    else
        echo "  ❌ $dir: missing"
    fi
done

echo ""
echo "📜 Script:"
if [ -x ~/.claude/hooks/play-random-sound.sh ]; then
    echo "  ✅ play-random-sound.sh: installed and executable"
else
    echo "  ❌ play-random-sound.sh: not found or not executable"
fi

echo ""
echo "⚙️  Configuration:"
if grep -q '"hooks"' ~/.claude/settings.json 2>/dev/null; then
    echo "  ✅ Hooks configured in ~/.claude/settings.json"
else
    echo "  ❌ Hooks not configured"
fi
```

---

## Post-Installation Instructions

After successful installation, provide these instructions to the user:

```
🎉 Fun Sounds installed successfully!

📂 Next Steps:

1. Download your favorite sound effects from movies, games, or sound libraries
2. Add them to these directories:
   - ~/.claude/hooks/SessionStart/       (plays when starting a conversation)
   - ~/.claude/hooks/UserPromptSubmit/   (plays when you send a message)
   - ~/.claude/hooks/PermissionRequest/  (plays when Claude asks permission)
   - ~/.claude/hooks/Stop/               (plays when Claude completes a task)

3. Supported formats: WAV, MP3
4. The script will randomly select one sound from each directory

💡 Suggestions:
   - SessionStart: Welcome sounds, greetings ("Hello", "Ready")
   - UserPromptSubmit: Acknowledgment sounds ("Roger", "Affirmative")
   - PermissionRequest: Alert sounds ("Attention", "Request")
   - Stop: Completion sounds ("Done", "Mission accomplished")

🎮 Example sound packs:
   - Warcraft peon sounds (classic "Work work", "Yes milord")
   - StarCraft unit acknowledgments
   - Portal 2 GLaDOS quotes
   - Your own custom recordings

💾 Where to download sounds:
   - https://x.com/delba_oliveira/status/2020515010985005255?s=20

🔊 Test it: Restart your Claude session to hear the SessionStart sound!

⚙️  Configuration saved in: ~/.claude/settings.json
📜 Script location: ~/.claude/hooks/play-random-sound.sh
```

---

## Troubleshooting

### No audio player found

**Solution**: Install appropriate audio player:
- macOS: afplay (built-in)
- Linux: `sudo apt install alsa-utils` (aplay) or `sudo apt install pulseaudio-utils` (paplay)
- Cross-platform: `brew install mpg123` or `sudo apt install mpg123`

### Permission denied on script

**Solution**: Make script executable:
```bash
chmod +x ~/.claude/hooks/play-random-sound.sh
```

### Hooks not working

**Solution**:
1. Verify settings.json syntax: `cat ~/.claude/settings.json | jq .`
2. Check script works manually: `~/.claude/hooks/play-random-sound.sh ~/.claude/hooks/SessionStart`
3. Restart Claude Code

### Sounds playing too loud/quiet

**Solution**: Adjust system volume or use audio editor to normalize sound files

### Script not found during installation

**Solution**: Verify plugin is installed:
```bash
ls ~/.codemie/claude-plugin/scripts/play-random-sound.sh
```

If missing, the SSO provider should auto-install it. Or copy manually:
```bash
cp ./src/agents/plugins/claude/plugin/scripts/play-random-sound.sh ~/.claude/hooks/
```

---

## Uninstallation

If user wants to remove Fun Sounds:

```bash
# Remove hooks from settings.json (manual edit or use jq)
# Remove directories
rm -rf ~/.claude/hooks/SessionStart
rm -rf ~/.claude/hooks/UserPromptSubmit
rm -rf ~/.claude/hooks/PermissionRequest
rm -rf ~/.claude/hooks/Stop
rm ~/.claude/hooks/play-random-sound.sh

echo "✅ Fun Sounds uninstalled"
```

---

## Success Criteria

- ✅ All hook directories created
- ✅ Script installed and executable
- ✅ settings.json updated with hooks configuration
- ✅ User understands how to add sound files
- ✅ Verification checks pass
