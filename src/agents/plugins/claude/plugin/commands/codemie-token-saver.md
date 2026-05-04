---
allowed-tools: Bash(uname:*), Bash(uname -m:*), Bash(command -v:*), Bash(brew install:*), Bash(apt-get install:*), Bash(curl -fsSL:*), Bash(chmod:*), Bash(mkdir -p:*), Bash(tar -xzf:*)
description: Install token-saving tools (jq, rtk, codebase-memory-mcp) that reduce Claude Code context usage by 60-90%.
---

## Current State

- OS: !`uname -s`
- Architecture: !`uname -m`
- jq: !`command -v jq && jq --version || echo "MISSING"`
- rtk: !`command -v rtk && rtk --version || echo "MISSING"`
- codebase-memory-mcp: !`command -v codebase-memory-mcp && codebase-memory-mcp --version 2>/dev/null || echo "MISSING"`
- claude CLI: !`command -v claude && claude --version || echo "MISSING"`

## Token-Saving Tools

| Tool | Token Impact | Hook |
|------|-------------|------|
| `rtk` | 60-90% savings — compresses CLI output before it reaches context | `rtk-rewrite.sh`, `bash-ban-raw-tools.sh` |
| `codebase-memory-mcp` | Replaces grep/glob with graph search (far fewer tokens per lookup) | `cbm-code-discovery-gate.sh`, `cbm-mcp-marker.sh`, `cbm-session-reminder.sh` |
| `context-mode` | 98% context savings — sandboxed code execution + FTS5 knowledge base | MCP plugin (install via `/plugin`) |
| `jq` | Required by all optimizer hook scripts | All optimizer hooks |
| `claude` CLI | Auto-generates handoff JSON on compaction | `handoff-precompact.sh` |

## Your Task

Check the **Current State** above. Install only the **MISSING** tools, configure where needed, then report.

### jq (required for all hooks)

```bash
# macOS
brew install jq

# Linux (Debian/Ubuntu)
sudo apt-get install -y jq
```

### rtk (60-90% token compression)

```bash
# macOS (recommended)
brew install rtk

# Linux / macOS alternative
curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/refs/heads/master/install.sh | sh
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### codebase-memory-mcp (graph-based code search)

```bash
curl -fsSL https://raw.githubusercontent.com/DeusData/codebase-memory-mcp/main/install.sh | bash -s -- --ui
```

After installing, run the `index_repository` tool to index the current project.

### context-mode (MCP plugin — sandboxed execution + knowledge base)

Cannot be installed via shell. Suggest the user run these two slash commands:

```
/plugin marketplace add mksglu/context-mode
/plugin install context-mode@context-mode
```

### claude CLI

If missing, direct the user to https://claude.ai/code — it should already be present.

## Report

After completing installation, tell the user:
- Which tools were already installed (skip)
- Which tools were just installed (success)
- Which tools could not be installed and why (fail + manual steps)
- Estimated token savings now unlocked
