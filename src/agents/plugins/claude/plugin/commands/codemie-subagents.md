# Codemie Subagents - Generate Project-Specific Subagent Files

**Command Name**: `codemie-subagents`
**Description**: Generate project-specific subagent files from templates by analyzing codebase and existing guides
**Output**: AI-optimized subagent definitions in `.claude/agents/`

---
## Additional user's input
Additional context/input from user: $ARGUMENTS. Might be empty by default.

## Purpose

Analyze project and generate tailored subagent files:
- **Unit Tester Agent** - Project's testing patterns and framework
- **Solution Architect Agent** - Project's architecture and conventions
- **Code Review Agent** - Project's code standards and linting rules
- **Refactor Cleaner Agent** - Project's cleanup tools and critical paths

---

## Prerequisites

- [ ] Project is accessible
- [ ] Templates exist at `.codemie/claude-templates/templates/agents/`
- [ ] (Optional) Backup existing `.claude/agents/` if updating agents

**Safety Note**: If existing agents are found, original content will be preserved during updates. However, creating a backup before running this command is recommended for recovery purposes.

---

## 🚨 SIZE LIMITS

**Each generated subagent: 150-300 lines maximum**

| ✅ Do | ❌ Don't |
|-------|---------|
| Brief examples (10-15 lines) | Extensive code blocks |
| Tables for patterns | Long prose explanations |
| File:line references | Full code listings |
| One example per pattern | Multiple variations |

---

## Execution

### Phase 1: Discovery

#### Step 1.1: Find Templates

```bash
ls .codemie/claude-templates/templates/agents/
```

Expected: `code-review-agent-template.md`, `solution-architect-agent.md`, `unit-tester-agent.md`, `refactor-cleaner-agent.md`

If no templates found → Report error and stop.

---

#### Step 1.1b: Check Existing Agents

```bash
ls .claude/agents/ 2>/dev/null
```

**Purpose**: Identify existing agents to update rather than recreate

**Agent Name Variations to Match**:
| Template | Possible Existing Names |
|----------|------------------------|
| unit-tester-agent.md | unit-tester.md, tester.md, unit-test-agent.md, test-agent.md |
| solution-architect-agent.md | solution-architect.md, architect.md, architecture-agent.md |
| code-review-agent.md | code-review.md, reviewer.md, review-agent.md, code-reviewer.md |
| refactor-cleaner-agent.md | refactor-cleaner.md, refactor.md, cleaner.md, cleanup-agent.md |

**Match Logic**:
- Exact match (e.g., `solution-architect-agent.md`)
- Partial match (e.g., `architect.md` matches solution-architect template)
- Keyword match (e.g., `tester.md` matches unit-tester template)

**Record Results**:
- List all existing agents found
- Map each to corresponding template (if match found)
- Note unmatched agents (leave unchanged)

---

#### Step 1.2: Read Project Context (PRIORITY ORDER)

**First**: Check `.codemie/guides/` folder
```bash
# If exists, read ALL guides first - this is the primary source
ls .codemie/guides/ 2>/dev/null && cat .codemie/guides/*.md
```

**Second**: Read standard documentation
```bash
cat README.md CONTRIBUTING.md ARCHITECTURE.md CLAUDE.md 2>/dev/null
```

**Third**: Analyze codebase for missing information
- Package files (package.json, pyproject.toml, pom.xml, go.mod)
- Config files (tsconfig.json, .eslintrc, pytest.ini)
- Directory structure
- Sample source and test files

**Extract**:
| Item | Source Priority |
|------|-----------------|
| Architecture pattern | guides/ → ARCHITECTURE.md → directory structure |
| Code conventions | guides/ → CONTRIBUTING.md → linter configs |
| Testing patterns | guides/ → test files → package.json |
| Critical paths | guides/ → core business logic analysis |

---

### Phase 2: Generate or Update Each Agent

For each template, create a todo item and process:

#### Step 2.0: Determine Action (Create vs Update)

**For each template**:
1. Check if matching existing agent was found in Step 1.1b
2. Decide action:
   - **UPDATE**: Existing agent found → Review and adjust existing file
   - **CREATE**: No existing agent → Generate from template

**Update Priority**:
- If existing agent is outdated (missing project info, has placeholders) → UPDATE
- If existing agent is custom/non-template based → ASK USER before updating
- If uncertain → ASK USER: "Found existing [agent-name]. Update it or create new?"

---

#### Step 2.1: Load Template or Existing Agent

**If CREATE (no existing agent)**:
```bash
cat .codemie/claude-templates/templates/agents/[template-file]
```

Identify all `[PLACEHOLDERS]` and `[GENERATION INSTRUCTION]` blocks.

**If UPDATE (existing agent found)**:
```bash
# Read both template and existing agent
cat .codemie/claude-templates/templates/agents/[template-file]
cat .claude/agents/[existing-agent-file]
```

**Compare and Identify**:
- Sections in template that are missing in existing agent
- Outdated information in existing agent
- Placeholders that need replacement
- Project-specific updates needed (new patterns, tools, conventions)

---

#### Step 2.2: Gather Agent-Specific Information

**Unit Tester**:
- Test framework, version, plugins
- Test directory and file patterns
- Mocking approach
- 1-2 representative test examples

**Solution Architect**:
- Architecture layers and their names
- Specs directory location
- Naming conventions
- Tech stack summary

**Code Review**:
- Linting tools and configs
- Severity thresholds
- 5-7 critical pattern categories
- Git workflow commands

**Refactor Cleaner**:
- Available analysis tools (knip, depcheck, vulture, etc.)
- Critical paths that must never be removed
- Deletion log location
- Build/test verification commands

**Source Priority**: Always check `.codemie/guides/` first, then analyze code.

---

#### Step 2.3: Populate Template or Update Existing

**If CREATE (from template)**:
1. **Replace all `[PLACEHOLDERS]`** with discovered values
2. **Fill pattern examples** using actual project code (brief, 10-15 lines)
3. **Remove all `[GENERATION INSTRUCTION]`** blocks
4. **Remove "Generation Instructions"** section from template

**If UPDATE (existing agent)**:
1. **Preserve custom content**: Keep user-added sections, custom examples, specific instructions
2. **Update outdated sections**:
   - Replace old tool versions with current versions
   - Update file paths if structure changed
   - Refresh pattern examples with current codebase code
   - Add missing sections from template
3. **Replace remaining placeholders** (if any)
4. **Enhance with new patterns**: Add newly discovered patterns not in original
5. **Maintain structure**: Keep existing organization unless template structure changed significantly

**Update Strategy**:
- **Section-by-section merge**: Compare template sections with existing agent sections
- **Preserve > Replace**: Keep existing content unless clearly outdated or incorrect
- **Add > Remove**: Add missing information rather than removing custom content
- **Validate > Assume**: Check if existing examples still exist in codebase

---

#### Step 2.4: Write and Validate

```bash
mkdir -p .claude/agents
# Write agent file (create new or overwrite existing)
```

**Checklist (CREATE)**:
- [ ] No `[PLACEHOLDER]` text remains
- [ ] No `[GENERATION INSTRUCTION]` blocks remain
- [ ] Examples are from actual codebase
- [ ] File paths are accurate
- [ ] Commands are valid for project

**Checklist (UPDATE)**:
- [ ] Custom content preserved (user additions not lost)
- [ ] Outdated information refreshed
- [ ] New sections from template added if relevant
- [ ] Examples validated against current codebase
- [ ] File paths updated if project structure changed
- [ ] Tool versions/commands current
- [ ] No regression (agent still functional after update)

**Action Logging**:
Record for summary report:
- Agent name
- Action taken (CREATED or UPDATED)
- Key changes made (if updated)

Mark todo complete, proceed to next template.

---

### Phase 3: Finalize

#### Step 3.1: Verify All Agents

```bash
ls -la .claude/agents/
wc -l .claude/agents/*.md
```

Confirm:
- All agents created
- All within size limits
- No placeholder text remains

---

#### Step 3.2: Summary Report

```markdown
# Subagent Generation Complete

## Agents Processed
| Agent | Lines | Action | Key Changes |
|-------|-------|--------|-------------|
| unit-tester-agent.md | X | CREATED/UPDATED | [If updated: list changes] |
| solution-architect-agent.md | Y | CREATED/UPDATED | [If updated: list changes] |
| code-review-agent.md | Z | CREATED/UPDATED | [If updated: list changes] |
| refactor-cleaner-agent.md | W | CREATED/UPDATED | [If updated: list changes] |

## Actions Taken
- **Created**: X new agents
- **Updated**: Y existing agents
- **Preserved**: Z unmatched agents (left unchanged)

## Project Context Used
- **Guides**: [list of .codemie/guides/ files read, or "none found"]
- **Tech Stack**: [Language], [Framework], [Test Framework]
- **Architecture**: [Pattern]

## Update Details (if applicable)
- Outdated paths updated: [list]
- New patterns added: [list]
- Tool versions refreshed: [list]
- Custom content preserved: [yes/no, details]

## Usage
Agents are automatically available to Claude Code.
Explicit invocation: "Use the [agent-name] agent to [task]"
```

---

## Decision Gates

| Gate | Condition | Pass | Fail |
|------|-----------|------|------|
| Templates exist | ≥1 template found | Continue | Stop with error |
| Existing agents check | Checked .claude/agents/ | Continue | Continue (assume no existing) |
| Update decision | Clear CREATE or UPDATE action | Continue | Ask user for preference |
| Custom content | Identified custom sections in existing agent | Preserve during update | Proceed with standard update |
| Project understood | ≥80% info gathered | Continue | Ask user for clarification |
| Agent size | 100-300 lines | Continue | Condense/expand as needed |
| Validation | No placeholders remain | Complete | Fix and revalidate |
| Update safety | Custom content preserved (if applicable) | Complete | Review and fix |

---

## Troubleshooting

| Issue | Action |
|-------|--------|
| Templates not found | Check path, ask user for correct location |
| Existing agent name doesn't match | Use partial/keyword matching logic (Step 1.1b) |
| Uncertain if existing agent is custom | Ask user: "Found [agent]. Update or preserve?" |
| Existing agent very different from template | Ask user before updating, risk losing custom content |
| Agent has placeholders after update | Re-gather project info, re-populate |
| Update causes agent to exceed size limit | Condense: prioritize new info, remove outdated examples |
| Unclear tech stack | Check `.codemie/guides/` first, then ask user |
| No test files found | Check alternate patterns, note in agent |
| Agent too large (>300) | Condense: use references, tables, single examples |
| Missing critical info | Check guides/, then analyze code, then ask user |
| Custom sections lost during update | Restore from backup (existing file), merge manually |

---

## Success Criteria

- ✅ All templates processed
- ✅ Existing agents checked and mapped to templates
- ✅ All agents in `.claude/agents/`
- ✅ All agents 100-300 lines
- ✅ No placeholders remain
- ✅ Project-specific content (not generic)
- ✅ Custom content preserved (if updating existing agents)
- ✅ Outdated information refreshed (if updating)
- ✅ Summary report generated with actions taken (CREATE/UPDATE)