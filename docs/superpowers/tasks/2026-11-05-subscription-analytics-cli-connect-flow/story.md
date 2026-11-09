---
schema_version: 1
id: subscription-analytics-cli-connect-flow
parent: subscription-analytics-private-sessions
repository: codemie-code
depends_on: [subscription-analytics-backend-capability]
---
# CLI: explicit-connect signal, funding-route evidence and session-transition handling — Story

**Date**: 2026-11-04
**Status**: Approved
**Ticket**: EPMCDME-16849 (umbrella)
**Parent**: ../../story.md
**Feature**: subscription-analytics

---

## Complexity

**Size**: XL (27/36) · **Recommended flow**: sdlc-standard (flagged for manual re-split decision)

On the XL boundary; assessor proposes three same-repo slices (session-transitions spike, connect/funding signals, capability e2e). No auto-recursion; split decision is the reviewer's.

---

## Story

**As a** CLI user, **I want** the CLI to publish a session to a project only when I explicitly connected the folder, and to record how the session is funded, **so that** work sessions are visible to the project while unrelated personal sessions stay private across /clear, resume and folder changes.

---

## Background

CLI (origin/main 916710fb) stamps project source from profile identity and classifies subscription type, but has no explicit-connection signal distinct from provenance, no funding-route evidence, and no verified /clear, resume or folder-change boundaries. The evidence/session-transition spike runs first and informs the backend contract; activation ships after the backend capability.

---

## Acceptance Criteria

- [ ] AC1 Given a folder with an explicit folder-to-project connection under the new publication semantics, when a new session starts there, then the CLI emits the explicit-connect signal and funding-route evidence and the real backend routes it to the project.
- [ ] AC2/AC3 Given no explicit connection, a profile-sourced project alone, or a global work profile in an unrelated folder, when a session runs, then no work-project consent is emitted and nothing is published into a work project.
- [ ] AC4 Given global collection disabled or a folder excluded, when a session runs, then nothing is published.
- [ ] AC5 Given the effective route and authentication, when evidence is captured, then funding route is api_based only when positively established, subscription only from supported effective subscription authentication, otherwise unknown; contradictory inputs yield unknown; no credentials are logged.
- [ ] AC8 Given /clear, resume or folder change, when the session continues, then session_id, cwd and project are evaluated per transition; no personal history reaches a work project, no consumption is duplicated, and when separation cannot be guaranteed publication is suspended with an actionable notification, without blocking Claude usage or switching the profile.
- [ ] AC11 Given a backend without the capability, when a new CLI publishes, then it does not report publication as succeeded and does not freeze the session into an unexpected private destination.
- [ ] AC-E2E (owner of the final check) Given the new CLI and the new backend, when real producer output is consumed by the real backend and analytics reader, then AC1, AC2, AC3, AC5, AC8 and AC9/AC11 hold end to end; this child evidences the shared parent-level coverage.

---

## Out of Scope

- Backend changes; automatic profile switching; Control Plane, UI, ticket attribution, Cost per Point; sending credentials.

---

## Decisions

- Inherits parent D1 and D5–D8.
- Spike first (research order): record session_id, cwd and project across /clear, resume and folder change on a compatible isolated build; the installed 0.16.4 wrapper lacks the evidence modules, so do not replace the global CLI. Findings go to the backend contract before it is frozen.
- Deployment order is backend support first, then CLI activation after capability negotiation.
- This child owns the final real CLI-to-backend consumer check and shared AC coverage.
- Keep wrapper launches on `--profile claude-personal`.

---

## Open Questions

- None
