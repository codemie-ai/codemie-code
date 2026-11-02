# Analytics PR/MR Creation Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Export conservative, timestamped GitHub PR and GitLab MR creation evidence from existing Claude native logs.

**Architecture:** Extractor reuses trace ownership; enrichment carries evidence independently of pricing; payload allowlists public fields.

**Tech Stack:** Node >=20, TypeScript ES modules, existing Vitest; no new dependencies.

**Spec:** `docs/superpowers/tasks/2026-10-22-analytics-pr-creation-evidence/spec.md` (original approved 2026-10-22; GitLab extension explicitly requested by user).

Commit per task using repository conventions; orchestrator owns whole-suite gates. Tests authorized.

## Global Constraints

- Exact observed successful-result timestamps; never report-generation timestamps.
- Maximum 100 events/session and 256 characters/identity; invalid identities omitted, not truncated.
- Only direct literal `gh pr create` / `glab mr create` and exact `mcp__github__create_pull_request` / `mcp__gitlab__create_merge_request` contracts. HTTPS github.com or GitLab.com/self-managed DNS hosts with optional ports; no GitHub Enterprise or HTTP.
- Public `changeRequestCreation` uses provider/type/source plus canonical host and full project path. GitLab `number` is project-local `iid`, never global `id`. Validate supplied provider/host/project identities; never infer provider from a URL alone.
- No network, transcript discovery, dependencies, configuration, UI, Collector or Control Plane changes.
- No monetary allocation, Jira inference, external-session inclusion changes, raw commands/results/bodies or branch export.
- Multiple PRs/MRs remain separate events. Interval attribution is a future Control Plane recommendation, never performed here.

## Review Focus

- Quoted shell metacharacters versus executed shell syntax: literal titles work; executable composition fails closed (Task 1).
- Conflicting MCP envelopes/hosts/projects and iid versus global id cannot prove the wrong creation (Task 1).
- Replayed shared files and duplicate tool IDs cannot cross session boundaries (Tasks 1–2).
- Missing or unpriced usage cannot suppress verified evidence; one broken session cannot abort others (Task 2).
- Unknown injected fields and secret-bearing responses never enter any public output (Task 3).

### Task 1 — Extract bounded confirmed creation events

**Files:** Create `src/cli/commands/analytics/cost/change-request-creation-extractor.ts` and `cost/__tests__/change-request-creation-extractor.test.ts` under the same analytics directory. Modify `cost/types.ts:125-201`; extend `cost/claude-native.ts:2-37` structural typing only if needed. Reuse `claude-trace.ts` and `claude-ownership.ts` without changing dispatch semantics.

**Interfaces:** Define `ChangeRequestCreationEvent` and `ChangeRequestCreationEvidence` with the exact spec fields/status union. Export `extractChangeRequestCreationEvidence(parsed: ParsedSession, window?: { start?: number; end?: number }): ChangeRequestCreationEvidence`; bounds are milliseconds, start inclusive/end exclusive, applied to owned invocation/result evidence. The caller handles missing/unsupported logs.

**Test-first: yes —** CLI/MCP pairs produce canonical events; absent extractor fails first.

- [ ] Add fixtures for both CLIs with quoted literals, glab TTY summary/non-TTY URL, both exact structured/text-JSON MCP contracts and linked subagents. Include GitLab nested groups, self-managed hosts/ports, numeric and URL-encoded path `project_id`, `iid` distinct from global `id`, two creations sharing a number on distinct hosts/projects, native timestamps and query/fragment removal. Assert exact allowlisted fields.
- [ ] Add rejection/coverage cases: errors/nonzero exit/already exists, missing timestamp/result, mismatched provider/host/project/number, invalid or encoded-separator/dot-segment/issue/preview URLs, unsupported numeric CLI project selectors, help/browser-preview modes, failed post-creation actions, compounds/wrappers/examples/reads, duplicate/conflicting IDs, replay/ambiguous owners, bounds and 101-event overflow. Preserve valid events when another candidate fails; reject oversized identities.
- [ ] Run `npx vitest run --project unit src/cli/commands/analytics/cost/__tests__/change-request-creation-extractor.test.ts`, observe intended failure, implement conservative local extraction using existing ownership helpers, rerun to pass. Match target selectors and treat `--head` as a source fork, not target. GitLab MCP must validate response `project_id` against numeric requests and URL project path against path requests; require `iid` to match URL. Use reference contract shapes linked in the spec. No generic shell interpreter or new discovery.

### Task 2 — Carry evidence through session enrichment

**Files:** Modify `src/cli/commands/analytics/cost/cost-enricher.ts:549-705` and `cost/__tests__/cost-enricher.test.ts`.

**Interfaces:** `SessionCost.changeRequestCreation?: ChangeRequestCreationEvidence` carries Task 1 output. Invoke extraction outside priced/usage guards, with existing observed session/shared-file bounds. Scope any cross-session deduplication to the enrichment run and owned invocation plus provider/host/project/number identity; do not collapse equal numbers on different hosts/projects.

**Test-first: yes —** unpriced logs retain evidence; shared/replayed sessions cannot acquire others' creations.

- [ ] Add integration fixtures for unpriced/empty usage, missing logs (`unavailable`), unsupported/OTEL-only sources (`unsupported`), extraction failure (`partial`), and valid neighboring sessions after failure. Assert unchanged costs/dispatch values and preserved independently verified events.
- [ ] Run `npx vitest run --project unit src/cli/commands/analytics/cost/__tests__/cost-enricher.test.ts`, observe intended failure, wire isolated extraction/coverage assignment into the existing parsed-session loop and other source paths, rerun to pass.

### Task 3 — Export the shared contract and document limits

**Files:** Modify `src/cli/commands/analytics/report/types.ts:10-99`, `report/payload-builder.ts:20-69`, `report/__tests__/{payload-builder,report-generator,session-report}.test.ts`, and `docs/ANALYTICS-REPORT.md`.

**Interfaces:** `ReportSessionRecord.changeRequestCreation?: ChangeRequestCreationEvidence`; project each field explicitly through the shared payload. Absent legacy metadata means unknown coverage.

**Test-first: yes —** JSON, embedded HTML and per-session payloads must expose identical evidence while dropping injected raw/secret fields.

- [ ] Add bounded public projection and export regression fixtures; assert exact observed timestamps, statuses, empty events, mixed-provider PR/MR events (including host, subgroup path and iid), omitted legacy metadata and unchanged existing financial/report fields.
- [ ] Run `npx vitest run --project unit src/cli/commands/analytics/report/__tests__/payload-builder.test.ts src/cli/commands/analytics/report/__tests__/report-generator.test.ts src/cli/commands/analytics/report/__tests__/session-report.test.ts`, observe intended failure, implement allowlist projection and additive type, rerun to pass.
- [ ] Document schema/statuses, supported tool/command shapes, GitLab nested/self-managed targets, iid semantics, the archived reference MCP contract boundary (not universal GitLab MCP support), subagent provenance, missing-log limits and that creation evidence does not assign preceding work/cost; timestamped events merely enable future downstream interval proposals.

## Negative-constraint pass

Tasks 1–2 use existing logs/ownership only, exclude GitHub Enterprise, HTTP-only hosting, unsupported tool aliases and read operations, and preserve cost/dispatch semantics. Task 3 exports only bounded allowed metadata with no new UI. All tasks preserve external-session inclusion and leave Collector, Control Plane, Jira and monetary/interval allocation untouched. No task adds runtime configuration/dependencies or remote calls.
