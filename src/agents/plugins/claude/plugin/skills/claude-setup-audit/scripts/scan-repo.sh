#!/usr/bin/env bash
# scan-repo.sh — Discover and inventory all Claude Code components in a repository
# Usage: ./scan-repo.sh [path]
# Output: Structured inventory of all Claude Code components found

set -e

ROOT="${1:-.}"
SKILLS=()
AGENTS=()
COMMANDS=()
CLAUDE_MD=""
HOOKS=""
MCP=""

# ── Discovery ────────────────────────────────────────────────────────────────

# Skills: SKILL.md files anywhere under .claude/skills/ or plugins/*/skills/
while IFS= read -r file; do
  SKILLS+=("$file")
done < <(find "$ROOT" \( \
  -path '*/.claude/skills/*/SKILL.md' -o \
  -path '*/plugins/*/skills/*/SKILL.md' \
\) -not -path '*/node_modules/*' 2>/dev/null | sort)

# Agents: .md files in .claude/agents/ or plugins/*/agents/
while IFS= read -r file; do
  AGENTS+=("$file")
done < <(find "$ROOT" \( \
  -path '*/.claude/agents/*.md' -o \
  -path '*/plugins/*/agents/*.md' \
\) -not -path '*/node_modules/*' 2>/dev/null | sort)

# Commands: .md files in .claude/commands/ (recursive) or plugins/*/commands/
while IFS= read -r file; do
  COMMANDS+=("$file")
done < <(find "$ROOT" \( \
  -path '*/.claude/commands/*.md' -o \
  -path '*/.claude/commands/**/*.md' -o \
  -path '*/plugins/*/commands/**/*.md' \
\) -not -path '*/node_modules/*' 2>/dev/null | sort)

# CLAUDE.md: root or .claude/
if [ -f "$ROOT/CLAUDE.md" ]; then
  CLAUDE_MD="$ROOT/CLAUDE.md"
elif [ -f "$ROOT/.claude/CLAUDE.md" ]; then
  CLAUDE_MD="$ROOT/.claude/CLAUDE.md"
fi

# Hooks: settings.json
if [ -f "$ROOT/.claude/settings.json" ]; then
  HOOKS="$ROOT/.claude/settings.json"
fi

# MCP config
if [ -f "$ROOT/.mcp.json" ]; then
  MCP="$ROOT/.mcp.json"
elif [ -f "$ROOT/.claude/mcp.json" ]; then
  MCP="$ROOT/.claude/mcp.json"
fi

# ── Output ───────────────────────────────────────────────────────────────────

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Claude Code Repository Inventory"
echo "  Path: $(realpath "$ROOT")"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

echo "📦 SKILLS (${#SKILLS[@]} found)"
if [ ${#SKILLS[@]} -eq 0 ]; then
  echo "   (none)"
else
  for f in "${SKILLS[@]}"; do
    # Extract name from frontmatter if possible
    name=$(grep -m1 '^name:' "$f" 2>/dev/null | sed 's/name: *//' || echo "?")
    echo "   • $f  [name: $name]"
  done
fi
echo ""

echo "🤖 AGENTS (${#AGENTS[@]} found)"
if [ ${#AGENTS[@]} -eq 0 ]; then
  echo "   (none)"
else
  for f in "${AGENTS[@]}"; do
    name=$(grep -m1 '^name:' "$f" 2>/dev/null | sed 's/name: *//' || echo "?")
    model=$(grep -m1 '^model:' "$f" 2>/dev/null | sed 's/model: *//' || echo "not specified ⚠️")
    echo "   • $f  [name: $name | model: $model]"
  done
fi
echo ""

echo "⚡ COMMANDS (${#COMMANDS[@]} found)"
if [ ${#COMMANDS[@]} -eq 0 ]; then
  echo "   (none)"
else
  for f in "${COMMANDS[@]}"; do
    name=$(grep -m1 '^name:' "$f" 2>/dev/null | sed 's/name: *//' || echo "?")
    echo "   • $f  [name: $name]"
  done
fi
echo ""

echo "📋 CLAUDE.md"
if [ -n "$CLAUDE_MD" ]; then
  lines=$(wc -l < "$CLAUDE_MD" | tr -d ' ')
  echo "   ✓ $CLAUDE_MD  [$lines lines]"
else
  echo "   ✗ Not found"
fi
echo ""

echo "🪝 HOOKS"
if [ -n "$HOOKS" ]; then
  hook_count=$(grep -c '"event"' "$HOOKS" 2>/dev/null || echo "0")
  echo "   ✓ $HOOKS  [$hook_count hook(s)]"
else
  echo "   ✗ Not found (.claude/settings.json)"
fi
echo ""

echo "🔌 MCP CONFIG"
if [ -n "$MCP" ]; then
  server_count=$(grep -c '"type"' "$MCP" 2>/dev/null || echo "?")
  echo "   ✓ $MCP  [~$server_count server(s)]"
else
  echo "   ✗ Not found (.mcp.json)"
fi
echo ""

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
TOTAL=$(( ${#SKILLS[@]} + ${#AGENTS[@]} + ${#COMMANDS[@]} ))
echo "  Total components: $TOTAL"
echo "  Summary: ${#SKILLS[@]} skills | ${#AGENTS[@]} agents | ${#COMMANDS[@]} commands"
EXTRAS=""
[ -n "$CLAUDE_MD" ] && EXTRAS+="CLAUDE.md "
[ -n "$HOOKS" ] && EXTRAS+="hooks "
[ -n "$MCP" ] && EXTRAS+="MCP "
echo "  Config files: ${EXTRAS:-none}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Quick Security Sweep ─────────────────────────────────────────────────────
echo ""
echo "🔐 Security Sweep"
SECURITY_HITS=$(grep -rn \
  -e '/Users/' \
  -e '/home/[a-z]' \
  -e 'password\s*=' \
  -e 'api_key\s*=' \
  -e 'token\s*=' \
  "$ROOT/.claude/" "$ROOT/.mcp.json" \
  --include="*.md" --include="*.json" --include="*.sh" \
  2>/dev/null | grep -v "node_modules" | grep -v "# " | head -20 || true)

if [ -z "$SECURITY_HITS" ]; then
  echo "   ✓ No obvious hardcoded credentials or paths found"
else
  echo "   ⚠️  Potential issues detected:"
  echo "$SECURITY_HITS" | sed 's/^/   /'
fi
echo ""
