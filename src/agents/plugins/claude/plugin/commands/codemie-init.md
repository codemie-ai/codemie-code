# Codemie Init - Generate Project Documentation

**Command Name**: `codemie-init`
**Description**: Initialize documentation for any project using CodeMie approach - analyze structure and generate AI-optimized guides
**Category**: Documentation Generation

---

## Additional user's input
Additional context/input from user: $ARGUMENTS. Might be empty by default.

## Purpose

Analyze any software project and generate AI-optimized documentation for Claude Code:
- Main CLAUDE.md file with project-specific workflows
- Detailed guides for relevant patterns (only those that exist in codebase)
- Properly structured .codemie/guides/ directory

---

## Prerequisites

- [ ] Project is cloned and accessible
- [ ] Read access to the codebase
- [ ] Templates available at `.codemie/claude-templates/templates/`

---

## 🚨 CRITICAL RULES

### Size Limits (MANDATORY)
- **CLAUDE.md**: 200-300 lines maximum
- **Each guide**: 200-400 lines maximum

### Generation Principles
- ✅ Create guides ONLY for patterns/categories that exist in codebase
- ✅ Brief code examples (5-15 lines, max 20)
- ✅ Use tables for patterns instead of long explanations
- ✅ ONE example per pattern
- ✅ Reference file:line instead of copying entire functions
- ✅ Multiple .md files per category allowed (e.g., component-specific guides in development/)
- ❌ NO guides for non-existent features (no API = no API guide)
- ❌ NO extensive code blocks
- ❌ NO multiple examples for same pattern

### Existing Documentation Handling
- If CLAUDE.md exists → Analyze and UPDATE/ADJUST (don't overwrite blindly)
- If guides exist in .codemie/guides/ → READ, INCLUDE in CLAUDE.md, and ADJUST if needed
- Preserve user customizations where possible

---

## Execution Steps

### Phase 1: Discovery & Analysis

#### Step 1.1: Check Existing Documentation

**Task**: Detect existing Codemie documentation

**Actions**:
1. Check if `CLAUDE.md` exists in project root
2. Check if `.codemie/guides/` directory exists
3. If guides exist, read each one and extract:
    - Category and purpose
    - Key patterns documented
    - Quality and completeness

**Decision**:
- Existing CLAUDE.md found → Load and prepare for adjustment
- Existing guides found → Include in final CLAUDE.md, adjust if outdated
- Nothing exists → Fresh generation from templates

---

#### Step 1.2: Analyze Project Structure

**Task**: Discover project organization, tech stack, and patterns

**Discover**:
- Package manager files (package.json, requirements.txt, pom.xml, go.mod, Cargo.toml)
- Programming language(s) and framework(s)
- Directory structure (src/, lib/, app/, tests/, etc.)
- Configuration files
- Build and run scripts

**Output**: Project analysis summary:
- Language + version
- Framework + version
- Build tools
- Test framework
- Key directories

**Confidence Check**: Tech stack identified with 80%+ confidence?
- ✅ YES → Continue
- ❌ NO → Ask user for clarification

---

#### Step 1.3: Identify What Actually Exists

**Task**: Detect ONLY categories/features that exist in codebase

**Analyze codebase for each category**:

| Category | What to Look For | Detection Signals |
|----------|------------------|-------------------|
| **Architecture** | Project structure, layer separation, design patterns | Directory organization, module boundaries, dependency flow |
| **API Development** | REST/GraphQL endpoints, routing, request handling | Route decorators, controllers, endpoint definitions, API schemas |
| **Data & Database** | ORM usage, models, repositories, migrations | Model classes, database configs, migration files, query patterns |
| **Testing** | Test files, test configuration, mocking | Test directories, test framework config, fixture files |
| **Development Practices** | Code patterns, error handling, logging, components | Custom exceptions, logger setup, shared utilities, UI components |
| **Integrations** | External services, third-party APIs, messaging | API clients, SDK usage, queue consumers/producers, webhooks |
| **Workflows** | Business logic, state machines, process flows | Workflow definitions, state handlers, domain services |
| **Security** | Authentication, authorization, validation | Auth middleware, permission checks, input validators, security configs |

**Output**: List of confirmed categories with evidence (file paths)

**Example Output**:
```
✅ Architecture - Found: src/controllers/, src/services/, src/repositories/
✅ API Development - Found: REST routes in src/api/, OpenAPI spec
✅ Data & Database - Found: PostgreSQL config, SQLAlchemy models in src/models/
✅ Testing - Found: pytest.ini, tests/ directory with 50+ test files
✅ Development Practices - Found: Custom exceptions, logging config, React components
❌ Integrations - Not found: No external API clients detected
❌ Workflows - Not found: No state machines or workflow definitions
✅ Security - Found: JWT auth middleware, input validation schemas
```

---

#### Step 1.4: Read Existing Project Documentation

**Task**: Extract context from existing docs

**Check and read**:
- README.md
- CONTRIBUTING.md
- docs/ directory
- Any ADRs (Architecture Decision Records)

**Extract**:
- Project purpose
- Setup/build/run commands
- Testing commands
- Known conventions

---

### Phase 2: Determine Required Guides

#### Step 2.1: Map Categories to Guides

**Task**: Based on Step 1.3, determine which guides to create per category

**Guide Categories Reference**:

| Category | User Intent / Purpose | Guide Folder | Possible Guides                                                         |
|----------|----------------------|--------------|-------------------------------------------------------------------------|
| **Architecture** | System structure, design decisions, patterns, planning features | .codemie/guides/architecture/ | architecture.md, patterns.md                                            |
| **API Development** | REST/GraphQL endpoints, routing, request/response handling | .codemie/guides/api/ | api-patterns.md, [specific-api].md                                      |
| **Data & Database** | Database operations, queries, migrations, models, repositories | .codemie/guides/data/ | data-patterns.md                                                        |
| **Testing** | Writing/fixing tests, coverage, mocking, test infrastructure | .codemie/guides/testing/ | testing-patterns.md, [framework]-testing.md                             |
| **Development Practices** | Code quality, error handling, components, standards | .codemie/guides/development/ | development-practices.md, frontend-patterns.md, [component]-patterns.md |
| **Integrations** | External services, third-party APIs, cloud services, messaging | .codemie/guides/integrations/ | [service-name].md, external-apis.md                                     |
| **Workflows** | Business logic, state machines, process flows, domain operations | .codemie/guides/workflows/ | workflow-patterns.md, [workflow-name].md                                |
| **Security** | Authentication, authorization, input validation, secrets | .codemie/guides/security/ | security-patterns.md                                                    |

**Rules for Guide Creation**:
- ❌ Category NOT detected → DO NOT create any guides for it
- ✅ Category detected → Create relevant guides with real examples
- ✅ Multiple guides per category allowed (e.g., separate component guides in development/)
- ✅ Existing guide found → Review, include, adjust if needed

**Determine Specific Guides**:

For each detected category, identify specific guides needed:

```
Example for detected "Development Practices" category:
- Error handling patterns found → development/error-handling.md
- Logging configuration found → development/logging.md
- React components found → development/react-components.md
- Shared utilities found → development/utilities.md
```

---

#### Step 2.2: Merge with Existing Guides

**Task**: Combine new guides with any existing ones

**Actions**:
1. List guides to create (from Step 2.1)
2. List existing guides (from Step 1.1)
3. Merge lists:
    - Existing guide covers same topic → Review and adjust existing
    - New guide needed, no existing → Create new
    - Existing guide, no longer relevant → Keep but note as legacy

---

#### Step 2.3: User Confirmation

**Present to user**:

```
Based on codebase analysis, I'll create/update guides for these categories:

**Categories Detected**:

📁 Architecture
   - To create: architecture.md (system layers and patterns)

📁 API Development  
   - To create: api-patterns.md (REST conventions found in src/api/)

📁 Data & Database
   - To create: database-patterns.md (PostgreSQL + SQLAlchemy patterns)

📁 Testing
   - To create: testing-patterns.md (pytest patterns)
   - Existing: integration-testing.md ✓ (will include, no changes needed)

📁 Development Practices
   - To create: error-handling.md, logging.md
   - To create: react-components.md (UI component patterns)

📁 Security
   - To create: security-patterns.md (JWT auth, validation)

**Categories Skipped** (not found in codebase):
   ⏭️ Integrations - No external API clients detected
   ⏭️ Workflows - No state machines or workflow definitions

Proceed with this plan? (Yes / Customize)
```

---

### Phase 3: Generate Guides

#### Step 3.1: Create Directory Structure

**Actions**:
```bash
mkdir -p .codemie/guides
# Create category subdirectories ONLY for categories with guides being generated
```

---

#### Step 3.2: Generate Each Guide

**For each guide in approved list**:

**3.2.1: Load Template**
- Read from `.codemie/claude-templates/templates/guides/[category]/[guide].md.template`
- If no specific template exists, use category base template

**3.2.2: Analyze Codebase for This Guide**
- Find relevant code examples
- Extract actual patterns used
- Note file paths with line numbers

**3.2.3: Populate Template**

Replace placeholders with real project data:
- `[PROJECT_NAME]` → Actual name
- `[LANGUAGE]` → Detected language
- `[FRAMEWORK]` → Detected framework
- `[code_example]` → Real code from codebase (5-15 lines)
- `[file:lines]` → Actual file paths

**3.2.4: Validate Size**
```bash
LINE_COUNT=$(wc -l < .codemie/guides/[category]/[guide].md)
if [ $LINE_COUNT -gt 400 ]; then
    # STOP - condense before continuing
fi
```

**3.2.5: Write Guide**
- Save to `.codemie/guides/[category]/[guide].md`
- Verify no placeholders remain

---

#### Step 3.3: Track Progress

Use TodoWrite to track by category:
```
Architecture:
- [ ] architecture/architecture.md

API Development:
- [ ] api/api-patterns.md

Data & Database:
- [ ] data/database-patterns.md

Testing:
- [ ] testing/testing-patterns.md

Development Practices:
- [ ] development/error-handling.md
- [ ] development/logging.md
- [ ] development/react-components.md

Security:
- [ ] security/security-patterns.md
```

---

### Phase 4: Generate CLAUDE.md

#### Step 4.1: Load Template

- Read `.codemie/claude-templates/templates/CLAUDE.md.template`

---

#### Step 4.2: Populate Sections

**4.2.1: Basic Info**
- Replace `[PROJECT_NAME]`, `[LANGUAGE]`, `[FRAMEWORK]`, etc.

**4.2.2: Critical Rules**
- Set environment rule based on project type (venv, nvm, docker, etc.)
- Remove rule row if not applicable

**4.2.3: Guide Imports Table**

List ALL guides grouped by category:

```markdown
| Category | Guide Path | Purpose |
|----------|------------|---------|
| Architecture | .codemie/guides/architecture/architecture.md | System layers and design patterns |
| API Development | .codemie/guides/api/api-patterns.md | REST endpoint conventions |
| Data & Database | .codemie/guides/data/database-patterns.md | PostgreSQL and SQLAlchemy patterns |
| Testing | .codemie/guides/testing/testing-patterns.md | Pytest patterns and fixtures |
| Development Practices | .codemie/guides/development/error-handling.md | Exception handling patterns |
| Development Practices | .codemie/guides/development/logging.md | Logging configuration |
| Development Practices | .codemie/guides/development/react-components.md | UI component patterns |
| Security | .codemie/guides/security/security-patterns.md | JWT auth and validation |
```

**4.2.4: Task Classifier**

Create intent-based category mapping (ONLY for categories that have guides):

```markdown
| Category | User Intent / Purpose | Example Requests | P0 Guide | P1 Guide |
|----------|----------------------|------------------|----------|----------|
| **Architecture** | System structure, design decisions, planning features | "How should I structure?", "Where should this go?" | .codemie/guides/architecture/architecture.md | - |
| **API Development** | Creating/modifying endpoints, routing, validation | "Create endpoint", "Add API for..." | .codemie/guides/api/api-patterns.md | - |
| **Data & Database** | Database operations, queries, models, migrations | "Query database", "Add new table" | .codemie/guides/data/database-patterns.md | - |
| **Testing** | Writing tests, fixing tests, coverage, mocking | "Write tests for...", "Fix failing test" | .codemie/guides/testing/testing-patterns.md | - |
| **Development Practices** | Code quality, error handling, logging, components | "Add error handling", "Create component" | .codemie/guides/development/error-handling.md | .codemie/guides/development/react-components.md |
| **Security** | Authentication, authorization, input validation | "Secure endpoint", "Add auth" | .codemie/guides/security/security-patterns.md | - |
```

**Note**: Exclude categories that don't have guides (e.g., if no Integrations guides, don't include Integrations row)

**4.2.5: Commands**
- Extract from package.json scripts, Makefile, pyproject.toml, etc.
- Include setup, run, lint, format, test, build

**4.2.6: Project Context**
- Technology stack table
- Project structure diagram
- Key integrations (if any)

**4.2.7: Troubleshooting**
- Common issues from README/CONTRIBUTING
- Environment setup problems

---

#### Step 4.3: Handle Existing CLAUDE.md

**If CLAUDE.md already exists**:
1. Compare existing vs generated
2. Preserve user customizations (custom rules, notes)
3. Update outdated sections (commands, guides list)
4. Add new guides to imports
5. Merge, don't overwrite

---

#### Step 4.4: Write CLAUDE.md

- Save to `./CLAUDE.md` (project root)
- Validate size (200-300 lines)
- Verify no placeholders remain

---

### Phase 5: Validation

#### Step 5.1: Verify All References

**Check**:
- [ ] Every guide path in CLAUDE.md exists
- [ ] All file:line references in guides are valid
- [ ] Commands are accurate (match package.json/Makefile)
- [ ] No `[PLACEHOLDER]` or `FILL IN` text remains
- [ ] Task Classifier only includes categories with actual guides

---

#### Step 5.2: Validate Sizes

```bash
# CLAUDE.md
wc -l CLAUDE.md  # Should be 200-300

# Each guide
for guide in .codemie/guides/**/*.md; do
    lines=$(wc -l < "$guide")
    if [ $lines -gt 400 ]; then
        echo "⚠️ $guide exceeds 400 lines ($lines)"
    fi
done
```

---

#### Step 5.3: Generate Summary Report

```markdown
# Codemie Init Complete

## Generated/Updated Files

**Main**: CLAUDE.md ✅

## Guides by Category

**Architecture** (1 guide):
- ✅ .codemie/guides/architecture/architecture.md

**API Development** (1 guide):
- ✅ .codemie/guides/api/api-patterns.md

**Data & Database** (1 guide):
- ✅ .codemie/guides/data/data-patterns.md

**Testing** (2 guides):
- ✅ .codemie/guides/testing/testing-patterns.md (created)
- ✅ .codemie/guides/testing/integration-testing.md (existing, kept)

**Development Practices** (3 guides):
- ✅ .codemie/guides/development/development-practices.md
- ✅ .codemie/guides/development/frontend-patterns.md
- ✅ .codemie/guides/development/react-components.md

**Security** (1 guide):
- ✅ .codemie/guides/security/security-patterns.md

**Categories Skipped**:
- ⏭️ Integrations - No external services detected
- ⏭️ Workflows - No workflow patterns detected

## Project Summary

| Component | Value |
|-----------|-------|
| Language | [Language] [Version] |
| Framework | [Framework] [Version] |
| Database | [Database or "None"] |
| Testing | [Framework] |

## Next Steps

1. Review generated documentation
2. Test by asking Claude Code to perform a task
3. Customize any sections needing refinement
```

---

## Decision Gates

| Gate | After Step | Question | If NO |
|------|------------|----------|-------|
| 1 | 1.2 | Tech stack identified (80%+ confidence)? | Ask user |
| 2 | 1.3 | Categories correctly identified? | Verify with user |
| 3 | 2.3 | User confirmed guide list? | Adjust list |
| 4 | 3.2.4 | Guide within size limit? | Condense |
| 5 | 4.4 | CLAUDE.md complete, no placeholders? | Fix issues |
| 6 | 5.1 | All references valid? | Fix broken refs |

---

## Troubleshooting

| Issue | Action |
|-------|--------|
| Can't identify architecture | Ask user; offer common patterns as options |
| No code examples for pattern | Verify pattern exists; skip guide if not |
| Multiple frameworks detected | Ask user which is primary; document both if needed |
| Existing guide conflicts with template | Preserve existing customizations; update only outdated parts |
| Guide exceeds 400 lines | Remove redundant examples; use tables; add file:line refs |
| Category detected but minimal code | Create minimal guide or ask user if needed |

---

## Success Criteria

- ✅ CLAUDE.md exists (200-300 lines)
- ✅ Only relevant guides created (categories with actual code patterns)
- ✅ All guides within 200-400 lines
- ✅ Existing guides integrated
- ✅ Task Classifier matches generated guides
- ✅ All code examples from actual codebase
- ✅ All file paths accurate
- ✅ All commands verified
- ✅ No placeholder text remains
- ✅ User confirmed accuracy