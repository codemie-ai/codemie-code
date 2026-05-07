# Complexity Assessment Examples — M

M examples (total score 15–20). Mix of 2s and 3s across dimensions.
Add new M examples below following the same format.

---

## Example: Create New Agent with Custom Tool

**Ticket:** EPMCDME-10202
**Actual Outcome:** M — completed in 4 days

```markdown
## Complexity Analysis: EPMCDME-10202

### Component Scope: S (2)
- Affected: Agents subsystem, Tools subsystem
- Layers: Agent orchestration + tool implementation

### Requirements Clarity: S (2)
- Status: Partially Clear
- Gaps: Tool behavior details need clarification

### Technical Risk: S (2)
- Risk factors: LLM token usage, tool reliability
- Mitigation: Add usage tracking, error handling

### File Change Estimate: M (3)
- Modified: 2 files (agent config, tool registry)
- New: 3 files (agent class, tool class, tests)
- Affected directories: agents/, agents/tools/

### Dependencies: XS (1)
- New packages: None (using existing LangChain)
- Version changes: None

### Affected Layers: M (3)
- Layers changed: API + Service + Agent orchestration
- Schema/migration: no
- Cross-system: no

### Total Score: 13/36

### Size: S

### Reasoning:
- **Multi-Component**: Agent + tool coordination required
- **Pattern Available**: LangChain patterns documented
- **Moderate Risk**: LLM usage needs monitoring
- **Multiple Files**: 5 files total, but following established patterns
```

---

## Example: Add New REST Endpoint with Business Logic

**Ticket:** EPMCDME-10203
**Actual Outcome:** M — completed in 3 days

```markdown
## Complexity Analysis: EPMCDME-10203

### Component Scope: M (3)
- Affected: Router, service layer, repository
- Layers: API + Service + Repository

### Requirements Clarity: M (3)
- Status: Partially Clear
- Gaps: Error response format not specified; pagination requirements TBD

### Technical Risk: S (2)
- Risk factors: None significant — standard REST pattern
- Mitigation: Follow existing endpoint patterns

### File Change Estimate: M (3)
- Modified: 4 files (router, service, repository, types)
- New: 2 files (endpoint handler, tests)
- Affected directories: src/api/, src/services/, src/repositories/

### Dependencies: XS (1)
- New packages: None
- Version changes: None

### Affected Layers: M (3)
- Layers changed: API + Service + DB (read-only queries)
- Schema/migration: no (read queries only)
- Cross-system: no

### Total Score: 15/36

### Size: M

### Reasoning:
- **Three-Layer Change**: API + Service + Repository all touched
- **Gaps in Spec**: Error format and pagination need clarification before starting
- **Known Pattern**: REST endpoint pattern well-established in codebase
- **Moderate File Count**: 6 files across 3 directories
```
