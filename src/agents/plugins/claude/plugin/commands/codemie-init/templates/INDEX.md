# Template Index

## Overview

Concise templates for generating Claude Code documentation. Each template is **150-250 lines max**, focusing on contracts and best practices.

---

## Main Template

### CLAUDE.md.template
**Lines**: ~300
**Purpose**: Main AI-optimized execution guide
**Use**: Every project (required)

---

## Guide Templates (10 Total)

### Required (P0) - For All Projects

#### development/development-practices.md.template
**Lines**: ~180
**Covers**: Error handling, logging, configuration, setup
**Use**: All projects
**Combines**: Error patterns + logging + config + setup in one file

#### security/security-practices.md.template
**Lines**: ~160
**Covers**: Auth, authorization, validation, secrets, SQL injection, XSS
**Use**: All projects

#### testing/testing-patterns.md.template
**Lines**: ~125
**Covers**: Unit tests, integration tests, fixtures, mocking
**Use**: All projects

#### standards/code-quality.md.template
**Lines**: ~135
**Covers**: Linting, formatting, type safety, naming
**Use**: All projects

#### standards/git-workflow.md.template
**Lines**: ~160
**Covers**: Branching, commits, PRs, code review
**Use**: All projects

---

### Recommended (P1) - Based on Project Type

#### api/api-patterns.md.template
**Lines**: ~190
**Covers**: CRUD, validation, auth, pagination, errors, rate limiting
**Use**: Projects with REST/GraphQL APIs

#### architecture/layered-architecture.md.template
**Lines**: ~125
**Covers**: Layer responsibilities, communication, error flow, testing
**Use**: Projects with layered architecture

#### architecture/project-structure.md.template
**Lines**: ~110
**Covers**: Directory layout, module organization, navigation
**Use**: For better code navigation (optional)

#### data/database-patterns.md.template
**Lines**: ~160
**Covers**: Models, CRUD, transactions, migrations, N+1 prevention
**Use**: Projects using databases

#### integration/external-integrations.md.template
**Lines**: ~145
**Covers**: API clients, auth, retries, rate limiting, error handling
**Use**: Projects with external API integrations

---

## Template Size Guide

**Target**: 150-250 lines per template
**Philosophy**: Concise, focused, efficient
**Content**: Best practices and contracts, minimal code examples

### Size Breakdown

| Template | Lines | Type |
|----------|-------|------|
| CLAUDE.md | ~300 | Main |
| development-practices | ~180 | Required |
| security-practices | ~160 | Required |
| testing-patterns | ~125 | Required |
| code-quality | ~135 | Required |
| git-workflow | ~160 | Required |
| api-patterns | ~190 | Optional |
| layered-architecture | ~125 | Optional |
| project-structure | ~110 | Optional |
| database-patterns | ~160 | Optional |
| external-integrations | ~145 | Optional |

**Total**: ~1,790 lines for all templates
**Generated docs**: 200-400 lines per guide (target)

---

## Template Selection

### Decision Matrix

| Found in Project | Required Template | Optional Template |
|------------------|------------------|-------------------|
| **Always** | development-practices, security-practices, testing-patterns, code-quality, git-workflow | - |
| REST/GraphQL endpoints | - | api-patterns |
| Layered architecture | - | layered-architecture, project-structure |
| Database/ORM | - | database-patterns |
| External APIs | - | external-integrations |

### Quick Selection

**Minimal (5 guides)**:
- development-practices
- security-practices
- testing-patterns
- code-quality
- git-workflow

**Standard Web App (8 guides)**:
- All minimal +
- api-patterns
- layered-architecture
- database-patterns

**Full Stack (10 guides)**:
- All standard +
- project-structure
- external-integrations

---

## Placeholders

### Global (All Templates)

- `[PROJECT_NAME]` - Project name
- `[LANGUAGE]` - Programming language
- `[FRAMEWORK]` - Main framework
- `[file:lines]` - Source file reference
- `[code_example]` - Brief code snippet
- `# FILL IN` - Project-specific section

### Template-Specific

- `[DATABASE]` / `[ORM]` - Database patterns
- `[TEST_FRAMEWORK]` - Testing patterns
- `[LINTER]` / `[FORMATTER]` - Code quality
- `[AUTH_METHOD]` - Security/API patterns

---

## Usage

### For Claude Code Generation

1. Analyze project (tech stack, patterns)
2. Select templates (P0 + relevant P1)
3. For each template:
   - Search codebase for patterns
   - Extract concise examples (< 20 lines)
   - Replace placeholders
   - Fill sections
4. Generate CLAUDE.md last
5. **Validate**: Each guide 200-400 lines max

### For Manual Use

1. Copy template
2. Replace `[PLACEHOLDERS]`
3. Fill `# FILL IN` sections
4. Add brief code examples
5. Keep concise (200-400 lines)

---

## Version History

### v2.0 (2026-01-14)
- **Major revision**: Condensed all templates
- Combined development folder into single file
- Moved security to separate folder
- Reduced from 14 to 10 templates
- Target: 150-250 lines per template
- Focus: Contracts and best practices, not extensive examples

### v1.0 (2026-01-14)
- Initial release (deprecated)

---

## References

- **Generation Command**: `../codemie-init-skill.md`
- **README**: `../README.md`
- **Source**: CodeMie project patterns

---
