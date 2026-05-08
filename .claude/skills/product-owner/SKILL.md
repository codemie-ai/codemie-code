---
name: product-owner
description: Use when a user wants to create, draft, or refine a user story, feature story, or Jira ticket. Triggers on "create story", "draft story", "write a story", "new story for", "story for this feature", "I need a story", "help me write a story", "create a ticket", "draft a ticket", "write acceptance criteria", "act as product owner", "create requirements for", "write functional requirements", "I have an idea help me spec it out", "create stories for", "break this into user stories", "define acceptance criteria", "create an FRD". Invoke whenever the user describes a feature idea, improvement, or bug fix and wants it turned into a structured story — even if they don't say "story" explicitly. Always explore the codebase for context before asking questions.
version: 0.3.0
---

# Product Owner: Story Drafter

## Purpose

Turn a raw idea, feature description, or conversation into a well-structured user story saved to `docs/stories/`. The story is your primary output — a file the user can review, edit, approve, and then ship to Jira.

## Flow

```
Step 1: Input Collection — assess specificity of request
Step 2: Scope Clarification (conditional) — only if request is too broad
Step 3: Explore Codebase — find relevant existing capabilities and context
Step 4: Focused Questions — 3–5 targeted questions informed by the exploration
Step 5: Draft Story — save to docs/stories/YYYY-MM-DD-[feature-name].md
Step 6: Review Loop — user requests changes → update file → repeat until approved
Step 7: On Approval — call brianna to create Jira ticket
```

---

## Step 1: Input Collection

Acknowledge what the user described. Then assess whether the request is specific enough to explore meaningfully.

**Signs a request is too broad** (any one of these → go to Step 2):
- No feature area mentioned ("improve the system", "add better UX", "make it faster")
- Multiple unrelated areas implied ("notifications, search, and reporting")
- No user mentioned and no problem implied
- Scope would require exploring more than 3–4 unrelated parts of the codebase

**Signs a request is specific enough** (skip Step 2 → go straight to Step 3):
- A named feature or flow is mentioned ("add bulk export to the datasource list")
- A clear persona + problem is implied ("users can't cancel a running job")
- The user is asking about an existing thing ("improve the error message on the login page")

---

## Step 2: Scope Clarification (conditional — only if request is too broad)

Ask **2–3 short questions** — all at once, not one at a time — to narrow scope before exploring. Explain briefly why you're asking: "Your request is quite broad — a couple of quick questions before I dig into the codebase."

Choose from:
1. **Which part of the product does this touch?** (e.g., which feature, flow, or screen)
2. **Who is the primary user affected?** (role or persona)
3. **What's the one thing they can't do today that they should be able to?**

Do not ask more than 3 clarifying questions at this stage. Once answers narrow the scope to a single feature area, proceed to Step 3.

---

## Step 3: Explore Codebase

Use the Agent tool with `subagent_type="Explore"` to find relevant context. Tailor the prompt to the feature area described:

```
Research the existing codebase for context relevant to [feature area].

Find:
1. Existing features, flows, or components that overlap with or relate to [feature area]
2. User-facing capabilities that already exist in this area
3. Gaps between current capabilities and what is being requested
4. Any related models, services, or API endpoints (names only — no code)

Return:
- What already exists (feature names, component names, flow names — no code snippets)
- What is missing or partially supported
- What overlaps with the new request

Keep findings at the concept level. Max 200 words.
```

Use these findings to:
- Ground your questions in current system reality
- Avoid asking about things that are already obvious from the code
- Surface gaps and overlaps explicitly in the story's Context section

---

## Step 4: Focused Questions

Ask **one question at a time**, up to 5 total. Stop as soon as the story is sufficiently clear — you don't need all five if earlier answers cover the ground.

Tailor the questions to gaps in your understanding after exploring the codebase. Default questions to draw from:

1. **Who is this for?** Describe the user as a person — what do they do, what frustrates them today?
2. **What problem does this solve?** One sentence: the job-to-be-done.
3. **What does done look like?** A measurable outcome or observable change in user behavior.
4. **What is explicitly out of scope for this story?**
5. **Any constraints?** Deadline, accessibility, device, or regulatory constraints.

Do not ask technical questions (stack, API design, database). If the user volunteers technical details, note them but do not let them drive the story.

---

## Step 5: Draft Story

Save to `docs/stories/YYYY-MM-DD-[feature-name].md`. Create `docs/stories/` if it does not exist.

Use this exact structure:

```markdown
# [Feature Name] — Story

**Date**: YYYY-MM-DD
**Status**: Draft
**Ticket**: TBD

---

## Context

[Findings from codebase exploration: what already exists, what is missing, what overlaps with this request. Keep it factual and brief — 3–5 bullet points.]

---

## Story

**As a** [persona], **I want** [goal] **so that** [outcome].

---

## Background

[Problem this solves. Who experiences it. Why it matters now. 2–4 sentences.]

---

## Acceptance Criteria

- [ ] Given [context], when [action], then [result]
- [ ] Given [context], when [action], then [result]
- [ ] Given [context], when [action], then [result]

---

## Out of Scope

- [What is explicitly excluded from this story]

---

## Open Questions

- [Unresolved items that need stakeholder input before implementation]
```

Rules:
- At least 3 acceptance criteria
- Each criterion is independently verifiable ("given / when / then")
- No code snippets, no architecture decisions, no tech stack references
- Open Questions captures things you couldn't resolve from exploration or user answers

After saving, tell the user the file path and ask: **"Does this look right, or do you want any changes?"**

---

## Step 6: Review Loop

If the user requests changes:
1. Update the story file directly — do not create a new file
2. Tell the user what changed
3. Ask again: "Does this look right, or do you want any more changes?"

Repeat until the user approves. Watch for phrases like "looks good", "approved", "create the ticket", "ship it", "go ahead" — these signal approval.

---

## Step 7: On Approval — Create Jira Ticket

When the user approves the story:

1. Update the file's `**Status**` field from `Draft` to `Approved`
2. Invoke the `brianna` skill to create a Jira ticket

Pass to brianna:
- **Summary**: the story title (the `# [Feature Name] — Story` heading)
- **Description**: the full story content (Story + Background + Acceptance Criteria sections)
- **Issue type**: Story
- **Acceptance criteria**: the formatted criteria list from the story file

After the ticket is created, update the `**Ticket**` field in the story file with the Jira issue key (e.g., `EPMCDME-1234`).

---

## Key Principles

**Do:**
- Check scope before exploring — if the request is too broad, ask 2–3 clarifying questions first
- Explore the codebase after scope is clear — context makes feature questions sharper
- Keep stories small enough to be independently deliverable
- Write acceptance criteria as given/when/then — not as a feature checklist
- Update the story file in place when changes are requested (same file, same path)
- Ask before creating any ticket — never auto-create

**Don't:**
- No code snippets anywhere in the story
- No architecture or implementation decisions
- No story without at least 3 acceptance criteria
- Never create a Jira ticket before explicit user approval
- Never create a new file for revisions — always update the existing draft
