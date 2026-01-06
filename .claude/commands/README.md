# Claude Commands for CodeMie CLI

Custom commands for maintaining the hierarchical CLAUDE.md documentation system.

## Available Commands

| Command | Purpose | When to Use |
|---------|---------|-------------|
| `/memory-add` | Capture session learnings | End of productive sessions |
| `/memory-init [dir]` | Document directory architecture | Starting work in new areas |
| `/memory-refresh` | Audit all memory files | Monthly maintenance |

## Quick Start

### End of Session
```
/memory-add
```
Captures important discoveries and updates appropriate CLAUDE.md files.

### New Area of Code
```
/memory-init src/providers
```
Analyzes directory architecture and creates/updates its CLAUDE.md file.

### Monthly Maintenance
```
/memory-refresh
```
Reviews all CLAUDE.md files for accuracy and removes stale information.

## Memory System

**Hierarchical Structure**:
```
CLAUDE.md                    # Root (always loaded)
src/agents/CLAUDE.md        # Auto-loads when working in src/agents/**
src/providers/CLAUDE.md     # Auto-loads when working in src/providers/**
src/cli/CLAUDE.md           # Auto-loads when working in src/cli/**
src/analytics/CLAUDE.md     # Auto-loads when working in src/analytics/**
src/workflows/CLAUDE.md     # Auto-loads when working in src/workflows/**
CLAUDE.local.md             # Personal notes (gitignored)
```

**Token Savings**: 30-70% depending on work location vs monolithic 1117-line file.

## Memory Budgets

- Root CLAUDE.md: < 400 lines
- Subdirectory CLAUDE.md: < 500 lines each

## Best Practices

**When to Update**:
- **Immediate** (Session Learning): After corrections or discoveries
- **Scheduled** (Spring Cleaning): Monthly or after major changes
- **New Areas** (Memory Init): Before starting work in unfamiliar code

**Content Guidelines**:
- Include file paths and function names
- Use code examples for patterns
- Keep information at most specific level
- Don't duplicate across files
- Remove stale information immediately

## Workflow Example

```bash
# Starting work on new provider
/memory-init src/providers

# ... development work ...

# End of session
/memory-add

# Monthly review
/memory-refresh
```

## Reference

- Implementation Plan: `.codemie/memory-restructure-plan.md`
- Detailed Guide: `.codemie/maintenance-prompts.md`
