# Claude Code Documentation Templates

**Version**: 1.0
**Purpose**: Generic templates for generating AI-optimized project documentation for Claude Code

---

## Overview

This directory contains a complete template system for generating Claude Code documentation for any software project. The templates are based on the successful documentation patterns used in the CodeMie project and adapted to be generic and reusable.

### What This Generates

- **CLAUDE.md**: Main AI-optimized execution guide in project root
- **Guides**: Detailed pattern guides in `.codemie/guides/` directory
- **Structure**: Properly organized documentation following AI-first principles

### Key Benefits

- ✅ **AI-Optimized**: Pattern-first, example-driven, highly structured
- ✅ **Project-Specific**: Filled with real code examples from your project
- ✅ **Comprehensive**: Covers architecture, patterns, workflows, and best practices
- ✅ **Reusable**: Generic templates work for any tech stack
- ✅ **Actionable**: Claude Code can immediately use the documentation

---

## Directory Structure

```
claude-templates/
├── README.md                          # This file
├── codemie-init-skill.md             # Command to generate documentation
└── templates/
    ├── CLAUDE.md.template             # Main CLAUDE.md template
    └── guides/                        # Guide templates by category
        ├── agents/                    # AI agent patterns (optional)
        ├── api/
        │   └── api-patterns.md.template
        ├── architecture/
        │   └── layered-architecture.md.template
        ├── data/
        │   └── database-patterns.md.template
        ├── development/
        │   ├── error-handling.md.template
        │   ├── logging-patterns.md.template
        │   ├── security-patterns.md.template
        │   └── setup-guide.md.template
        ├── integration/
        │   └── [future templates]
        ├── standards/
        │   ├── code-quality.md.template
        │   └── git-workflow.md.template
        ├── testing/
        │   └── testing-patterns.md.template
        └── workflows/                 # Workflow patterns (optional)
```

---

## Quick Start

### For Users: Generate Documentation for Your Project

1. **Navigate to your project**:
   ```bash
   cd /path/to/your/project
   ```

2. **Invoke Claude Code with the codemie-init command**:
   ```
   @codemie-init Generate project documentation for my [framework] project
   ```

3. **Follow prompts**: Claude Code will:
   - Analyze your project structure
   - Identify patterns and tech stack
   - Ask which guides to generate
   - Create documentation with real code examples

4. **Review output**:
   - CLAUDE.md in project root
   - Guides in .codemie/guides/
   - Summary report

5. **Customize** (optional): Refine project-specific sections

### For Template Developers: Adding New Templates

1. **Create template file**:
   ```bash
   touch claude-templates/templates/guides/[category]/[name].md.template
   ```

2. **Follow template structure**:
   - Use AI-first writing principles (see CodeMie guides/WRITING_GUIDELINES.md)
   - Use placeholders: `[PROJECT_NAME]`, `[LANGUAGE]`, `[FRAMEWORK]`, etc.
   - Include `# FILL IN` comments for project-specific content
   - Add code examples with `[language]` and `[code_example]` placeholders
   - Reference source files with `[file.ext:lines]` format

3. **Add to codemie-init-skill.md**:
   - Update decision matrix in Step 2.2
   - Add analysis steps in Step 3.2.2
   - Document pattern detection

4. **Test** with real project

---

## Template Structure

### CLAUDE.md.template

**Main sections**:
- Guide Imports: References to all generated guides
- Instant Start: Critical rules, task classifier, self-check
- Execution Workflow: Step-by-step process with gates
- Pattern Quick Reference: Fast lookups for common patterns
- Development Commands: Project-specific commands
- Troubleshooting: Common issues and fixes
- Project Context: Tech stack and architecture
- Coding Standards: Language features and conventions
- Detailed Policies: Testing, git, environment, shell

**Placeholders**:
- `[PROJECT_NAME]`: Project name
- `[LANGUAGE]`: Programming language
- `[FRAMEWORK]`: Main framework
- `[ENV_NAME]`: Environment name (e.g., virtualenv, venv)
- `[category]`: Guide category
- `[guide]`: Guide name
- `# FILL IN`: Sections that need project-specific content

---

### Guide Templates

**Common structure**:
1. **Quick Summary**: What this guide covers
2. **Prerequisites**: Required knowledge
3. **Patterns**: 3-5 main patterns with examples
4. **Best Practices**: DO/DON'T tables
5. **Integration**: Links to related patterns
6. **References**: Source code and external docs

**Placeholders**:
- `[PROJECT_NAME]`: Project name
- `[LANGUAGE]`: Programming language
- `[FRAMEWORK]`: Framework/tool name
- `[DATABASE_NAME]`: Database name
- `[TEST_FRAMEWORK]`: Testing framework
- `[file.ext:lines]`: Source file reference
- `[code_example]`: Code snippet placeholder
- `# FILL IN`: Project-specific content

**Available templates**:
- **development/error-handling.md.template**: Exception patterns, error responses
- **development/logging-patterns.md.template**: Logging best practices
- **development/security-patterns.md.template**: Authentication, validation, encryption
- **development/setup-guide.md.template**: Installation and setup
- **api/api-patterns.md.template**: REST/GraphQL endpoint patterns
- **architecture/layered-architecture.md.template**: Layer responsibilities and flow
- **data/database-patterns.md.template**: ORM, queries, transactions, migrations
- **testing/testing-patterns.md.template**: Unit/integration tests, fixtures, mocking
- **standards/code-quality.md.template**: Linting, formatting, type safety
- **standards/git-workflow.md.template**: Branching, commits, PRs

---

## Usage Guide

### How codemie-init-skill.md Works

The documentation generation process has 5 phases:

#### Phase 1: Project Discovery & Analysis
- Analyzes project structure (directories, files)
- Identifies tech stack (language, frameworks, tools)
- Detects architectural patterns (layers, components)
- Reads existing documentation (README, CONTRIBUTING)

#### Phase 2: Template Selection & Customization
- Loads CLAUDE.md template
- Identifies which guides are relevant based on detected patterns
- Presents list to user for confirmation
- Prioritizes guides (P0=required, P1=optional)

#### Phase 3: Guide Generation
- Creates .codemie/guides/ directory structure
- For each selected guide:
  - Loads template
  - Searches codebase for relevant patterns
  - Extracts real code examples
  - Fills template placeholders
  - Writes completed guide
- Tracks progress with todos

#### Phase 4: Generate Main CLAUDE.md
- Fills basic placeholders (project name, language, etc.)
- Populates guide references
- Creates task classifier with project keywords
- Extracts patterns for quick reference tables
- Documents commands from project
- Fills troubleshooting section
- Completes project context

#### Phase 5: Validation & Finalization
- Verifies all files exist
- Validates internal links
- Tests documented commands
- Reviews content quality (no placeholders remain)
- Generates summary report

### Decision Gates

The process includes 5 decision gates where Claude Code checks:
1. Understanding of tech stack (80%+ confidence)
2. Right guides identified (user confirmation)
3. Guide content complete (no placeholders)
4. CLAUDE.md complete (project-specific)
5. Validation passed (links work, commands run)

---

## Template Customization Guide

### Adding a New Guide Template

**Example**: Adding a "deployment-patterns.md.template"

1. **Create template**:
   ```bash
   touch claude-templates/templates/guides/deployment/deployment-patterns.md.template
   ```

2. **Write template content**:
   ```markdown
   # Deployment Patterns

   ## Quick Summary

   Deployment patterns for [PROJECT_NAME]. Covers [CI/CD], [containerization], and [cloud deployment].

   **Category**: Deployment
   **Complexity**: High
   **Prerequisites**: [CI/CD tool], [container tool], [cloud platform]

   ## Pattern 1: [Container Build]

   ```[language]
   # Source: [file.ext:lines]
   [code_example]
   ```

   ## Pattern 2: [CI/CD Pipeline]

   # FILL IN: Document your CI/CD pipeline

   ...
   ```

3. **Update codemie-init-skill.md**:
   - Add to decision matrix:
     ```markdown
     | Docker/Kubernetes found | deployment/deployment-patterns.md | P1 (Optional) |
     ```
   - Add analysis step:
     ```markdown
     **For Deployment Guide**:
     - Search for Dockerfile
     - Find CI/CD config (.github/workflows/, .gitlab-ci.yml)
     - Identify deployment scripts
     ```

4. **Test** by generating docs for project with deployment patterns

---

### Customizing Placeholders

**Global placeholders** (used everywhere):
- `[PROJECT_NAME]`: Project name
- `[LANGUAGE]`: Programming language(s)
- `[FRAMEWORK]`: Main framework

**Guide-specific placeholders**:
- `[DATABASE_NAME]`: PostgreSQL, MySQL, MongoDB, etc.
- `[TEST_FRAMEWORK]`: pytest, Jest, JUnit, etc.
- `[ORM]`: SQLAlchemy, Prisma, Hibernate, etc.
- `[CI/CD]`: GitHub Actions, GitLab CI, Jenkins, etc.

**Code placeholders**:
- `[language]`: Language for code blocks (python, typescript, java, etc.)
- `[file.ext:lines]`: Actual file path with line numbers
- `[code_example]`: Real code from project
- `# FILL IN`: Sections needing project-specific content

**Adding new placeholders**:
1. Use descriptive names in brackets: `[NEW_PLACEHOLDER]`
2. Document in template header
3. Add to codemie-init-skill.md replacement logic

---

## Best Practices

### Template Writing

1. **AI-First Principles**:
   - Pattern-first (code before explanation)
   - Example-driven (3+ examples)
   - Structured (tables, lists, code blocks)
   - Dense (high information per line)
   - See CodeMie `.codemie/guides/WRITING_GUIDELINES.md`

2. **Placeholder Strategy**:
   - Use placeholders for project-specific terms
   - Use `# FILL IN` for sections that need analysis
   - Keep generic sections generic
   - Make templates 80% reusable, 20% customizable

3. **Code Examples**:
   - Always include source reference: `# Source: [file.ext:lines]`
   - Show complete, runnable examples
   - Use real patterns (not toy examples)
   - Keep examples < 20 lines

4. **Links and References**:
   - Use relative paths: `./other-guide.md`
   - Link related patterns
   - Reference source code
   - Include external docs

### Documentation Generation

1. **Discovery**:
   - Use Glob for file finding (fast)
   - Use Grep for pattern searching (specific)
   - Use Read for file content (targeted)
   - Prefer Task tool for open-ended exploration

2. **Analysis**:
   - Look for established patterns first
   - Extract real code examples
   - Note file paths with line numbers
   - Identify conventions

3. **Customization**:
   - Replace ALL placeholders
   - Fill ALL "FILL IN" sections
   - Use real commands (tested)
   - Include actual configuration

4. **Validation**:
   - Test all commands
   - Verify all links
   - Check code examples compile
   - Ensure no placeholders remain

---

## Troubleshooting

### Issue: Template doesn't fit project

**Symptom**: Project uses different patterns than template assumes
**Solution**:
1. Customize template for your needs
2. Create project-specific template variant
3. Document deviations in guide header

### Issue: Can't find code examples

**Symptom**: Project doesn't have clear examples of pattern
**Solution**:
1. Check if pattern actually exists in project
2. If not, consider if guide is needed
3. If aspirational, note as "TODO: Implement" in guide

### Issue: Multiple frameworks/languages

**Symptom**: Project is polyglot or uses multiple frameworks
**Solution**:
1. Create separate guides for each
2. Or, document both in same guide with sections
3. Update CLAUDE.md task classifier to handle both

### Issue: Large codebase takes too long

**Symptom**: Discovery phase takes 10+ minutes
**Solution**:
1. Start with P0 guides only
2. Generate guides iteratively
3. Focus on most important patterns first
4. Use Task tool with Explore agent for large-scale discovery

---

## Examples

### Example 1: FastAPI + PostgreSQL Project

**Detected**:
- Language: Python
- Framework: FastAPI
- Database: PostgreSQL (SQLAlchemy)
- Testing: pytest
- Linter: ruff

**Generated guides**:
- api/api-patterns.md (FastAPI endpoints)
- architecture/layered-architecture.md (router→service→repository)
- data/database-patterns.md (SQLAlchemy models, queries)
- development/error-handling.md (FastAPI exception handlers)
- development/logging-patterns.md (Python logging)
- development/security-patterns.md (JWT, input validation)
- development/setup-guide.md (Poetry, virtualenv)
- testing/testing-patterns.md (pytest, fixtures)
- standards/code-quality.md (ruff configuration)
- standards/git-workflow.md (branch strategy)

**Time**: ~15 minutes

---

### Example 2: Express.js + MongoDB Project

**Detected**:
- Language: TypeScript
- Framework: Express.js
- Database: MongoDB (Mongoose)
- Testing: Jest
- Linter: ESLint

**Generated guides**:
- api/api-patterns.md (Express routes)
- architecture/layered-architecture.md (routes→services→repositories)
- data/database-patterns.md (Mongoose schemas, queries)
- development/error-handling.md (Express error middleware)
- development/logging-patterns.md (Winston/Morgan)
- development/security-patterns.md (Passport.js, JWT)
- development/setup-guide.md (npm, node_modules)
- testing/testing-patterns.md (Jest, mocking)
- standards/code-quality.md (ESLint, Prettier)
- standards/git-workflow.md (branch strategy)

**Time**: ~12 minutes

---

### Example 3: Spring Boot + MySQL Project

**Detected**:
- Language: Java
- Framework: Spring Boot
- Database: MySQL (JPA/Hibernate)
- Testing: JUnit
- Build: Maven

**Generated guides**:
- api/api-patterns.md (REST controllers)
- architecture/layered-architecture.md (controller→service→repository)
- data/database-patterns.md (JPA entities, repositories)
- development/error-handling.md (Exception handlers)
- development/logging-patterns.md (SLF4J/Logback)
- development/security-patterns.md (Spring Security)
- development/setup-guide.md (Maven, Java setup)
- testing/testing-patterns.md (JUnit, Mockito)
- standards/code-quality.md (Checkstyle)
- standards/git-workflow.md (branch strategy)

**Time**: ~18 minutes

---

## Contributing

### Adding Templates

1. Follow existing template structure
2. Use AI-first writing principles
3. Include comprehensive placeholders
4. Add examples from real projects
5. Test with 2-3 different project types
6. Update this README

### Improving Templates

1. Identify gaps or unclear sections
2. Add missing patterns
3. Improve examples
4. Enhance placeholder coverage
5. Update codemie-init-skill.md if logic changes

### Reporting Issues

File issues with:
- Template name
- Project type where it failed
- What was unclear or missing
- Suggested improvements

---

## Version History

### v1.0 (2026-01-14)
- Initial release
- 10 guide templates covering common patterns
- Main CLAUDE.md template
- Complete codemie-init-skill command
- Support for Python, TypeScript, Java, and other major languages

---

## License

[Your License Here]

---

## References

- **Source Project**: CodeMie (where these patterns originated)
- **Writing Guidelines**: `.codemie/guides/WRITING_GUIDELINES.md` in CodeMie
- **Claude Code Documentation**: https://claude.com/claude-code
- **AI-First Documentation Principles**: Based on LangChain, FastAPI, and Anthropic docs

---

## Contact

For questions or support:
- [Contact method]
- [Issue tracker]
- [Documentation]

---
