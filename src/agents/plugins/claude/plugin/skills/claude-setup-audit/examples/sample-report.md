# Claude Setup Audit Report

**Project**: `/Users/developer/my-app`
**Date**: 2026-03-02
**Assessed by**: claude-setup-audit v1.0.0

---

## Overall Score: 71% (Grade C)

> ⚠️ **3 of 8 components are below the production threshold (80% / Grade B)**

| Component | Files | Avg Score | Grade | Production Ready |
|-----------|-------|-----------|-------|-----------------|
| Skills | 3 | 84% | B | 2/3 (67%) ✅ |
| Agents | 2 | 58% | F | 0/2 (0%) ❌ |
| CLAUDE.md | 1 | 73% | C | 0/1 ⚠️ |
| Commands | 2 | 90% | A | 2/2 (100%) ✅ |
| Hooks | 1 | 65% | D | 0/1 ❌ |
| MCP Config | 1 | 85% | B | 1/1 (100%) ✅ |

---

## Issues by Priority

### 🔴 Critical (Fix Before Production)

**1. Hardcoded API key in `.claude/settings.json`** (Hook: `audit-logger`)
- **Issue**: Literal API key `sk-prod-abc123` found in hook command string
- **Risk**: Credential exposed in version control if file is committed
- **Fix**: Replace with env var reference: `$AUDIT_API_KEY`
- **Reference**: See `examples/bad-hooks.json` line 12 → `examples/good-hooks.json` line 18

**2. Agent `analyzer.md` — Grade F (47%)**
- **Issue**: No model specified, no role statement, no output format, Bash unjustified
- **Risk**: Unpredictable behavior and cost; Bash access without constraints
- **Fix**: Add frontmatter `model: claude-sonnet-4-6`; add "You are..." role; justify Bash
- **Reference**: See `examples/bad-agent.md` → `examples/good-agent.md`

---

### 🟡 Important (Fix Soon)

**3. Agent `summarizer.md` — Grade D (63%)**
- Missing: model (−3 pts), anti-hallucination section (−2 pts), 3+ examples (−1 pt)
- **Quick fix**: Add 3 lines to frontmatter + one "Source Verification" section

**4. CLAUDE.md — Grade C (73%)**
- Missing: quick-reference task classifier table (−2 pts), ✅/❌ pattern examples (−2 pts)
- Has: coding standards, workflow policies, critical rules ✓
- **Fix**: Add a "Task Classifier" table and one before/after code example per major rule

**5. Hook `audit-logger` — Grade D (65%)** *(aside from the Critical security issue above)*
- Matcher is `.*` (runs on every tool use) — should target `Bash` only
- No `description` field on the hook object
- No error handling in bash script (`set -e` missing)

---

### 🔵 Minor (Polish)

**6. Skill `data-processor` — Grade B (81%)**
- Missing: actionable checklists `- [ ]` (−2 pts)
- Easy win: add 3 checkbox items to the workflow section

**7. Naming inconsistency**
- Agent file `Summarizer.md` uses PascalCase — rename to `summarizer.md`
- Skill `data_processor/` uses underscore — rename to `data-processor/`

---

## Per-Component Details

<details>
<summary>Skills — 3 files, avg 84%, Grade B</summary>

| File | Score | Grade | Top Issues |
|------|-------|-------|------------|
| `.claude/skills/commit-helper/SKILL.md` | 94% | A | None |
| `.claude/skills/data-processor/SKILL.md` | 81% | B | Missing checklists (-2 pts) |
| `.claude/skills/deploy-helper/SKILL.md` | 78% | C | No "When to use" triggers (-2), no output format (-2) |

**deploy-helper gaps**:
```
❌ S4.2: No "When to use" section
   → Add: "## When to Use / Do NOT use this for..."
   → See: examples/good-skill.md line 14–22

❌ S2.2: Output format not defined
   → Add: "## Output Format" section
```
</details>

<details>
<summary>Agents — 2 files, avg 58%, Grade F</summary>

| File | Score | Grade | Top Issues |
|------|-------|-------|------------|
| `.claude/agents/analyzer.md` | 47% | F | No model, no role, Bash unjustified, no examples |
| `.claude/agents/summarizer.md` | 69% | D | No model, no anti-hallucination, weak examples |

**analyzer.md failed criteria**:
```
❌ A1.3: No model specified (−3 pts)
   → Add to frontmatter: model: claude-sonnet-4-6

❌ A2.1: No role statement (−2 pts)
   → Add: "You are a data analyst specializing in..."

❌ A1.4: Bash in tools without justification (−3 pts)
   → Add comment: # Bash required for: running analysis scripts

❌ A2.4: No anti-hallucination measures (−2 pts)
   → Add "## Source Verification" section
   → See: examples/good-agent.md line 47–51

❌ A3.1: Only 1 example (needs ≥3) (−1 pt)
```
</details>

<details>
<summary>CLAUDE.md — 73%, Grade C</summary>

**Passing criteria** (19/30 pts):
- ✅ R1.1: Coding standards section present
- ✅ R1.2: Git workflow policy documented
- ✅ R1.3: MANDATORY/NEVER directives present
- ✅ R2.1: Instructions are actionable
- ✅ R2.3: Prohibitions stated

**Failing criteria** (−8 pts):
```
❌ R2.2: No trigger conditions on rules (−3 pts)
   → Rules say "NEVER use --no-verify" but don't say when this applies
   → Add: "When user says 'commit': NEVER use --no-verify"
   → See: examples/good-claude-md-snippet.md line 18–22

❌ R3.2: No quick-reference table (−2 pts)
   → Add a "Task Classifier" table mapping keywords to policies
   → See: examples/good-claude-md-snippet.md line 9–15

❌ R3.3: No ✅/❌ pattern examples (−2 pts)
   → Add one before/after code block for TypeScript imports or git commits
   → See: examples/good-claude-md-snippet.md line 32–40

❌ R4.2: Technology versions not mentioned (−1 pt)
   → Add: "Node.js >=20.0.0 required"
```
</details>

<details>
<summary>Commands — 2 files, avg 90%, Grade A</summary>

| File | Score | Grade | Notes |
|------|-------|-------|-------|
| `.claude/commands/create-ticket.md` | 95% | A | Excellent |
| `.claude/commands/summarize-pr.md` | 85% | B | Missing validation gates |

</details>

<details>
<summary>Hooks — 65%, Grade D (+ Critical security issue)</summary>

See Critical issue #1 above. Additional failures:
- H3.1: `.*` matcher runs on all tools (should be `Bash` only)
- H3.2: No `description` field on hook
- H2.2: No `set -e` in bash command
</details>

<details>
<summary>MCP Config — 85%, Grade B</summary>

**Passing**: Valid JSON, `mcpServers` structure, env var references, descriptive names.

**Gaps**:
```
⚠️ M3.2: Required env vars not documented in README (−3 pts)
   → Add a ## MCP Configuration section to README.md listing:
     - JIRA_TOKEN: your Jira API token (Settings > Personal Access Tokens)
     - GITHUB_TOKEN: GitHub PAT with repo scope
```
</details>

---

## Cross-Component Analysis

### Coverage Gaps
- ✅ CLAUDE.md present (agents exist)
- ⚠️ `analyzer.md` references `parse-data` skill — but `.claude/skills/parse-data/` not found
- ✅ Commands have corresponding agents

### Naming Consistency Issues
- `Summarizer.md` → rename to `summarizer.md`
- `data_processor/` → rename to `data-processor/`

### Duplication Check
- `analyzer.md` and `summarizer.md` descriptions have 52% Jaccard overlap — consider merging or differentiating scope

### Security Sweep
```
⚠️ .claude/settings.json: sk-prod-abc123  [line 14]
```

---

## Recommended Action Plan

**Week 1 (Critical)**:
1. Remove hardcoded key from `settings.json` → use `$AUDIT_API_KEY`
2. Fix `analyzer.md`: add model, role statement, Bash justification

**Week 2 (Important)**:
3. Fix `summarizer.md`: model + anti-hallucination + examples
4. Improve CLAUDE.md: add task classifier table + pattern examples
5. Fix hook matcher from `.*` to `Bash`

**Week 3 (Polish)**:
6. Add checklists to `data-processor` skill
7. Fix file naming: PascalCase and underscore → kebab-case
8. Document required MCP env vars in README

**Re-run after fixes**: Target overall score ≥85% (Grade B).
