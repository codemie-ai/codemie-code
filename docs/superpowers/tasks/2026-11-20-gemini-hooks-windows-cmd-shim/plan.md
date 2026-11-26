# Gemini hooks cmd.exe windows (EPMCDME-16975) Implementation Plan

**Goal:** On win32, heal installed hook commands that use the extensionless codemie shim to the `.cmd` shim (all hosts), at launch via the existing `localizeInstalledHooks`, and once at startup via migration 012 for every provider.

**Architecture:** One shared helper in `src/utils/hook-command.ts` owns the `.cmd` rule, used by `resolveBinary` and `resolveHookCommand`. Migration 012 extends the 006 class like 008 does. No `"shell"` change, no `hookHost` change.

**Conventions:** Vitest, written first (`.ai-run/guides/testing/testing-patterns.md`); `.js` import extensions. Commit per task using the repository's existing convention (Conventional Commits, allowed scopes only, ticket EPMCDME-16975 in the footer, not the subject). No push, no PR. Branch: EPMCDME-16975_gemini-hooks-windows-shell.

---

### Task 1: Shared `.cmd` shim helper and healing in `resolveHookCommand`

**Files:** modify `src/utils/hook-command.ts`; extend `src/utils/__tests__/hook-command.test.ts`.

- Test-first: yes — on win32 (mock `process.platform`), `resolveHookCommand('C:/npm/codemie hook', bin)` with `C:/npm/codemie` and `C:/npm/codemie.cmd` existing still returns the extensionless command; expected `C:/npm/codemie.cmd hook`.

- [ ] Add tests (existing mocking style, `:35-69`): extensionless to `.cmd`; quoted head `"C:/Program Files/npm/codemie" hook` becomes `"C:/Program Files/npm/codemie.cmd" hook` (`.cmd` inside the quotes); with `powershell=true` the `& ` prefix and `"shell": "powershell"` pin are kept (via `rewriteHooksCommandTree`); already `.cmd` returns the identical string (idempotence); no `.cmd` beside the shim leaves the command unchanged; non-win32 unchanged; Claude-shaped command on win32 is healed (intended) while the pin tests at `:59-69` still pass unchanged.
- [ ] Run the new tests; confirm they fail.
- [ ] Add exported-internal helper `toCmdShim(p: string): string` near `quoteIfNeeded` (`:59`): returns `${p}.cmd` when `process.platform === 'win32'`, `!extname(p)`, and `existsSync(`${p}.cmd`)`; otherwise `p`. Replace the inline check at `resolveBinary` (`:87-90`) with it.
- [ ] In `resolveHookCommand` (`:177-178`, the final return), when the head is a single path (not the node+script form) and `toCmdShim(last) !== last`, rebuild the head with the `.cmd` path inside the original quoting and return `render(newHead) + rest`. Leave the stale branch (`:173-176`) first so a missing extensionless file is still re-resolved.
- [ ] Run `hook-command.test.ts`; all pass. Commit.

### Task 2: Installer-level win32 Gemini regression guard

**Files:** extend `src/agents/core/extension/__tests__/BaseExtensionInstaller.hooks.test.ts`.

- Test-first: no — characterization of Task 1 through `localizeInstalledHooks` (AC1, AC2, AC3, AC5); it passes once Task 1 lands. The test seeds an installed Gemini-shaped `hooks.json` (six events, extensionless absolute command, `.cmd` file created beside it in a temp dir) and asserts: every command is rewritten to `.cmd hook`; a second call leaves the file bytes and mtime-independent content identical (no rewrite); missing `.cmd` leaves it and does not throw; non-win32 leaves it.

- [ ] Add a win32 describe block reusing the TestInstaller (`:6-74`); mock `process.platform` and restore it in `afterEach`; assert no `"shell"` key is added for the `'other'` host.
- [ ] Run the file; commit.

### Task 3: Migration 012 for Gemini hooks, every provider

**Files:** create `src/migrations/012-heal-gemini-hook-cmd-shim.migration.ts` and `src/migrations/__tests__/012-heal-gemini-hook-cmd-shim.migration.test.ts`; modify `src/migrations/006-resolve-hook-command-paths.migration.ts` (behavior-preserving) and `src/migrations/index.ts:35`.

- Test-first: yes — with win32 mocked and a temp `~/.gemini/extensions/codemie/hooks/hooks.json` holding the extensionless command and an existing `.cmd`, `new HealGeminiHookCmdShimMigration().up()` must return `{ success: true, migrated: true }` with the file rewritten; fails before the class exists.

- [ ] Write tests modelled on the 006 test (`:19-102`, `vi.doMock` of `os` and `processes.js`, temp homes): rewrite on win32; second run returns `success: true`, `reason: 'nothing-to-rewrite'`, and does not write; ENOENT and unreadable file return `success: true`; write failure (EACCES) returns `success: false`, `reason: 'write-failed'`; non-win32 no-op; Claude file is never touched; the written file has no leftover temp file.
- [ ] In 006: change `hookFiles` from `private` to `protected`, and extract its inline `fs.writeFile` (`:46`) into `protected async writeHooks(file, content)` that calls `fs.writeFile` as today. 006/008 behavior and gates stay unchanged; run the existing 006 test to confirm.
- [ ] Create 012: `class HealGeminiHookCmdShimMigration extends RewriteHookCommandPathsMigration` with `id = '012-heal-gemini-hook-cmd-shim'`, a description, `hookFiles()` returning only the Gemini path (reuse the 006 entry, not a new hard-coded copy; import-free by filtering the parent's list on `claude === false`), and `writeHooks` override that writes to a temp file in the same directory then `fs.rename`s over the target (arch-review RUN-1: avoids a torn read by Gemini mid-write), removing the temp file on failure. Register with `MigrationRegistry.register(...)`.
- [ ] Add `import './012-heal-gemini-hook-cmd-shim.migration.js';` after `:35` in `index.ts`.
- [ ] Run the migration tests and the 006 test; commit.

---

## Notes for the reviewer

- AC7 (manual Windows `codemie-gemini` run) is the only check of the real symptom, that no window opens. If it fails the spec is reopened, not patched. Additionally the unit tests assert the rewritten command has the exact shape the analysis s.9 reproduction showed window-free: `<abs path>/codemie.cmd hook`, unquoted when the path has no special characters.
- Negative constraints honored: no `"shell"` for Gemini (T1 asserts none added, NG2); Claude pin unchanged (T1 keeps `:59-69` passing, NG4); 006/008 gates and OTLP connector untouched (T3 only widens visibility and extracts the write, NG); no `defaultAgentHooks` or `beforeRun` change; no Gemini CLI change; no OpenCode change.
- Per spec AC8 the migration returns success on unreadable files and on a missing `.cmd`; architecture review AR-1 flags that as a permanent miss for non-sso/jwt providers. This plan follows the approved spec.
