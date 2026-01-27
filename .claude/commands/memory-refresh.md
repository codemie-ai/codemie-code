# Refresh and Audit Project Documentation

**Purpose**: Verify and update project documentation to reflect current implementation. This includes both structured guides (if present) and CLAUDE.md memory files (if present).

**IMPORTANT**: Not every code change requires documentation updates. Only update documentation when:
- Implementation patterns have actually changed
- New architectural decisions were made
- Critical information is missing or incorrect
- Non-obvious behaviors have been introduced

If documentation accurately reflects the current codebase, no changes are needed.

---

**Step 1: Discover Documentation Structure**

Identify what documentation systems exist in the project:

**A. Structured Guides** (if present, commonly in `.codemie/guides/`, `.claude/guides/`, or `docs/`):
```
Typical structure (may vary by project):
├── architecture/       # System design, layering, patterns
├── development/        # Development practices, workflows
├── standards/          # Code quality, git workflow, conventions
├── testing/            # Testing patterns, frameworks
├── security/           # Security practices, credential handling
├── integration/        # External integrations, APIs
├── api/                # API patterns, endpoints
├── data/               # Database patterns, schemas
```

**B. CLAUDE.md Memory Files** (if present):
```
Common locations (project-specific):
├── CLAUDE.md                    # Root - project overview
├── src/agents/CLAUDE.md         # Component-specific
├── src/providers/CLAUDE.md
├── src/cli/CLAUDE.md
├── src/utils/CLAUDE.md
└── [other key directories]/CLAUDE.md
```

**Note**: Projects may have:
- Only structured guides
- Only CLAUDE.md files
- Both systems
- Neither (no action needed in this case)

---

**Step 2: Review Recent Changes**

Before reviewing documentation, understand what actually changed:

1. Check recent git commits: `git log --oneline -10`
2. Check current staged/unstaged changes: `git status` and `git diff`
3. Identify affected areas:
   - Did architectural patterns change?
   - Were new components/modules added?
   - Did error handling approaches evolve?
   - Were security practices updated?
   - Did testing strategies change?

**Decision Point**: If changes are minor (bug fixes, typos, small refactors), documentation likely doesn't need updates. Only proceed if changes affect patterns, architecture, or critical knowledge.

---

**Step 3: Audit Structured Guides (if present)**

For each guide file that exists:

**Review Process**:
1. Load the guide content
2. Compare documented patterns against actual implementation
3. Check if described patterns still match the codebase
4. Identify outdated, incorrect, or missing information

**Update Criteria** (only update if TRUE):
- [ ] Pattern described in guide no longer matches implementation
- [ ] New pattern emerged that should be documented
- [ ] Critical information is missing or incorrect
- [ ] Examples in guide reference deleted/renamed code
- [ ] Security or architectural decisions changed

**Common Guide Topics** (not all projects will have all guides):
- **Architecture**: Layering, plugin systems, dependency flow
- **Development**: Error handling, logging, async patterns, file operations
- **Testing**: Framework setup, mocking patterns, test organization
- **Security**: Credential storage, input validation, sanitization
- **Standards**: Code quality rules, git workflow, commit conventions
- **Integration**: External service patterns, API usage

**Guide Structure** (typical pattern, adapt to project):
```markdown
# [Topic Name]

## Overview
Brief description of what this guide covers

## Patterns
Key patterns used in the project

## Examples
Code examples demonstrating patterns

## Common Pitfalls
What to avoid

## Related Guides
Links to other relevant guides
```

---

**Step 4: Audit CLAUDE.md Files (if present)**

For each CLAUDE.md file that exists:

**Review Process**:
1. Load the current content
2. Compare documented patterns against actual implementation in that directory
3. Check if file structure/organization changed
4. Identify outdated, incorrect, or missing information

**Update Criteria** (only update if TRUE):
- [ ] Module purpose or responsibility changed
- [ ] Key architectural decisions evolved
- [ ] Important implementation details missing
- [ ] Documented patterns no longer used
- [ ] New gotchas or non-obvious behaviors introduced

**CLAUDE.md Content** (typical structure, adapt to project):
- Purpose and responsibility of this module
- Key architectural decisions
- Important implementation details
- Common patterns used throughout the code
- Non-obvious behaviors or gotchas
- Integration points with other modules

---

**Step 5: Determine Update Scope**

For files identified as needing updates:

**Structured Guides** → Update when:
- Pattern described is now incorrect
- New project-wide pattern should be documented
- Security or architectural approach changed
- Testing strategy evolved
- Critical examples are outdated

**CLAUDE.md Files** → Update when:
- Module responsibility shifted
- Implementation approach changed significantly
- New abstractions or patterns introduced
- Integration points modified
- Critical knowledge for future sessions

**No Update Needed** when:
- Bug fixes that don't affect patterns
- Code refactoring that maintains same approach
- Typo fixes or variable renames
- Documentation already accurate
- Changes are self-evident from code

---

**Step 6: Execute Updates (Selective)**

Only update files where changes are actually needed:

**For Structured Guides**:
1. Edit the specific sections that are outdated
2. Update code examples if referenced files changed
3. Add new patterns only if broadly applicable
4. Remove obsolete information
5. Keep guide focused and concise

**For CLAUDE.md Files**:
1. Verify technical claims against current codebase
2. Update specific sections that changed
3. Add new critical information
4. Remove obsolete patterns
5. Ensure information is in most appropriate file

**Content Placement Rules**:

If project has structured guides:
- Broad patterns → Guides (e.g., `.codemie/guides/development/error-handling.md`)
- Module-specific details → CLAUDE.md (e.g., `src/agents/CLAUDE.md`)

If project only has CLAUDE.md files:
- Project-wide patterns → Root `CLAUDE.md`
- Component-specific details → Component `CLAUDE.md`

---

**Step 7: Validate Changes**

Before finalizing updates:

**Accuracy Check**:
- [ ] All technical claims verified against current code
- [ ] Examples reference existing files/functions
- [ ] Patterns match actual implementation
- [ ] No contradictions between different docs

**Relevance Check**:
- [ ] Information is actionable
- [ ] Content helps future understanding
- [ ] No duplicate information across files
- [ ] No obsolete references

**Quality Check**:
- [ ] Clear and concise language
- [ ] Examples are accurate
- [ ] Proper markdown formatting
- [ ] Links work (if any)

---

**Remember**:
- Documentation serves the code, not vice versa
- Not every commit requires documentation changes
- Accuracy > Completeness (better to have less that's correct)
- If in doubt, verify against actual implementation
- Don't document what's obvious from well-written code
- Focus on "why" and "gotchas", not "what" (code shows "what")
