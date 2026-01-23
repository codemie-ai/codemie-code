# Codemie Subagents - Generate Project-Specific Subagent Files

**Command Name**: `codemie-subagents`
**Description**: Generate project-specific subagent files from templates - analyze codebase and create AI-optimized subagent definitions
**Category**: Subagent Generation
**Complexity**: Medium-High

---

## Purpose

This command analyzes any software project and generates project-specific subagent files from templates, including:
- Unit Tester Agent - specialized for project's testing patterns
- Solution Architect Agent - tailored to project's architecture
- Code Review Agent - customized for project's code standards

Generated agents are placed in `.claude/agents/` directory for immediate use by Claude Code.

---

## Prerequisites

Before running this command:
- [ ] Project is cloned and accessible
- [ ] You have read access to the codebase
- [ ] Codemie templates are available at `.codemie/claude-templates/templates/agents/`

**Note**: The templates directory should be located in `.codemie/claude-templates/` within the project.

---

## 🚨 CRITICAL SIZE LIMITS

**MANDATORY**: Each generated subagent must be **300-500 lines maximum**.

### Enforcement Strategy

**During Generation**:
- ✅ Use brief, focused examples (10-20 lines max)
- ✅ Focus on contracts: function signatures, patterns, conventions
- ✅ Use tables for pattern references instead of long explanations
- ✅ ONE representative example per pattern category
- ✅ Reference file:line for detailed examples instead of copying entire code
- ❌ NO extensive code blocks (keep under 20 lines)
- ❌ NO multiple variations of same pattern
- ❌ NO verbose tutorials or walkthroughs
- ❌ NO redundant explanations

**Validation**:
After generating each subagent, count lines:
```bash
wc -l .claude/agents/[agent-name].md
```
If > 500 lines: **STOP and condense before continuing**.

---

## Execution Steps

### Phase 1: Template Discovery & Project Analysis

#### Step 1.1: Discover Available Templates

**Task**: Find all subagent templates available for generation

**Actions**:
```bash
# List all template files in subagents directory
ls .codemie/claude-templates/templates/subagents/
```

**Expected Templates**:
- `code-review-agent-template.md.template` - Code review specialized agent
- `solution-architect-agent.md.template` - Architecture planning agent
- `unit-tester-agent.md.template` - Testing specialized agent

**Output**: Array of template file names and paths

**Confidence Check**: Can you find at least 1 template file?
- ✅ YES → Continue to Step 1.2
- ❌ NO → Report error (templates directory missing)

---

#### Step 1.2: Analyze Project Structure

**Task**: Understand project organization, tech stack, and patterns

**Actions**:
```bash
# Identify project type and structure
- Check for package.json, requirements.txt, pom.xml, Cargo.toml, go.mod, etc.
- Identify language(s) and frameworks
- Map directory structure
- Find configuration files (tsconfig.json, .eslintrc, pytest.ini, etc.)
- Locate test directories and files
- Find architecture patterns (MVC, layered, microservices, etc.)
```

**Critical Information to Extract**:
- **Programming Language(s)**: TypeScript, Python, Java, Go, Rust, etc.
- **Framework(s)**: Express, FastAPI, Spring Boot, Gin, etc.
- **Build Tools**: npm, pip, maven, cargo, etc.
- **Testing Framework**: Vitest, Jest, pytest, JUnit, Go test, etc.
- **Linting Tools**: ESLint, Pylint, Checkstyle, golangci-lint, etc.
- **Project Structure**: Monorepo/multi-package vs single package
- **Key Directories**: src/, tests/, lib/, internal/, etc.

**Output**: Project analysis document with all extracted information

---

#### Step 1.3: Read Existing Documentation

**Task**: Check for existing documentation to understand conventions

**Actions**:
```bash
# Read existing docs (if they exist)
- README.md - project overview, setup, conventions
- CONTRIBUTING.md - contribution guidelines, code standards
- CLAUDE.md - existing AI instructions (if present)
- .codemie/guides/ - existing guides
- docs/ directory - additional documentation
```

**Extract**:
- Code style conventions
- Testing requirements
- Review standards
- Architecture decisions
- Common patterns and anti-patterns

---

### Phase 2: Template Loading & Validation

#### Step 2.1: Create Todo List for Templates

**Task**: Create todo tasks for each discovered template

**Actions**:
```typescript
// For each template file found in Step 1.1:
// - Create todo item: "Generate [agent-name] from template"
// Example todos:
// - [ ] Generate unit-tester agent from template
// - [ ] Generate solution-architect agent from template
// - [ ] Generate code-review agent from template
```

**Output**: Todo list with one task per template

---

#### Step 2.2: Load Each Template

**Task**: Read and parse each template file

**For Each Template**:

**Step 2.2.1: Read Template Content**
```bash
# Read template file
cat .codemie/claude-templates/templates/subagents/[template-file]
```

**Step 2.2.2: Identify Placeholders**

Common placeholders to find:
- `[PROJECT_NAME]` - Project name
- `[LANGUAGE]` - Programming language
- `[FRAMEWORK]` - Main framework
- `[TEST_FRAMEWORK]` - Testing framework
- `[BUILD_TOOL]` - Build tool (npm, cargo, maven, etc.)
- `[LINTER]` - Linting tool
- `[PROJECT_STRUCTURE]` - Directory structure overview
- `[ARCHITECTURE_PATTERN]` - Main architecture pattern
- `[code_example]` - Code snippet placeholders
- `[file.ext:lines]` - File reference placeholders
- `FILL IN` sections - Areas needing project-specific content

**Output**: List of placeholders per template and sections to fill

---

### Phase 3: Subagent Generation (Iterative)

**For Each Template** (mark as in_progress, then completed):

#### Step 3.1: Gather Template-Specific Information

**For Unit Tester Agent**:
- Testing framework and version
- Test file locations and naming patterns (e.g., `*.test.ts`, `*_test.go`, `test_*.py`)
- Mock/fixture patterns used in project
- Coverage requirements (if documented)
- Test commands (npm test, pytest, go test, etc.)
- Example test files (2-3 representative examples)
- Common testing utilities and helpers

**Actions**:
```bash
# Find test files and patterns
find . -name "*.test.ts" -o -name "*_test.go" -o -name "test_*.py"
# Find test configuration
grep -r "test" package.json tsconfig.json pytest.ini go.mod
# Read example test files
cat [test-file-path]  # 2-3 representative examples
```

**For Solution Architect Agent**:
- Project architecture pattern (layered, hexagonal, microservices, etc.)
- Key directories and their purposes
- Layer/module dependencies and communication patterns
- Technology stack summary
- Integration points (databases, APIs, external services)
- Configuration management approach

**Actions**:
```bash
# Map directory structure
tree -L 2 -d
# Find architectural patterns
grep -r "interface\|abstract\|Repository\|Service\|Controller" src/
# Find integration points
grep -r "database\|api\|http\|grpc" config/ src/
```

**For Code Review Agent**:
- Code style configuration (.eslintrc, .pylintrc, etc.)
- Linting rules and enforcement level
- Formatter configuration (prettier, black, gofmt, etc.)
- Code review checklist (if in CONTRIBUTING.md)
- Common code smells documented in project
- Type safety requirements (TypeScript strict mode, mypy, etc.)

**Actions**:
```bash
# Find linting configuration
cat .eslintrc* .pylintrc* .golangci.yml
# Find formatter configuration
cat .prettierrc* pyproject.toml .rustfmt.toml
# Read contribution guidelines
cat CONTRIBUTING.md | grep -A 10 "review\|style\|lint"
```

**🚨 SIZE LIMIT ENFORCEMENT**:
**Target: 300-500 lines for final agent**

Gather information selectively:
- Focus on **essential patterns only**
- Collect **1-2 representative examples** per category
- Prefer **file:line references** over full code listings
- Use **tables** to summarize multiple patterns compactly

---

#### Step 3.2: Fill Template Placeholders

**Step 3.2.1: Replace Generic Placeholders**

Replace all standard placeholders with actual values from project analysis:
- `[PROJECT_NAME]` → Actual project name (from package.json, README, etc.)
- `[LANGUAGE]` → Detected language(s)
- `[FRAMEWORK]` → Detected framework(s)
- `[TEST_FRAMEWORK]` → Detected test framework
- `[BUILD_TOOL]` → npm, cargo, maven, etc.
- `[LINTER]` → ESLint, Pylint, etc.
- `[PROJECT_STRUCTURE]` → Brief directory structure (5-10 lines)
- `[ARCHITECTURE_PATTERN]` → Identified pattern

**Step 3.2.2: Fill Code Examples (KEEP BRIEF)**

For each `[code_example]` placeholder:
- Use **actual code from codebase** (never generic examples)
- Keep examples **10-20 lines maximum**
- Add source reference: `// Source: file.ts:23-42`
- Focus on **pattern demonstration**, not complete implementations

**Example**:
```typescript
// GOOD: Brief, focused example (15 lines)
describe('UserService', () => {
  it('should create user with valid data', async () => {
    const mockRepo = { save: vi.fn().mockResolvedValue(user) };
    const service = new UserService(mockRepo);

    const result = await service.createUser(validData);

    expect(result).toEqual(user);
    expect(mockRepo.save).toHaveBeenCalledWith(validData);
  });
});
// Source: tests/services/user.test.ts:45-56
```

**Step 3.2.3: Fill "FILL IN" Sections**

For sections marked "FILL IN":
- Add **project-specific content only**
- Use **tables** for multiple patterns:
  ```markdown
  | Pattern | File Location | Key Characteristics |
  |---------|--------------|---------------------|
  | [Pattern1] | file.ts:line | Brief description |
  ```
- Keep explanations **concise** (1-2 sentences max per item)
- Use **bullet lists** for quick reference

**Step 3.2.4: Replace File References**

For each `[file.ext:lines]` placeholder:
- Find **actual relevant files** from codebase analysis
- Use **real file paths** with line numbers
- Example: `src/services/user.ts:23-45` instead of `[service.ts:lines]`

---

#### Step 3.3: Create Output Directory

**Task**: Ensure output directory exists

**Actions**:
```bash
# Create directory if it doesn't exist
mkdir -p .claude/agents
```

**Note**: Only create this directory once, not per agent.

---

#### Step 3.4: Write Generated Subagent File

**Task**: Write completed subagent to file

**Actions**:

**Step 3.4.1: Determine Output Filename**

Template filename → Output filename:
- `code-review-agent-template.md.template` → `code-review-agent.md`
- `solution-architect-agent.md.template` → `solution-architect-agent.md`
- `unit-tester-agent.md.template` → `unit-tester-agent.md`

**Step 3.4.2: Write File**
```bash
# Write completed agent file
# Save to .claude/agents/[agent-name].md
```

**🚨 MANDATORY SIZE VALIDATION**:
```bash
# Count lines immediately after writing
LINE_COUNT=$(wc -l < .claude/agents/[agent-name].md)

# Check if within limit
if [ $LINE_COUNT -lt 300 ]; then
    echo "⚠️  WARNING: Agent is only $LINE_COUNT lines (minimum: 300)"
    echo "Consider adding more detail or examples"
elif [ $LINE_COUNT -gt 500 ]; then
    echo "⚠️  ERROR: Agent is $LINE_COUNT lines (maximum: 500)"
    echo "MUST condense before continuing!"
    # STOP and condense the agent
fi
```

**Validation Checklist**:
- [ ] **Agent is 300-500 lines** (MANDATORY)
- [ ] All placeholders replaced with actual values
- [ ] Code examples are from actual codebase (not generic)
- [ ] Code examples are brief (10-20 lines max)
- [ ] File paths are accurate with line numbers
- [ ] Commands are correct for the project
- [ ] No "FILL IN" or "[PLACEHOLDER]" remains
- [ ] Used tables for pattern summaries
- [ ] ONE representative example per pattern category

**If > 500 Lines** (MUST FIX):
1. Remove redundant code examples (keep only most representative)
2. Convert multiple examples to a single comprehensive example
3. Replace code blocks with file:line references
4. Use tables instead of long prose descriptions
5. Remove verbose explanations (keep only essential info)
6. Consolidate similar patterns into single entries
7. Re-validate line count

**If < 300 Lines** (CONSIDER):
1. Add more pattern examples if relevant
2. Expand key sections with project-specific details
3. Add troubleshooting section if missing
4. Ensure all template sections are filled

---

#### Step 3.5: Mark Todo Complete

**Actions**:
- Mark current agent generation todo as "completed"
- Move to next template

---

### Phase 4: Validation & Finalization

#### Step 4.1: Verify Generated Agents

**For Each Generated Agent**:

**4.1.1: Check File Existence**
```bash
# Verify all agents were created
ls -lh .claude/agents/
```

**4.1.2: Validate Content Quality**
- [ ] No placeholder text remains (`[...]`, `FILL IN`)
- [ ] Code examples are real (not pseudo-code)
- [ ] File references are accurate (actual files exist)
- [ ] Commands are correct for project environment
- [ ] Line count is within 300-500 range

**4.1.3: Test Sample Commands (Optional)**
```bash
# Try running documented commands to ensure they work
# Example: npm test (from unit-tester agent)
# Example: npm run lint (from code-review agent)
```

---

#### Step 4.2: Generate Summary Report

**Task**: Create summary of what was generated

**Report Structure**:
```markdown
# Subagent Generation Complete

## Generated Agents ([N] agents)

- ✅ .claude/agents/unit-tester-agent.md ([X] lines)
- ✅ .claude/agents/solution-architect-agent.md ([Y] lines)
- ✅ .claude/agents/code-review-agent.md ([Z] lines)

## Project Analysis Summary

**Technology Stack**:
- Language: [Language]
- Framework: [Framework]
- Testing: [Test Framework]
- Build Tool: [Build Tool]
- Linter: [Linter]

**Architecture Pattern**: [Pattern]

**Key Directories**:
- [dir1/] - [purpose]
- [dir2/] - [purpose]
- [dir3/] - [purpose]

## Subagent Capabilities

**Unit Tester Agent**:
- Specialized for [Test Framework]
- Knows project test patterns in [test-dir/]
- Configured for [specific testing approach]

**Solution Architect Agent**:
- Understands [Architecture Pattern]
- Knows layer structure and dependencies
- Tailored for [Project Type] architecture

**Code Review Agent**:
- Enforces [Linter] rules
- Knows project code standards
- Checks [specific quality requirements]

## Next Steps

1. Review generated agents for accuracy
2. Customize any project-specific sections if needed
3. Use agents via Claude Code for specialized tasks:
   - "Write tests for [component]" → Uses unit-tester agent
   - "Design architecture for [feature]" → Uses solution-architect agent
   - "Review code in [file]" → Uses code-review agent

## How to Use

These agents are automatically available to Claude Code in this project.
Claude Code will select the appropriate agent based on your task.

You can also explicitly request an agent:
- "Use the unit-tester agent to write tests for authentication"
- "Use the solution-architect agent to plan the new feature"
- "Use the code-review agent to check this PR"
```

---

## Decision Gates Throughout Process

### Gate 1: After Template Discovery (Step 1.1)
**Question**: Did I find at least 1 template file?
- ✅ YES → Continue to project analysis
- ❌ NO → Report error (check template directory path)

### Gate 2: After Project Analysis (Step 1.3)
**Question**: Do I have enough information about the project?
- ✅ 80%+ confidence → Continue to generation
- ❌ < 80% confidence → Ask user for clarification

### Gate 3: After Each Agent Generation (Step 3.4)
**Question**: Is the agent within size limits (300-500 lines)?
- ✅ YES → Mark complete, move to next
- ❌ NO → Condense (if > 500) or expand (if < 300)

### Gate 4: After All Agents Generated (Step 4.1)
**Question**: Are all agents complete and valid?
- ✅ YES → Generate summary report and finish
- ❌ NO → Fix issues and re-validate

---

## Troubleshooting

### Issue: Template Directory Not Found

**Symptoms**: Cannot find `.codemie/claude-templates/templates/subagents/`
**Action**:
1. Check if templates are in alternate location
2. Ask user for correct template path
3. Verify project has been set up with codemie-init first

### Issue: Cannot Determine Project Language/Framework

**Symptoms**: Unclear tech stack from project files
**Action**:
1. Ask user: "What language and framework does your project use?"
2. Look for alternate configuration files
3. Check README.md for explicit mention

### Issue: No Test Files Found

**Symptoms**: Cannot find tests for unit-tester agent
**Action**:
1. Check alternate test directory names (test/, __tests__/, spec/)
2. Check alternate file patterns (*.spec.ts, *.test.js)
3. Ask user where tests are located
4. If no tests exist, note in agent that tests should be created

### Issue: Generated Agent Too Large (> 500 Lines)

**Symptoms**: Line count exceeds limit
**Action**:
1. Remove redundant code examples (keep most representative)
2. Replace code blocks with file:line references
3. Use tables instead of prose for pattern lists
4. Consolidate similar patterns
5. Remove verbose explanations

### Issue: Generated Agent Too Small (< 300 Lines)

**Symptoms**: Line count below minimum
**Action**:
1. Check if all template sections were filled
2. Add more representative examples if relevant
3. Expand troubleshooting or pattern sections
4. Add project-specific details from analysis

---

## Success Criteria

Subagent generation is complete when:
- ✅ All template files processed
- ✅ All agents generated in `.claude/agents/`
- ✅ All agents are 300-500 lines
- ✅ All code examples are from actual codebase
- ✅ All file references are accurate
- ✅ All commands are correct
- ✅ No placeholders or "FILL IN" text remains
- ✅ Agents are project-specific (not generic)
- ✅ Summary report generated

---

## Example Invocation

**User**: "Generate subagents for my TypeScript project"

**Claude Code**:
1. Discovers 3 templates (unit-tester, solution-architect, code-review)
2. Analyzes project (finds TypeScript, Vitest, ESLint, layered architecture)
3. Creates todo list with 3 agent generation tasks
4. Generates unit-tester agent (uses actual test examples from tests/)
5. Generates solution-architect agent (uses actual architecture from src/)
6. Generates code-review agent (uses actual ESLint config)
7. Validates all agents (sizes OK, no placeholders)
8. Presents summary report with capabilities

**Result**: project-specific subagent files ready to use in `.claude/agents/`.
IMPORTANT: put agents into ".claude/agents" folder.

---

## Notes

- **Time Estimate**: 5-15 minutes depending on project size
- **Token Usage**: Medium - reading templates and codebase samples
- **User Interaction**: 0-1 confirmation points (only if unclear project structure)
- **Customization**: Output should be 90% ready, 10% may need refinement
- **Updates**: Re-run command when project patterns change significantly

---
