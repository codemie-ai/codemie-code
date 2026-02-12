# Complexity Assessment Guide

## Purpose

This guide provides detailed criteria and examples for assessing feature complexity when working with Jira tickets. Accurate complexity assessment ensures appropriate planning and implementation approaches.

## Complexity Dimensions

### 1. Component Scope

**Simple:**
- Single component (API, Service, or Repository)
- Self-contained changes
- No cross-cutting concerns
- Example: Add new field to existing endpoint

**Medium:**
- 2-3 components across layers
- Coordination between API and Service layers
- Minor database schema changes
- Example: Add new endpoint with business logic and data access

**Complex:**
- 4+ components across multiple subsystems
- New integrations or external services
- Database migrations affecting multiple tables
- Example: Add new workflow with agent, tools, and external API integration

### 2. Requirements Clarity

**Clear:**
- All acceptance criteria defined
- No ambiguous terms
- Implementation path obvious
- Existing patterns directly applicable

**Partially Clear:**
- Core requirements defined
- Some details need clarification
- Minor assumptions required
- May need 1-2 clarifying questions

**Unclear:**
- Vague acceptance criteria
- Multiple interpretations possible
- Significant architectural decisions needed
- Requires specification or multiple clarifications

### 3. Technical Risk

**Low Risk (Simple):**
- Using well-established patterns
- No performance concerns
- No security implications
- Rollback is straightforward

**Medium Risk (Medium):**
- Some new patterns or approaches
- Minor performance considerations
- Standard security measures apply
- May need feature flag

**High Risk (Complex):**
- Novel implementation required
- Performance/scalability critical
- Security-sensitive operations
- Difficult to rollback
- External dependencies

### 4. File Change Estimate

**Simple:**
- 1-3 files modified
- No new files needed (or 1 new file)
- Changes are localized

**Medium:**
- 4-8 files modified
- 1-3 new files created
- Changes span multiple directories

**Complex:**
- 9+ files modified
- 4+ new files created
- Changes affect project structure

### 5. Dependencies

**Simple:**
- No new dependencies
- Works with existing libraries
- No version conflicts

**Medium:**
- 1-2 new dependencies
- Minor version updates
- Standard libraries

**Complex:**
- 3+ new dependencies
- Major version updates required
- Custom integrations needed
- Potential dependency conflicts

## Complexity Matrix

Score each dimension (1=Simple, 2=Medium, 3=Complex):

| Total Score | Complexity |
|-------------|------------|
| 5-7         | Simple     |
| 8-11        | Medium     |
| 12-15       | Complex    |

Example scoring:
- Component Scope: 2 (2 components)
- Requirements: 1 (Clear)
- Technical Risk: 1 (Low)
- File Changes: 2 (5 files)
- Dependencies: 1 (None)
- **Total: 7 = Simple**

## Complexity Assessment Template

```markdown
## Complexity Analysis: [TICKET-ID]

### Component Scope: [1-3]
- Affected: [list components]
- Layers: [API/Service/Repository/etc.]

### Requirements Clarity: [1-3]
- Status: [Clear/Partially Clear/Unclear]
- Gaps: [any unclear items]

### Technical Risk: [1-3]
- Risk factors: [list]
- Mitigation: [if applicable]

### File Change Estimate: [1-3]
- Modified: [count] files
- New: [count] files
- Affected directories: [list]

### Dependencies: [1-3]
- New packages: [list or "none"]
- Version changes: [list or "none"]

### Total Score: [sum]/15

### Final Complexity: [Simple | Medium | Complex]
```

## Example Assessments

### Example 1: Add Logging to Existing Endpoint (Simple)

```markdown
## Complexity Analysis: EPMCDME-10101

### Component Scope: 1
- Affected: Single API endpoint
- Layers: API only

### Requirements Clarity: 1
- Status: Clear
- Gaps: None - logging pattern documented

### Technical Risk: 1
- Risk factors: None
- Mitigation: N/A

### File Change Estimate: 1
- Modified: 1 file (router file)
- New: 0 files
- Affected directories: rest_api/routers/

### Dependencies: 1
- New packages: None
- Version changes: None

### Total Score: 5/15

### Final Complexity: Simple

### Reasoning:
- **Isolated Change**: Only API layer affected
- **Clear Pattern**: Logging patterns documented in guides
- **Low Risk**: Non-functional addition, no business logic change
- **Minimal Scope**: Single file modification
```

### Example 2: Create New Agent with Custom Tool (Medium)

```markdown
## Complexity Analysis: EPMCDME-10202

### Component Scope: 2
- Affected: Agents subsystem, Tools subsystem
- Layers: Agent orchestration + tool implementation

### Requirements Clarity: 2
- Status: Partially Clear
- Gaps: Tool behavior details need clarification

### Technical Risk: 2
- Risk factors: LLM token usage, tool reliability
- Mitigation: Add usage tracking, error handling

### File Change Estimate: 2
- Modified: 2 files (agent config, tool registry)
- New: 3 files (agent class, tool class, tests)
- Affected directories: agents/, agents/tools/

### Dependencies: 1
- New packages: None (using existing LangChain)
- Version changes: None

### Total Score: 9/15

### Final Complexity: Medium

### Reasoning:
- **Multi-Component**: Agent + tool coordination required
- **Pattern Available**: LangChain patterns documented
- **Moderate Risk**: LLM usage needs monitoring
- **Multiple Files**: 5 files total, but following established patterns
```

### Example 3: Integrate New Cloud Service (Complex)

```markdown
## Complexity Analysis: EPMCDME-10303

### Component Scope: 3
- Affected: API, Service, Repository, Configuration, Integration layer
- Layers: Full stack + external service

### Requirements Clarity: 2
- Status: Partially Clear
- Gaps: Authentication method, data mapping, error handling strategy

### Technical Risk: 3
- Risk factors: External API reliability, security (credentials), rate limits
- Mitigation: Circuit breaker, credential management, retry logic

### File Change Estimate: 3
- Modified: 8 files (configs, existing services)
- New: 6 files (integration service, models, tests, configs)
- Affected directories: service/, integration/, configs/, repository/

### Dependencies: 3
- New packages: Cloud SDK (major dependency), auth library
- Version changes: May require Python version update

### Total Score: 14/15

### Final Complexity: Complex

### Reasoning:
- **Cross-Cutting**: Affects multiple subsystems and all layers
- **High Risk**: External dependency with security implications
- **Architectural Impact**: New integration pattern, credential management
- **Extensive Changes**: 14 files across entire codebase
```

## Red Flags for Complexity

Automatically consider as Complex if ticket contains:

### Technical Red Flags
- "Migrate" or "Refactor" large subsystems
- "Real-time" or "Streaming" requirements
- "Performance" or "Scalability" as primary concern
- "Security" or "Compliance" requirements
- "Integration" with new external service

### Scope Red Flags
- Affects authentication or authorization
- Changes database schema significantly
- Requires data migration
- Touches core shared utilities
- Affects multiple workflows or agents

### Clarity Red Flags
- Vague acceptance criteria
- Multiple stakeholders with different expectations
- "Similar to X but different" requirements
- Phrases like "we'll figure it out" or "TBD"

## Questions to Ask for Clarity

### For Partially Clear Requirements

**Data Questions:**
- What is the expected data format?
- What are the validation rules?
- What is the data volume?

**Behavior Questions:**
- What happens in edge cases?
- What are the error handling expectations?
- What is the expected performance?

**Integration Questions:**
- Which systems need to be notified?
- What is the authentication method?
- What are rate limits or quotas?

### For Unclear Requirements

**Strategic Questions:**
- What problem are we solving?
- Who are the end users?
- What is the success metric?
- Are there existing alternatives?

**Technical Questions:**
- What are the non-functional requirements?
- What is the expected load?
- What are the SLAs?
- What are the security requirements?

**Scoping Questions:**
- Is this a proof of concept or production feature?
- What is the timeline?
- Can this be broken into smaller tickets?

## Assessment Output Format

Always provide assessment in this structure:

```markdown
## Implementation Analysis: EPMCDME-XXXXX

### Complexity Rating: [Simple | Medium | Complex]

### Reasoning:
- **[Dimension 1]**: [Score justification]
- **[Dimension 2]**: [Score justification]
- **[Dimension 3]**: [Score justification]
- **[Dimension 4]**: [Score justification - optional]

### Clarity Assessment:
[Clear | Partially Clear | Unclear] - [Explanation]

### Affected Components:
- **[Component]**: `path/to/file` - [Nature of change]
- **[Component]**: `path/to/file` - [Nature of change]
- **[Component]**: `path/to/file` - [Nature of change]

### Risk Factors:
- [Risk 1]
- [Risk 2]

### Implementation Estimate:
- Files to modify: [count]
- New files: [count]
- New dependencies: [list or "none"]
```

## Best Practices

### Do's
✅ Consider all five dimensions
✅ Provide evidence for each score
✅ Reference specific files and patterns
✅ Identify concrete risks
✅ Use objective criteria

### Don'ts
❌ Rely on gut feeling alone
❌ Ignore available patterns
❌ Underestimate integration complexity
❌ Skip risk assessment
❌ Guess at file counts

## Handling Edge Cases

### Ticket Seems Simple But...

If initial assessment seems Simple but has red flags:
1. Re-evaluate Technical Risk dimension
2. Check for hidden dependencies
3. Verify requirements are truly clear
4. Consider upgrading to Medium

### User Disagrees with Assessment

If user believes complexity is different:
1. Ask for their reasoning
2. Identify which dimensions differ
3. Reassess with additional context
4. Document the agreed complexity

### Borderline Cases (Score 7-8 or 11-12)

For borderline scores:
- Lean toward higher complexity if risks are present
- Lean toward lower if strong patterns exist
- Let user make final call
- Document uncertainty

## Continuous Improvement

After implementation:
1. Compare actual vs estimated complexity
2. Note which dimensions were misjudged
3. Update assessment criteria
4. Share learnings with team

Track accuracy over time:
- Simple tickets: Should complete in 1-2 days
- Medium tickets: Should complete in 3-5 days
- Complex tickets: May need specification phase first
