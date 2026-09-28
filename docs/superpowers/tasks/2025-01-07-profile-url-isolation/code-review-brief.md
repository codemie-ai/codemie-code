# Code review — 2025-01-07-profile-url-isolation (2026-09-23)

**request-changes** · confidence: medium · 1 resolved · 2 unresolved
Coverage: targeted verifier ✓

## Finding status

- CR-001 — `src/cli/commands/profile/index.ts:60` — **resolved** — listProfiles() now uses resolveIdentityWorkspace(), filtering to identity-bearing workspaces in scope order, matching resolveIdentity()'s fallback logic

## Still blocking

- CR-002 — `src/utils/config.ts:688` — **unresolved** — splitProfileAndWorkspace() casts to any four times (lines 688–694) with no justifying comment or typed index signature
- CR-003 — `src/utils/config.ts` — **unresolved** — config.ts now 1651 lines; identity-resolution helpers remain inline, not extracted to a dedicated module

## Standards (carried forward)

commit-format ✓ · security ✓ · code-quality ✗ (CR-002 and CR-003 block)
