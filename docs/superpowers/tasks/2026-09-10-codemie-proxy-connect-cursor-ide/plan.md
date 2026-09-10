# Cursor IDE Connect Stub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real `--cursor-ide` Commander option to `codemie proxy connect` that, when it is the only target passed, prints "Only analytics is supported" and exits cleanly — no daemon, profile, or config-writing side effects.

**Architecture:** Extend the existing unified-target model (`ConnectTargets`, `hasAnyTarget`, `describeTargets`, `TARGET_LIST` in `connect-orchestrator.ts`) with a `cursorIde` field so help text and the real target set never drift, then add one early-return branch inside `connectTargets()` — placed right after the existing `hasAnyTarget()` guard, before any daemon/profile work — that fires only when `cursorIde` is the sole selected target.

**Tech Stack:** TypeScript, Commander, Vitest, chalk (existing project conventions — no new dependencies).

**Requirements source:** inline (no spec.md) — see Acceptance criteria below and the full requirements text carried in this task's `technical-analysis.md`.

**Technical analysis:** `docs/superpowers/tasks/2026-09-10-codemie-proxy-connect-cursor-ide/technical-analysis.md`

## Global Constraints

- Stub only: no real Cursor IDE connector, config writer, or OTLP/analytics integration in this task.
- `--analytics` does not exist and must not be invented here.
- The cursor-ide-only path must never call `resolveSsoProxyConfig` or `ensureDaemon`.
- Commit per task using the repository's existing convention (Conventional Commits per `.ai-run/guides/standards/git-workflow.md`); no commit commands are shown in this plan.
- No task in this plan runs the whole-suite quality gate, manual/browser verification, or code review — the calling flow owns those.

## Acceptance criteria

- [ ] `codemie proxy connect --help` lists `--cursor-ide` alongside the other targets.
- [ ] `codemie proxy connect --cursor-ide` (alone) prints a message containing "Only analytics is supported" and exits with code 0.
- [ ] `codemie proxy connect --cursor-ide` (alone) never calls `resolveSsoProxyConfig` or the daemon lifecycle (`checkStatus`/`spawnDaemon`/`ensureDaemon`).
- [ ] `--cursor-ide` combined with a real target (e.g. `--claude-desktop`) proceeds with the real target's normal flow; the cursor-ide branch is skipped, not an error.
- [ ] `hasAnyTarget`, `describeTargets`, and `TARGET_LIST` all recognize `cursorIde` so `--help`/target-list output and the real target set stay consistent.
- [ ] No `--analytics` flag, real connector, config writer, or OTLP integration is added.

---

### Task 1: Add `cursorIde` to the target model and command wiring

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:56-61` (`ConnectTargets`), `:265-280` (`TARGET_LIST`), `:282-284` (`hasAnyTarget`), `:287-296` (`describeTargets`)
- Modify: `src/cli/commands/proxy/index.ts:33-43` (`UnifiedConnectOptions`), `:290-299` (`.option(...)` chain), `:300-314` (`.action()` body)
- Test: `src/cli/commands/proxy/__tests__/connect-wiring.test.ts`

**Interfaces:**
- Produces: `ConnectTargets.cursorIde?: boolean`, consumed by `hasAnyTarget`, `describeTargets`, and by Task 2's short-circuit branch in `connectTargets()`.

- [ ] **Step 1: Write the failing test**

Add to `connect-wiring.test.ts`, alongside the existing `'unified connect maps target flags to a ConnectTargets set'` test:

```ts
it('unified connect maps --cursor-ide into the ConnectTargets set', async () => {
  const { connectTargets } = await import('../connect-orchestrator.js');
  const { createProxyCommand } = await import('../index.js');

  await createProxyCommand().parseAsync(['connect', '--cursor-ide'], { from: 'user' });

  expect(connectTargets).toHaveBeenCalledWith(
    expect.objectContaining({ targets: expect.objectContaining({ cursorIde: true }) })
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-wiring.test.ts -t "cursor-ide"`
Expected: FAIL — `--cursor-ide` is not a recognized option (Commander throws) or `cursorIde` is `undefined`.

- [ ] **Step 3: Implement**

- `connect-orchestrator.ts`: add `cursorIde?: boolean;` to `ConnectTargets` (line ~61). Add `'  --cursor-ide            Cursor IDE — analytics only for now',` to `TARGET_LIST` (after the `--codex-desktop` line, before the blank line at ~272). Change `hasAnyTarget` to `Boolean(t.claudeDesktop || t.vscode || t.vscodeClaudeCode || t.codexDesktop || t.cursorIde);`. In `describeTargets`, add `if (t.cursorIde) { flags.push('--cursor-ide'); labels.push('Cursor IDE'); }` alongside the other branches.
- `index.ts`: add `cursorIde?: boolean;` to `UnifiedConnectOptions`. Add `.option('--cursor-ide', 'Configure Cursor IDE — analytics only for now')` to the `.option(...)` chain (after `--codex-desktop`, before `--model`). In the `.action()` body's `targets` object, add `cursorIde: Boolean(opts.cursorIde),`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-wiring.test.ts`
Expected: PASS (including the pre-existing tests in this file, unaffected by the new field being optional).

Test-first: yes — connect-wiring test asserting `--cursor-ide` maps to `targets.cursorIde: true`.

---

### Task 2: Short-circuit `connectTargets()` when `cursorIde` is the only target

**Files:**
- Modify: `src/cli/commands/proxy/connect-orchestrator.ts:590-595` (inside `connectTargets()`, immediately after the `hasAnyTarget` guard and before the `--insiders`/`--model` Note branches at `:600-608`)
- Test: `src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`

**Interfaces:**
- Consumes: `ConnectTargets.cursorIde` (Task 1), `hasAnyTarget` (existing).
- Produces: no new exports — this is an internal branch in the existing `connectTargets()` export.

- [ ] **Step 1: Write the failing test**

Add to the `'connectTargets — no-write paths and daemon lifecycle'` describe block in `connect-orchestrator.test.ts`, mirroring the existing `'bare connect: prints the target list...'` test:

```ts
it('--cursor-ide alone prints the analytics-only note and does no daemon/profile work', async () => {
  const { ConfigLoader } = await import('../../../../utils/config.js');
  const { checkStatus, spawnDaemon } = await import('../daemon-manager.js');
  const { connectTargets } = await import('../connect-orchestrator.js');

  await connectTargets({ targets: { cursorIde: true } });

  expect(ConfigLoader.load).not.toHaveBeenCalled();
  expect(checkStatus).not.toHaveBeenCalled();
  expect(spawnDaemon).not.toHaveBeenCalled();
  expect(console_.log()).toHaveBeenCalledWith(expect.stringContaining('Only analytics is supported'));
  expect(process.exitCode).toBe(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts -t "cursor-ide"`
Expected: FAIL — no "Only analytics is supported" message is printed; execution falls through toward `resolveSsoProxyConfig`.

- [ ] **Step 3: Implement**

In `connectTargets()`, right after the `hasAnyTarget` guard (`connect-orchestrator.ts:592-595`) and before the `verbose`/`insiders` Note branches, add:

```ts
if (targets.cursorIde && !targets.claudeDesktop && !targets.vscode && !targets.vscodeClaudeCode && !targets.codexDesktop) {
  console.log(chalk.yellow('Note: Only analytics is supported for --cursor-ide.'));
  return;
}
```

This mirrors the existing `chalk.yellow('Note: ...')` / `console.log` convention used two branches below for `--insiders`/`--model`, and returns before `resolveSsoProxyConfig`/`ensureDaemon` are ever reached. When `cursorIde` is combined with a real target, this condition is false and execution proceeds normally into the real target's flow — the cursor-ide flag is simply inert for this run (no separate warning needed, since `describeTargets`/`hasAnyTarget` already account for it and no connector reads it).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/cli/commands/proxy/__tests__/connect-orchestrator.test.ts`
Expected: PASS (including all pre-existing tests in the file).

Test-first: yes — connect-orchestrator test asserting the cursor-ide-only short-circuit prints the note and skips `ConfigLoader.load`/`checkStatus`/`spawnDaemon`.

---

## Negative-constraint pass

- "No real Cursor IDE connector/config writer/OTLP integration in this task" — honored: Task 1 only touches the target-model plumbing (types, help text, target-detection functions) and Task 2 only adds a `console.log` + `return`; neither task creates a file under `connectors/` or touches telemetry/OTel code.
- "`--analytics` does not exist and is out of scope" — honored: no task adds an `--analytics` option, field, or reference anywhere; Task 2's message is a static string, not conditioned on any analytics flag.
- "Cursor-ide-only path must never call `resolveSsoProxyConfig`/`ensureDaemon`" — honored and test-covered: Task 2's branch returns before the `resolveSsoProxyConfig` call at `connect-orchestrator.ts:627`, and its test explicitly asserts `ConfigLoader.load`/`checkStatus`/`spawnDaemon` are not called.
- Docs (`docs/ARCHITECTURE-PROXY.md`, `.ai-run/guides/integration/exposed-api.md`): checked both; neither contains a discrete "supported connect targets" list to extend without a disproportionate restructure (`exposed-api.md` has no matching content at all; `ARCHITECTURE-PROXY.md`'s target-related mentions are embedded in larger daemon/telemetry sections). Judged out of scope to keep this a small, single-file-cluster change per the requirements' own instruction to keep changes small — no doc task added.
