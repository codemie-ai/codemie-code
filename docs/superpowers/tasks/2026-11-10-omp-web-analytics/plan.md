# omp web analytics (codemie-omp) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox syntax.

**Goal:** Verify the delivered `codemie-omp` slice (commits `f2382a07`, `74cb3acd`) and add only the three missing tests.

**Architecture:** Managed `omp` plugin reuses Pi machinery via identity parameters; `proxy connect --omp` uses client type `codemie-omp`. Do NOT re-implement delivered code; scope diffs by those two commits (local `main` is stale).

**Spec:** `/tmp/omp-web-analytics/sdlc-task.md`. Commit per task using the repository's existing convention. Never push, never open a PR/MR. Other repos out of scope.

## Acceptance criteria

- A `codemie-omp` run produces metrics and conversations with `codemie_client=codemie-omp`, `agent=omp`.
- omp subagent transcripts (`ctx.agent.kind === 'sub'`) are not recorded or uploaded.
- `~/.omp` is not modified by a managed run.
- `codemie proxy connect --omp` traffic is attributed to `codemie-omp`.
- `codemie-pi` behaviour is unchanged.

negative-constraints: omp must not touch `~/.omp` (Task 1 verifies); no `--session-id` for omp (Task 1); subagents not uploaded (Task 1); Pi unchanged (Task 2); no push/PR (header).

### Task 1: Managed omp plugin and extensions (verify)

**Files:** `src/agents/plugins/omp/` (plugin, extension materializer, `extension/index.js`), `src/agents/registry.ts`, `src/agents/core/AgentCLI.ts`, `bin/codemie-omp.js`, `package.json`, `eslint.config.mjs`, `scripts/copy-plugins.js`.

- [ ] Test-first: no — verify-only, already delivered
- [ ] Run `npx vitest run src/agents/plugins/omp src/agents/__tests__/registry.test.ts`; confirm identity, args, extension, providers-extension tests pass and cover `~/.omp` untouched, no `--session-id`, `codemie-omp` upload.

### Task 2: Pi machinery parameterization (verify, Pi unchanged)

**Files:** `src/agents/plugins/pi/` (`pi.plugin.ts`, `pi.extension.ts`, `pi.models.ts`, `pi.session.ts`, `pi.incremental-sync.ts`, `extension/index.js`, `session/processors/pi.conversations-processor.ts`).

- [ ] Test-first: no — verify-only, already delivered
- [ ] Run `npx vitest run src/agents/plugins/pi`; confirm Pi defaults (`pi`, `codemie-pi`, folder `pi`) and the ledger subagent-skip test pass.

### Task 3: Proxy connect --omp identity (verify) plus sanitizer allow-list test

**Files:** `src/cli/commands/proxy/connect-orchestrator.ts`, `src/providers/plugins/sso/proxy/plugins/codex-encrypted-content-sanitizer.plugin.ts:35-41`; Test: `src/providers/plugins/sso/proxy/plugins/__tests__/codex-encrypted-content-sanitizer.plugin.test.ts`.

- [ ] Test-first: yes — a request with client type `codemie-omp` is sanitized (not skipped), mirroring the existing `codemie-pi` case; fails only if `codemie-omp` is removed from `ALLOWED_AGENTS`.
- [ ] Verify `connect-orchestrator.test.ts` passes (omp -> `codemie-omp`, `codemie-daemon` daemon restarted). Add only the sanitizer case.

### Task 4: Conversation folder mapping (verify) plus omp branch test

**Files:** `src/providers/plugins/sso/session/processors/conversations/syncProcessor.ts:280` (`resolveConversationFolder`); Test: `.../conversations/__tests__/syncProcessor-folder-mapping.test.ts`.

- [ ] Test-first: yes — clientType `codemie-omp` (and agentName `omp`) resolves to folder `omp`; fails if the omp branch is removed.
- [ ] Follow the existing cases in that file; add only the omp case(s).

### Task 5: Same-transcript keys for omp (verify) plus branch test

**Files:** `src/agents/core/session/next-record-start.ts:71,142`; Test: `src/agents/core/session/__tests__/stale-session-reconciliation.test.ts`.

- [ ] Test-first: yes — omp sessions sharing a transcript are keyed `omp:<path>` via ledger and the key list is not cached (recomputed per call), like `pi`; fails if the `omp` case at line 71 or the uncached check at line 142 drops omp.
- [ ] Mirror the existing pi case in that file; add only the omp case.

Final check (no extra task): flow-owned quality gates run afterwards.
