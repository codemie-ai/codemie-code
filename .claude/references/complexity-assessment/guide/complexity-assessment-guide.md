# Complexity Assessment Guide

## Purpose

This guide provides detailed criteria for assessing feature complexity. Each dimension is scored XS–XXL (1–6). Six dimensions sum to a total of 6–36, which maps directly to the T-shirt size output. The scoring system is self-consistent: if all dimensions score M, the story is M; if all score XL, the story is XL.

## Scoring Scale

Each dimension uses the same 6-point scale:

| Score | Label | Meaning |
|-------|-------|---------|
| 1 | XS | Trivial — no uncertainty, exact pattern exists |
| 2 | S | Small — well-understood, minor effort |
| 3 | M | Medium — standard work, some decisions needed |
| 4 | L | Large — significant effort, notable unknowns |
| 5 | XL | Very large — new territory, high risk or wide impact |
| 6 | XXL | Extreme — research required, architectural impact |

## Complexity Dimensions

### 1. Component Scope

**XS (1):**
- Single function or method touched
- No architectural impact, no layer boundaries crossed
- Example: Fix a typo in an error message

**S (2):**
- Single component (API endpoint, service method, or repository query)
- Self-contained change, no cross-cutting concerns
- Example: Add a new field to an existing endpoint response

**M (3):**
- 2–3 components across 2 layers (e.g., API + Service)
- Coordination needed but pattern is clear
- Example: Add new endpoint with basic business logic and data access

**L (4):**
- 3–4 components across 2–3 layers
- Some cross-cutting concerns, shared utilities involved
- Example: Add feature requiring API, service logic, and config changes

**XL (5):**
- Full-stack change, 4+ components, multiple subsystems
- New abstractions or significant restructuring within a subsystem
- Example: New workflow touching agent, tools, API, and persistence layers

**XXL (6):**
- Cross-service or cross-system change
- Requires changes to shared contracts, external integrations, or architectural boundaries
- Example: New integration with an external service requiring new adapter, auth, and schema

---

### 2. Requirements Clarity

**XS (1):**
- All acceptance criteria defined, no ambiguity
- Implementation path completely obvious
- Existing patterns apply directly, no decisions needed

**S (2):**
- Requirements are clear with minor details to confirm
- 0–1 lightweight clarifying questions
- Existing patterns apply with small adaptations

**M (3):**
- Core requirements defined, some gaps exist
- 1–2 clarifying questions needed before starting
- Minor assumptions required

**L (4):**
- Partially clear — several gaps or vague criteria
- Multiple clarifications needed, some design decisions open
- Risk of rework if assumptions prove wrong

**XL (5):**
- Vague requirements, significant assumptions required
- Architectural decisions not yet made
- Specification doc or stakeholder alignment needed before planning

**XXL (6):**
- Unclear or conflicting requirements
- Multiple valid interpretations, stakeholders disagree
- Research or discovery phase required before any implementation

---

### 3. Technical Risk

**XS (1):**
- Exact same pattern exists in the codebase — copy, adapt, done
- Zero performance or security implications
- Trivial to roll back

**S (2):**
- Well-established pattern, low risk
- No performance concerns, no security implications
- Straightforward rollback

**M (3):**
- Some new patterns or approaches required
- Minor performance considerations (non-critical path)
- Standard security measures apply, may need feature flag

**L (4):**
- New approach needed with no exact precedent
- Moderate performance considerations or security measures
- Feature flag recommended, rollback plan needed

**XL (5):**
- Novel implementation, significant unknowns
- Performance-critical path or security-sensitive operations
- Difficult to roll back, requires careful staged rollout

**XXL (6):**
- High uncertainty, proof-of-concept may be needed first
- Compliance implications or extreme performance requirements
- Irreversible once deployed (data migration, breaking API change)
- External dependencies with unknown reliability

---

### 4. File Change Estimate

**XS (1):**
- 1–2 files modified
- No new files
- Changes fully localized

**S (2):**
- 3–4 files modified
- 0–1 new files
- Changes within one directory

**M (3):**
- 5–7 files modified
- 1–2 new files
- Changes span 2 directories

**L (4):**
- 8–10 files modified
- 2–4 new files
- Changes span 3+ directories

**XL (5):**
- 11–15 files modified
- 4–6 new files
- Changes affect multiple subsystems

**XXL (6):**
- 16+ files modified
- 6+ new files
- Affects project structure or shared foundations

---

### 5. Dependencies

**XS (1):**
- No new dependencies, no version changes
- No configuration changes needed

**S (2):**
- No new packages, minor config or env var additions
- Existing library used in a new place

**M (3):**
- 1 new well-known library (low risk)
- No version conflicts expected

**L (4):**
- 1–2 new dependencies or minor version updates to existing ones
- Version compatibility needs verification

**XL (5):**
- 2–3 new dependencies, or 1 major/heavyweight dependency
- Version conflicts possible, integration testing needed

**XXL (6):**
- 3+ new dependencies, major version upgrades required
- Custom integrations or forked libraries needed
- High risk of dependency conflicts

---

### 6. Affected Layers

Scores which architectural/infrastructure layers require changes: UI, API/backend, service/business logic, database/persistence, infrastructure, external integrations.

**XS (1):**
- Single layer only (e.g., service-only fix, UI copy change)
- No layer coordination needed
- Example: Fix a bug in a single service method

**S (2):**
- 2 layers, same tier (e.g., API + existing service, UI + existing state manager)
- Simple handoff over an established interface
- Example: Pipe a new field from API response to UI display

**M (3):**
- 2–3 distinct layers (e.g., UI + API + Service)
- Standard full-stack path, established patterns exist
- Example: New feature from UI form submission to business logic

**L (4):**
- 3–4 layers including persistence (e.g., UI + API + Service + DB schema)
- Database schema change or migration required
- Example: New entity with full CRUD operations

**XL (5):**
- Full stack: UI + API + Service + DB + integration layer
- Cross-cutting concerns added to multiple layers (auth, observability, feature flags)
- Example: New authenticated workflow touching all layers plus an external service

**XXL (6):**
- Cross-system: changes span multiple services or codebases
- Infrastructure changes needed (deployment config, environment variables across systems)
- Multiple external service integrations involved simultaneously
- Example: New feature requiring changes in 2+ microservices plus 2 external APIs

---

## Complexity Matrix

Score each dimension XS–XXL (1–6). Total range: 6–36.

| Total Score | Size | Typical Cycle | Routing |
|-------------|------|---------------|---------|
| 6–9         | XS   | < half day    | → `superpowers:writing-plans` directly |
| 10–14       | S    | 1 day         | → `superpowers:writing-plans` directly |
| 15–20       | M    | 2–3 days      | → `superpowers:brainstorming` first |
| 21–26       | L    | 4–5 days      | → `superpowers:brainstorming` first |
| 27–31       | XL   | > 1 sprint    | → **Recommend splitting** before planning |
| 32–36       | XXL  | > 1 sprint    | → **Must split** — do not proceed until decomposed |

Self-check: all-M dimensions (6×3=18) → M. All-L (6×4=24) → L. All-XL (6×5=30) → XL. ✓

Example scoring:
- Component Scope: M (3 — new endpoint with service layer)
- Requirements: S (2 — clear, one minor question)
- Technical Risk: S (2 — known pattern, low risk)
- File Changes: M (3 — 6 files across 2 directories)
- Dependencies: XS (1 — no new deps)
- Affected Layers: M (3 — UI + API + Service)
- **Total: 14 = S**

## Complexity Assessment Template

```markdown
## Complexity Analysis: [TICKET-ID]

### Component Scope: [XS|S|M|L|XL|XXL] ([score])
- Affected: [list components]
- Layers: [API/Service/Repository/etc.]

### Requirements Clarity: [XS|S|M|L|XL|XXL] ([score])
- Status: [one-line summary]
- Gaps: [any unclear items, or "none"]

### Technical Risk: [XS|S|M|L|XL|XXL] ([score])
- Risk factors: [list, or "none"]
- Mitigation: [if applicable]

### File Change Estimate: [XS|S|M|L|XL|XXL] ([score])
- Modified: [count] files
- New: [count] files
- Affected directories: [list]

### Dependencies: [XS|S|M|L|XL|XXL] ([score])
- New packages: [list or "none"]
- Version changes: [list or "none"]

### Affected Layers: [XS|S|M|L|XL|XXL] ([score])
- Layers changed: [UI | API | Service | DB | Infra | External]
- Schema/migration: [yes/no]
- Cross-system: [yes/no]

### Total Score: [sum]/36

### Size: [XS | S | M | L | XL | XXL]
```

## Example Assessments

Examples live in separate files in this skill's `references/` folder, one per size tier:

- `complexity-examples-xs.md` — XS examples (score 6–9)
- `complexity-examples-s.md` — S examples (score 10–14)
- `complexity-examples-m.md` — M examples (score 15–20)
- `complexity-examples-l.md` — L examples (score 21–26)
- `complexity-examples-xl.md` — XL examples (score 27–31)
- `complexity-examples-xxl.md` — XXL examples (score 32–36)

To add a new example: append it to the matching tier file following the existing format.
To add a new category: create a new `complexity-examples-<label>.md` file — the skill auto-discovers all files matching this pattern via Glob.

## Red Flags for Complexity

Any of the following bumps the relevant dimension up by 1 tier:

### Technical Red Flags
- "Migrate" or "Refactor" large subsystems → bump Component Scope
- "Real-time" or "Streaming" requirements → bump Technical Risk
- "Performance" or "Scalability" as primary concern → bump Technical Risk
- "Security" or "Compliance" requirements → bump Technical Risk
- "Integration" with new external service → bump Component Scope + Affected Layers

### Scope Red Flags
- Affects authentication or authorization → bump Technical Risk
- Changes database schema significantly → bump Affected Layers + Technical Risk
- Requires data migration → bump Technical Risk + File Changes
- Touches core shared utilities → bump Component Scope
- Affects multiple workflows or agents → bump Component Scope

### Clarity Red Flags
- Vague acceptance criteria → bump Requirements Clarity
- Multiple stakeholders with different expectations → bump Requirements Clarity
- "Similar to X but different" requirements → bump Requirements Clarity
- Phrases like "we'll figure it out" or "TBD" → bump Requirements Clarity

## XL/XXL: Story Splitting Recommendation

If the ticket scores XL (27–31) or XXL (32–36), do NOT proceed to planning. Instead:

1. Present the score breakdown and explain which dimensions drove it high
2. Explain the risk: stories this large are hard to review, hard to roll back, and frequently stall
3. Suggest concrete splitting strategies:
   - **By layer**: implement API contract first, then business logic, then integration
   - **By feature**: core happy-path first, then edge cases and error handling
   - **By dependency**: infrastructure or shared utilities first, then the feature that uses them
   - **By phase**: read-only (query) path first, then write path
4. Wait for the user to break it into smaller stories before proceeding

For XL (27–31): splitting is strongly recommended — present the options and let the user decide.
For XXL (32–36): splitting is required — do not invoke any planning skill until the user provides decomposed stories.

## Questions to Ask for Clarity

### For L/XL Requirements Clarity

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

### For XXL Requirements Clarity

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

### Size: [XS | S | M | L | XL | XXL]  ([total]/36)

### Dimension Scores:
| Dimension            | Score | Label |
|----------------------|-------|-------|
| Component Scope      | [1-6] | [XS–XXL] |
| Requirements Clarity | [1-6] | [XS–XXL] |
| Technical Risk       | [1-6] | [XS–XXL] |
| File Change Estimate | [1-6] | [XS–XXL] |
| Dependencies         | [1-6] | [XS–XXL] |
| Affected Layers      | [1-6] | [XS–XXL] |

### Key Reasoning:
- **[Highest dimension]**: [Why this score]
- **[Second highest]**: [Why this score]
- **[Any red flags applied]**: [Which dimension was bumped and why]

### Affected Components:
- **[Component]**: `path/to/file` — [nature of change]

### Risk Factors:
- [Risk 1]
- [Risk 2]

### Routing:
[superpowers:writing-plans | superpowers:brainstorming | SPLIT REQUIRED — see splitting recommendation]
```

## Best Practices for Accurate Estimation

### Do's
✅ Consider all six dimensions independently
✅ Apply red flags before finalising scores
✅ Run Grep/Glob to count affected files — don't guess File Change Estimate
✅ Use the self-check: does the overall size feel right given the dimension profile?
✅ Use objective criteria, not gut feeling
✅ Verify acceptance criteria in the ticket before scoring Requirements Clarity
✅ For Affected Layers, list each layer explicitly (UI / API / Service / DB / Infra / External)
✅ When unsure about Technical Risk, search the codebase for the closest existing pattern

### Don'ts
❌ Average the dimensions mentally — score each independently first
❌ Ignore available patterns when assessing Technical Risk
❌ Guess at file counts — do a quick Glob/Grep to estimate
❌ Skip the red flag check
❌ Score based only on the happy path — consider error handling, rollback, and edge cases

### Estimation Calibration Tips

- **Anchor to past work**: compare against the examples in `references/complexity-examples-*.md`
- **Layer count is a leading indicator**: stories touching 4+ distinct layers rarely finish in 1–2 days
- **Vague requirements multiply risk**: if Requirements Clarity scores L or higher, Technical Risk and File Change often follow
- **"Just a config change" red flag**: config changes often trigger downstream validation, migration, and documentation updates — don't undercount
- **DB schema changes always bump Affected Layers to at least L**: migrations have blast radius beyond the feature itself

## Handling Edge Cases

### Ticket Seems Small But Has Red Flags

Apply red flags explicitly — bump the affected dimension by 1 tier, recalculate total. Don't override; let the math decide.

### User Disagrees with Assessment

1. Ask which dimension they disagree with
2. Walk through the criteria for that dimension together
3. Reassess with their additional context
4. Document the agreed score and why

### Borderline Cases

For scores near tier boundaries (9→10, 14→15, 20→21, 26→27, 31→32):
- Lean toward higher size if high-risk dimensions are near a higher tier
- Lean toward lower if strong patterns make execution predictable
- L/XL boundary (26→27) deserves extra scrutiny — XL triggers a split recommendation

## Continuous Improvement

After implementation, record actual vs estimated:
- XS: completed in < half a day
- S: completed in ~1 day
- M: completed in 2–3 days
- L: completed in 4–5 days
- XL: should have been split; if attempted, likely ran over a sprint
- XXL: must always be split before starting
