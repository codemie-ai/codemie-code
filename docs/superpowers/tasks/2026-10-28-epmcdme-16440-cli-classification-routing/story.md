---
schema_version: 1
id: cli-classification-routing
parent: cli-subscription-classification
repository: codemie-code
depends_on: [backend-ingest-routing]
---
# CLI: collect classification evidence and resolve the project in both launch modes — Story

**Date**: 2026-10-27
**Status**: Draft
**Parent**: ../../story.md
**Ticket**: —

---

## Context

- `OtlpAgentAdapter.resolveIdentityFields` stamps the user's email from stored CodeMie SSO credentials plus the profile `codeMieProject`; `forwarder.ts` sends `X-CodeMie-Project` and auth headers.
- A global profile ignores the folder's `.codemie` project (`ConfigLoader.resolveProfileWorkspace`); only `.codemie` workspace linkage was found as repo-to-project registration.
- `session-project.ts` binds the first project per session; a conflicting name discards the unsent backlog and a session without a name is never sent.
- Native Claude uses the `claude-code-otlp` hooks via `~/.claude/settings.json`; codemie-claude uses the `claude` plugin with `CODEMIE_PROJECT` and the proxy header. Whether codemie-claude reaches the cli-analytics gate is unconfirmed and must be inspected first.
- Local non-secret Claude evidence: `oauthAccount.organizationName` in the Claude config JSON; `claude auth status --json` has no organization. CodeMie routing signal: `ANTHROPIC_BASE_URL` pointing at CodeMie.
- Tracking scopes `user|project` exist on `proxy connect/disconnect --claude-code-otlp` (interpretation from source).

---

## Complexity

**Size**: L (23/36) · **Recommended flow**: sdlc-standard

Two launch modes, two tracking scopes, undocumented Claude org source and project-precedence change; brainstorm first.

---

## Story

**As a** CodeMie CLI user, **I want** the CLI to send what it knows about my Claude account and folder so that the platform can classify and route my sessions, **so that** my sessions land in the right project without me configuring it each time.

---

## Background

Classification and destination are resolved by the platform; the CLI must supply reliable, non-secret evidence consistently for the whole session, in both launch modes.

---

## Acceptance Criteria

- [ ] Given native Claude whose model endpoint is CodeMie, when a session is reported, then evidence marks it CodeMie; the same for codemie-claude.
- [ ] Given a native Claude account with an organization name, when a session is reported, then the organization name (and no account identity or credential) is sent as evidence.
- [ ] Given a session starts, when the CLI classifies locally with the D7 ordered rules before any forwarding, then it exposes one result `{subscription_type, status: determinate|indeterminate, basis, policy_version}` that opt-out (EPMCDME-16396) can consume; `status` and `basis` are separate from the four-value stored enum and are not stored (see `dependencies.md` interface). Opt-out itself is not implemented here.
- [ ] Given confirmed CodeMie routing, when the policy is unavailable, then the result is CodeMie, determinate (AC1 precedence).
- [ ] Given the organization is unavailable, or a usable policy is known and empty, when classifying, then the result is Unknown, determinate (AC7 classification), never Personal.
- [ ] Given a known organization, not CodeMie-routed, and no usable policy (unreachable, no cache, expired), when classifying, then subscription_type is Unknown but status is **indeterminate** with basis `policy_unavailable`, never Personal and never "determinate Unknown" (negative case).
- [ ] Given an indeterminate result and a consumer that suppresses Personal (16396), when events are produced, then the contract lets that consumer withhold them: the CLI keeps them in the spool as pending (not deleted, not forwarded), re-resolves after a policy refresh, and releases or suppresses per the consumer's decision. Without such a consumer, indeterminate events are forwarded as today with the Unknown value so collection is not lost.
- [ ] Given withheld-pending events that stay unresolvable past the spool's retention bound, when the bound is hit, then the loss is recorded with a distinct observable reason (`classification_unresolved`), separate from intentional opt-out suppression and from no-project collection loss.
- [ ] Given the backend answers an ingest with a retryable stale-policy response carrying the current policy version, when received, then the CLI refreshes the policy, re-classifies, re-applies any consumer decision, and resends from the spool; it never deletes the backlog on that response.
- [ ] Given `--silent` without `--scope` or an existing tracking-scope configuration from EPMCDME-16394 (#702), when this change runs, then the actual scope behavior of #702 is preserved, not redesigned.
- [ ] Given the owner and identity sources moved by #701 (profile-level identity), when sessions are stamped, then the owner is still the signed-in CodeMie user and billing is never inferred from the analytics authentication profile.
- [ ] Given the organization cannot be read (file missing, format changed, not logged in), when a session is reported, then no organization evidence is sent and the platform's Unknown path applies.
- [ ] Given a folder linked by `.codemie` and a global profile, when native Claude runs, then the linked project is sent (not the profile's work project) and the session owner stays the signed-in CodeMie user.
- [ ] Given a folder inside a repository registered to a project, when a session is reported, then the non-secret repository identity (as defined by the backend contract) is sent so the platform can resolve the registered project; the registration lookup itself is owned by `backend-ingest-routing` and its mechanism is an open design gap, so this criterion is contingent on that contract.
- [ ] Given a folder with neither a `.codemie` link nor a registered repository, when native Claude runs, then the session is still sent without a project and marked as unlinked; it is never dropped for lacking a project.
- [ ] Given codemie-claude, when a session is reported, then the profile project is sent and the subscription evidence is carried; Personal behavior follows settled D2 (a Personal result routes to the personal project even in codemie-claude; the CLI sends the evidence, the backend resolves the destination).
- [ ] Given the project changes or becomes unsendable mid-session, when events continue, then the session's stamped evidence stays stable and no backlog is lost silently (negative case).
- [ ] Given tracking scope `user` and `project` (including a folder outside the allowlist), when sessions run, then behavior is correct for each scope and launch mode.
- [ ] Given an older backend that ignores the new evidence, when the CLI runs, then existing behavior is unchanged.

---

## Out of Scope

- Reading or sending any Claude credentials or account identity.
- Server-side classification, destinations and analytics API (backend children).

---

## Decisions

- D1: Organization read from the Claude config JSON (parent D4), drift-safe, fields only.
- D2: Launch event paths for native vs codemie-claude must be inspected at the start of delivery before regression coverage is designed.

---

## Open Questions

- None.

## Design Work

- Exact evidence field names, repository identity form and "unlinked" signal come from the backend child's contract.
- Repository registration: depends on `backend-ingest-routing` design gap (design gap D8, resolved by source/design analysis there).
