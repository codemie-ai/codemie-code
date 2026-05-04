---
name: spec-reviewer
description: Reviews technical specifications from solution-architect against Jira ticket requirements and project design guidelines. Identifies critical gaps and design principle violations. Provides focused feedback without code snippets. Verdict is APPROVED for implementation or NEEDS WORK with specific issues.
version: 0.1.0
---

# Spec Reviewer: Technical Specification Review

## Purpose

This skill reviews technical specifications produced by the solution-architect agent to ensure they:
- Address all requirements from the Jira ticket
- Follow project design guidelines from `.codemie/guides/`
- Comply with architectural principles and patterns
- Are focused, clear, and implementation-ready

The skill provides a binary verdict (APPROVED or NEEDS WORK) with critical feedback only—no minor comments, no code snippets.

## When to Use This Skill

Use this skill when:
- Solution-architect agent has produced a technical specification
- Before starting implementation of a complex feature
- User asks to "review spec", "validate specification", "check design doc"
- Need to verify specification against Jira ticket requirements
- Want to ensure spec follows project design principles

## Review Workflow

### Phase 1: Input Gathering

**Step 1: Obtain Specification**

Get the technical specification to review:
- **From user message**: User provides spec content directly
- **From file path**: User provides path to spec file (use Read tool)
- **From previous context**: Spec was generated earlier in conversation

**Step 2: Identify Jira Ticket**

Extract Jira ticket ID from specification or ask user:
- Look for `EPMCDME-XXXXX` pattern in spec
- If not found, ask user for ticket ID
- Use brianna skill to fetch ticket description and summary

```
Use Skill tool with skill="brianna" and args:
"Get ticket details for EPMCDME-XXXXX. I need only the description and summary fields."
```

### Phase 2: Criteria Loading

**Step 3: Load Relevant Project Guides**

Based on spec content, load applicable guides from `.codemie/guides/`:

| Spec Mentions | Load Guide (P0) | Also Load (P1) |
|---------------|-----------------|----------------|
| Architecture, layers, components | .codemie/guides/architecture/architecture.md | - |
| API, endpoints, REST | .codemie/guides/api/ (if exists) | .codemie/guides/architecture/architecture.md |
| Agent, plugin, registry | .codemie/guides/architecture/architecture.md | .codemie/guides/integration/external-integrations.md |
| Security, auth, credentials | .codemie/guides/security/security-practices.md | .codemie/guides/development/development-practices.md |
| Testing, mocking, coverage | .codemie/guides/testing/testing-patterns.md | - |
| Error handling, logging | .codemie/guides/development/development-practices.md | .codemie/guides/standards/code-quality.md |
| Provider, LLM, integration | .codemie/guides/integration/external-integrations.md | .codemie/guides/architecture/architecture.md |
| Git, workflow, CI/CD | .codemie/guides/standards/git-workflow.md | - |

**Step 4: Identify Design Principles**

Extract key design principles from loaded guides:
- Layered architecture rules (CLI → Registry → Plugin → Core → Utils)
- Plugin isolation principles
- Error handling patterns
- Security requirements
- Testing strategies
- Dependency rules

### Phase 3: Critical Review

**Step 5: Verify Against Jira Ticket**

Compare specification to Jira ticket requirements:

**CRITICAL Issues** (Must report):
- ❌ Missing acceptance criteria not addressed in spec
- ❌ Misalignment with ticket goals or scenarios
- ❌ Spec solves different problem than ticket describes
- ❌ Key user-facing functionality omitted

**NOT Critical** (Skip):
- Minor wording differences
- Implementation details beyond ticket scope
- Additional nice-to-have features

**Step 6: Verify Against Design Principles**

Check spec compliance with project design guidelines:

#### Architecture Violations (CRITICAL)

From `.codemie/guides/architecture/architecture.md`:

**Must Report**:
- ❌ Skipping architectural layers (e.g., CLI directly calls Plugin)
- ❌ Core layer depending on Plugin layer (dependency inversion violation)
- ❌ Plugin-to-Plugin direct dependencies
- ❌ Business logic in CLI layer
- ❌ Missing registry registration for new plugins

**Example Feedback Format**:
```markdown
**Architecture Violation**: Spec proposes CLI command directly instantiating ClaudePlugin.
**Principle**: CLI → Registry → Plugin flow (5-layer architecture)
**Reference**: .codemie/guides/architecture/architecture.md:246-273 (Communication Rules)
**Impact**: Breaks plugin isolation, makes testing difficult, violates Open/Closed principle
```

#### Security Violations (CRITICAL)

From `.codemie/guides/security/security-practices.md`:

**Must Report**:
- ❌ Hardcoded credentials or API keys in spec
- ❌ Missing input validation for user-provided data
- ❌ Logging sensitive data without sanitization
- ❌ File path operations without security checks
- ❌ Missing CredentialStore usage for credential storage

**Example Feedback Format**:
```markdown
**Security Violation**: Spec shows API key stored in configuration file.
**Principle**: No hardcoded credentials, use CredentialStore
**Reference**: .codemie/guides/security/security-practices.md (Credential Storage section)
**Impact**: Credentials exposed in version control, security risk
```

#### Error Handling Violations (CRITICAL)

From `.codemie/guides/development/development-practices.md`:

**Must Report**:
- ❌ Using generic Error instead of specific error classes
- ❌ Missing error context for debugging
- ❌ Swallowing errors without logging
- ❌ No error propagation strategy defined

**Example Feedback Format**:
```markdown
**Error Handling Violation**: Spec uses generic Error for agent not found.
**Principle**: Use specific error classes from src/utils/errors.ts
**Reference**: .codemie/guides/development/development-practices.md (Error Handling section)
**Impact**: Poor user experience, difficult debugging, no structured error handling
```

#### Testing Violations (CRITICAL)

From `.codemie/guides/testing/testing-patterns.md`:

**Must Report**:
- ❌ No testing strategy defined for complex features
- ❌ Mixing unit and integration test concerns
- ❌ Missing test isolation strategy
- ❌ Incorrect mocking approach (static imports without dynamic loading)

**Example Feedback Format**:
```markdown
**Testing Violation**: Spec proposes static imports for modules that need mocking.
**Principle**: Use dynamic imports after beforeEach for mockable modules
**Reference**: .codemie/guides/testing/testing-patterns.md (Dynamic Imports section)
**Impact**: Tests cannot properly mock dependencies, brittle test suite
```

#### Integration Violations (CRITICAL)

From `.codemie/guides/integration/external-integrations.md`:

**Must Report**:
- ❌ Direct integration without provider abstraction
- ❌ Missing error handling for external service failures
- ❌ No retry or timeout strategy for external calls
- ❌ Hardcoded external service URLs

**Step 7: Verify Focus and Clarity**

Check specification quality:

**CRITICAL Issues** (Must report):
- ❌ Spec is vague or ambiguous about key implementation details
- ❌ Multiple disconnected features bundled together
- ❌ Missing critical interfaces or contracts
- ❌ Unclear component responsibilities
- ❌ No clear success criteria or validation approach

**NOT Critical** (Skip):
- Minor typos or grammatical issues
- Formatting inconsistencies
- Missing diagrams (unless critical for understanding)
- Overly verbose explanations

### Phase 4: Verdict and Feedback

**Step 8: Provide Review Verdict**

Format review results as follows:

#### If NO Critical Issues Found:

```markdown
## Specification Review: APPROVED ✅

**Jira Ticket**: EPMCDME-XXXXX
**Specification**: [Title or path]

### Verdict
This specification is **APPROVED** for implementation.

### Review Summary
- ✅ Addresses all Jira ticket acceptance criteria
- ✅ Follows 5-layer architecture principles
- ✅ Complies with security guidelines
- ✅ Proper error handling strategy defined
- ✅ Clear component responsibilities and interfaces
- ✅ [Additional positive findings]

### Next Steps
Proceed with implementation following the specification. Use tech-lead skill to guide implementation.
```

#### If Critical Issues Found:

```markdown
## Specification Review: NEEDS WORK ⚠️

**Jira Ticket**: EPMCDME-XXXXX
**Specification**: [Title or path]

### Verdict
This specification **REQUIRES ADDITIONAL WORK** before implementation.

### Critical Issues

#### 1. [Issue Category] - [Brief Title]
**Violation**: [What principle/requirement is violated]
**Principle**: [Which design principle from guides]
**Reference**: [Guide path and section]
**Impact**: [Why this matters, consequences of not fixing]

#### 2. [Issue Category] - [Brief Title]
**Violation**: [What principle/requirement is violated]
**Principle**: [Which design principle from guides]
**Reference**: [Guide path and section]
**Impact**: [Why this matters, consequences of not fixing]

[Continue for all critical issues]

### Jira Ticket Alignment

[If applicable]
- ❌ Acceptance criterion "[text]" not addressed
- ❌ Scenario "[text]" not covered
- ❌ [Other alignment issues]

### Recommendations

[High-level guidance - NO code snippets]
1. [Action to address issue category 1]
2. [Action to address issue category 2]
3. [Action to address issue category 3]

### Next Steps
Address critical issues above, then resubmit specification for review.
```

## Critical Review Criteria

### ✅ What to Report (CRITICAL Only)

| Category | Report If |
|----------|-----------|
| **Architecture** | Violates 5-layer architecture, breaks dependency rules, skips layers |
| **Security** | Hardcoded credentials, missing validation, unsafe operations, logging sensitive data |
| **Error Handling** | Using generic errors, missing context, swallowing exceptions |
| **Testing** | No strategy for complex features, incorrect mocking approach |
| **Jira Alignment** | Missing acceptance criteria, wrong problem being solved |
| **Clarity** | Vague key details, unclear responsibilities, no success criteria |
| **Integration** | Direct coupling to external services, no error handling |

### ❌ What NOT to Report (Minor Issues)

| Category | Skip If |
|----------|---------|
| **Style** | Formatting, minor typos, grammar issues |
| **Optimization** | Performance suggestions not affecting correctness |
| **Extras** | Missing nice-to-have features beyond ticket scope |
| **Preferences** | Alternative approaches that are equally valid |
| **Documentation** | Minor documentation improvements |

## Key Principles

### Do's
✅ Focus on CRITICAL issues only (design principle violations, missing requirements)
✅ Reference specific guides and sections
✅ Explain WHY issue is critical (impact)
✅ Fetch Jira ticket to verify alignment
✅ Load applicable guides before review
✅ Provide clear verdict (APPROVED or NEEDS WORK)
✅ Give focused feedback without code snippets
✅ Be constructive and specific

### Don'ts
❌ Don't report minor style or formatting issues
❌ Don't provide code snippets or implementation fixes
❌ Don't suggest "nice to have" improvements
❌ Don't be overly pedantic about minor details
❌ Don't assume—verify against actual guides
❌ Don't approve specs with critical violations
❌ Don't provide vague feedback like "improve clarity"

## Example Reviews

### Example 1: APPROVED Specification

```
User: "Review this spec for EPMCDME-10500"
[Spec: New REST endpoint following existing patterns]

Spec Reviewer:
1. Fetches EPMCDME-10500 via brianna
2. Loads .codemie/guides/architecture/architecture.md
3. Reviews spec:
   - Follows CLI → Registry → Plugin architecture ✅
   - Uses existing error classes ✅
   - Addresses all acceptance criteria ✅
   - Clear interfaces defined ✅
4. Verdict: APPROVED ✅
5. Recommends: Proceed with implementation
```

### Example 2: NEEDS WORK - Architecture Violation

```
User: "Review this spec for EPMCDME-10600"
[Spec: New agent with CLI directly calling plugin code]

Spec Reviewer:
1. Fetches EPMCDME-10600 via brianna
2. Loads .codemie/guides/architecture/architecture.md
3. Identifies CRITICAL issue:
   - Spec shows CLI command directly instantiating agent plugin
   - Violates 5-layer architecture (CLI → Registry → Plugin)
   - Reference: architecture.md:246-273
4. Verdict: NEEDS WORK ⚠️
5. Feedback: "CLI must call AgentRegistry.getAgent(), not instantiate plugin directly"
```

### Example 3: NEEDS WORK - Security Violation

```
User: "Review this spec for EPMCDME-10700"
[Spec: Provider integration with API key in config file]

Spec Reviewer:
1. Fetches EPMCDME-10700 via brianna
2. Loads .codemie/guides/security/security-practices.md
3. Identifies CRITICAL issue:
   - API key stored in configuration file
   - Violates credential storage principle
   - Reference: security-practices.md
4. Verdict: NEEDS WORK ⚠️
5. Feedback: "Use CredentialStore.getInstance() for secure credential storage"
```

### Example 4: NEEDS WORK - Missing Jira Requirements

```
User: "Review this spec for EPMCDME-10800"
[Spec: Agent feature but missing key acceptance criterion]

Spec Reviewer:
1. Fetches EPMCDME-10800 via brianna
2. Ticket has acceptance criterion: "Support batch mode processing"
3. Spec only covers streaming mode
4. Identifies CRITICAL gap:
   - Acceptance criterion not addressed
   - Spec incomplete for ticket requirements
5. Verdict: NEEDS WORK ⚠️
6. Feedback: "Spec must address batch mode processing (acceptance criterion 3)"
```

## Integration with Other Skills

### Solution-Architect Skill
- **Input source**: Specs produced by solution-architect
- **Workflow**: solution-architect creates spec → spec-reviewer validates → implement or revise
- **Feedback loop**: If NEEDS WORK, solution-architect revises based on feedback

### Brianna Skill
- **Purpose**: Fetch Jira ticket for alignment verification
- **Usage**: Request description + summary fields only
- **Handle missing**: If ticket not found, cannot verify alignment (note in review)

### Tech-Lead Skill
- **Handoff**: After APPROVED verdict, tech-lead can guide implementation
- **Workflow**: spec-reviewer approves → tech-lead implements
- **Dependency**: tech-lead should not start without approved spec for complex features

## Error Handling

### Specification Not Provided
```markdown
Error: No specification provided for review.

Please provide:
- Specification content (paste directly)
- File path to specification document
- Reference to spec in conversation history
```

### Jira Ticket Not Found
```markdown
Warning: Unable to fetch Jira ticket EPMCDME-XXXXX.

Proceeding with guide compliance review only. Cannot verify alignment with ticket requirements.

Consider:
- Verifying ticket ID format
- Checking ticket exists and is accessible
- Reviewing ticket requirements manually
```

### Guides Not Available
```markdown
Error: Required guide not found: [path]

Cannot complete review without design guidelines.

Please ensure .codemie/guides/ directory is available with:
- architecture/architecture.md
- security/security-practices.md
- development/development-practices.md
- [Other applicable guides]
```

## Success Criteria

A successful spec review results in:
- ✅ Specification content obtained and understood
- ✅ Jira ticket fetched and reviewed
- ✅ Relevant guides loaded and consulted
- ✅ Critical issues identified (if any)
- ✅ Clear verdict provided (APPROVED or NEEDS WORK)
- ✅ Focused feedback with guide references (if NEEDS WORK)
- ✅ User has actionable next steps

## Additional Resources

### Reference Files

For detailed review criteria:
- **`references/review-checklist.md`** - Comprehensive checklist for each review category
- **`references/violation-examples.md`** - Examples of critical violations by category

### Integration Points

This skill coordinates with:
- **CLAUDE.md**: Uses guide references and task classifier
- **`.codemie/guides/`**: Loads all applicable guides for compliance verification
- **brianna skill**: Fetches Jira ticket information for alignment check
- **solution-architect skill**: Reviews specs produced by this skill
- **tech-lead skill**: Hands off to tech-lead after APPROVED verdict
