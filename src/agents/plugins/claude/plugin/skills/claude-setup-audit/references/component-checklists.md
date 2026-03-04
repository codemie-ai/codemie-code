# Component Scoring Checklists

Full scoring rubrics for all Claude Code components. Use during Phase 2 of the assessment.

**Scoring logic per criterion:**
- ✅ Pass → full points
- ⚠️ Partial → half points (present but incomplete/weak — round down)
- ❌ Fail → 0 points

---

## Skill Type Classification

Run this check **before** applying any scoring rubric to a skill file.

```bash
grep -i "codemie.*assistant\|codemie.*chat\|assistants chat" SKILL.md
```

| Result | Skill Type | Rubric to Apply |
|--------|-----------|----------------|
| Match found | **Codemie-delegating** — thin API wrapper that routes to a Codemie assistant backend | Reduced rubric (21 pts max, see below) |
| No match | **Standard skill** — executes locally via Claude tool calls | Full rubric (32 pts max) |

### Codemie-Delegating Skill: Exemptions Table

These criteria are **N/A** (skip, do not score, do not penalise):

| Criterion | Why exempted |
|-----------|-------------|
| S1.4 `allowed-tools` | No local tool execution — the assistant handles it |
| S2.1 Methodology/workflow | No local workflow steps — delegation is the entire "workflow" |
| S2.2 Output format | Output is determined by the backend assistant |
| S2.3 Examples | Usage pattern differs from standard skills; not applicable |
| S2.4 Checklists | No step-by-step process to check off |

**Applicable criteria for codemie-delegating skills** (21 pts max):
- S1.1 (3), S1.2 (3), S1.3 (3) — identity always matters
- S3.1 (1), S3.2 (1, **includes UUID check — see below**), S3.3 (1), S3.4 (1) — technical hygiene
- S4.1 (2), S4.2 (2), S4.3 (2), S4.4 (2) — design quality

**Scoring formula for codemie-delegating skills**:
```
Score = (points obtained from applicable criteria / 21) × 100
```

---

## Skills (32 points max)

### Structure (weight 3×) — 12 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| S1.1 | Valid SKILL.md filename or frontmatter | 3 | Filename == `SKILL.md` OR YAML frontmatter with `name:` field | File correctly identified as skill |
| S1.2 | Name follows convention | 3 | Frontmatter `name:` matches `^[a-z0-9-]{1,64}$` | Lowercase, hyphens only, 1–64 chars |
| S1.3 | Description non-empty | 3 | `description` field exists and length >20 chars | Not empty, not placeholder text |
| S1.4 | `allowed-tools` specified | 3 | Frontmatter has `allowed-tools:` field | List or `all` value present |

**Partial credit (⚠️)**:
- S1.2: Name exists but uses underscores or has uppercase → 1.5 pts
- S1.3: Description exists but <20 chars or is generic ("A skill for…") → 1.5 pts
- S1.4: `allowed-tools` present but empty list `[]` → 1.5 pts

### Content (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| S2.1 | Methodology or workflow described | 2 | Section titled `Methodology`, `Workflow`, `Process`, or numbered steps present | Structured process documented |
| S2.2 | Output format specified | 2 | Section `Output`, `Format`, `Deliverables`, or explicit output type mentioned | Output shape defined |
| S2.3 | Examples provided | 2 | Section `Examples`, `Usage`, `Scenarios` with code blocks or concrete instances | ≥1 concrete example |
| S2.4 | Actionable checklists | 2 | Markdown checkboxes `- [ ]` or `- [x]` present | ≥3 checklist items |

**Partial credit (⚠️)**:
- S2.1: Steps exist but not organized (bullet list without numbering) → 1 pt
- S2.3: Examples section exists but examples are abstract/vague → 1 pt
- S2.4: Checkboxes present but <3 items → 1 pt

### Technical (weight 1×) — 4 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| S3.1 | No hardcoded absolute paths | 1 | Grep for `/Users/`, `/home/[a-z]`, `C:\`, `D:\` | None found in SKILL.md or bundled scripts |
| S3.2 | No plaintext secrets | 1 | Grep for `password\s*=`, `api_key\s*=`, `token\s*=` with literal values | None found (comments about avoiding secrets OK) |
| S3.3 | Script error handling | 1 | If `.sh`/`.bash` files exist: grep for `set -e`, `trap`, `\|\| exit` | All scripts have error handling, or no scripts |
| S3.4 | Dependencies documented | 1 | If external tools required: section `Requirements`, `Dependencies`, or `Prerequisites` | Prerequisites stated or no external deps |

### Design (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| S4.1 | Single responsibility | 2 | Token count <5000 AND description avoids: `general`, `multi-purpose`, `various` | One focused domain |
| S4.2 | Clear trigger conditions | 2 | Content has `When to use`, `Triggers`, `Activation`, or `Use cases` | User knows when to invoke |
| S4.3 | No significant overlap | 2 | Jaccard similarity with other skills <0.5 | <50% keyword overlap with siblings |
| S4.4 | Token budget respected | 2 | Total file size estimate (words × 1.3) <8000 tokens | Does not bloat context |

---

## Agents / Subagents (32 points max)

### Identity (weight 3×) — 12 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| A1.1 | Descriptive name | 3 | `name:` not matching: `agent\d+`, `test`, `example`, `helper`, `assistant` | Meaningful, domain-specific name |
| A1.2 | Description with trigger context | 3 | Description uses third-person ("This agent should be invoked when…") with `when`/`trigger` keywords; includes negative cases | User knows when AND when NOT to invoke |
| A1.3 | Model specified | 3 | Frontmatter `model:` field is present with a value — `inherit`, `sonnet`, `opus`, `haiku` all count | Model explicitly declared (even `inherit` is valid) |
| A1.4 | Tools appropriately restricted | 3 | All powerful/non-obvious tools justified: Bash AND any of Write/Edit/WebFetch/WebSearch need inline `# <tool> required for: <reason>` comment within 3 lines of `tools:` line | Least-privilege; intent clear |

**Partial credit (⚠️)**:
- A1.1: Name is generic but somewhat descriptive (e.g., "reviewer") → 1.5 pts
- A1.2: Uses "Use this agent when the user…" (object-directed) with trigger phrases → 1.5 pts; uses "Use this agent when you…" (user-directed second person) with triggers → 1 pt
- A1.4: Bash/powerful tools present with partial/non-proximate justification OR ≤3 tools total (minimal set) → 1.5 pts

**A1.3 note**: `model: inherit` means the agent deliberately uses the calling context's model. This is an intentional architectural decision — score as full pass. Only penalise when `model:` field is entirely absent.

### Prompt Quality (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| A2.1 | Role statement defined | 2 | First paragraph of body starts with `You are` OR contains `You are a/an [role]` within first 5 lines | Agent has clear, explicit persona at the top |
| A2.2 | Output format specified | 2 | Section `Output`, `Format`, `Deliverables`, or inline `## Output Format` / `### Structure` present | Output structure defined |
| A2.3 | Scope and limits defined | 2 | Section/content: `Scope`, `Limits`, `When NOT to use`, `What to AVOID`, `Do NOT`, `Triggers` | Boundaries explicit |
| A2.4 | Anti-hallucination measures | 2 | Any of: `verify`, `cite`, `source`, `evidence`, `don't invent`, `hallucination`, `when uncertain`, `only use verified`, `based on`, `read.*first`, `check.*guide`, `FIRST STEP.*read` | Accuracy guardrails present |

**Partial credit (⚠️)**:
- A2.1: Role implied through purpose statement (`**Purpose**: You will…`) or `## Your Core Mission` with first-person instructions but no "You are…" opener → 1 pt
- A2.3: Scope mentioned briefly but no negative cases defined → 1 pt
- A2.4: Some accuracy guidance but not explicit (e.g., "be accurate", "reference docs") → 1 pt

**A2.4 note**: Agents that instruct reading project guides before acting (`FIRST STEP: Read .codemie/guides/…`) provide implicit hallucination guardrails — count as partial pass (1 pt) if no explicit "when uncertain" language exists.

### Validation (weight 1×) — 4 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| A3.1 | 3+ usage examples | 1 | `Examples`, `Usage`, `Scenarios` section with ≥3 distinct entries | Sufficient usage coverage |
| A3.2 | Edge cases documented | 1 | Keywords: `edge case`, `corner case`, `error`, `failure`, `limitation` | Failure modes acknowledged |
| A3.3 | Error handling described | 1 | Keywords: `fallback`, `recovery`, `error handling`, `failure mode`, `graceful` | Recovery strategy present |
| A3.4 | Integration documented | 1 | References other agents, skills, or tools: `uses`, `integrates`, `works with`, `see also` | Ecosystem fit stated |

### Design (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| A4.1 | Single responsibility | 2 | Token count <5000 AND description avoids: `general`, `multi-purpose`, `various`, `all` | One focused domain |
| A4.2 | No duplication | 2 | Jaccard similarity with other agents <0.5 | <50% overlap with siblings |
| A4.3 | Composable | 2 | References skills, agents, or project guides: `skill:`, `invoke`, `delegate`, `uses`, `see also`, or direct path refs (`guides/`, `.codemie/`, `SKILL.md`) | Leverages ecosystem — agents, skills, or project knowledge base |
| A4.4 | Token budget | 2 | File size (words × 1.3) <8000 tokens | Context-efficient |

**A4.3 partial credit (⚠️)**: Agent references project guide files (`.codemie/guides/`, `CLAUDE.md`) for grounding but does not explicitly reference other agents or skills → 1 pt.

---

## CLAUDE.md Rules (36 points max)

### Coverage (weight 3×) — 9 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| R1.1 | Coding standards defined | 3 | Section on code style, language conventions, import patterns, or tooling | Style guidance present |
| R1.2 | Workflow policies stated | 3 | Git, testing, deployment, or PR policies explicitly documented | Process guidance present |
| R1.3 | Critical rules with triggers | 3 | Contains `MANDATORY`, `NEVER`, `ALWAYS`, `CRITICAL` with trigger conditions | Non-negotiables documented |

**Partial credit (⚠️)**:
- R1.1: Brief style mentions but no concrete rules → 1.5 pts
- R1.3: "Always/Never" keywords present but no trigger context → 1.5 pts

### Clarity (weight 3×) — 9 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| R2.1 | Actionable instructions | 3 | Instructions start with verbs; avoids vague words: `try`, `consider`, `be careful` | Commands are executable |
| R2.2 | Trigger conditions stated | 3 | Rules specify when they apply: `when user says`, `if file is`, `for TypeScript` | Context is unambiguous |
| R2.3 | Prohibitions explicit | 3 | `Never`, `Do not`, `Avoid` with concrete examples of what NOT to do | Forbidden actions are clear |

**Partial credit (⚠️)**:
- R2.1: Mix of actionable and vague instructions → 1.5 pts
- R2.3: General warnings but no concrete examples → 1.5 pts

### Structure (weight 2×) — 6 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| R3.1 | Section organization | 2 | ≥3 distinct H2 sections (not a wall of text) | Scannable and navigable |
| R3.2 | Quick-reference tables | 2 | ≥1 markdown table summarizing rules or commands | Fast lookup exists |
| R3.3 | Pattern examples | 2 | Shows ✅/❌ patterns or code blocks with correct vs incorrect | Good vs bad demonstrated |

### Maintenance (weight 1×) — 6 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| R4.1 | No contradictions | 2 | Rules don't conflict (manual review) | Consistent guidance |
| R4.2 | Technology versions noted | 2 | Stack versions mentioned: `Node >=20`, `Python 3.11+`, etc. | Version requirements clear |
| R4.3 | Project context present | 2 | Project name, purpose, or team context stated | Reader understands the project |

### Efficiency (weight 2×) — 6 points

**Before scoring R5.3, detect the knowledge organisation pattern:**

```bash
find . -name 'CLAUDE.md' | grep -v node_modules | wc -l   # count
find . -type d \( -name 'guides' -o -name '.codemie' \) | grep -v node_modules  # guide dirs
```

| Pattern | Detection | R5.3 scoring |
|---------|-----------|-------------|
| **A — Single CLAUDE.md + Guide Files** | 1 CLAUDE.md + guide/reference dirs present | Full credit if CLAUDE.md references guide paths |
| **B — Hierarchical CLAUDE.md** | Multiple CLAUDE.md at different dir depths | **N/A** — hierarchy IS the delegation; auto-pass R5.3 |

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| R5.1 | Concise body | 2 | Non-code-block word count ≤400 words per file | Short enough that all rules are noticed |
| R5.2 | No anti-pattern content | 2 | Does NOT contain: file-by-file descriptions, standard conventions Claude already knows, self-evident advice ("write clean code", "be careful") | Pruned of noise |
| R5.3 | Delegates detail appropriately | 2 | **Pattern A**: CLAUDE.md references guide files by path; **Pattern B**: N/A (auto-pass) | Detail offloaded via the chosen pattern |

**Partial credit (⚠️)**:
- R5.1: 400–700 words → 1 pt; >700 words → 0 (applies to every CLAUDE.md file regardless of pattern)
- R5.2: A few self-evident statements but critical rules still clear → 1 pt
- R5.3 (Pattern A only): Guide files exist but CLAUDE.md describes them vaguely without path refs → 1 pt

**R5.1 word count** (exclude code blocks):
```python
import re
def non_code_words(text: str) -> int:
    no_code = re.sub(r'```.*?```', '', text, flags=re.DOTALL)
    return len(no_code.split())
```

**R5.2 anti-pattern detection**:
```bash
grep -n "\.md does\|\.ts does\|^- \`src/" CLAUDE.md       # file-by-file descriptions
grep -ni "write clean\|be careful\|good code\|best practice" CLAUDE.md  # self-evident advice
```

---

## CLAUDE.md Knowledge Organisation Check

Apply this **after** per-file scoring. This is a **cross-component analysis** (Phase 3).

### Two Valid Patterns — Detect First

Both patterns are correct. Do NOT penalise a repo for not using the other pattern.

**Pattern A: Single CLAUDE.md + Guide Files**
One root CLAUDE.md acts as an index; domain knowledge lives in separate guide files that CLAUDE.md references by path.
```
./CLAUDE.md                       ← lean index, references guides by path
./.codemie/guides/architecture.md ← detail here
./.codemie/guides/testing.md
```

**Pattern B: Hierarchical CLAUDE.md**
Multiple CLAUDE.md files at different directory levels, each scoped to its context level.
```
./CLAUDE.md                       ← project-wide rules
./packages/api/CLAUDE.md          ← api-specific context only
./packages/frontend/CLAUDE.md     ← frontend-specific context only
```

**Mixed pattern flag**: Having both subdir CLAUDE.md files AND a separate guides directory without clear ownership → 🔵 Minor inconsistency.

### Pattern A Checks

| Check | Severity | Detection |
|-------|----------|-----------|
| CLAUDE.md doesn't reference guide files by path | 🟡 Important | Guide dirs exist but no path refs to them in CLAUDE.md |
| `CLAUDE.local.md` not gitignored | 🔴 Critical | `grep CLAUDE.local.md .gitignore` → empty |
| Root not git-tracked | 🟡 Important | `git ls-files CLAUDE.md` → empty |

### Pattern B Checks

| Check | Severity | Detection |
|-------|----------|-----------|
| Root `CLAUDE.md` missing but subdir ones exist | 🟡 Important | No `./CLAUDE.md` but subdir files found |
| Subdir duplicates root content | 🟡 Important | Jaccard similarity >0.3 between subdir and root |
| Subdir contains project-wide rules | 🟡 Important | Subdir mentions stack/tooling that applies everywhere |
| `CLAUDE.local.md` not gitignored | 🔴 Critical | `grep CLAUDE.local.md .gitignore` → empty |
| Root not git-tracked | 🟡 Important | `git ls-files CLAUDE.md` → empty |
| Monorepo missing per-package CLAUDE.md | 🔵 Minor | `packages/*/` dirs exist but none have CLAUDE.md |

---

## Commands (20 points max)

### Structure (weight 3×) — 12 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| C1.1 | Valid frontmatter | 3 | YAML frontmatter with `name:` AND `description:` fields | Identity established |
| C1.2 | Argument hint present | 3 | If `$ARGUMENTS` in body: frontmatter has `argument-hint:` | Usage hints visible in slash-complete |
| C1.3 | Step-by-step workflow | 3 | Numbered phases (Phase 1…, 1., 2.) or clear H2 sections | Structured process |
| C1.4 | Usage examples | 3 | Section `Usage`, `Examples` with invocation patterns | Invocation shown |

**Partial credit (⚠️)**:
- C1.2: Hint present but vague (e.g., `"[args]"`) → 1.5 pts
- C1.3: Some structure but missing step numbers/phases → 1.5 pts

### Quality (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| C2.1 | Error handling | 2 | Keywords: `error`, `failure`, `fallback`, `if fails`, `on failure` | Failure cases addressed |
| C2.2 | Output format defined | 2 | Specifies what command produces (report, file, summary) | Output shape documented |
| C2.3 | Validation gates | 2 | Keywords: `checkpoint`, `verify`, `validate`, `before proceeding`, `confirm` | Safety checks present |
| C2.4 | Argument parsing shown | 2 | If `$ARGUMENTS` used: shows parsing (defaults, validation, conditional logic) | Arg handling demonstrated |

---

## Hooks (20 points max)

### Validity (weight 3×) — 6 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| H1.1 | Valid JSON structure | 3 | File parses as valid JSON; hooks is an array | Syntactically correct |
| H1.2 | Recognized event types | 3 | Event values in: `PreToolUse`, `PostToolUse`, `Stop`, `SubagentStop`, `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreCompact`, `Notification` | Known lifecycle events only |

### Security (weight 2×) — 8 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| H2.1 | No hardcoded credentials | 4 | Grep env/command values for: `password`, `secret`, `token`, `key` with literal values | Env var refs only, no literals |
| H2.2 | Scripts use error handling | 4 | Bash commands in hooks use `set -e`, `trap`, or `\|\| exit` | Scripts exit cleanly on failure |

### Quality (weight 2×) — 6 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| H3.1 | Scoped matchers | 3 | Matchers target specific tools or patterns, not `.*` or empty | Minimum necessary scope |
| H3.2 | Purpose documented | 3 | `description` field in each hook OR adjacent README explains purpose | Intent is clear |

---

## MCP Config (20 points max)

### Structure (weight 3×) — 9 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| M1.1 | Valid JSON | 3 | File parses as valid JSON | Syntactically correct |
| M1.2 | `mcpServers` key present | 3 | Top-level key `mcpServers` exists as an object | Standard structure used |
| M1.3 | Server definitions complete | 3 | Each server has `command` (stdio) or `url` (SSE/HTTP) | Required fields present |

### Security (weight 2×) — 6 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| M2.1 | No hardcoded secrets | 3 | No literal values for `password`, `token`, `key`, `secret` in env sections | Credentials not in config file |
| M2.2 | Env vars for credentials | 3 | Credentials use `${ENV_VAR}` pattern | Env var references used |

### Documentation (weight 2×) — 5 points

| ID | Criterion | Pts | Detection | Pass Condition |
|----|-----------|-----|-----------|----------------|
| M3.1 | Descriptive server names | 2 | Server keys are meaningful (not `server1`, `test`, `mcp`) | Names indicate purpose |
| M3.2 | Required env vars documented | 3 | README.md, `.env.example`, or CLAUDE.md lists required vars | Setup is documented |

---

## Detection Utilities

### Frontmatter Parser (Python)
```python
import re, yaml

def parse_frontmatter(content: str) -> dict:
    m = re.search(r'^---\n(.*?)\n---', content, re.DOTALL)
    return yaml.safe_load(m.group(1)) if m else {}
```

### Token Estimate
```python
def estimate_tokens(text: str) -> int:
    return int(len(text.split()) * 1.3)  # 1 token ≈ 0.75 words
```

### Jaccard Similarity (overlap detection)
```python
def jaccard(text1: str, text2: str) -> float:
    s1 = set(text1.lower().split())
    s2 = set(text2.lower().split())
    return len(s1 & s2) / len(s1 | s2) if (s1 | s2) else 0.0
# Flag if result > 0.5
```

### Security Grep
```bash
grep -rn \
  -e '/Users/' \
  -e '/home/[a-z]' \
  -e 'password\s*=' \
  -e 'api_key\s*=' \
  -e 'token\s*=' \
  .claude/ .mcp.json \
  --include="*.md" --include="*.json" --include="*.sh" 2>/dev/null \
  | grep -v "node_modules" \
  | grep -v "# "   # skip comment lines
```

### Grade Calculator
```python
def grade(score: float) -> str:
    if score >= 90: return "A"
    if score >= 80: return "B"
    if score >= 70: return "C"
    if score >= 60: return "D"
    return "F"

def score(obtained: float, max_pts: float) -> float:
    return round((obtained / max_pts) * 100, 1)
```
