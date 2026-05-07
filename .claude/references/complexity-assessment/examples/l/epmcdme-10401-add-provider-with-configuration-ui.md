# Complexity Assessment Examples — L

L examples (total score 21–26). Mix of 3s and 4s; red flags may bump a dimension.
Add new L examples below following the same format.

---

## Example: Add New Provider with Configuration UI

**Ticket:** EPMCDME-10401
**Actual Outcome:** L — completed in 5 days

```markdown
## Complexity Analysis: EPMCDME-10401

### Component Scope: M (3)
- Affected: Provider layer, CLI commands, Config system, Registry
- Layers: CLI + Registry + Provider + Config

### Requirements Clarity: S (2)
- Status: Partially Clear
- Gaps: Config schema not fully specified; credential storage approach TBD

### Technical Risk: M (3) ← red flag applied
- Risk factors: Config migration for existing users, provider registration order
- Mitigation: Backwards-compatible config schema, feature-flagged activation
- Note: "config migration" red flag bumped this from S (2) to M (3)

### File Change Estimate: M (3)
- Modified: 5 files (registry, config loader, CLI command, provider base)
- New: 3 files (provider implementation, config schema, tests)
- Affected directories: src/providers/, src/cli/commands/, src/env/

### Dependencies: XS (1)
- New packages: None
- Version changes: None

### Affected Layers: L (4)
- Layers changed: UI (CLI) + API + Service + Config/Infra
- Schema/migration: yes (config schema update affects existing users)
- Cross-system: no

### Total Score: 16/36 → bumped to 22/36 after red flag

### Size: L

### Reasoning:
- **Multi-Layer**: CLI + Registry + Provider + Config all touched
- **Config Migration Red Flag**: Existing users affected — bumped Technical Risk and Affected Layers
- **Moderate Files**: 8 files total across 3 directories
- **Established Pattern**: Provider registration pattern exists; reduces risk
```
