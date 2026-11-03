# EPMCDME-15375: claude-code-otlp settings backup refresh/cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `codemie proxy connect/disconnect --claude-code-otlp` so `~/.claude/settings.json.codemie-backup` is always fresh at connect time and always cleaned up after a successful disconnect, so disconnect never resurrects values the user changed or removed after connecting.

**Architecture:** Both fixes live entirely inside `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (connector layer). A new internal helper, `stripCodemieManagedContent`, centralizes "remove codemie's hook groups + env keys from a settings object" so both `writeClaudeCodeOtlpConfig` (to rebuild a missing backup without re-copying our own secrets) and `removeClaudeCodeOtlpConfig` (to compute the post-disconnect file) share one implementation. `removeClaudeCodeOtlpConfig` stops doing a blind full-backup restore and instead always derives the final file from current live content, deleting the file when nothing foreign remains.

**Tech Stack:** TypeScript, Node `node:fs`/`node:fs/promises`, Vitest.

**Spec:** `docs/superpowers/tasks/2026-10-18-otlp-settings-backup-refresh-cleanup/technical-analysis.md`

## Clarification assumptions

This task skipped Stage 2 clarifying questions (research gave a clear, proven sibling pattern), but one technical ambiguity surfaced while writing this plan and is recorded here rather than guessed silently:

- **AC #3 cannot be satisfied by freshness + cleanup alone.** The ticket's own repro (steps 5–9) shows that even a *freshly refreshed* backup (captured right before the most recent connect) can still contain a value (`STEP: B`) that the user explicitly deletes *after* that connect and *before* the final disconnect. The ticket's root-cause note only calls out "backup not refreshed" and "backup not cleaned up", but its own "Expected" column for step 9 ("File is empty/deleted; no outdated values restored") is incompatible with ever restoring *any* backup content at disconnect time, however fresh.
  - **Decision taken:** `removeClaudeCodeOtlpConfig` no longer restores raw backup bytes at all. It always derives the result from the *current* live settings file (surgical strip, same as the existing non-empty branch), and deletes the file outright when nothing foreign remains instead of restoring the backup. This mirrors the already-reviewed `codex-desktop.ts::removeCodexDesktopConfig`, where a full-backup restore is only ever a corruption fallback, never the normal-path mechanic — and `claude-code-otlp.ts` has no equivalent corruption case (invalid JSON is rejected earlier, in `readSettingsFile`).
  - **Consequence:** the `usedBackup` field on `RemoveClaudeCodeOtlpResult` can never be `true` again, so it is removed (see Task 2) along with the now-dead "Restored the pre-connect backup" warning in `disconnect-orchestrator.ts` (see Task 3).

## Global Constraints

- ES modules; relative imports use the `.js` extension (`claude-code-otlp.ts` already follows this).
- No `any`; explicit return types on exported functions (existing file convention).
- All settings-file writes go through `writeAtomically` (`./vscode.js`) — never a bare `writeFile`.
- Logging uses `logger` + `sanitizeLogArgs`, never raw `console.log`/secrets (existing file convention; the OTLP bearer token in `env.OTEL_EXPORTER_OTLP_HEADERS` must never be logged raw).
- Tests only on explicit request — the user's ticket plus this plan's "Test-first" lines are that explicit request for this task; do not add tests beyond what each task specifies.

## Review Focus

- **`--scope project` disconnect path** (lines ~374–407, untouched by this fix): must keep behaving identically — allowlist-entry removal never touches the backup file at all.
- **Malformed (non-array) hook event values** passed through unchanged by the new shared strip helper, exactly as the existing "preserves a malformed hook value as-is" test requires.
- **Noop disconnect must not touch a stray backup file.** When `removeClaudeCodeOtlpConfig` finds no codemie-owned entries (`mode: 'noop'`), an existing `.codemie-backup` file next to the settings file must be left completely alone (no unlink) — only a *successful* ('full') disconnect cleans it up.
- **Secrets exposure window.** After a successful disconnect, the backup — which may contain a previous `OTEL_EXPORTER_OTLP_HEADERS` bearer token — must no longer exist on disk (AC #2), closing the plaintext-credential exposure flagged in `technical-analysis.md`.
- **Fresh install with an empty/`{}` existing settings file on connect** (already-covered cases, must keep passing unmodified after the refactor): backup-of-nothing must not throw and must still produce `backupPath` pointing at a readable (even if trivial) backup file.

---

### Task 1: Refresh the connect-side backup based on marker presence, not file existence (AC #1)

**Files:**
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (add internal `stripCodemieManagedContent` helper near `stripCodemieCommandsFromGroups`, lines ~187–200; rewrite the backup block in `writeClaudeCodeOtlpConfig`, lines ~278–292)
- Test: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`

**Interfaces:**
- Produces: `function stripCodemieManagedContent(existing: ClaudeSettings): { stripped: ClaudeSettings; removedHookCommands: boolean; removedEnvKeys: boolean }` — not exported (internal to the module, matching the file's existing convention of not exporting `isHookEntry`/`stripCodemieCommandsFromGroups`/etc.). `stripped` is `{...existing}` with `hooks`/`env` replaced per the same rules `removeClaudeCodeOtlpConfig` currently applies inline (strip codemie commands out of every hook group via the existing `stripCodemieCommandsFromGroups`; delete `CODEMIE_ENV_KEYS` and `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` from `env`; delete the `hooks`/`env` keys entirely if they end up empty). Task 2 consumes this signature as-is.

- [ ] **Step 1: Write the failing tests**

Add to the `writeClaudeCodeOtlpConfig` describe block:

```ts
it('rebuilds a missing backup from stripped content (not a raw copy) when settings are already managed', async () => {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  await mkdir(join(homeDir, '.claude'), { recursive: true });

  // Already managed (has our hook group + our env keys) AND has foreign content,
  // but no backup file exists yet.
  await writeFile(
    settingsPath,
    JSON.stringify(
      {
        theme: 'dark',
        env: { FOO: 'bar', OTEL_LOGS_EXPORTER: 'otlp' },
        hooks: { PreToolUse: [codemieHookGroup(), { matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      },
      null, 2
    )
  );

  const result = await writeClaudeCodeOtlpConfig();

  expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
  const backup = await readJson(result.backupPath!);
  expect(backup.theme).toBe('dark');
  expect(backup.env).toEqual({ FOO: 'bar' }); // codemie env keys stripped, not copied
  expect(backup.hooks.PreToolUse).toEqual([{ matcher: '', hooks: [{ type: 'command', command: 'echo mine' }] }]);
});

it('refreshes the backup to reflect the latest pre-connect state on reconnect after a disconnect and manual edit', async () => {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  await mkdir(join(homeDir, '.claude'), { recursive: true });
  await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'A' } }, null, 2));

  await writeClaudeCodeOtlpConfig();     // connect #1: backup snapshots STEP: A
  await removeClaudeCodeOtlpConfig();    // disconnect: leaves { env: { STEP: 'A' } }, backup removed
  await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2)); // manual edit

  const result = await writeClaudeCodeOtlpConfig(); // connect #2

  expect(result.backupPath).toBe(settingsPath + SETTINGS_BACKUP_SUFFIX);
  expect(await readJson(result.backupPath!)).toEqual({ env: { STEP: 'B' } });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts -t "rebuilds a missing backup|refreshes the backup"`
Expected: both FAIL — the first because today's code copies the whole file (including codemie env keys) into the backup instead of stripping it; the second because `removeClaudeCodeOtlpConfig` currently never deletes the backup from connect #1, so connect #2 reuses the stale `STEP: A` snapshot instead of taking a fresh one.

Note: the second test will only go fully green once Task 2's disconnect-side fix lands too (it exercises both `writeClaudeCodeOtlpConfig` and `removeClaudeCodeOtlpConfig`). That is expected — land Task 1 first, confirm Task 1's own new assertions compile and the first new test passes, then keep this second test red until Task 2 is done, per TDD red→green across the two tasks.

- [ ] **Step 3: Implement `stripCodemieManagedContent` and the new backup decision in `writeClaudeCodeOtlpConfig`**

`stripCodemieManagedContent`: build the `stripped: ClaudeSettings` object by porting the existing inline logic at lines ~409–448 of `removeClaudeCodeOtlpConfig` verbatim (iterate `existing.hooks` through `stripCodemieCommandsFromGroups`, tracking `removedHookCommands`; delete `CODEMIE_ENV_KEYS` + `CODEMIE_ANALYTICS_PROJECT_FILTER_ENV` from a copy of `existing.env`, tracking `removedEnvKeys`; drop `hooks`/`env` from the result if they end up with zero keys).

Replace the backup block in `writeClaudeCodeOtlpConfig` (lines ~278–292):

```ts
let backupPath: string | null = null;
if (existsSync(settingsPath)) {
  const backupPathCandidate = settingsPath + SETTINGS_BACKUP_SUFFIX;
  const alreadyManaged = Object.values(existingHooksBlock).some(
    (entries) => Array.isArray(entries) && entries.some(groupContainsCodemieCommand)
  );
  if (alreadyManaged) {
    if (existsSync(backupPathCandidate)) {
      backupPath = backupPathCandidate; // trustworthy pre-connect snapshot; do not touch it
    } else {
      const { stripped } = stripCodemieManagedContent(existing);
      await writeAtomically(backupPathCandidate, JSON.stringify(stripped, null, 2) + '\n');
      backupPath = backupPathCandidate;
    }
  } else {
    await copyFile(settingsPath, backupPathCandidate); // always (re)snapshot: overwrite any stale previous backup
    backupPath = backupPathCandidate;
  }
}
```

(`existingHooksBlock` and `existing` are already in scope above this block — no other changes to the surrounding function.)

- [ ] **Step 4: Run the full connector test file**

Run: `npm run test -- src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`
Expected: the new "rebuilds a missing backup..." test PASSES. The new "refreshes the backup..." test still FAILS (expected — Task 2 not done yet). All pre-existing tests in the `writeClaudeCodeOtlpConfig` describe block (including "is idempotent for a fresh install" and "rerunning on a pre-existing foreign file keeps the original backup untouched") still PASS unmodified — both describe a same-cycle rerun with no disconnect/edit in between, which still hits the "already managed and backup exists → keep as-is" branch.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/proxy/connectors/claude-code-otlp.ts src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts
git commit -m "fix(proxy): refresh claude-code-otlp settings backup on each connect"
```

---

### Task 2: Stop restoring raw backup bytes on disconnect; always derive from live content and clean up the backup (AC #2 + AC #3)

**Files:**
- Modify: `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (rewrite `removeClaudeCodeOtlpConfig`'s strip/write/backup logic, lines ~409–469; remove `usedBackup` from `RemoveClaudeCodeOtlpResult`, lines ~46–56)
- Test: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`

**Interfaces:**
- Consumes: `stripCodemieManagedContent` from Task 1 — call signature exactly as produced there.
- Produces: `RemoveClaudeCodeOtlpResult` with the `usedBackup` field removed (`removed`, `path`, `mode`, `reason?`, `allowlist?` only). Task 3 consumes this narrowed shape.

- [ ] **Step 1: Write the failing tests**

Retarget (rename + change body of) the test at ~line 639, `'restores the backup and deletes it when stripping leaves the settings fully empty'`, to:

```ts
it('deletes the settings file without restoring backup content, and removes the backup, when stripping leaves settings fully empty', async () => {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
  await mkdir(join(homeDir, '.claude'), { recursive: true });

  // A backup exists holding an OLD value the user has since removed — it must
  // never come back, even though it's the only backup available.
  await writeFile(backupPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2));

  const codemieOnlyEnv = CODEMIE_ENV_KEYS.reduce<Record<string, string>>((acc, key) => {
    acc[key] = 'whatever';
    return acc;
  }, {});
  await writeFile(
    settingsPath,
    JSON.stringify(
      { env: codemieOnlyEnv, hooks: { PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` }] }] } },
      null, 2
    )
  );

  const result = await removeClaudeCodeOtlpConfig();

  expect(result).toEqual({ mode: 'full', removed: true, path: settingsPath });
  expect(existsSync(settingsPath)).toBe(false);
  expect(existsSync(backupPath)).toBe(false);
});
```

Retarget the test at ~line 762, `'does NOT touch the backup when a mixed group leaves foreign content behind (settings not fully empty)'`, to:

```ts
it('removes the backup once disconnect succeeds, even when foreign content remains', async () => {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
  await mkdir(join(homeDir, '.claude'), { recursive: true });

  await writeFile(backupPath, JSON.stringify({}, null, 2));

  const mixedGroup = {
    matcher: '',
    hooks: [
      { type: 'command', command: `codemie ${CODEMIE_COMMAND_MARKER}` },
      { type: 'command', command: 'echo my-own-hook' },
    ],
  };
  await writeFile(settingsPath, JSON.stringify({ hooks: { PreToolUse: [mixedGroup] } }, null, 2));

  const result = await removeClaudeCodeOtlpConfig();

  expect(result.removed).toBe(true);
  expect(existsSync(backupPath)).toBe(false);
});
```

Add a new end-to-end regression test reproducing the exact ticket repro steps:

```ts
it('reproduces EPMCDME-15375: never restores a value the user removed after the latest connect', async () => {
  const settingsPath = join(homeDir, '.claude', 'settings.json');
  const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;

  await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'A' } }, null, 2));
  await writeClaudeCodeOtlpConfig();                                         // connect #1
  await removeClaudeCodeOtlpConfig();                                        // disconnect: leaves STEP:A, backup gone
  await writeFile(settingsPath, JSON.stringify({ env: { STEP: 'B' } }, null, 2)); // manual edit
  await writeClaudeCodeOtlpConfig();                                         // connect #2: backup now snapshots STEP:B

  // User deletes STEP themselves, leaving only codemie's own keys.
  const beforeFinalDisconnect = await readJson(settingsPath);
  delete beforeFinalDisconnect.env.STEP;
  await writeFile(settingsPath, JSON.stringify(beforeFinalDisconnect, null, 2));

  await removeClaudeCodeOtlpConfig();                                        // final disconnect

  expect(existsSync(settingsPath)).toBe(false); // nothing foreign remained -> file deleted, not restored
  expect(existsSync(backupPath)).toBe(false);
});
```

Update the two `usedBackup: ...` fields out of every existing `toEqual({...})` result assertion in this file's `removeClaudeCodeOtlpConfig` describe blocks (the noop-path and entry-removed-path assertions at lines ~582, 589, 618, 692, 807, 819, 835, 848, 861 — drop `usedBackup: false,` from each expected object; `result.usedBackup` is no longer a field on the type).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`
Expected: the two retargeted tests and the new EPMCDME-15375 test FAIL against current code (today it restores backup content / leaves the backup file / still returns `usedBackup`). The Task-1 "refreshes the backup..." test (still red from Task 1) is expected to stay red until this step's implementation lands, then go green in Step 4.

- [ ] **Step 3: Implement the new disconnect logic**

Remove `usedBackup: boolean;` from `RemoveClaudeCodeOtlpResult` (lines ~46–56). Replace lines ~409–469 of `removeClaudeCodeOtlpConfig`:

```ts
const { stripped, removedHookCommands, removedEnvKeys } = stripCodemieManagedContent(existing);

if (!removedHookCommands && !removedEnvKeys) {
  return { removed: false, path: settingsPath, mode: 'noop', reason: 'no CodeMie entries found' };
}

const backupPath = settingsPath + SETTINGS_BACKUP_SUFFIX;
const isEmpty = Object.keys(stripped).length === 0;

if (isEmpty) {
  await unlink(settingsPath);
} else {
  await writeAtomically(settingsPath, JSON.stringify(stripped, null, 2) + '\n');
}
if (existsSync(backupPath)) {
  await unlink(backupPath);
}

logger.info('[proxy] Removed Claude Code analytics entries from settings', ...sanitizeLogArgs({ settingsPath, deleted: isEmpty }));
return { removed: true, path: settingsPath, mode: 'full' };
```

Remove every other `usedBackup: ...` key from this function's remaining return statements (the `noop`/`entry-removed` early returns above this block, lines ~369, ~385, ~393, ~404).

- [ ] **Step 4: Run the full connector test file**

Run: `npm run test -- src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`
Expected: all tests PASS, including both Task 1 tests and all three tests from this task's Step 1.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors — confirms no other file in `src/` still reads `.usedBackup` off a `RemoveClaudeCodeOtlpResult`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/proxy/connectors/claude-code-otlp.ts src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts
git commit -m "fix(proxy): never restore stale claude-code-otlp settings backup on disconnect"
```

---

### Task 3: Remove the now-dead "restored backup" warning from the disconnect CLI output

**Files:**
- Modify: `src/cli/commands/proxy/disconnect-orchestrator.ts` (lines ~79–84, `disconnectClaudeCodeOtlp`)
- Test: `src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`

**Interfaces:**
- Consumes: `RemoveClaudeCodeOtlpResult` from Task 2 (no `usedBackup` field).

- [ ] **Step 1: Write the failing test**

Replace the test at ~line 83, `'warns when the backup was restored'` (its mocked result — `usedBackup: true` — can no longer occur, per Task 2), with:

```ts
it('does not print a restored-backup warning (claude-code-otlp never restores backup content)', async () => {
  vi.doMock('../connectors/claude-code-otlp.js', () => ({
    removeClaudeCodeOtlpConfig: vi.fn().mockResolvedValue({ removed: true, path: settingsPath, mode: 'full' }),
  }));
  const { disconnectTargets } = await import('../disconnect-orchestrator.js');

  await disconnectTargets({ targets: { claudeCodeOtlp: true } });

  expect(consoleLogSpy).toHaveBeenCalledWith(expect.stringContaining('Claude Code OTLP disconnected'));
  expect(consoleLogSpy).not.toHaveBeenCalledWith(expect.stringContaining('Restored the pre-connect backup'));
});
```

Also drop `usedBackup: false,`/`usedBackup: true,` from the other mocked `removeClaudeCodeOtlpConfig` results in this describe block (lines ~73, ~96) to match the narrowed type.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts -t "does not print a restored-backup warning"`
Expected: FAIL — `disconnectClaudeCodeOtlp` still has dead `if (result.usedBackup)` code, but since `usedBackup` is now `undefined` on the mocked result (TypeScript would already reject the old field at compile time once Task 2's type change lands — this test is really guarding against the console message path being left reachable by some other means).

- [ ] **Step 3: Remove the dead branch**

In `disconnectClaudeCodeOtlp` (`disconnect-orchestrator.ts`), delete:

```ts
    if (result.usedBackup) {
      console.log(chalk.yellow(
        "⚠ Restored the pre-connect backup because CodeMie's entries were the file's only content."
      ));
    }
```

leaving the `console.log(chalk.green(\`✓ Claude Code OTLP disconnected (${result.path})\`));` line immediately followed by the function's closing brace. (The sibling `disconnectCodexDesktop`'s own `usedBackup` warning at lines ~46–50 is untouched — `codex-desktop.ts`'s corruption-fallback restore is unrelated to this fix.)

- [ ] **Step 4: Run the full orchestrator test file**

Run: `npm run test -- src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts`
Expected: all tests PASS.

- [ ] **Step 5: Run typecheck and the full proxy test directory**

Run: `npm run typecheck && npm run test -- src/cli/commands/proxy`
Expected: no errors; all proxy connector/orchestrator tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/proxy/disconnect-orchestrator.ts src/cli/commands/proxy/__tests__/disconnect-orchestrator.test.ts
git commit -m "chore(proxy): drop dead restored-backup warning for claude-code-otlp disconnect"
```

---

## Out of scope (explicit)

- No shared backup helper extracted across connectors (`codex-desktop.ts` keeps its own independent `backupIfUnmanaged`).
- `src/agents/plugins/kimi/kimi.hook-config-injector.ts`'s identical latent bug (create-once backup, unconditional restore, no cleanup) is **not** touched — flagged in `technical-analysis.md` as a follow-up ticket candidate only.
