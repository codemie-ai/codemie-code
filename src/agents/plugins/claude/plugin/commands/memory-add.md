# Add New Knowledge to Project Documentation

**Purpose**: Capture important learnings from the current session that should persist for future work.

**Context**: You manage persistent memory using documentation systems. Common approaches:
- **CLAUDE.md files** - Project-specific context loaded recursively from working directory
- **Structured guides** - Organized documentation by topic/category (if present)
- **README/docs** - Traditional documentation files

Projects may use any combination of these systems or none at all.

---
## Additional user's input
Additional context/input from user: $ARGUMENTS. Might be empty by default.

## When to Add Documentation

**✅ DO add documentation when**:
- You learned something **non-obvious** about the project
- User corrected a **pattern or approach** you used
- You struggled to find critical information that should be documented
- You discovered an important **architectural decision** or **gotcha**
- User provided context about "**why**" something is done a certain way
- You had to infer important details that aren't clear from code alone
- A pattern contradicts common conventions for this language/framework

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

Reflect on the session:

**Documentation Triggers**:
- [ ] I was corrected on an implementation pattern
- [ ] I learned about a project-specific convention
- [ ] I discovered non-obvious behavior or gotcha
- [ ] I struggled to locate important information
- [ ] I learned architectural decisions or "why" behind choices
- [ ] I found out about critical integration points
- [ ] I discovered error handling or security patterns
- [ ] I learned testing or tooling conventions
- [ ] I discovered how components interact

**What specifically did I learn?**
- Specific pattern: _____
- Why it matters: _____
- Where it applies: _____

---

## Step 2: Determine Scope

**Broad Knowledge** (affects multiple components or entire project):
- Architectural patterns
- Error handling conventions
- Logging patterns
- Security practices
- Testing strategies
- Code quality standards
- Build/deployment processes

→ Add to **project-wide documentation** (root CLAUDE.md, main docs, or broad guides)

**Specific Knowledge** (affects one component/module):
- Module-specific patterns
- Component integration details
- Directory-specific conventions
- Local gotchas or behaviors

→ Add to **component documentation** (component CLAUDE.md or specific doc section)

---

## Step 3: Find Documentation Location

**Discover existing documentation**:
```bash
# Find CLAUDE.md files
find . -name "CLAUDE.md" -not -path "*/node_modules/*" -not -path "*/.git/*"

# Check for documentation directories
ls -la docs/ documentation/ .claude/guides/ 2>/dev/null
```

**Decision Tree**:

```
Is knowledge broad/project-wide?
├─ YES → Add to root documentation
│   ├─ Root CLAUDE.md (if exists)
│   ├─ README.md or ARCHITECTURE.md
│   ├─ docs/ or documentation/ directory
│   └─ Create root CLAUDE.md if none exists
│
└─ NO (component-specific) → Add to component documentation
    ├─ Component CLAUDE.md (if exists)
    ├─ Component README.md
    └─ Create component CLAUDE.md if appropriate
```

**Common Patterns**:
- **Root CLAUDE.md**: Project overview, architecture, main patterns
- **Component CLAUDE.md**: `src/[module]/CLAUDE.md`, `lib/[feature]/CLAUDE.md`
- **Structured docs**: `docs/architecture.md`, `docs/development.md`, etc.
- **README files**: High-level overview, setup, common patterns

---

## Step 4: Format the Knowledge

**For CLAUDE.md Files**:

```markdown
## [Topic Area or Module Name]

**[Specific Pattern/Knowledge]**:
- **What**: Brief description of the pattern/approach
- **Why**: Reason or context for this decision
- **Where**: Applicable locations or when to use it
- **Gotcha**: Non-obvious behavior (if any)

**Example** (if helpful):
```[language]
// Concise code example demonstrating pattern
```
```

**For Structured Documentation**:

```markdown
## [Pattern/Topic Name]

**Context**: When/why this pattern is used

**Pattern**:
[Description of the approach]

**Example**:
```[language]
// Code example demonstrating pattern
```

**Rationale**: Why we do it this way

**Common Pitfalls**: What to avoid
```

---

## Step 5: Add the Documentation

**For CLAUDE.md Files**:
1. Open or create the appropriate CLAUDE.md file
2. Find relevant section or create new heading
3. Add knowledge in structured format
4. Keep it concise and scannable
5. Include example only if pattern isn't obvious

**For Other Documentation**:
1. Locate the appropriate file (README, ARCHITECTURE, etc.)
2. Find relevant section or create one
3. Add information following existing format/style
4. Keep consistent with rest of document
5. Update table of contents if applicable

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

If knowledge spans multiple areas or files:

**In CLAUDE.md**:
```markdown
**Related Documentation**:
- See [ARCHITECTURE.md](./ARCHITECTURE.md) for system design
- See [src/auth/CLAUDE.md](./src/auth/CLAUDE.md) for auth patterns
```

**In structured docs**:
```markdown
**See also**:
- [Component Documentation](../component/CLAUDE.md)
- [Related Guide](./related-guide.md)
```

---

## Common Documentation Patterns

**Architectural Decisions**:
```markdown
## Architecture

**[Decision Name]**: We use [pattern/approach]
- **Rationale**: [Why this choice was made]
- **Trade-offs**: [What we gained/lost]
- **Alternative considered**: [What we didn't choose and why]
```

**Error Handling**:
```markdown
## Error Handling

- Use [specific error types/classes] for [scenario]
- Always [pattern] when [condition]
- Never [anti-pattern] because [reason]
```

**Testing Conventions**:
```markdown
## Testing

- Test files: [location pattern]
- Mocking: [approach and tools]
- Coverage: [requirements]
- Gotcha: [non-obvious testing behavior]
```

**Integration Points**:
```markdown
## [External Service/Component]

- **Authentication**: [method]
- **Configuration**: [where/how]
- **Error handling**: [approach]
- **Gotcha**: [non-obvious behavior]
```

---

## Examples (Generic, adapt to your project)

**Broad Pattern → Project Documentation**:
```
Learning: "Project uses custom error classes for each failure category"
Location: Root CLAUDE.md or docs/development.md
Section: Error Handling
```

**Component-Specific → Component Documentation**:
```
Learning: "Auth module requires initialization before any API calls"
Location: src/auth/CLAUDE.md
Section: Setup and Initialization
```

**Architectural → Architecture Documentation**:
```
Learning: "System uses event-driven architecture with message queue"
Location: ARCHITECTURE.md or root CLAUDE.md
Section: System Architecture
```

**Gotcha → Relevant Documentation**:
```
Learning: "Database connections must be manually closed in serverless"
Location: src/database/CLAUDE.md or docs/database.md
Section: Connection Management
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
- Over-document standard language features

**✅ Do**:
- Focus on "why" and "gotchas"
- Keep it concise and actionable
- Place in most specific applicable location
- Cross-reference related documentation
- Update existing docs rather than creating new files
- Validate information is still accurate before adding
- Document decisions and trade-offs

---

## Quick Decision Guide

**Question Flow**:
1. Is this **non-obvious** and **worth remembering**?
   → NO: Skip
2. Is it **broad/reusable** across components?
   → YES: Add to project-wide docs
3. Is it **component-specific**?
   → YES: Add to component docs
4. Does it **already exist** in documentation?
   → YES: Update if outdated, skip if accurate
5. Will I **struggle without** this in future sessions?
   → YES: Add it / NO: Skip

**File Selection**:
- **Project pattern** → Root CLAUDE.md, README, or main docs
- **Component behavior** → Component CLAUDE.md or README
- **Architecture** → ARCHITECTURE.md or root CLAUDE.md
- **Setup/workflow** → README.md or CONTRIBUTING.md
- **API patterns** → Relevant component or API docs

**Remember**: Less documentation that's accurate and maintained is better than comprehensive documentation that becomes stale. Focus on capturing **critical, non-obvious knowledge** that helps future work.
