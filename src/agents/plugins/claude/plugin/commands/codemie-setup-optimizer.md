---
description: Install optional tools (jq, rtk, codebase-memory-mcp) that make the codemie plugin optimizer hooks fully functional.
---

# CodeMie Setup Optimizer

Install the tools required by codemie's token-optimization and handoff hooks. Each tool is optional — the plugin works without them, but installing all three unlocks the full experience.

## Tools

| Tool | Purpose | Hook that uses it |
|------|---------|-------------------|
| `jq` | JSON parsing in all hook scripts | All 6 optimizer hooks |
| `rtk` | Compresses CLI output before it reaches context | `rtk-rewrite.sh`, `bash-ban-raw-tools.sh` |
| `codebase-memory-mcp` | Knowledge-graph code search (replaces grep/glob) | `cbm-code-discovery-gate.sh`, `cbm-mcp-marker.sh`, `cbm-session-reminder.sh` |
| `claude` CLI | Auto-generates handoff JSON on compaction | `handoff-precompact.sh` |

## Procedure

### Step 1 — Detect OS

Run:
```bash
uname -s
```
- `Darwin` → macOS (use `brew`)
- `Linux` → Linux (use `apt-get`)

### Step 2 — Check what is already installed

Run these checks and note which are missing:
```bash
command -v jq && jq --version || echo "jq: MISSING"
command -v rtk && rtk --version || echo "rtk: MISSING"
command -v codebase-memory-mcp && codebase-memory-mcp --version 2>/dev/null || echo "codebase-memory-mcp: MISSING"
command -v claude && claude --version || echo "claude: MISSING (install Claude Code CLI)"
```

### Step 3 — Install missing tools

**jq** (required for all hooks):
```bash
# macOS
brew install jq

# Linux (Debian/Ubuntu)
sudo apt-get install -y jq
```

**rtk** (token compression):
```bash
# macOS (recommended)
brew install rtk

# Linux / macOS alternative (places binary in ~/.local/bin)
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
# Add to PATH if not already:
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc  # or ~/.bashrc

# Verify:
rtk --version
```

**codebase-memory-mcp** (code knowledge graph):

Download the latest release binary for your platform from:
https://github.com/DeusData/codebase-memory-mcp/releases

macOS arm64:
```bash
curl -L "https://github.com/DeusData/codebase-memory-mcp/releases/latest/download/codebase-memory-mcp-darwin-arm64" \
  -o /usr/local/bin/codebase-memory-mcp
chmod +x /usr/local/bin/codebase-memory-mcp
```

macOS x86_64:
```bash
curl -L "https://github.com/DeusData/codebase-memory-mcp/releases/latest/download/codebase-memory-mcp-darwin-x64" \
  -o /usr/local/bin/codebase-memory-mcp
chmod +x /usr/local/bin/codebase-memory-mcp
```

Linux x86_64:
```bash
curl -L "https://github.com/DeusData/codebase-memory-mcp/releases/latest/download/codebase-memory-mcp-linux-x64" \
  -o /usr/local/bin/codebase-memory-mcp
chmod +x /usr/local/bin/codebase-memory-mcp
```

### Step 4 — Verify installation

```bash
echo "=== Verification ==="
jq --version
rtk --version
codebase-memory-mcp --version 2>/dev/null || echo "codebase-memory-mcp installed"
```

### Step 5 — Report to user

After completing installation, summarize:
- Which tools were already installed (skip)
- Which tools were just installed (success)
- Which tools could not be installed and why (fail + manual instructions)
- What each installed tool now enables in the plugin

## Notes

- `claude` CLI is the Claude Code binary itself — it should already be available. If missing, direct the user to https://claude.ai/code
- The plugin hooks run silently without these tools — no errors, no blocking
- After installing `codebase-memory-mcp`, run `index_repository` to index the current project
