---
name: claude-setup-audit
description: This skill should be used when the user asks to "audit my claude setup", "check my claude configuration", "assess my claude code setup", "audit claude", "review my .claude folder", "is my claude setup correct", "check repo health", "assess my skills quality", "review my agents", "check my CLAUDE.md", "validate my hooks", "audit claude configuration", "check my MCP config", "how good is my claude setup", "scan my .claude folder", or wants a comprehensive quality assessment of all Claude Code components in a repository. Evaluates skills, subagents, CLAUDE.md rules, commands, hooks, and MCP configuration against established best practices. Produces a graded health report (A–F per component) with good/bad example references and prioritized recommendations.
allowed-tools: [Read, Grep, Glob, Bash, Write]
version: 1.0.0
tags: [quality, audit, claude-setup, assessment, production-readiness]
---

# Claude Setup Audit

Comprehensive quality assessment of Claude Code configuration and components in a repository. Evaluates skills, agents, CLAUDE.md rules, commands, hooks, and MCP configuration against established best practices. Produces a graded health report with concrete good/bad example references and actionable fixes.

## Assessment Scope

| Component | Primary Locations | Max Score |
|-----------|------------------|-----------|
| **Skills** | `.claude/skills/*/SKILL.md`, `plugins/*/skills/*/SKILL.md` | 32 pts each |
| **Agents** | `.claude/agents/*.md`, `plugins/*/agents/*.md` | 32 pts each |
| **CLAUDE.md** | `CLAUDE.md`, `.claude/CLAUDE.md`, `**/CLAUDE.md` (subdirs), `CLAUDE.local.md` | 36 pts each |
| **Commands** | `.claude/commands/**/*.md`, `plugins/*/commands/**/*.md` | 20 pts each |
| **Hooks** | `.claude/settings.json` (hooks array) | 20 pts total |
| **MCP Config** | `.mcp.json`, `.claude/mcp.json` | 20 pts |

## 5-Phase Workflow

### Phase 1: Discovery

Run `scripts/scan-repo.sh` or manually scan:

```bash
find . \( \
  -path '*/.claude/agents/*.md' -o \
  -path '*/skills/*/SKILL.md' -o \
  -path '*/.claude/commands/**/*.md' -o \
  -name 'CLAUDE.md' -o \
  -name 'CLAUDE.local.md' -o \
  -name '.mcp.json' -o \
  -path '*/.claude/settings.json' \
\) -not -path '*/node_modules/*' 2>/dev/null
```

**CLAUDE.md knowledge organisation scan** (run separately):
```bash
# Find all CLAUDE.md files
find . -name 'CLAUDE.md' -o -name 'CLAUDE.local.md' \
  | grep -v node_modules | sort

# Find dedicated guide directories
find . -type d \( -name 'guides' -o -name 'references' -o -name '.codemie' \) \
  | grep -v node_modules | sort
```

**Detect which pattern is in use** — both are valid, mutually exclusive:

| Pattern | Signals | Scoring note |
|---------|---------|-------------|
| **A — Single CLAUDE.md + Guide Files** | 1 CLAUDE.md at root + guide files in `guides/`, `.codemie/guides/`, `references/`, `docs/` | R5.3 full credit if CLAUDE.md references guide paths |
| **B — Hierarchical CLAUDE.md** | Multiple CLAUDE.md files at different directory depths | R5.3 N/A (hierarchy IS the delegation); run hierarchy checks |

Print discovery summary:
```
Found: X skills, Y agents, Z commands
CLAUDE.md pattern: A (single + guides) | B (hierarchical) | unknown
CLAUDE.md locations: [list each path found]
Guide dirs: [list if present]
Hooks: ✓/✗ | MCP: ✓/✗
```

### Phase 2: Per-Component Scoring

Apply checklists from `references/component-checklists.md`. Mark each criterion:
- ✅ **Pass** — full points
- ⚠️ **Partial** — half points (present but incomplete or weak)
- ❌ **Fail** — 0 points

**Skills — classify type first, then score**:

> **Before scoring any skill, detect its type:**
> ```bash
> grep -i "codemie.*assistant\|codemie.*chat\|assistants chat" SKILL.md
> ```
> - **Match found** → **Codemie-delegating skill** (API wrapper): applies reduced rubric (21 pts max)
> - **No match** → **Standard skill**: full 32-pt rubric applies

**Standard Skills (32 pts max)**:
- Structure (3×): Valid SKILL.md filename, `[a-z0-9-]+` name, description >20 chars, `allowed-tools` field
- Content (2×): Methodology/workflow section, output format, examples, checklists (`- [ ]`)
- Technical (1×): No absolute paths, no hardcoded UUIDs/secrets, dependencies documented
- Design (2×): Single responsibility, "When to use" triggers, no >50% overlap, <8K tokens

**Codemie-delegating Skills (21 pts max — exemptions apply)**:
- Structure (3×): Valid SKILL.md, valid name, description >20 chars — `allowed-tools` is **N/A** (no local tool execution)
- Content: **All content criteria N/A** — output format, workflow, examples, checklists are determined by the backend assistant
- Technical (1×): No absolute paths, no secrets, deps documented
- Design (2×): Single responsibility, "When to use" triggers, no overlap, token budget
- Score = (pts obtained / 21) × 100 — **do not penalise for exempted criteria**

**Agents (32 pts max)**:
- Identity (3×): Descriptive name, description has "when"/"use"/"trigger" keywords, model specified, tools justified
- Prompt Quality (2×): "You are…" role statement, output format section, scope/limits, anti-hallucination keywords
- Validation (1×): 3+ examples, edge cases, error handling described
- Design (2×): Single responsibility, composable (references skills), <8K tokens

**CLAUDE.md Rules (36 pts max)**:
- Coverage (3×): Coding standards, workflow policies, explicit critical rules with triggers
- Clarity (3×): Actionable instructions, trigger conditions stated, prohibitions explicit
- Structure (2×): Section organization, quick-reference tables, correct/incorrect pattern examples
- Maintenance (1×): No contradictions, technology versions noted, project context stated
- Efficiency (2×): Concise body (≤400 non-code words), no anti-pattern noise, delegates detail via `@import`

**CLAUDE.md hierarchy** — score each file separately, then run hierarchy analysis (Phase 3).

**Commands (20 pts max)**:
- Structure (3×): Frontmatter (name + description), `argument-hint` if uses `$ARGUMENTS`, numbered phases, usage examples
- Quality (2×): Error/failure handling, output format defined, validation gates, argument parsing shown

**Hooks (20 pts max)**:
- Validity (3×): Valid JSON, recognized event types, valid matchers
- Security (2×): No hardcoded credentials, bash scripts use `set -e`/`trap`
- Quality (2×): Hook purpose documented, tool restriction scope appropriate

**MCP Config (20 pts max)**:
- Structure (3×): Valid JSON, `mcpServers` key, each server has `command`/`url` + type
- Security (2×): No hardcoded tokens/passwords, env vars used for credentials
- Documentation (2×): Descriptive server names, required env vars listed

### Phase 3: Cross-Component Analysis

After individual scoring, check repository-wide health:

1. **Coverage gaps** — CLAUDE.md present if agents exist? Skills referenced by agents available?
2. **Naming consistency** — All files use `lowercase-kebab-case`?
3. **Duplication** — Any agents/skills with >50% description keyword overlap?
4. **Security sweep** — Grep all `.claude/` content for `/Users/`, `/home/`, `password=`, `api_key`, `token=`
5. **Integration** — Agents reference the skills they use? Commands invoke relevant agents?
6. **CLAUDE.md knowledge organisation analysis** — see checklist in `references/component-checklists.md` (Pattern A and B checks are separate)

### Phase 4: Grading

```
Component Score = (Points Obtained / Max Points) × 100
Overall Score   = Average of all component scores
```

| Grade | Range | Label |
|-------|-------|-------|
| A | 90–100% | Production-ready |
| B | 80–89% | Good — meets production threshold |
| C | 70–79% | Needs improvement |
| D | 60–69% | Significant gaps |
| F | <60% | Critical issues — rewrite needed |

**Production threshold**: Grade B (≥80%) required per component.

### Phase 5: Report Generation

Generate a report following `examples/sample-report.md` structure.

For each failed criterion, cite the relevant example:
```
❌ No role statement ("You are...") found
   → See examples/bad-agent.md (line 10) vs examples/good-agent.md (line 8)
```

Prioritize findings:
- 🔴 **Critical** (fix immediately): Security issues OR grade F
- 🟡 **Important** (fix soon): Grade D–C OR missing key structural elements
- 🔵 **Minor** (polish): Grade B OR optional improvements

## Quick Wins (High-Impact, Low-Effort Fixes)

| Issue | Score Impact | Fix Effort |
|-------|-------------|------------|
| Missing `model:` in agent | +3 pts | 1 line |
| No `allowed-tools` in standard skill | +3 pts | 1 line |

| No "When to use" trigger section | +2–3 pts | 1 paragraph |
| Hardcoded `/Users/` path | +1 pt + removes security risk | Find + replace |
| No `argument-hint` for command with args | +3 pts | 1 line |
| Missing "You are…" role statement in agent | +2 pts | 1 sentence |
| No output format section | +2 pts | 1 short section |
| Description uses second person ("Use this...") | +1–2 pts | Rephrase |
| CLAUDE.md >400 non-code words | +2 pts + reduces instruction loss | Prune noise |
| `CLAUDE.local.md` not in `.gitignore` | removes security risk | 1 line in .gitignore |
| Pattern A: guides exist but not referenced by path | +2 pts | Add guide paths to CLAUDE.md |
| Pattern B: subdir CLAUDE.md duplicates root | +2 pts | Remove duplication, scope to module only |

## Reference Files

### Scoring Details
- **`references/component-checklists.md`** — Full rubric: all criteria, point values, detection patterns
- **`references/best-practices.md`** — Rationale per criterion, anti-patterns to avoid, quick-fix examples

### Examples

| Component | Good Example | Bad Example |
|-----------|-------------|-------------|
| Skill | `examples/good-skill.md` | `examples/bad-skill.md` |
| Agent | `examples/good-agent.md` | `examples/bad-agent.md` |
| CLAUDE.md | `examples/good-claude-md-snippet.md` | `examples/bad-claude-md-snippet.md` |
| Command | `examples/good-command.md` | `examples/bad-command.md` |
| Hooks config | `examples/good-hooks.json` | `examples/bad-hooks.json` |
| Full report | `examples/sample-report.md` | — |

### Utilities
- **`scripts/scan-repo.sh`** — Discover and inventory all Claude Code components
