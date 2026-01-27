# Refresh and Audit Project Documentation

**Purpose**: Verify and update project documentation to reflect current implementation.

**CRITICAL**: Not every code change requires documentation updates. Only update documentation when:
- Implementation patterns have actually changed
- New architectural decisions were made
- Critical information is missing or incorrect
- Non-obvious behaviors have been introduced

If documentation accurately reflects the current codebase, no changes are needed.



## Additional user's input
Additional context/input from user: $ARGUMENTS. Might be empty by default.

## Step 1: Discover What Documentation Exists

Identify documentation systems in this project:

**A. Structured Guides** (if present):
Common locations to check:
- `docs/`, `.claude/guides/`, `.codemie/guides/`, `documentation/`
- Look for topical organization (architecture, development, testing, etc.)

**B. CLAUDE.md Files** (if present):
- Root `CLAUDE.md` (project overview)
- Component-specific `CLAUDE.md` in subdirectories
- Common in: `src/`, `lib/`, feature directories

**C. Other Documentation**:
- `README.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`
- Wiki, Confluence, or external docs (mentioned in README)

**Note**: Projects may have any combination of these, or none at all.

---

## Step 2: Review Recent Changes

Before reviewing documentation, understand what changed:

1. **Check recent commits**: `git log --oneline -10`
2. **Check current changes**: `git status` and `git diff`
3. **Identify impact areas**:
   - Did architectural patterns change?
   - Were new components/modules added?
   - Did core approaches evolve (error handling, testing, etc.)?
   - Were security practices updated?
   - Did integrations or APIs change?

**Decision Point**: If changes are minor (bug fixes, typos, small refactors), documentation likely doesn't need updates. Only proceed if changes affect patterns, architecture, or critical knowledge.

---

## Step 3: Audit Structured Guides (if present)

For each guide/doc file that exists:

**Review Process**:
1. Load the content
2. Compare documented patterns against actual implementation
3. Check if described approaches still match the codebase
4. Identify outdated, incorrect, or missing information

**Update Only If**:
- [ ] Pattern described no longer matches implementation
- [ ] New pattern emerged that should be documented
- [ ] Critical information is missing or incorrect
- [ ] Examples reference deleted/renamed code
- [ ] Security or architectural decisions changed

**Common Documentation Topics** (adapt to your project):
- Architecture and system design
- Error handling and logging patterns
- Testing strategies and setup
- Security practices
- API patterns and conventions
- Database/data patterns
- Development workflow
- Deployment and operations

---

## Step 4: Audit CLAUDE.md Files (if present)

For each CLAUDE.md file:

**Find CLAUDE.md Files**:
```bash
find . -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*"
```

**Review Process**:
1. Load current content
2. Compare against actual implementation in that directory
3. Check if file structure/organization changed
4. Identify outdated, incorrect, or missing information

**Update Only If**:
- [ ] Module purpose or responsibility changed
- [ ] Key architectural decisions evolved
- [ ] Important implementation details missing
- [ ] Documented patterns no longer used
- [ ] New gotchas or non-obvious behaviors introduced

**Typical CLAUDE.md Content** (adapt to project style):
- Purpose and responsibility of module
- Key architectural decisions
- Important implementation details
- Common patterns used
- Non-obvious behaviors or gotchas
- Integration points with other modules

---

## Step 5: Determine What Needs Updating

Categorize findings:

**Definitely Update**:
- Documented pattern now incorrect
- Missing critical information for understanding
- Security or architectural approach changed
- Examples reference non-existent code
- Misleading or confusing content

**Probably Update**:
- New project-wide pattern should be documented
- Testing strategy evolved
- Integration points changed
- Important context missing

**No Update Needed**:
- Bug fixes that don't affect patterns
- Code refactoring maintaining same approach
- Typo fixes or variable renames
- Documentation already accurate
- Changes are self-evident from code

---

## Step 6: Execute Selective Updates

Only modify files where changes are actually needed:

**For Structured Guides**:
1. Edit specific sections that are outdated
2. Update code examples if references changed
3. Add new patterns only if broadly applicable
4. Remove obsolete information
5. Keep content focused and concise

**For CLAUDE.md Files**:
1. Verify technical claims against current code
2. Update specific sections that changed
3. Add new critical information
4. Remove obsolete patterns
5. Ensure info is in most appropriate file

**Content Placement**:
- **Broad patterns** (used across project) → Root docs or main CLAUDE.md
- **Component-specific** (local to one area) → Component CLAUDE.md or specific guide section
- **Project-wide conventions** → Root README or CLAUDE.md
- **Module implementation details** → Module-level CLAUDE.md

---

## Step 7: Validate Changes

Before finalizing:

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

## Key Principles

**Accuracy Over Completeness**:
- Better to have less documentation that's accurate
- Don't document what's obvious from well-written code
- Focus on "why" and "gotchas", not "what" (code shows "what")

**Selective Updates**:
- Not every commit requires documentation changes
- Only update when patterns or understanding actually shifts
- If in doubt, verify against actual implementation

**Appropriate Placement**:
- Put information where it's most useful
- Avoid duplication across files
- Component-specific → component docs
- Project-wide → root docs

**Maintainability**:
- Keep documentation focused
- Remove outdated content promptly
- Cross-reference related docs
- Use examples sparingly but effectively

---

## Decision Checklist

Before making changes, ask:

1. **Is this change needed?** (Does doc mismatch implementation?)
2. **Is it significant?** (Will this help future understanding?)
3. **Where should it go?** (Most specific applicable location)
4. **What's the scope?** (Component-specific or project-wide?)
5. **Is it accurate?** (Verified against current code?)
6. **Is it clear?** (Would someone else understand this?)

**If unsure**: Verify implementation first, then update documentation.

**Remember**: Documentation serves the code, not vice versa. Focus on critical, non-obvious knowledge that helps future work.
