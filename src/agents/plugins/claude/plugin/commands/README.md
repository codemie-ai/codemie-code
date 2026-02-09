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

## Git & Version Control

### `/codemie-catchup` - Branch Changes Summary

Reviews all changes in your current git branch compared to main and provides a comprehensive summary.

**Usage:**
```
/codemie-catchup
```

**What it does:**
1. Reads all files changed in current branch vs main
2. Summarizes features added or modified
3. Identifies breaking changes
4. Highlights files needing tests
5. Notes areas needing documentation updates
6. Shows current state of work

**When to use:**
- After pulling a branch worked on by others
- When returning to a branch after time away
- Before creating a PR to review all changes
- When onboarding to an in-progress feature

### `/codemie-commit` - Create Git Commit

Creates a git commit following conventional commit standards with branch protection.

**Usage:**
```
/codemie-commit
```

**What it does:**
1. Checks current branch (protects main/master)
2. If on main/master: suggests and creates feature branch first
3. Stages relevant changes
4. Creates commit with conventional commit format
5. Follows commitlint rules

**Commit Format:**
- `<type>(<scope>): <subject>` or `<type>: <subject>`
- Types: feat, fix, docs, style, refactor, perf, test, chore, ci, revert
- Scopes: cli, agents, providers, config, proxy, workflows, ci, analytics, utils, deps, tests

**When to use:**
- After completing a logical chunk of work
- When you want properly formatted commit messages
- To avoid accidentally committing to main/master

## Memory Management

### `/memory-refresh` - Smart Documentation Refresh & Audit

Intelligently detects code changes and refreshes documentation. Supports two modes:

**Smart Mode** (for codemie-init docs):
- Detects changed files using git
- Maps changes to affected guide categories
- Updates only impacted guides (selective)
- Fast and efficient for regular updates

**Traditional Mode** (for all documentation):
- Comprehensive audit of all documentation
- Reviews all docs vs implementation
- Thorough for major refactors

**Usage:**
```
/memory-refresh
/memory-refresh "focus on API changes"
```

**What it does:**
1. Auto-detects documentation type (Codemie vs traditional)
2. Reviews recent code changes
3. Compares documentation against actual implementation
4. Updates only outdated/incorrect sections
5. Validates all references and examples

**When to use:**
- After implementing features or significant changes
- Regular maintenance (weekly/monthly for Smart Mode)
- After significant refactoring (Traditional Mode)
- When patterns have evolved
- Before starting work on unfamiliar code

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

## Command Workflows

### Documentation Workflow

**Initial Setup:**
1. `/codemie-init` - Generate documentation from scratch
2. `/codemie-subagents` - Generate specialized agents

**Regular Maintenance:**
3. `/memory-refresh` - Smart refresh after code changes (auto-detects mode)

**Comparison:**

| Command | Scope | Effort | When to Use |
|---------|-------|--------|-------------|
| `/codemie-init` | Full generation | High | First time, complete regeneration |
| `/memory-refresh` (Smart Mode) | Changed guides only | Low-Medium | After features, regular updates (Codemie docs) |
| `/memory-refresh` (Traditional) | All documentation | Medium-High | Major refactoring, any doc type |

### Development Workflow

**Working on a Feature:**
1. `/codemie-commit` - Create properly formatted commits
2. Work on changes
3. `/codemie-commit` - Commit logical chunks
4. `/memory-refresh` - Update docs after significant changes

**Reviewing Branch State:**
1. `/codemie-catchup` - Understand all changes in branch
2. Review summary for completeness
3. `/memory-refresh` - Ensure docs are current
4. Create PR

**Quick Reference:**

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/codemie-commit` | Create conventional commits | After completing work chunks |
| `/codemie-catchup` | Summarize branch changes | Before PR, after time away, onboarding |

## Command Principles

**Project-Aware:** All commands analyze your actual codebase, not generic templates

**Selective Updates:** Only creates/updates documentation when patterns actually exist

**Preserves Customizations:** When updating, keeps user-added content

**Size Conscious:** Enforces line limits to keep documentation scannable:
- `CLAUDE.md`: 200-300 lines
- Guides: 200-400 lines each
- Subagents: 150-300 lines each

**Examples From Code:** Uses real code examples, not hypothetical ones
