# Best Practices Reference

Rationale, anti-patterns, and quick-fix guidance for each component type.

---

## Skill Types

### Codemie-Delegating Skills: Reduced Rubric Applies

**What they are**: Thin wrapper skills that route a user request to a Codemie AI assistant via API (`codemie assistants chat <uuid>`). They do not execute local tool calls, have no step-by-step workflow, and do not control output format — the backend assistant handles all of that.

**Detection**:
```bash
grep -i "codemie.*assistant\|codemie.*chat\|assistants chat" SKILL.md
```

**What to skip** (do NOT penalise for these — they are architecturally N/A):
- `allowed-tools` — no local tool execution happens
- Methodology / workflow section — delegation is the entire process
- Output format section — determined by the assistant
- Examples section — invocation differs from standard skills
- Checklists — no process steps to enumerate

**What still matters** (always assessed):
- Identity: name convention, description quality (users still need to find and trigger it)
- Technical hygiene: especially **no hardcoded UUIDs** (see below)
- Design: single responsibility, clear triggers, token budget

---

## Skills

### ✅ Description: Third-person with specific trigger phrases

**Why it matters**: The `description` field is the only signal Claude uses to decide whether to load a skill. Vague descriptions cause the skill to never load (misses) or load on unrelated tasks (false positives). Specific trigger phrases make the skill predictable.

```yaml
# ✅ Good — third person, specific phrases
description: This skill should be used when the user asks to "commit changes",
  "create a conventional commit", "stage and commit", or wants to write a commit
  message following the conventional commits standard.

# ❌ Bad — vague, wrong person, no triggers
description: Use this skill for git operations and commits.
```

### ✅ `allowed-tools`: Always specify explicitly

**Why it matters**: Without `allowed-tools`, Claude defaults to its full toolset. Explicit restrictions enforce least-privilege and prevent a documentation skill from accidentally running shell commands.

```yaml
# ✅ Good
allowed-tools: [Read, Grep, Glob]

# ❌ Bad — missing entirely (defaults to unconstrained)
# (no allowed-tools field in frontmatter)
```

### ✅ Keep SKILL.md lean — move details to `references/`

**Why it matters**: SKILL.md loads into context every time the skill triggers. A 6,000-token SKILL.md consumes substantial context even when 80% of the content isn't relevant to the current task. Lean SKILL.md + on-demand references = efficient context use.

**Target**: SKILL.md body 1,500–2,000 words. Move detailed docs to `references/`.

### ✅ Single focused purpose

**Why it matters**: Multi-purpose skills have ambiguous trigger conditions ("does this trigger for commits OR for PRs?") and are harder to maintain (fixing a commit bug might break the PR flow).

```
# ✅ Good
name: commit-helper          # one responsibility: commits
name: pr-creator             # one responsibility: pull requests

# ❌ Bad — three concerns in one
name: git-workflow-helper    # commits + PRs + branch management
```

### ✅ Include actionable checklists (`- [ ]`)

**Why it matters**: Checklists make the skill's criteria explicit and verifiable. They give the executing Claude instance something to tick off, reducing missed steps.

---

## Agents

### ✅ Always specify `model:`

**Why it matters**: Without a model, Claude selects the default. The default may be over-powered (costly for simple classification) or under-powered (Haiku for complex reasoning). Explicit model choice is an intentional architectural decision.

```yaml
# ✅ Good — match model to task complexity
model: claude-haiku-4-5-20251001    # fast lookups, classification
model: claude-sonnet-4-6            # balanced reasoning, most tasks
model: claude-opus-4-6              # complex analysis, architecture
model: inherit                       # intentionally use calling context's model

# ❌ Bad — no model
# (no model: field)
```

**`model: inherit` is valid**: It means the agent deliberately adopts the model of whoever invokes it. This is a legitimate architectural choice (e.g., when agents are invoked from other agents and should match capability). Do **not** penalise `model: inherit` — penalise only a missing `model:` field entirely.

### ✅ Justify powerful tools inline

**Why it matters**: Bash is the most powerful and risky tool, but Write, Edit, WebFetch, and WebSearch also have significant side effects. An agent with an 8-tool list gives no signal about why each tool is needed. Justification creates an audit trail and forces minimum-privilege thinking.

**Rule**: Any tool from `[Bash, Write, Edit, WebFetch, WebSearch]` in a tool list of 4+ tools should be accompanied by an inline comment within 3 lines of the `tools:` declaration.

```yaml
# ✅ Good — comment immediately after tools line
tools: [Read, Grep, Bash]
# Bash required for: git diff, git log to inspect changed files

# ✅ Also good — comment on same line (if format allows)
tools: [Glob, Grep, Read, WebFetch, TodoWrite, WebSearch, Edit, Write, Bash]
# Bash: run tests/scripts; Edit/Write: create spec files; WebFetch/WebSearch: look up API docs

# ❌ Bad — no justification for Bash (or any powerful tool)
tools: [Read, Grep, Glob, Bash, Write, WebFetch]
# (nothing explaining why Bash, Write, or WebFetch are needed)
```

**Partial credit**: A comment that says "for running commands" or "for file operations" is better than nothing but too vague — partial credit applies.

### ✅ Description: Third-person with trigger phrases and negative cases

**Why it matters**: The description determines when the agent auto-loads. Three failure modes exist:
1. **Second-person user-directed** ("Use this agent when **you** need to…") — places the user as subject; awkward in agent routing context
2. **Object-directed but no negatives** ("Use this agent when the user requests…") — acceptable but incomplete
3. **Third-person with positives AND negatives** — ideal; routes correctly and prevents over-invocation

```yaml
# ✅ Best — third person, positive triggers, negative cases
description: |-
  This agent should be invoked when code needs to be reviewed for quality or security.
  Invoke after completing a feature, bug fix, or refactor.
  Do NOT invoke for: architecture decisions, test writing, or deployment tasks.

# ⚠️ Acceptable — object-directed, missing negative cases
description: |-
  Use this agent when the user requests a code review.
  Focuses on Git-tracked changes only.

# ❌ Bad — user-directed second person, vague
description: Use this agent when you need to review code.
```

**Scoring**: Full pass → third-person with negatives; partial → "Use this agent when the user…" with triggers; lower partial → "Use this agent when you…" with triggers.

### ✅ Include anti-hallucination guardrails

**Why it matters**: Without explicit instructions, agents confidently state incorrect information (wrong version numbers, invented API signatures, fabricated statistics). Guardrails reduce this significantly.

```markdown
# ✅ Good — explicit guardrails
## Source Verification
- Cite documentation or tool output when stating facts
- State "I don't have verified info on..." when uncertain
- Never invent: statistics, version numbers, API signatures, error messages

# ❌ Bad — no accuracy guidance at all
```

### ✅ Define scope with negative cases ("When NOT to use")

**Why it matters**: Without negative cases, agents are invoked for everything related to their domain. A "code-reviewer" agent without negative cases might be invoked to review architecture decisions — which is a separate concern.

```markdown
# ✅ Good
## Scope
**DO NOT use this agent for**: architecture decisions, test writing, deployment.
Use `solution-architect` agent for architecture. Use `test-writer` for tests.
```

### ✅ "You are…" role statement

**Why it matters**: Role statements calibrate the agent's persona, expertise level, and decision-making style. Without one, behavior is generic and inconsistent across tasks.

```markdown
# ✅ Good
You are a senior security engineer with expertise in OWASP Top 10 and secure
code review. Your job is to identify real vulnerabilities, not style issues.

# ❌ Bad — no role
# (starts directly with instructions, no persona)
```

---

## CLAUDE.md

### ✅ Keep CLAUDE.md short — ≤400 non-code words

**Why it matters**: Claude reads CLAUDE.md at the start of every session. Bloated files cause rules to get lost — Claude may miss instructions buried in long prose. The official guidance: *"For each line, ask: 'Would removing this cause Claude to make mistakes?' If not, cut it."*

**Target**: ≤400 words of non-code text. Use code blocks freely (they're scanned, not parsed as prose).

```markdown
# ✅ Good — lean, verb-first, essential only
## Code Style
- ES modules only (import/export), never require()
- .js extension on all imports
- Throw specific error classes from src/utils/errors.ts

## Workflow
- Run `npm run lint` after any TypeScript change
- NEVER commit to main directly — use feature branches

# ❌ Bad — bloated with obvious or redundant content
## Code Style
TypeScript is a strongly typed superset of JavaScript that helps catch errors.
You should write clean code that follows best practices. Variable names should
be meaningful and descriptive. Use camelCase for variables and PascalCase for
classes, which is the standard TypeScript convention...
```

**Pruning test**: If Claude already follows a rule without being told, delete it. If the rule is about standard language conventions (camelCase, etc.), delete it. If it's project-specific and non-obvious, keep it.

### ✅ Use `@import` to delegate detail

**Why it matters**: `@path/to/file` tells Claude to load that file into context when relevant. This keeps CLAUDE.md lean while making detailed guides available on demand — same progressive disclosure principle as skills.

```markdown
# ✅ Good — delegates without embedding
See @README.md for project overview.

# Git workflow
@docs/git-instructions.md

# Architecture decisions
@.codemie/guides/architecture/architecture.md

# ❌ Bad — all detail copy-pasted into CLAUDE.md
## Architecture (500 words of inline architecture prose...)
```

**When to use `@import`**: Any time CLAUDE.md references a file ("see the architecture guide"), replace the pointer with an actual `@path` reference.

### ✅ Choose one knowledge organisation pattern — and use it consistently

**Why it matters**: There are two valid ways to organise deep project knowledge for Claude. Both work well. Using both at once creates confusion about where knowledge lives.

---

**Pattern A: Single CLAUDE.md + Guide Files**

One lean root CLAUDE.md acts as an index with path references; all detail lives in separate guide files that Claude reads on demand.

```
# ✅ Good — Pattern A
./CLAUDE.md                        ← lean index, references guides by path
./.codemie/guides/architecture.md  ← architecture detail
./.codemie/guides/testing.md       ← testing patterns
./docs/git-instructions.md         ← git workflow
```

CLAUDE.md should reference these guides by actual path so Claude loads them when needed:
```markdown
# Architecture
See .codemie/guides/architecture/architecture.md for layer patterns.

# Testing
See .codemie/guides/testing/testing-patterns.md for Vitest patterns.
```

**Best for**: Projects with rich domain knowledge (many guides), or teams wanting a single source of truth with CLAUDE.md as a navigator.

---

**Pattern B: Hierarchical CLAUDE.md**

Multiple CLAUDE.md files at different directory depths, each scoped to its level. Claude automatically loads parent-directory CLAUDE.md files when working in subdirectories.

```
# ✅ Good — Pattern B
./CLAUDE.md                    ← project-wide: Node 20+, git workflow, ESLint
./packages/api/CLAUDE.md       ← api-only: Express patterns, OpenAPI conventions
./packages/frontend/CLAUDE.md  ← frontend-only: React, CSS modules, Vite

# ❌ Bad — Pattern B with duplication
./CLAUDE.md              ← has Node.js conventions
./packages/api/CLAUDE.md ← repeats the same Node.js conventions
```

**Best for**: Monorepos where different packages have genuinely different tech stacks or conventions.

---

**Detection commands** (run both to identify which pattern is in use):
```bash
# Find all CLAUDE.md files
find . -name "CLAUDE.md" -o -name "CLAUDE.local.md" | grep -v node_modules | sort

# Find guide directories (Pattern A signal)
find . -type d \( -name 'guides' -o -name '.codemie' \) | grep -v node_modules

# Check git tracking
git ls-files CLAUDE.md

# Check CLAUDE.local.md is gitignored
grep CLAUDE.local.md .gitignore
```

### ✅ Use MANDATORY / NEVER / ALWAYS with trigger conditions

**Why it matters**: Vague guidance ("try to follow…", "consider using…") is deprioritized when Claude is making decisions. Explicit directives with trigger conditions are followed consistently.

```markdown
# ✅ Good — directive + trigger + rationale
🚨 MANDATORY: When user says "commit", NEVER use `git commit --no-verify`.
   If a hook fails, fix the underlying issue first.

# ❌ Bad — vague
Try to avoid skipping git hooks when possible.
```

### ✅ Include a keyword/trigger table

**Why it matters**: CLAUDE.md is read on every task. A task classifier table lets Claude quickly identify which rules apply to the current task, rather than re-reading everything every time.

```markdown
# ✅ Good
| Keyword | Load Guide / Rule |
|---------|------------------|
| "commit", "push" | Follow Git Policy |
| "test", "spec" | Follow Testing Policy (write tests ONLY if asked) |
| TypeScript | Use strict mode, .js imports |
```

### ✅ Show ✅/❌ examples for critical rules

**Why it matters**: Abstract rules ("use meaningful variable names") are interpreted differently. Concrete examples remove ambiguity.

```markdown
# ✅ Good
## Import Style
✅ `import { foo } from './utils.js'`
❌ `import { foo } from './utils'`     ← missing .js extension
❌ `const { foo } = require('./utils')` ← no CommonJS
```

### ✅ Never contradict yourself

**Anti-pattern to avoid**: Having `Always use npm` in one section and `Use pnpm for dependencies` in another. Claude will pick one inconsistently, and behavior becomes unpredictable.

**Prevention**: Search CLAUDE.md for tool names and compare all mentions before writing a new rule.

---

## Commands

### ✅ `argument-hint` is mandatory when using `$ARGUMENTS`

**Why it matters**: Without `argument-hint`, the slash-complete UI shows no hint. Users don't know what to type and the command appears broken.

```yaml
# ✅ Good
argument-hint: "<ticket-id> [--dry-run] [--priority high|medium|low]"

# ❌ Bad — uses $ARGUMENTS but no hint
# (no argument-hint field, $ARGUMENTS appears in body)
```

### ✅ Phase-based workflow for auditability

**Why it matters**: Numbered phases make command execution auditable ("it failed in Phase 3"). Users understand progress and can debug failures.

```markdown
# ✅ Good
## Phase 1: Validate Input
## Phase 2: Generate Content
## Phase 3: Confirm and Execute

# ❌ Bad — flat instructions
Run git status. Then commit. Then push.
```

### ✅ Always handle the failure path

**Why it matters**: Commands that don't handle failures leave users stranded with no error context and no path forward.

```markdown
# ✅ Good
## Error Handling
| Error | Action |
|-------|--------|
| API unreachable | Save draft to ./draft.md, print error |
| Invalid input | Show usage hint, exit cleanly |

# ❌ Bad — no failure cases mentioned at all
```

---

## Hooks

### ✅ Scope matchers to specific tools

**Why it matters**: A wildcard matcher (`.*`) runs on every tool use, adding latency to every action Claude takes. Overly broad hooks also create unexpected side effects.

```json
// ✅ Good — targets specific tool
{"matcher": "Bash", "hooks": [...]}
{"matcher": "Write|Edit", "hooks": [...]}

// ❌ Bad — matches everything
{"matcher": ".*", "hooks": [...]}
{"matcher": "", "hooks": [...]}
```

### ✅ Scripts must handle failures explicitly

**Why it matters**: A hook script that crashes without a clean exit blocks the tool use it's attached to. Users see cryptic failures with no context.

```bash
#!/usr/bin/env bash
# ✅ Good
set -e
trap 'echo "Hook failed on line $LINENO" >&2' ERR

# ❌ Bad — no error handling
curl https://api.example.com/log -d "$CLAUDE_TOOL_INPUT"
```

### ✅ Never hardcode credentials in hook commands

**Why it matters**: `settings.json` is often committed to version control. Hardcoded tokens in hooks become exposed credentials in git history.

```json
// ✅ Good — env var reference
"command": "bash -c 'curl $API_URL -H \"Authorization: Bearer $MY_TOKEN\"'"

// ❌ Bad — literal token in config
"command": "bash -c 'curl https://api.example.com -H \"Authorization: Bearer sk-abc123\"'"
```

---

## MCP Config

### ✅ Use env var references for all credentials

**Why it matters**: `.mcp.json` is often committed to repositories and shared across teams. Literal credentials become a security incident.

```json
// ✅ Good
"env": {
  "API_KEY": "${MY_SERVICE_API_KEY}",
  "DATABASE_URL": "${DATABASE_URL}"
}

// ❌ Bad
"env": {
  "API_KEY": "YOUR_API_KEY_HERE",
  "DATABASE_URL": "postgres://user:pass@prod-host/db"
}
```

### ✅ Document required env vars

**Why it matters**: New team members cloning the repo can't use your MCP servers if they don't know which env vars to configure. This creates a "works on my machine" problem.

**Do this**: Add a `.env.example` file or a `## MCP Configuration` section to `CLAUDE.md` listing:
- Server name
- Required env var name
- Where to get the value
- Example value format (not real value)

### ✅ Use descriptive server names

**Why it matters**: `server1`, `mcp`, `test` give no information about what the server does. Descriptive names help Claude and team members understand the ecosystem at a glance.

```json
// ✅ Good
"mcpServers": {
  "jira": {...},
  "github": {...},
  "postgres-analytics": {...}
}

// ❌ Bad
"mcpServers": {
  "server1": {...},
  "mcp": {...},
  "test": {...}
}
```

---

## Common Anti-Patterns Quick Reference

| Anti-Pattern | Component | Impact | Fix |
|--------------|-----------|--------|-----|
| Second-person in skill description ("Use this skill when you…") | Skill | Poor triggering | Rewrite as third-person: "This skill should be used when…" |
| User-directed agent description ("Use this agent when you need to…") | Agent | Awkward routing | Use "Use this agent when the user requests…" or full third-person |
| No negative cases in agent description | Agent | Over-invocation | Add "Do NOT invoke for: X, Y, Z" |
| Missing `model:` field | Agent | Unpredictable cost/quality | Add explicit model; `model: inherit` is valid if intentional |
| Powerful tools (Bash/Write/Edit) with no inline comment | Agent | Security risk, no audit trail | Add `# <Tool> required for: [reason]` within 3 lines of `tools:` |
| Wall of text CLAUDE.md | CLAUDE.md | Rules ignored | Add H2 sections + tables |
| No `argument-hint` | Command | Poor UX | Add `argument-hint: "<description>"` |
| `.*` matcher in hook | Hook | Latency + side effects | Scope to specific tool name |
| Hardcoded token in `.mcp.json` | MCP | Security incident | Use `${ENV_VAR_NAME}` pattern |
| Multi-purpose skill ("does X AND Y AND Z") | Skill | Ambiguous triggers | Split into separate skills |
| Vague guidance ("be careful") | CLAUDE.md | Rules ignored | Replace with explicit directives |
| No usage examples in agent | Agent | Unpredictable invocation | Add `## Examples` with 3+ invocation cases |
| "You are…" role statement missing or buried | Agent | Weak persona calibration | Add "You are a [role]…" as first line of body |
| No anti-hallucination section | Agent | Accuracy issues | Add "Source Verification" section OR "FIRST STEP: Read [guide]" |
| Agent references no guides or other components | Agent | Poor grounding | Reference project guides or related skills/agents |
