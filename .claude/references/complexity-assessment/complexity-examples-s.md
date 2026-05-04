# Complexity Assessment Examples — S

S examples (total score 10–14). Mostly dimension-1 scores with one or two 2s.
Add new S examples below following the same format.

---

## Example: Add Validation to Existing Form Field

**Ticket:** EPMCDME-10102
**Actual Outcome:** S — completed in 1 day

```markdown
## Complexity Analysis: EPMCDME-10102

### Component Scope: S (2)
- Affected: Single service method + API layer
- Layers: API + Service (validation logic)

### Requirements Clarity: XS (1)
- Status: Clear
- Gaps: None — validation rules fully specified in ticket

### Technical Risk: XS (1)
- Risk factors: None
- Mitigation: N/A

### File Change Estimate: S (2)
- Modified: 3 files (router, service, validation schema)
- New: 0 files
- Affected directories: rest_api/routers/, services/

### Dependencies: XS (1)
- New packages: None (using existing validation library)
- Version changes: None

### Affected Layers: S (2)
- Layers changed: API + Service
- Schema/migration: no
- Cross-system: no

### Total Score: 9/36

### Size: S

### Reasoning:
- **Narrow Scope**: Two layers touched but change is additive only
- **Clear Requirements**: Validation rules fully defined in ticket
- **Low Risk**: Follows existing validation pattern
- **Few Files**: 3 files, all in adjacent directories
```
