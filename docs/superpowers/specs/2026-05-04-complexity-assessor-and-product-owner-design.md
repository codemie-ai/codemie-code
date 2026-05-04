# Complexity Assessor Agent + Product Owner Skill — Design

> **Ticket:** N/A — internal SDLC tooling improvements
> **Date:** 2026-05-04
> **Scope:** Two changes to the CodeMie SDLC flow

---

## Goal

1. Replace the `complexity-assessment` skill with a named subagent (`complexity-assessor`) that performs independent codebase research without polluting tech-lead's context.
2. Add a `product-owner` skill that takes user input (text, wireframes, screenshots, mockups) and produces a detailed functional requirements document with story breakdown, optionally pushing stories to a ticket tracking system.

---

## Architecture Overview

### Updated SDLC Flow

```
[product-owner]  ←  upstream, standalone
       ↓ (produces FRD + stories → optional ticket creation)

[tech-lead]  ←  entry point for implementation
  Phase 1: Requirements Gathering + worktree creation
  Phase 2: Assessment — load guides, dispatch complexity-assessor agent  ← UPDATED
       ↓ (receives assessment block + routing decision)
  Phase 3: brainstorming | writing-plans
  Phase 4: spec-reviewer → subagent-driven-development
  Phase 5: qa-lead
```

---

## Change 1: Complexity Assessor Agent

### What Changes

| Before | After |
|--------|-------|
| `.claude/skills/complexity-assessment/SKILL.md` (user-invokable skill) | Removed |
| tech-lead: "Invoke Skill: complexity-assessment" | tech-lead: "Dispatch Agent: complexity-assessor" |
| Skill ran inline — guide + scoring loaded into tech-lead's context | Agent runs in isolated context — nothing leaks back except the assessment block |
| `.claude/skills/complexity-assessment/references/` | Stays — agent reads these files itself |

### New Agent: `complexity-assessor`

The agent is generated using the **agent-creator tool** (not hand-authored). During implementation, invoke the agent-creator with the requirements below to produce the agent definition. The resulting agent file is loaded by the runtime when tech-lead dispatches the agent by name. Tech-lead never reads it.

**Agent responsibilities:**

1. Read `.claude/skills/complexity-assessment/references/complexity-assessment-guide.md` — load all 6 dimensions, scoring matrix, red flags, and best practices
2. Glob and read all `complexity-examples-*.md` files in the same references folder for calibration anchors
3. Run Explore (Glob/Grep) on the codebase to identify affected files, components, and layers — based on the task description and feature area provided by tech-lead
4. Score each dimension (XS–XXL, 1–6) using the guide criteria
5. Apply red flags from the guide — bump affected dimensions where applicable
6. Return a structured assessment block to tech-lead

**Strict output rules for the agent:**

- No code snippets — reference component names, file paths, layer labels only
- No implementation suggestions — assessment only
- No guide content reproduced — scoring output only
- Assessment block must be ≤300 words

**Assessment block format returned to tech-lead:**

```markdown
## Complexity Assessment: [feature area]

### Dimension Scores:
| Dimension            | Score | Label |
|----------------------|-------|-------|
| Component Scope      | [1-6] | [XS–XXL] |
| Requirements Clarity | [1-6] | [XS–XXL] |
| Technical Risk       | [1-6] | [XS–XXL] |
| File Change Estimate | [1-6] | [XS–XXL] |
| Dependencies         | [1-6] | [XS–XXL] |
| Affected Layers      | [1-6] | [XS–XXL] |

### Total: [sum]/36 — [XS | S | M | L | XL | XXL]

### Key Reasoning:
- **[Highest dimension]**: [Why — component names, not code]
- **[Second highest]**: [Why]
- **[Red flags applied]**: [Which dimension bumped and why, if any]

### Routing:
[superpowers:writing-plans | superpowers:brainstorming | SPLIT REQUIRED]
```

### Tech-Lead Step 5 (updated)

```
Dispatch Agent: complexity-assessor
Provide:
  - task description (from Phase 1)
  - feature area / keywords (e.g., "provider integration", "CLI command")

Wait for assessment block. Use the Routing line to proceed to Phase 4.
```

Tech-lead makes all routing decisions. The agent only returns data.

---

## Change 2: Product Owner Skill

### New File: `.claude/skills/product-owner/SKILL.md`

A user-facing skill that transforms raw input (text, wireframes, screenshots, mockups) into a detailed functional requirements document with story breakdown.

### Trigger Phrases

- "act as product owner"
- "create requirements for [feature]"
- "write functional requirements"
- "I have an idea, help me spec it out"
- "create stories for [feature]"
- "break this into user stories"

### Flow

```
Step 1: Input Collection
Step 2: Clarifying Questions (one at a time)
Step 3: Explore Subagent — existing system research
Step 4: superpowers:brainstorming — non-technical scope
Step 5: FRD Assembly
Step 6: Story Breakdown
Step 7: Ticket Creation (optional)
```

#### Step 1: Input Collection

Accept any combination of:
- Plain text description of the feature or idea
- Wireframes (images)
- Screenshots of existing flows
- Mockups (static or annotated)
- Links to existing docs or tickets

If the user provides only a one-liner, ask for more context before proceeding. Do not attempt to infer requirements from minimal input.

#### Step 2: Clarifying Questions (one at a time)

Ask until the following are clear:
- **Who are the target users?** (personas — non-technical description)
- **What problem does this solve?** (the job-to-be-done)
- **What does success look like?** (measurable outcome or user behavior)
- **What is explicitly out of scope?**
- **Are there any constraints?** (regulatory, brand, accessibility, device)

Stop asking when all five are answered. Do not ask implementation or technology questions.

#### Step 3: Explore Subagent

Dispatch `Agent(subagent_type="Explore")` with a focused prompt:

- Find existing flows, screens, or features similar to what is being described
- Identify which user-facing capabilities already exist
- Identify gaps between what exists and what is being requested
- Return a capability map: what exists, what is missing, what overlaps

This gives PO grounding in current system reality without building technical depth. The agent returns concept-level findings — feature names, flow names, screen names — not code.

#### Step 4: superpowers:brainstorming (non-technical scope)

Invoke `superpowers:brainstorming` with explicit framing:

**In scope for brainstorming:**
- User flows and journey maps
- Screen states and UI decisions
- Business rules and edge cases
- Visual structure via the visual companion (wireframes, flow diagrams, mockup comparisons)
- Acceptance scenarios ("given X, when Y, then Z")

**Explicitly out of scope:**
- Architecture, tech stack, implementation approach
- Database schema, API design, system internals
- Code patterns or technical conventions

The visual companion should be offered early — wireframes and flow diagrams are primary outputs of this step.

Brainstorming output feeds directly into Step 5.

#### Step 5: FRD Assembly

Produce `docs/product/YYYY-MM-DD-<feature-name>-requirements.md`:

```markdown
# [Feature Name] — Functional Requirements

**Date:** YYYY-MM-DD
**Status:** Draft | Under Review | Approved
**Author:** Product Owner (AI-assisted)

---

## Business Context

[Problem statement — what pain exists, why this matters]

## Target Users

### Persona 1: [Name]
[Who they are, what they need, what frustrates them today]

### Persona 2: [Name] (if applicable)
...

## Goals & Success Criteria

- [ ] [Measurable outcome 1]
- [ ] [Measurable outcome 2]

## Functional Requirements

### FR-001: [Requirement name]
[Description in plain language — what the system must do]
**Priority:** Must Have | Should Have | Nice to Have

### FR-002: ...

## User Flows

### Flow 1: [Flow name]
[Step-by-step description of the user journey — no technical steps]

## Visual References

[Wireframes, mockups, or flow diagrams produced during brainstorming]

## Out of Scope

- [What is explicitly not included in this release]

## Open Questions

- [Unresolved items that need stakeholder input]
```

#### Step 6: Story Breakdown

Append to the requirements doc:

```markdown
---

## Story Breakdown

### Epic 1: [Epic name]
[One-sentence epic goal]

#### Story 1.1: [Story title]
**As a** [persona], **I want** [goal] **so that** [outcome].

**Acceptance Criteria:**
- [ ] Given [context], when [action], then [result]
- [ ] Given [context], when [action], then [result]

**Size estimate:** [XS | S | M | L] ← business complexity only, not technical

#### Story 1.2: ...

### Epic 2: ...
```

Stories must be independently deliverable — each one produces observable value for the user. Tasks (sub-items within a story) are included only when a story has distinct sequential steps a team would track.

#### Step 7: Ticket Creation (optional)

After the doc is saved, check for available integrations:

1. **Jira** — if `brianna` skill is available: offer to create epics and stories in Jira. Each story in the breakdown maps to one Jira issue. Acceptance criteria go in the description.
2. **Other trackers** — if Azure DevOps, Linear, or other tools are configured and available: use them.
3. **None available** — output a structured export block the user can copy-paste:

```markdown
## Export: Stories for Ticket Tracker

### [Epic 1 name]
- **Story 1.1:** [title] | Priority: [P] | AC: [summary]
- **Story 1.2:** [title] | Priority: [P] | AC: [summary]
```

Always ask the user before creating tickets. Never create tickets automatically.

### Key Principles

**Do's:**
- Use plain, non-technical language throughout
- Anchor requirements to user goals and business outcomes
- Offer the visual companion early for UX/flow questions
- Keep stories independently deliverable
- Ask before creating tickets

**Don'ts:**
- No code snippets anywhere in the FRD
- No architecture or technical implementation decisions
- No assumptions about technology stack
- No story is too small to have acceptance criteria
- Never create tickets without explicit user confirmation

---

## File Structure

```
.claude/
  agents/
    complexity-assessor.md          ← NEW: generated via agent-creator tool
  skills/
    complexity-assessment/
      SKILL.md                      ← REMOVED
      references/
        complexity-assessment-guide.md   ← kept (agent reads this)
        complexity-examples-*.md         ← kept (agent reads these)
    product-owner/
      SKILL.md                      ← NEW: PO skill

docs/
  product/
    YYYY-MM-DD-<feature>-requirements.md   ← PO output
  superpowers/
    specs/
      2026-05-04-complexity-assessor-and-product-owner-design.md  ← this file
```

---

## Open Questions

- None — design is complete pending implementation.
