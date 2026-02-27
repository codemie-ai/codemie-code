# Complexity Assessment Guide

## Purpose

This guide provides detailed criteria and examples for assessing feature complexity when working with Jira tickets. Accurate complexity assessment ensures appropriate planning and implementation approaches.

## Complexity Dimensions

### 1. Component Scope

**Simple:**
- Single file or area (one component, one store method, or one page tweak)
- Self-contained changes
- No cross-cutting concerns
- Example: Add a new prop to an existing component, fix a UI bug

**Medium:**
- 2-3 areas across layers (e.g., store + component, or page + form + store)
- Coordination between component and store layers
- New route or page with standard CRUD
- Example: Add new list page with API call and Valtio store

**Complex:**
- 4+ areas across multiple subsystems (pages, stores, components, hooks, routes)
- New integrations or third-party libraries
- Significant refactoring of shared components
- Example: Add new workflow editor section with custom React Flow nodes and global state

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
- Affected: [list components/pages/stores/hooks]
- Layers: [Component/Store/Page/Hook/Route/etc.]

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

### Example 1: Add Tooltip to Existing Button (Simple)

```markdown
## Complexity Analysis: EPMCDME-10101

### Component Scope: 1
- Affected: Single Button component
- Layers: Component only

### Requirements Clarity: 1
- Status: Clear
- Gaps: None - tooltip pattern documented in reusable-components guide

### Technical Risk: 1
- Risk factors: None
- Mitigation: N/A

### File Change Estimate: 1
- Modified: 1 file (component file)
- New: 0 files
- Affected directories: src/components/Button/

### Dependencies: 1
- New packages: None
- Version changes: None

### Total Score: 5/15

### Final Complexity: Simple

### Reasoning:
- **Isolated Change**: Only one component affected
- **Clear Pattern**: Tooltip pattern documented in reusable-components guide
- **Low Risk**: UI-only addition, no state or API impact
- **Minimal Scope**: Single file modification
```

### Example 2: Add New Skills List Page with Filtering (Medium)

```markdown
## Complexity Analysis: EPMCDME-10202

### Component Scope: 2
- Affected: Skills store, SkillsListPage, SkillCard component
- Layers: Store + Page + Component

### Requirements Clarity: 2
- Status: Partially Clear
- Gaps: Filter behavior and URL query param handling need clarification

### Technical Risk: 2
- Risk factors: Store state shape, API response format
- Mitigation: Follow existing store patterns, use extractArrayFromResponse

### File Change Estimate: 2
- Modified: 2 files (existing store, router)
- New: 3 files (page component, card component, constants)
- Affected directories: src/pages/skills/, src/store/, src/components/

### Dependencies: 1
- New packages: None (using existing Valtio, React Hook Form)
- Version changes: None

### Total Score: 9/15

### Final Complexity: Medium

### Reasoning:
- **Multi-Layer**: Store + component + page coordination required
- **Pattern Available**: Similar list pages exist (assistants, data sources)
- **Moderate Risk**: Store design needs to match API response shape
- **Multiple Files**: 5 files total, but following established patterns
```

### Example 3: Add Interactive Workflow Editor Section (Complex)

```markdown
## Complexity Analysis: EPMCDME-10303

### Component Scope: 3
- Affected: WorkflowEditor page, multiple React Flow custom nodes, workflow store, shared toolbar components, router
- Layers: Page + Store + Multiple Components + Routing

### Requirements Clarity: 2
- Status: Partially Clear
- Gaps: Node type definitions, edge validation rules, state persistence strategy

### Technical Risk: 3
- Risk factors: React Flow performance with many nodes, complex state shape, drag-and-drop interactions
- Mitigation: Memoize node/edge callbacks, isolate workflow store

### File Change Estimate: 3
- Modified: 5 files (router, existing toolbar, shared types)
- New: 9 files (editor page, 3 node types, edge type, store, custom hook, constants, tests)
- Affected directories: src/pages/workflows/, src/store/, src/components/, src/hooks/

### Dependencies: 2
- New packages: None (React Flow already in use)
- Version changes: None

### Total Score: 13/15

### Final Complexity: Complex

### Reasoning:
- **Cross-Cutting**: Affects routing, store, multiple new components
- **High Risk**: React Flow performance, complex interaction patterns
- **Architectural Impact**: New store shape, new custom hook strategy
- **Extensive Changes**: 14 files across multiple directories
```

## Red Flags for Complexity

Automatically consider as Complex if ticket contains:

### Technical Red Flags
- "Migrate" or "Refactor" large shared components
- "Real-time" updates or WebSocket requirements
- "Performance" or "Lazy loading" as primary concern
- "New library" or "Replace existing" requirements
- Significant changes to the React Flow workflow editor

### Scope Red Flags
- Affects shared Layout or navigation components
- Changes global theme or Tailwind config
- Modifies multiple Valtio stores
- Touches core shared utilities (`src/utils/`, `src/hooks/`)
- Affects routing structure significantly

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
- Which store(s) need to be updated?
- Should this share state with existing features?
- Are there existing API endpoints or new ones needed?

### For Unclear Requirements

**Strategic Questions:**
- What problem are we solving?
- Who are the end users?
- What is the success metric?
- Are there existing alternatives?

**Technical Questions:**
- What are the non-functional requirements (accessibility, performance)?
- Should there be skeleton loaders or inline spinners?
- What are the responsive/mobile requirements?
- Are there design specs or mockups to follow?

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
