# Complexity Assessment Examples — XL

XL examples (total score 27–31). Mostly 4s and 5s; splitting is strongly recommended.
Add new XL examples below following the same format.

---

## Example: Integrate New Cloud Service

**Ticket:** EPMCDME-10303
**Actual Outcome:** XL — required specification phase and was split into 3 stories

```markdown
## Complexity Analysis: EPMCDME-10303

### Component Scope: XL (5)
- Affected: API, Service, Repository, Configuration, Integration layer
- Layers: Full stack + external service

### Requirements Clarity: M (3)
- Status: Partially Clear
- Gaps: Authentication method, data mapping, error handling strategy

### Technical Risk: XL (5)
- Risk factors: External API reliability, security (credentials), rate limits
- Mitigation: Circuit breaker, credential management, retry logic

### File Change Estimate: L (4)
- Modified: 8 files (configs, existing services)
- New: 6 files (integration service, models, tests, configs)
- Affected directories: service/, integration/, configs/, repository/

### Dependencies: XL (5)
- New packages: Cloud SDK (major dependency), auth library
- Version changes: May require runtime version update

### Affected Layers: L (4)
- Layers changed: API + Service + DB + External integration
- Schema/migration: no (uses external storage)
- Cross-system: yes (calls external cloud service)

### Total Score: 26/36

### Size: L → XL after cross-system red flag bumps Affected Layers to XL (5)

### Reasoning:
- **Cross-Cutting**: Affects multiple subsystems and all layers
- **High Risk**: External dependency with security implications
- **Architectural Impact**: New integration pattern, credential management
- **Extensive Changes**: 14 files across entire codebase
```

**Splitting suggestion used:**
1. Story 1 (M): Set up credential storage + provider abstraction
2. Story 2 (M): Implement core API integration with happy-path only
3. Story 3 (M): Error handling, retries, rate limiting, monitoring
