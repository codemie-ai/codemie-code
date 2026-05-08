# Complexity Assessment Examples — XXL

XXL examples (total score 32–36). Multiple dimensions score 5–6.
Splitting is mandatory — do not proceed until the user provides decomposed stories.
Add new XXL examples below following the same format.

---

## Example: Full Authentication System Rewrite

**Ticket:** EPMCDME-10999
**Actual Outcome:** XXL — split into 6 stories across 2 sprints

```markdown
## Complexity Analysis: EPMCDME-10999

### Component Scope: XXL (6)
- Affected: Auth middleware, session management, all API endpoints, CLI auth flow,
  credential store, provider adapters, database schema
- Layers: All layers — CLI + Registry + Plugin + Core + Utils

### Requirements Clarity: XL (5)
- Status: Unclear
- Gaps: Session token format, SSO integration scope, migration strategy for
  existing sessions, backward compatibility window undefined

### Technical Risk: XXL (6)
- Risk factors: Security-sensitive, affects all users immediately, hard to
  roll back once sessions are invalidated, external IdP dependencies
- Mitigation: Would need extensive testing, gradual rollout, migration scripts

### File Change Estimate: XXL (6)
- Modified: 16+ files
- New: 8+ files (new auth middleware, session models, migration scripts, tests)
- Affected directories: src/cli/, src/providers/, src/utils/, src/env/,
  database/migrations/

### Dependencies: XL (5)
- New packages: JWT library, OIDC client, session store adapter
- Version changes: Major version updates to security-related packages

### Affected Layers: XXL (6)
- Layers changed: UI (CLI) + API + Service + DB + Infra + External (IdP)
- Schema/migration: yes — existing session data must be migrated
- Cross-system: yes — external Identity Provider integration

### Total Score: 34/36

### Size: XXL
```

**Splitting recommendation presented:**
This ticket cannot be implemented as a single story. Suggested decomposition:

1. Story 1 (M): Research and define new auth token schema + write ADR
2. Story 2 (L): Implement new CredentialStore with JWT support (no migration)
3. Story 3 (M): Add SSO provider adapter behind feature flag
4. Story 4 (L): Migrate CLI auth flow to new CredentialStore
5. Story 5 (M): Migrate API middleware + backwards-compat bridge
6. Story 6 (S): Remove backwards-compat bridge after rollout

User agreed to this decomposition before proceeding.
