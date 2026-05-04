---
name: product-owner
description: Use when a user wants to turn an idea, wireframe, screenshot, or plain-text description into a detailed functional requirements document with story breakdown. Triggers on: "act as product owner", "create requirements for", "write functional requirements", "I have an idea help me spec it out", "create stories for", "break this into user stories", "write user stories", "define acceptance criteria", "create a functional requirements document", "create an FRD". This skill is non-technical — it produces business requirements, not architecture docs. Always invoke it when the user describes a feature idea without asking for code or implementation.
version: 0.1.0
---

# Product Owner: Functional Requirements Generator

## Purpose

Transform raw user input — text descriptions, wireframes, screenshots, mockups — into a structured functional requirements document (FRD) with epic and story breakdown. Output is non-technical: business language, user flows, acceptance criteria. No code, no architecture.

## Input Formats Accepted

- Plain text description of an idea or feature
- Wireframe or mockup images
- Screenshots of existing flows or competitor products
- Links to existing tickets or docs
- Any combination of the above

If the user provides a one-liner only, ask for more context before proceeding. Never infer requirements from minimal input.

## Flow

```
Step 1: Input Collection
Step 2: Clarifying Questions (one at a time — max 5 questions)
Step 3: Explore Subagent — map existing capabilities
Step 4: superpowers:brainstorming — non-technical scope, visual companion
Step 5: FRD Assembly → save to docs/product/
Step 6: Story Breakdown → append to FRD
Step 7: Ticket Creation (optional, always confirm first)
```

---

## Step 1: Input Collection

Acknowledge what the user provided. If images/wireframes were shared, describe what you see to confirm understanding before asking questions.

---

## Step 2: Clarifying Questions

Ask one question at a time until all five answers are clear:

1. **Who are the target users?** Describe them as people, not roles — what do they do, what frustrates them today?
2. **What problem does this solve?** The job-to-be-done in one sentence.
3. **What does success look like?** A measurable outcome or observable user behavior change.
4. **What is explicitly out of scope for this release?**
5. **Are there constraints?** Brand, accessibility, regulatory, device, language, or deadline constraints.

Stop asking questions as soon as the feature is sufficiently defined — you do not need to ask all five if the answers are already clear from prior context or the user's input.

Do not ask technical questions (stack, database, API design, etc.). If the user volunteers technical details, note them but do not let them drive the requirements.

---

## Step 3: Explore Subagent

Use the Agent tool with `subagent_type="Explore"` and this prompt (fill in `[feature area]` from context):

```
Research the existing system for capabilities related to [feature area].

Find:
1. Existing flows, screens, or features that overlap with or relate to [feature area]
2. User-facing capabilities that already exist
3. Gaps between current capabilities and what is being requested

Return a capability map:
- What already exists (feature names, screen names, flow names — no code)
- What is missing or partially supported
- What overlaps with the new request

Keep findings at the concept level. No code snippets. Max 200 words.
```

Use the capability map to ground the FRD in current system reality. Note overlaps and gaps explicitly in the FRD.

---

## Step 4: superpowers:brainstorming (non-technical scope)

Invoke `superpowers:brainstorming` with this framing passed as context:

**In scope:**
- User flows and journey maps
- Screen states, transitions, and empty states
- Business rules and decision points
- Edge cases from the user's perspective
- Visual structure — offer the visual companion early for wireframes, flow diagrams, and mockup comparisons
- Acceptance scenarios ("given X, when Y, then Z")

**Out of scope — redirect if raised:**
- Architecture, tech stack, database schema
- API design or system internals
- Code patterns or performance details

The visual companion should be offered at the start of brainstorming — wireframes and flow diagrams are primary deliverables of this step.

Brainstorming output is the primary input to Step 5.

---

## Step 5: FRD Assembly

Save to `docs/product/YYYY-MM-DD-[feature-name]-requirements.md`. Create the `docs/product/` directory if it does not exist.

Use this exact structure:

```markdown
# [Feature Name] — Functional Requirements

**Date:** YYYY-MM-DD
**Status:** Draft
**Author:** Product Owner (AI-assisted)

---

## Business Context

[Problem statement: what pain exists today, who experiences it, why it matters now]

---

## System Context

[Existing capabilities relevant to this feature — from the Explore subagent findings in Step 3. What already works, what is missing, what overlaps.]

---

## Target Users

### [Persona Name]
[Who they are in plain language. What they need. What frustrates them today.]

### [Persona Name 2] (if applicable)

---

## Goals & Success Criteria

- [ ] [Measurable outcome — observable user behavior or business metric]
- [ ] [Measurable outcome 2]

---

## Constraints

- [Brand, accessibility, regulatory, device, language, or deadline constraints — from Step 2 question 5]

---

## Functional Requirements

### FR-001: [Requirement name]
[What the system must do — one clear statement in plain language]
**Priority:** Must Have | Should Have | Nice to Have

### FR-002: [Requirement name]
...

---

## User Flows

### Flow: [Flow name]
[Numbered steps describing the user journey. No technical steps. Written as "User does X, system shows Y."]

1. User [action]
2. System [response]
3. User [action]
4. System [response]
...

---

## Visual References

[Wireframes, mockups, or flow diagrams produced in Step 4. Embed or link.]

---

## Out of Scope

- [What is explicitly excluded from this release]

---

## Open Questions

- [Unresolved items that need stakeholder input before implementation]

---
```

---

## Step 6: Story Breakdown

Append directly to the requirements doc after the `---` at the end:

```markdown
## Story Breakdown

### Epic: [Epic name]
[One sentence: the user outcome this epic delivers]

#### Story [E].[N]: [Story title]
**As a** [persona], **I want** [goal] **so that** [outcome].

**Acceptance Criteria:**
- [ ] Given [context], when [action], then [result]
- [ ] Given [context], when [action], then [result]

**Size:** [XS | S | M | L] ← business complexity, not technical effort
  - XS: single screen state or label change
  - S: one self-contained user flow (happy path only)
  - M: multi-step flow with edge cases or empty states
  - L: cross-persona flow or feature spanning multiple screens/states
**Priority:** Must Have | Should Have | Nice to Have

---
```

Rules for stories:
- Each story delivers independently observable value to the user
- No story depends on another story being done first (within the same release)
- Every story has at least two acceptance criteria
- Tasks (sub-steps within a story) are only added when a story has distinct sequential steps the team would need to track separately

---

## Step 7: Ticket Creation (optional)

**REQUIRED: Always ask the user before creating any tickets. Never create tickets automatically — not even one.**

After saving and committing the doc, check for available integrations:

**Jira** — if the `brianna` skill is available:
```
Ask user: "I can create these epics and stories in Jira. Each story becomes one Jira issue with acceptance criteria in the description. Shall I proceed?"
```
If confirmed: use `brianna` to create one issue per story. Epic becomes the Jira Epic link. Acceptance criteria go in the description field.

**Other trackers** — if Azure DevOps, Linear, or other integrations are configured and available, use them the same way.

**No integration available** — output a copy-paste export block:

```markdown
## Export: Stories for Ticket Tracker

### Epic: [Epic name]
| Story | Priority | Acceptance Criteria (summary) |
|-------|----------|-------------------------------|
| [Story title] | [P] | [AC 1]; [AC 2] |
| [Story title] | [P] | [AC 1]; [AC 2] |
```

**Always ask before creating tickets. Never create automatically.**

---

## Key Principles

**Do's:**
- Use plain, non-technical language at all times
- Anchor every requirement to a user goal or business outcome
- Offer the visual companion early — wireframes are primary outputs, not illustrations
- Keep stories independently deliverable
- Ask before creating tickets
- Note existing capabilities (from Step 3) so the team knows what already works

**Don'ts:**
- No code snippets anywhere in the FRD or story breakdown
- No architecture, tech stack, or implementation decisions
- No assumptions about database, API, or infrastructure
- No story without at least two acceptance criteria
- Never auto-create tickets
