---
name: tech-lead
description: This skill should be used when the user asks to "implement a Jira ticket", "start working on EPMCDME ticket", "analyze task", "begin implementation", "implement new task", "implement feature", "act as tech lead", "plan implementation", "how should I implement", or wants structured technical leadership for implementing features. Acts as a technical lead to guide implementation from requirements (Jira ticket or user description) through complexity assessment, architectural analysis, branch creation, and pattern-driven coding.
version: 0.1.0
---

# Tech Lead: Structured Implementation Guide

## Purpose

This skill acts as a technical lead to guide implementation of features and tasks with a structured approach. It bridges the gap between requirements and code by:
- Gathering requirements (from Jira tickets or user descriptions)
- Analyzing codebase and architectural patterns
- Assessing complexity and risks
- Creating feature branches
- Driving implementation with proper guidance

The skill ensures structured, informed development that follows project patterns and architectural guidelines.

## When to Use This Skill

Use this skill when:
- Starting work on a Jira ticket (EPMCDME-XXXX)
- Implementing a new feature or task (with or without Jira ticket)
- Need to assess implementation complexity before coding
- Want guidance on where and how to implement changes
- Need to create a proper feature branch
- Transitioning from requirements to implementation

## Implementation Workflow

### Phase 1: Requirement Gathering

**Step 1: Determine Requirement Source**

Check if user provided:
- **Jira ticket ID** (EPMCDME-XXXXX format)
- **Task description** (user-provided text)

**Step 1a: If Jira Ticket Provided**

Use the brianna skill to fetch ONLY description and summary fields:

```
Use Skill tool with skill="brianna" and args containing:
- Action: get ticket details
- Ticket ID: [provided by user]
- Fields: description, summary ONLY
```

Do NOT request other fields like status, assignee, or custom fields unless explicitly needed for complexity assessment.

**Step 1b: If Task Description Provided**

If user provides a task description without a Jira ticket:

1. **Confirm understanding** of the requirements
2. **Ask clarifying questions** if requirements are vague
3. **Document requirements** in a structured format for later reference

Example:
```markdown
## Task Requirements

**Goal**: [What needs to be implemented]

**Acceptance Criteria**:
- [Criterion 1]
- [Criterion 2]
- [Criterion 3]

**Context**: [Any additional context or constraints]
```

**Step 2: Branch Naming Decision**

Determine appropriate branch name:

**If Jira ticket exists:**
- Branch name: `EPMCDME-XXXXX` (exact ticket ID)

**If no Jira ticket:**
- Ask user for preferred branch name
- Suggest format: `feature/descriptive-name` or `task/descriptive-name`
- Example: `feature/add-user-logging`, `task/improve-error-handling`

### Phase 2: Technical Analysis

**Step 3: Explore Codebase and Guides**

After obtaining ticket details, perform targeted exploration:

1. **Check Relevant Guides First (MANDATORY)**
   - Identify task category from ticket (API, Agent, Database, etc.)
   - Use Read tool to load P0 guides from `.codemie/guides/`
   - Reference CLAUDE.md Task Classifier for guide mapping

2. **Search Codebase**
   - Use Grep to find related code patterns
   - Use Glob to locate relevant files
   - Identify existing implementations to follow

3. **Understand Architecture**
   - Determine affected layers (API → Service → Repository)
   - Identify integration points
   - Check for similar existing features

**Exploration Guidelines:**
- Focus on code patterns mentioned in ticket
- Prioritize guides over blind codebase search
- Look for existing similar implementations
- Identify affected components and dependencies

**Step 4: Clarifying Questions (Selective)**

Ask clarifying questions ONLY when:
- Requirements are ambiguous or contradictory
- Multiple valid implementation approaches exist
- Architectural decisions need user input
- Ticket lacks critical technical details

**Do NOT ask about:**
- Information already present in code
- Generic questions ("Should I use async?")
- Standard patterns covered in guides
- Details that can be inferred from existing implementations

Use AskUserQuestion tool with focused, specific questions that unblock implementation decisions.

### Phase 3: Complexity Assessment

**Step 5: Analyze and Report Complexity**

Provide a structured complexity assessment in this format:

```markdown
## Implementation Analysis: [TICKET-ID]

### Complexity Rating: [Simple | Medium | Complex]

### Reasoning:
- **[Point 1]**: [Explanation of complexity factor]
- **[Point 2]**: [Explanation of complexity factor]
- **[Point 3]**: [Explanation of complexity factor]
- **[Point 4]**: [Explanation of complexity factor - optional]

### Clarity Assessment:
[Clear | Partially Clear | Unclear] - [Brief explanation]

### Affected Components:
- **[Component 1]**: [File path or module] - [Nature of change]
- **[Component 2]**: [File path or module] - [Nature of change]
- **[Component 3]**: [File path or module] - [Nature of change]
```

**Complexity Criteria:**

**Simple:**
- Single component affected
- Well-defined requirements
- Existing patterns to follow
- No architectural decisions needed
- Estimated 1-3 files to change

**Medium:**
- 2-3 components affected
- Clear requirements with minor gaps
- May require some architectural decisions
- Estimated 4-8 files to change
- Requires coordination between layers

**Complex:**
- 4+ components affected
- Ambiguous or incomplete requirements
- Significant architectural decisions needed
- Estimated 9+ files to change
- Cross-cutting concerns (security, performance)
- New integrations or external dependencies

### Phase 4: Recommendation

**Step 6: Provide Implementation Recommendation**

Based on complexity assessment, provide one of these recommendations:

**For Simple/Medium Complexity:**
```markdown
### Recommendation

This feature is [Simple/Medium] complexity and can be implemented directly.

**Suggested Approach:**
1. Create feature branch: `[branch-name]`
2. [Step-by-step implementation guidance]
3. [Key patterns to follow]
4. [Testing approach]

Upon user confirmation, create the feature branch and begin implementation.
```

**For Complex Complexity:**
```markdown
### Recommendation

This feature is Complex and would benefit from architectural planning.

**Suggested Next Steps:**
1. Use solution-architect skill to create detailed specification
2. Address architectural decisions: [list key decisions]
3. Define interfaces and contracts
4. Create implementation plan with milestones

Alternatively, proceed with implementation if user accepts the complexity. Ask user to choose approach.
```

### Phase 5: Implementation Start

**Step 7: Branch Creation and Implementation**

If user agrees to proceed with implementation:

**CRITICAL: Always create feature branch before any code changes**

1. **Create Feature Branch:**
   ```bash
   # Check current branch
   git branch --show-current

   # Create and switch to feature branch
   # For Jira tickets:
   git checkout -b EPMCDME-XXXXX

   # For non-Jira tasks (use determined branch name):
   git checkout -b feature/branch-name
   ```

2. **Verify Branch:**
   ```bash
   # Confirm on new branch
   git branch --show-current
   ```

3. **Begin Implementation:**
   - Follow patterns identified in analysis phase
   - Reference guides for standard approaches
   - Implement changes layer by layer (API → Service → Repository)
   - Apply security and performance patterns

**Branch Naming:**

For Jira tickets:
- Format: `EPMCDME-XXXXX` (exactly as ticket ID)
- No prefixes like `feature/` or `fix/`
- Use ticket number as-is

For non-Jira tasks:
- Format: `feature/descriptive-name` or `task/descriptive-name`
- Use kebab-case for names
- Keep names concise but descriptive
- Examples: `feature/add-logging`, `task/refactor-auth`

**Implementation Guidelines:**
- Start with repository layer (data access)
- Then service layer (business logic)
- Then API layer (endpoints)
- Test incrementally
- Follow project patterns in guides

## Key Principles

### Do's
✅ Always check guides before searching codebase
✅ Accept both Jira tickets and task descriptions
✅ Fetch only required Jira fields (description, summary) when applicable
✅ Provide evidence-based complexity assessment
✅ Create feature branch BEFORE any changes
✅ Follow established patterns from guides
✅ Ask specific, blocking questions only
✅ Provide clear, actionable recommendations
✅ Adapt branch naming to context (Jira vs non-Jira)

### Don'ts
❌ Don't skip guide consultation
❌ Don't ask generic clarifying questions
❌ Don't start coding without branch creation
❌ Don't make architectural decisions for complex features without user input
❌ Don't fetch unnecessary Jira fields (when using Jira)
❌ Don't guess at complexity—analyze systematically
❌ Don't assume every task has a Jira ticket

## Example Workflow

### Example 1: Simple Feature (Jira Ticket)

```
User: "Implement EPMCDME-10500"

Tech Lead:
1. Identifies Jira ticket format
2. Fetches ticket via brianna (description + summary)
3. Reads .codemie/guides/api/rest-api-patterns.md
4. Searches for similar endpoints with Grep
5. Assesses: Simple (1 endpoint, standard CRUD, existing pattern)
6. Recommends: Direct implementation
7. Creates branch: EPMCDME-10500
8. Implements following REST API patterns
```

### Example 1b: Simple Feature (No Jira Ticket)

```
User: "Add logging to the authentication endpoint"

Tech Lead:
1. Identifies task description (no Jira ticket)
2. Documents requirements in structured format
3. Asks user for branch name preference
4. Reads .codemie/guides/development/logging-patterns.md
5. Searches for auth endpoint with Grep
6. Assesses: Simple (1 file, standard pattern, clear requirements)
7. Recommends: Direct implementation
8. Creates branch: feature/add-auth-logging
9. Implements following logging patterns
```

### Example 2: Medium Feature (Jira Ticket)

```
User: "Start work on EPMCDME-10600"

Tech Lead:
1. Fetches ticket via brianna
2. Reads guides: agents/langchain-agent-patterns.md, integration/llm-providers.md
3. Searches codebase for similar agents
4. Asks: "Should the new agent use streaming or batch mode?"
5. Assesses: Medium (new agent + tool, 5 files, clear patterns)
6. Recommends: Direct implementation with guidance
7. Creates branch: EPMCDME-10600
8. Implements agent following LangChain patterns
```

### Example 3: Complex Feature

```
User: "Implement EPMCDME-10700"

Tech Lead:
1. Fetches ticket via brianna
2. Reads multiple guides (architecture, workflows, integrations)
3. Identifies: 12+ files affected, new external service integration
4. Asks: "Which cloud provider should be used?" "What's the data retention policy?"
5. Assesses: Complex (multi-layer, new integration, security concerns)
6. Recommends: Use solution-architect skill first
7. If user insists: Creates branch and starts with high-level plan
```

## Integration with Other Skills

### Brianna Skill
- Use for Jira ticket retrieval (when Jira ticket is provided)
- Request ONLY description and summary fields
- Handle ticket not found gracefully
- Skip if user provides task description without Jira ticket

### Solution Architect Skill
- Invoke for Complex features needing specs
- Pass task details (Jira or user-provided) and analysis findings
- Wait for specification before implementation

### Codemie-Commit Skill
- Use after implementation completion
- Ensure commit message references Jira ticket (if applicable)
- Follow git workflow from guides

## Error Handling

### Ticket Not Found
```markdown
Unable to fetch Jira ticket [ID]. Please verify:
- Ticket ID format is correct (EPMCDME-XXXXX)
- Ticket exists in Jira
- You have access to view this ticket
```

### Branch Already Exists
```markdown
Branch [EPMCDME-XXXXX] already exists.

Options:
1. Switch to existing branch: `git checkout EPMCDME-XXXXX`
2. Delete and recreate: `git branch -D EPMCDME-XXXXX && git checkout -b EPMCDME-XXXXX`
3. Use different branch name (not recommended)

Which option do you prefer?
```

### Guides Not Found
```markdown
Warning: Unable to locate relevant guides for this task.

Proceeding with codebase exploration only. This may result in patterns inconsistent with project standards.

Continue? Consider updating guide paths if this persists.
```

## Success Criteria

A successful tech-lead session results in:
- ✅ Jira ticket details retrieved and understood
- ✅ Relevant guides consulted
- ✅ Codebase patterns identified
- ✅ Complexity accurately assessed
- ✅ Clear recommendation provided
- ✅ Feature branch created with correct name
- ✅ Implementation started following project patterns
- ✅ User has clarity on next steps

## Additional Resources

### Reference Files

For detailed patterns referenced during analysis:
- **`references/complexity-assessment-guide.md`** - Detailed complexity criteria and examples
- **`references/branch-workflow.md`** - Git branching best practices for Jira tickets

### Integration Points

This skill coordinates with:
- **CLAUDE.md**: Uses Task Classifier and guide references
- **`.codemie/guides/`**: Consults all relevant guides based on task type
- **brianna skill**: Fetches Jira ticket information
- **solution-architect skill**: Escalates complex features for specification
- **codemie-commit skill**: Completes implementation with proper commits
