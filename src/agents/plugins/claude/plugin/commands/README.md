# Claude Code Plugin Commands

Built-in commands for the CodeMie Claude Code plugin. These commands are automatically available when using `codemie-claude`.

## Project Documentation

### `/codemie-init` - Generate Project Documentation

Analyzes your codebase and generates AI-optimized documentation:
- Main `CLAUDE.md` file with project-specific workflows
- Detailed guides in `.codemie/guides/` (only for patterns that exist in your code)

**Usage:**
```
/codemie-init
/codemie-init "focus on API patterns"
```

**What it does:**
1. Analyzes project structure, tech stack, and patterns
2. Detects which categories apply (Architecture, API, Testing, etc.)
3. Generates guides only for detected patterns (no empty guides)
4. Creates/updates `CLAUDE.md` with guide references
5. Preserves existing customizations when updating

**Output:**
- `CLAUDE.md` (200-300 lines) - Project overview and guide references
- `.codemie/guides/<category>/*.md` (200-400 lines each) - Detailed patterns

### `/codemie-subagents` - Generate Specialized Agents

Creates project-specific subagent files tailored to your codebase:

**Usage:**
```
/codemie-subagents
```

**Generated Agents:**
- `unit-tester-agent.md` - Knows your test framework and patterns
- `solution-architect-agent.md` - Understands your architecture
- `code-review-agent.md` - Applies your code standards
- `refactor-cleaner-agent.md` - Uses your cleanup tools

**What it does:**
1. Reads existing guides from `.codemie/guides/` (if available)
2. Analyzes project structure, test setup, linting rules
3. Generates/updates agents in `.claude/agents/`
4. Preserves custom content when updating existing agents

## Memory Management

### `/memory-add` - Capture Knowledge

Adds important learnings to project documentation for future sessions.

**Usage:**
```
/memory-add
/memory-add "important context about auth flow"
```

**When to use:**
- You learned something non-obvious about the project
- User corrected a pattern or approach
- You discovered an important architectural decision or gotcha

**What it does:**
1. Identifies what was learned during the session
2. Determines scope (project-wide vs component-specific)
3. Adds structured knowledge to appropriate documentation

**Where it writes:**
- Project-wide patterns → Root `CLAUDE.md` or main docs
- Component-specific → Component `CLAUDE.md` or guide section

### `/memory-refresh` - Audit Documentation

Verifies and updates documentation to reflect current implementation.

**Usage:**
```
/memory-refresh
```

**What it does:**
1. Reviews recent code changes
2. Compares documentation against actual implementation
3. Updates only outdated/incorrect sections
4. Validates all references and examples

**When to use:**
- After significant refactoring
- When patterns have evolved
- Before starting work on unfamiliar code
- Periodically to keep docs accurate

## Status Command

### `/codemie-status` - Session Information

Displays current session tracking status and metrics.

**Usage:**
```
/codemie-status
```

**Output:**
```
CodeMie Session Status
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Session ID:     550e8400...
Started:        2026-01-12 10:30:45 (15m ago)
Metrics:        15,234 tokens | 42 tools | 23 files
Sync:           ✓ Connected (last: 30s ago)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## Command Principles

**Project-Aware:** All commands analyze your actual codebase, not generic templates

**Selective Updates:** Only creates/updates documentation when patterns actually exist

**Preserves Customizations:** When updating, keeps user-added content

**Size Conscious:** Enforces line limits to keep documentation scannable:
- `CLAUDE.md`: 200-300 lines
- Guides: 200-400 lines each
- Subagents: 150-300 lines each

**Examples From Code:** Uses real code examples, not hypothetical ones
