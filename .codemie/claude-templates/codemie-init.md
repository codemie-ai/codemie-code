# Codemie Init - Generate Project Documentation

**Command Name**: `codemie-init`
**Description**: Initialize Codemie documentation for any project - analyze structure and generate AI-optimized guides
**Category**: Documentation Generation
**Complexity**: High

---

## Purpose

This command analyzes any software project and generates AI-optimized documentation for Claude Code, including:
- Main CLAUDE.md file with project-specific patterns and workflows
- Detailed guides for relevant architectural patterns and practices
- Properly structured .codemie/guides/ directory with categorized documentation

---

## Prerequisites

Before running this command:
- [ ] Project is cloned and accessible
- [ ] You have read access to the codebase
- [ ] Codemie templates are available at `.codemie/claude-templates/templates/`

**Note**: The templates directory should be located in `.codemie/claude-templates/` within the project.

---

## 🚨 CRITICAL SIZE LIMITS

**MANDATORY**: Each generated guide must be **200-400 lines maximum**.

### Enforcement Strategy

**During Generation**:
- ✅ Use brief code examples (5-15 lines max, never > 20)
- ✅ Focus on contracts: function signatures, return types, status codes
- ✅ Use tables for patterns instead of long explanations
- ✅ ONE example per pattern (not multiple variations)
- ✅ Reference file:line instead of copying entire functions
- ❌ NO extensive code blocks
- ❌ NO multiple examples for same pattern
- ❌ NO verbose explanations
- ❌ NO tutorial walkthroughs

**Validation**:
After generating each guide, count lines:
```bash
wc -l .codemie/guides/[category]/[guide].md
```
If > 400 lines: **STOP and condense before continuing**.

---

## Execution Steps

### Phase 1: Project Discovery & Analysis

#### Step 1.1: Analyze Project Structure

**Task**: Discover project organization, tech stack, and patterns

**Actions**:
```bash
# Identify project type and structure
- Check for package.json, requirements.txt, pom.xml, Cargo.toml, etc.
- Identify language(s) and frameworks
- Map directory structure
- Find configuration files
```

**Output**: Create analysis document with:
- Programming language(s)
- Framework(s) and versions
- Build tools
- Testing frameworks
- Key directories (src/, tests/, config/, etc.)
- Dependency management approach

**Confidence Check**: Can you identify the tech stack with 80%+ confidence?
- ✅ YES → Continue to Step 1.2
- ❌ NO → Ask user for clarification

---

#### Step 1.2: Identify Architectural Patterns

**Task**: Detect architectural patterns used in the project

**Actions**:
```bash
# Use Glob and Grep to identify patterns
- Check for layered architecture (controllers/routes, services, repositories)
- Identify if REST API, GraphQL, or other
- Look for ORM usage (models directory)
- Find database configurations
- Check for agent/AI patterns (if LangChain, LangGraph, etc.)
- Identify testing structure
- Check for CI/CD configuration
```

**Questions to Answer**:
- What's the main architecture pattern? (MVC, layered, clean architecture, etc.)
- Is there an API layer? What type?
- Is there a service layer?
- Is there a data/repository layer?
- What testing approach is used?
- What external integrations exist?

**Output**: List of architectural patterns found

---

#### Step 1.3: Read Existing Documentation

**Task**: Check for existing documentation to understand context

**Actions**:
```bash
# Read existing docs (if they exist)
- README.md
- CONTRIBUTING.md
- docs/ directory
- Any architectural decision records (ADRs)
```

**Extract**:
- Project purpose
- Setup instructions
- Build/run commands
- Testing commands
- Deployment process
- Known patterns or conventions

---

### Phase 2: Template Selection & Customization

#### Step 2.1: Load Reference Templates

**Task**: Load the main CLAUDE.md template and understand its structure

**Actions**:
```bash
# Read template
- .codemie/claude-templates/templates/CLAUDE.md.template
```

**Understand**:
- What sections need to be filled
- What placeholders exist ([PROJECT_NAME], [LANGUAGE], etc.)
- Which sections are universal vs project-specific

---

#### Step 2.2: Identify Required Guides

**Task**: Based on Phase 1 analysis, determine which guide templates are relevant

**Decision Matrix**:

| Found Pattern/Feature | Required Guides | Priority |
|----------------------|-----------------|----------|
| REST API endpoints | api/api-patterns.md | P0 (Required) |
| Layered architecture | architecture/layered-architecture.md | P0 (Required) |
| Database/ORM usage | data/database-patterns.md | P0 (Required) |
| Service layer | architecture/service-layer-patterns.md | P1 (Optional) |
| Testing framework | testing/testing-patterns.md | P0 (Required) |
| Error handling | development/error-handling.md | P0 (Required) |
| Logging | development/logging-patterns.md | P0 (Required) |
| Security features | development/security-patterns.md | P0 (Required) |
| Setup/installation | development/setup-guide.md | P0 (Required) |
| Git repository | standards/git-workflow.md | P0 (Required) |
| Linting/formatting | standards/code-quality.md | P0 (Required) |
| Agent patterns (LangChain) | agents/agent-patterns.md | P0 (if found) |
| Workflow orchestration | workflows/workflow-patterns.md | P1 (if found) |
| External APIs | integration/external-integrations.md | P1 (if found) |

**Output**: List of guide templates to use with priorities

**User Confirmation**: Present the list and ask:
```
I've identified the following guides to create for your project:

Required (P0):
- [List P0 guides]

Optional (P1):
- [List P1 guides]

Would you like me to:
1. Generate all required and optional guides
2. Generate only required guides
3. Customize this list
```

---

### Phase 3: Guide Generation

#### Step 3.1: Create Base Directory

**Task**: Create base .codemie/guides/ directory

**Actions**:
```bash
# Create base directory ONLY
mkdir -p .codemie/guides
```

**IMPORTANT**: Do NOT create category subdirectories yet. Only create them when you actually generate a guide for that category.

---

#### Step 3.2: Generate Each Guide (Iterative)

**For Each Selected Guide Template**:

**Step 3.2.1: Load Template**
```bash
# Load guide template
- Read .codemie/claude-templates/templates/guides/[category]/[guide].md.template
```

**Step 3.2.2: Analyze Project for Guide-Specific Patterns**

**Actions**: Use Glob, Grep, and Read to find relevant code examples

**For Error Handling Guide**:
- Search for exception classes
- Find error handler implementations
- Identify error response patterns
- Example: `grep -r "class.*Exception" src/`

**For API Patterns Guide**:
- Find route/endpoint definitions
- Identify request/response models
- Find authentication middleware
- Example: `grep -r "@app.route\|@router\|@RestController" src/`

**For Database Patterns Guide**:
- Find model definitions
- Identify query patterns
- Find transaction usage
- Example: `grep -r "class.*Model\|@Entity\|models.Model" src/`

**For Architecture Guide**:
- Map out layer structure
- Find examples of layer communication
- Identify dependency injection patterns

**For Testing Guide**:
- Find test structure
- Identify testing frameworks used
- Find fixture/mock patterns
- Example: `ls -la tests/`

**For Setup Guide**:
- Extract setup commands from README
- Find environment configuration
- Identify dependency installation process

**Output**: Collection of:
- File paths with line numbers
- Code examples
- Pattern instances
- Configuration snippets

**Step 3.2.3: Fill Template Placeholders**

**🚨 SIZE LIMIT ENFORCEMENT**:
**Target: 200-400 lines for the final guide**

**Replace Generic Placeholders**:
- `[PROJECT_NAME]` → Actual project name
- `[LANGUAGE]` → Detected language(s)
- `[FRAMEWORK]` → Detected framework(s)
- `[DATABASE_NAME]` → Detected database
- `[TEST_FRAMEWORK]` → Detected test framework
- `[file.ext:lines]` → Actual file paths from analysis
- `[code_example]` → **BRIEF** code snippets (5-15 lines, never > 20)

**Add Project-Specific Content** (KEEP CONCISE):
- Fill "FILL IN" sections with **essential patterns only**
- Add **ONE brief code example** per pattern (5-15 lines)
- Document **key commands only** (not every variation)
- Include **minimal** configuration snippets (< 10 lines)
- Use **file:line references** instead of copying entire functions
- Use **tables** for multiple patterns instead of code blocks

**Examples of Brevity**:
```python
# GOOD: Brief, focused (8 lines)
@router.post("/users")
async def create_user(user: UserCreate):
    try:
        return await UserService.create(user)
    except ValidationError as e:
        raise HTTPException(400, str(e))
# Source: api/users.py:23-28

# BAD: Too long (50+ lines showing entire function with error handling, logging, etc.)
```

**Step 3.2.4: Write Guide File**

**Actions**:
```bash
# Create category directory if it doesn't exist
mkdir -p .codemie/guides/[category]

# Write completed guide
# Save to .codemie/guides/[category]/[guide].md
```

**🚨 MANDATORY SIZE VALIDATION**:
```bash
# Count lines immediately after writing
LINE_COUNT=$(wc -l < .codemie/guides/[category]/[guide].md)

# Check if within limit
if [ $LINE_COUNT -gt 400 ]; then
    echo "⚠️  WARNING: Guide is $LINE_COUNT lines (limit: 400)"
    echo "MUST condense before continuing!"
    # STOP and condense the guide
fi
```

**Validation Checklist**:
- [ ] **Guide is 200-400 lines** (MANDATORY)
- [ ] All placeholders replaced
- [ ] Code examples are brief (5-15 lines, max 20)
- [ ] File paths are accurate
- [ ] Commands are correct
- [ ] No "FILL IN" or "[PLACEHOLDER]" remains
- [ ] Used tables for patterns (not long code blocks)
- [ ] ONE example per pattern (not multiple)

**If > 400 Lines**:
1. Remove redundant code examples
2. Convert multiple examples to ONE representative example
3. Use tables instead of code blocks where possible
4. Replace code blocks with file:line references
5. Remove verbose explanations
6. Re-validate line count

---

#### Step 3.3: Track Progress

**Use TodoWrite** to track guide creation:

```
- [ ] Create development/error-handling.md
- [ ] Create development/logging-patterns.md
- [ ] Create development/security-patterns.md
- [ ] Create development/setup-guide.md
- [ ] Create api/api-patterns.md
- [ ] Create architecture/layered-architecture.md
- [ ] Create data/database-patterns.md
- [ ] Create testing/testing-patterns.md
- [ ] Create standards/code-quality.md
- [ ] Create standards/git-workflow.md
```

Mark each as in_progress when working on it, completed when done.

---

### Phase 4: Generate Main CLAUDE.md

#### Step 4.1: Load and Customize CLAUDE.md Template

**Task**: Create the main CLAUDE.md file with project-specific content

**Actions**:

**4.1.1: Replace Basic Placeholders**
- `[PROJECT_NAME]` → Actual project name
- `[LANGUAGE]` → Programming language
- `[FRAMEWORK]` → Main framework
- `[DATABASE_NAME]` → Database name
- Environment policy placeholders

**4.1.2: Fill Guide References Section**

Based on generated guides, populate the "Guide References by Category" section:

```markdown
**API Development**:
- API patterns: .codemie/guides/api/api-patterns.md

**Architecture**:
- Layered architecture: .codemie/guides/architecture/layered-architecture.md

**Data & Database**:
- Database patterns: .codemie/guides/data/database-patterns.md

**Development Practices**:
- Error handling: .codemie/guides/development/error-handling.md
- Logging patterns: .codemie/guides/development/logging-patterns.md
- Security patterns: .codemie/guides/development/security-patterns.md
- Setup guide: .codemie/guides/development/setup-guide.md

**Standards**:
- Code quality: .codemie/guides/standards/code-quality.md
- Git workflow: .codemie/guides/standards/git-workflow.md

**Testing**:
- Testing patterns: .codemie/guides/testing/testing-patterns.md
```

**4.1.3: Create Task Classifier Table**

Based on project patterns, create keyword → guide mappings:

```markdown
| Keywords | Complexity | Load Guide (P0=Required) | Also Load (P1=Optional) |
|----------|-----------|--------------------------|-------------------------|
| **api, endpoint, router** | Medium | .codemie/guides/api/api-patterns.md | - |
| **test, pytest** | Medium | .codemie/guides/testing/testing-patterns.md | - |
| **database, sql, postgres** | Medium-High | .codemie/guides/data/database-patterns.md | - |
| **error, exception** | Medium | .codemie/guides/development/error-handling.md | .codemie/guides/development/logging-patterns.md |
```

**4.1.4: Fill Pattern Quick Reference**

Extract key patterns from generated guides and create quick reference tables:

**Error Handling Quick Ref**:
```markdown
| When | Exception | Import From | Related Patterns |
|------|-----------|-------------|------------------|
| Validation failed | ValidationError | myproject.exceptions | Logging, API Patterns |
| Not found | NotFoundException | myproject.exceptions | API Patterns |
```

**Logging Quick Ref**:
```markdown
| ✅ DO | ❌ DON'T | Why | Related |
|-------|----------|-----|---------|
| [Project-specific best practice] | [Anti-pattern] | [Reason] | [Guide] |
```

**4.1.5: Fill Development Commands**

Extract from setup guide and project analysis:

```markdown
| Task | Command | Notes |
|------|---------|-------|
| **Setup** | npm install | First time setup |
| **Run Server** | npm run dev | Dev server (port 3000) |
| **Lint** | npm run lint | ESLint check |
| **Format** | npm run format | Prettier format |
| **Test** ⚠️ | npm test | ONLY if user requests |
```

**4.1.6: Fill Troubleshooting Section**

Based on common issues found in README or CONTRIBUTING:

```markdown
| Symptom | Likely Cause | Fix | Prevention |
|---------|--------------|-----|------------|
| [Common error] | [Root cause] | [Solution] | [Prevention] |
```

**4.1.7: Fill Project Context**

**Technology Stack**:
```markdown
| Component | Tool | Version | Purpose |
|-----------|------|---------|---------|
| Language | Python | 3.11+ | Core language |
| Framework | FastAPI | 0.104+ | REST API |
| Database | PostgreSQL | 15+ | Primary DB |
```

**Core Components**:
```markdown
| Component | Path | Purpose | Guide |
|-----------|------|---------|-------|
| API | src/api/ | FastAPI routers | .codemie/guides/api/api-patterns.md |
| Services | src/services/ | Business logic | .codemie/guides/architecture/layered-architecture.md |
```

---

#### Step 4.2: Write Final CLAUDE.md

**Actions**:
```bash
# Write completed CLAUDE.md
- Save to ./CLAUDE.md (project root)
```

**Validation**:
- [ ] All placeholders replaced
- [ ] Guide references are accurate
- [ ] Commands are tested
- [ ] Task classifier is populated
- [ ] Quick references are filled
- [ ] Project context is complete
- [ ] No "FILL IN" or "[PLACEHOLDER]" remains
- [ ] All internal links work

---

### Phase 5: Validation & Finalization

#### Step 5.1: Verify Documentation

**Actions**:

**5.1.1: Check File Existence**
```bash
# Verify all referenced guides exist
- Check that each guide in CLAUDE.md actually exists
- Verify correct paths
```

**5.1.2: Validate Links**
```bash
# Check internal links
- All guide references in CLAUDE.md point to existing files
- All cross-references between guides are valid
```

**5.1.3: Test Commands**
```bash
# Try running documented commands
- Setup command
- Lint command
- Test command (if documented)
- Build command
```

**5.1.4: Review Content Quality**
- [ ] Code examples are real (not placeholders)
- [ ] File paths include line numbers
- [ ] Patterns are project-specific
- [ ] No generic placeholders remain
- [ ] Guides follow AI-first writing principles (pattern-first, examples, structured)

---

#### Step 5.2: Generate Summary Report

**Task**: Create a summary of what was generated

**Report Structure**:
```markdown
# Documentation Generation Complete

## Generated Files

### Main Documentation
- ✅ CLAUDE.md (root directory)

### Guides Generated ([N] guides)

**Development** ([X] guides):
- ✅ .codemie/guides/development/error-handling.md
- ✅ .codemie/guides/development/logging-patterns.md
- ✅ .codemie/guides/development/security-patterns.md
- ✅ .codemie/guides/development/setup-guide.md

**API** ([X] guides):
- ✅ .codemie/guides/api/api-patterns.md

**Architecture** ([X] guides):
- ✅ .codemie/guides/architecture/layered-architecture.md

**Data** ([X] guides):
- ✅ .codemie/guides/data/database-patterns.md

**Testing** ([X] guides):
- ✅ .codemie/guides/testing/testing-patterns.md

**Standards** ([X] guides):
- ✅ .codemie/guides/standards/code-quality.md
- ✅ .codemie/guides/standards/git-workflow.md

## Project Analysis Summary

**Technology Stack**:
- Language: [Language]
- Framework: [Framework]
- Database: [Database]
- Testing: [Test Framework]
- Build Tool: [Build Tool]

**Architecture Patterns Documented**:
- [Pattern 1]
- [Pattern 2]
- [Pattern 3]

**Total Code Examples**: [N] examples from actual codebase
**Total Line References**: [N] file:line references

## Next Steps

1. Review generated documentation for accuracy
2. Customize any project-specific sections that need refinement
3. Test CLAUDE.md by asking Claude Code to perform a task
4. Update guides as project evolves

## How to Use

Claude Code will now:
1. Check guides first before searching codebase
2. Use documented patterns consistently
3. Follow project-specific workflows
4. Reference actual code examples from your project

Try asking Claude Code to:
- "Add a new API endpoint following project patterns"
- "Fix error handling in [file]"
- "Write tests for [component]"
```

---

## Decision Gates Throughout Process

### Gate 1: After Project Discovery (Step 1.3)
**Question**: Do I understand the tech stack and architecture?
- ✅ 80%+ confidence → Continue
- ❌ < 80% confidence → Ask user for clarification

### Gate 2: After Template Selection (Step 2.2)
**Question**: Have I identified the right guides to generate?
- ✅ YES → Present list to user for confirmation
- ❌ UNCERTAIN → Ask user which patterns/areas are important

### Gate 3: After Each Guide Generation (Step 3.2.4)
**Question**: Is this guide filled with real project content (not placeholders)?
- ✅ YES → Mark complete, move to next guide
- ❌ NO → Continue analyzing and filling content

### Gate 4: After CLAUDE.md Generation (Step 4.2)
**Question**: Is CLAUDE.md complete and project-specific?
- ✅ YES → Proceed to validation
- ❌ NO → Continue filling sections

### Gate 5: After Validation (Step 5.1)
**Question**: Do all links work and commands run?
- ✅ YES → Generate summary report and finish
- ❌ NO → Fix issues and re-validate

---

## Troubleshooting

### Issue: Can't Identify Architecture Pattern

**Symptoms**: Unclear project structure
**Action**:
1. Ask user: "What architecture pattern does your project use?"
2. If user unsure, provide options based on directory structure
3. Offer to create generic layered architecture guide

### Issue: No Code Examples Found for Pattern

**Symptoms**: Template sections can't be filled with real code
**Action**:
1. Check if pattern actually exists in project
2. If not, ask user if they want this guide (might be aspirational)
3. If yes but code not found, create guide with TODO for user to fill

### Issue: Multiple Frameworks/Patterns Detected

**Symptoms**: Mixed patterns (e.g., both REST and GraphQL)
**Action**:
1. Ask user which is primary
2. Document both if both are important
3. Create separate guides for each pattern

### Issue: Documentation Takes Too Long

**Symptoms**: Many guides, large codebase
**Action**:
1. Start with P0 guides only
2. Generate P1 guides in follow-up
3. Focus on most-used patterns first

---

## Success Criteria

Documentation generation is complete when:
- ✅ CLAUDE.md exists in project root
- ✅ All referenced guides exist
- ✅ All code examples are from actual project (no placeholders)
- ✅ All file paths are accurate with line numbers
- ✅ All commands are tested and work
- ✅ All internal links are valid
- ✅ Project-specific patterns are documented
- ✅ No "FILL IN" or "[PLACEHOLDER]" text remains
- ✅ User has reviewed and confirmed accuracy

---

## Example Invocation

**User**: "Generate project documentation for my FastAPI project"

**Claude Code**:
1. Analyzes project structure (finds FastAPI, PostgreSQL, pytest)
2. Identifies patterns (layered architecture, REST API, SQLAlchemy)
3. Selects templates (API, architecture, database, testing, etc.)
4. Generates 8 guides with real code examples
5. Creates CLAUDE.md with project-specific content
6. Validates all links and commands
7. Presents summary report

**Result**: Complete, project-specific Claude Code documentation ready to use

---

## Notes

- **Time Estimate**: 10-30 minutes depending on project size and complexity
- **Token Usage**: High - lots of reading and writing
- **User Interaction**: 2-3 confirmation points for guide selection
- **Customization**: Output should be 80% ready, 20% may need user refinement
- **Maintenance**: Documentation should be updated as project evolves

---
