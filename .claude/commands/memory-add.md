# Add New Knowledge to Project Documentation

**Purpose**: Capture important learnings from the current session that should persist for future work. This includes adding to structured guides (if present) and CLAUDE.md memory files (if present).

---

## Documentation Systems Overview

Projects may use different documentation approaches:

**A. Structured Guides** (if present, commonly `.codemie/guides/`, `.claude/guides/`, `docs/`):
- Organized by topic/category (architecture, development, testing, etc.)
- Contains reusable patterns and best practices
- Checked into version control for team sharing
- Loaded based on relevance to current task

**B. CLAUDE.md Memory Files** (if present):
- Located in repository root or component directories
- Project-specific context and patterns
- Loaded recursively from current directory upward
- Subdirectory files loaded only when working in that area

**C. Global User Memory** (optional):
- Personal `~/.claude/CLAUDE.md` for cross-project preferences
- Automatically merged into all sessions under home directory
- Use for personal conventions, not project-specific knowledge

**Note**: Projects may have guides only, CLAUDE.md only, both, or neither.

---

## When to Add Documentation

**✅ DO add documentation when**:
- You learned something **non-obvious** about the project
- User corrected a **pattern or approach** you used
- You struggled to find critical information that should be documented
- You discovered an important **architectural decision** or **gotcha**
- User provided context about "**why**" something is done a certain way
- You had to infer important details that aren't clear from code alone
- A pattern was repeated that contradicts common conventions

**❌ DON'T add documentation when**:
- Information is **obvious from well-written code**
- It's a **one-time fix** or edge case
- It's **implementation details** that may change frequently
- User just made a **typo correction** or minor fix
- Information already exists in documentation
- It's **standard practice** (not project-specific)

**Rule of Thumb**: If you would struggle with this again in a future session without documentation, add it. If it's obvious or self-evident, skip it.

---

## Step 1: Identify What You Learned

Reflect on the session and categorize your learnings:

**Triggers for Documentation**:
- [ ] I was corrected on an implementation pattern
- [ ] I learned about a project-specific convention
- [ ] I discovered non-obvious behavior or gotcha
- [ ] I struggled to locate important information
- [ ] I learned architectural decisions or "why" behind choices
- [ ] I found out about critical integration points
- [ ] I discovered security or error handling patterns
- [ ] I learned testing or tooling conventions

**What specifically did I learn?** (be concrete):
- Specific pattern: _____
- Why it matters: _____
- Where it applies: _____

---

## Step 2: Determine Scope (Broad vs Specific)

**Broad Knowledge** (affects multiple components or entire project):
- Architectural patterns (layering, plugin systems)
- Error handling conventions
- Logging patterns
- Security practices
- Testing strategies
- Git workflow rules
- Code quality standards

→ **Add to structured guides** (if they exist) or **root CLAUDE.md**

**Specific Knowledge** (affects one component/module):
- Module-specific patterns
- Component integration details
- Directory-specific conventions
- Local gotchas or behaviors

→ **Add to component CLAUDE.md** or **relevant guide section**

---

## Step 3: Choose Destination

### If Project Has Structured Guides:

**Decision Tree**:
```
Is knowledge broad/reusable?
├─ YES → Add to appropriate guide
│   ├─ Architecture → .codemie/guides/architecture/
│   ├─ Development patterns → .codemie/guides/development/
│   ├─ Testing → .codemie/guides/testing/
│   ├─ Security → .codemie/guides/security/
│   ├─ Standards → .codemie/guides/standards/
│   ├─ Integration → .codemie/guides/integration/
│   └─ Other → Most relevant guide
│
└─ NO → Add to component CLAUDE.md (if exists)
    └─ If no CLAUDE.md, add to most specific guide
```

**Common Guide Categories** (adapt to project structure):
- **architecture/** - System design, layers, plugin patterns
- **development/** - Error handling, logging, async patterns
- **testing/** - Testing frameworks, mocking, organization
- **security/** - Credentials, validation, sanitization
- **standards/** - Code quality, git workflow, conventions
- **integration/** - External APIs, provider patterns
- **api/** - API patterns, endpoints, contracts
- **data/** - Database patterns, schemas, queries

### If Project Only Has CLAUDE.md Files:

**Decision Tree**:
```
Is knowledge project-wide?
├─ YES → Add to root CLAUDE.md
│   └─ Project-level patterns, conventions, architecture
│
└─ NO → Add to component CLAUDE.md
    ├─ Example: src/agents/CLAUDE.md
    ├─ Example: src/providers/CLAUDE.md
    ├─ Example: src/cli/CLAUDE.md
    └─ Create new CLAUDE.md if directory lacks one
```

**Common Component Locations** (project-specific):
- Root CLAUDE.md → Project overview, main patterns
- src/[component]/CLAUDE.md → Component-specific patterns
- tests/CLAUDE.md → Testing setup and conventions
- scripts/CLAUDE.md → Build/deployment patterns

### If Project Has Both Systems:

**Use this priority**:
1. **Broad, reusable patterns** → Structured guides
2. **Component-specific details** → Component CLAUDE.md
3. **Temporary or experimental** → Component CLAUDE.md (easier to update)
4. **Architectural decisions** → Architecture guide + root CLAUDE.md (cross-reference)

---

## Step 4: Format the Knowledge

**For Structured Guides**:

Add to existing section or create new section:

```markdown
## [Pattern/Topic Name]

**Context**: When/why this pattern is used

**Pattern**:
[Description of the approach]

**Example**:
```[language]
// Code example demonstrating pattern
```

**Rationale**: Why we do it this way (not just what)

**Common Pitfalls**: What to avoid
```

**For CLAUDE.md Files**:

Add under appropriate section:

```markdown
## [Topic Area]

**[Specific Pattern/Knowledge]**:
- What: Brief description
- Why: Reason or context
- Where: Applicable locations
- Gotcha: Non-obvious behavior (if any)

**Example** (if helpful):
```[language]
// Concise code example
```
```

---

## Step 5: Add the Documentation

**For Guides**:
1. Locate the appropriate guide file
2. Find the relevant section or create one
3. Add knowledge in structured format
4. Keep it concise and actionable
5. Include example if pattern isn't obvious

**For CLAUDE.md Files**:
1. Locate or create the appropriate CLAUDE.md
2. Add to existing section or create new heading
3. Be specific about what, why, where
4. Keep it focused and scannable
5. No need for exhaustive examples

**Quality Checklist**:
- [ ] Clearly states what the pattern/knowledge is
- [ ] Explains why it matters (not just what)
- [ ] Specific enough to be actionable
- [ ] Concise (no unnecessary words)
- [ ] Example included if pattern is non-obvious
- [ ] Placed in most logical location
- [ ] Doesn't duplicate existing documentation

---

## Step 6: Cross-Reference (if applicable)

If knowledge spans multiple areas:

**In Guides**: Add "See also" links
```markdown
**See also**:
- [Related Guide](../other-category/guide.md)
- [Component CLAUDE.md](../../src/component/CLAUDE.md)
```

**In CLAUDE.md**: Reference guides
```markdown
**Related Guides**:
- See `.codemie/guides/development/patterns.md` for broader context
```

---

## Examples (CodeMie-specific, adapt to your project)

**Broad Pattern → Guide**:
```
Learning: "Project uses specific error classes for each failure type"
Destination: .codemie/guides/development/development-practices.md
Section: Error Handling
```

**Component-Specific → CLAUDE.md**:
```
Learning: "Agent plugins must register with registry before execution"
Destination: src/agents/CLAUDE.md
Section: Plugin Registration
```

**Architectural Decision → Both**:
```
Learning: "5-layer architecture with strict dependency flow"
Destination 1: .codemie/guides/architecture/architecture.md (full detail)
Destination 2: CLAUDE.md (summary + reference to guide)
```

**Security Pattern → Security Guide**:
```
Learning: "All credentials stored in CredentialStore with keychain + encryption"
Destination: .codemie/guides/security/security-practices.md
Section: Credential Management
```

---

## Common Pitfalls to Avoid

**❌ Don't**:
- Document what's obvious from code
- Add every minor detail or edge case
- Duplicate information across multiple files
- Include temporary workarounds or TODOs
- Write exhaustive implementation details
- Add information that changes frequently

**✅ Do**:
- Focus on "why" and "gotchas"
- Keep it concise and actionable
- Place in most specific applicable location
- Cross-reference related documentation
- Update existing docs rather than creating new sections
- Validate information is still accurate before adding

---

## Quick Decision Guide

**Question Flow**:
1. Is this **non-obvious** and **worth remembering**? → NO: Skip
2. Is it **broad/reusable** across components? → YES: Add to guide (if exists) or root CLAUDE.md
3. Is it **component-specific**? → YES: Add to component CLAUDE.md
4. Does it **already exist** in documentation? → YES: Update if outdated, skip if accurate
5. Will I **struggle without** this in future sessions? → YES: Add it / NO: Skip

**Remember**: Less documentation that's accurate and maintained is better than comprehensive documentation that becomes stale. Focus on capturing **critical, non-obvious knowledge** that helps future work.
