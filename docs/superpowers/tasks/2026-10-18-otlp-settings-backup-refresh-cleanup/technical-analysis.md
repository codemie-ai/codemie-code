# Technical Research

**Task**: claude-code-otlp, proxy connect, settings backup, connectors
**Generated**: 2026-10-18
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-15375 bug fix. settings.json.codemie-backup (for `codemie proxy connect/disconnect --claude-code-otlp`) is created only once on first connect and never refreshed or cleaned up:
- After disconnect, the backup stays on disk whenever the settings file still has other content.
- A later connect does not refresh the existing backup.
- When a later disconnect leaves the settings file empty, the outdated backup is restored, bringing back values the user deliberately changed or removed after the original connect.

Root cause per the ticket: in `src/cli/commands/proxy/connectors/claude-code-otlp.ts`, the backup is created only if none exists yet (in `writeClaudeCodeOtlpConfig`), and `removeClaudeCodeOtlpConfig` restores and deletes it only when the stripped file is empty; otherwise the backup is left behind and reused by later cycles.

Acceptance criteria:
1. The backup is refreshed (or recreated) on each connect that modifies the file.
2. After a successful disconnect, the backup file is removed.
3. Disconnect never restores values that were changed or removed by the user after connect.

---

## 2. Codebase Findings

### Existing Implementations

- `src/cli/commands/proxy/connectors/claude-code-otlp.ts` — the buggy connector. Key pieces:
  - `SETTINGS_BACKUP_SUFFIX = '.codemie-backup'` (line ~107); backup path = `${settingsPath}.codemie-backup`, sitting beside the real `~/.claude/settings.json` (resolved via `getClaudeSettingsPath()` in the allowlist module, always user-level regardless of `--scope`).
  - `writeClaudeCodeOtlpConfig` (lines ~278–292): backup is written only when `!alreadyManaged && !backupCandidateExists`. `alreadyManaged` = true if settings.json already contains a codemie-owned hook command group. If a backup file already exists it is reused verbatim and **never refreshed**, regardless of whether the user hand-edited settings.json since. If already managed but the backup is *missing*, no backup is (re)created at all — there's no "rebuild from stripped current content" branch (unlike the sibling connector, see below).
  - `removeClaudeCodeOtlpConfig` (lines ~450–465): computes `isEmpty = Object.keys(stripped).length === 0` after removing codemie's hook entries/env keys. Only in the `isEmpty` branch does it `readFile(backupPath)` → `writeAtomically(settingsPath, backupContent)` → `unlink(backupPath)`. If stripped settings still have other top-level keys (the common case), the function falls through to a plain `writeAtomically(settingsPath, stripped)` write with **no unlink call anywhere in that branch** — the stale backup is left on disk indefinitely and reused unchanged by the next connect/disconnect cycle.
  - Settings content model: `ClaudeSettings { hooks?: Record<string, unknown>; env?: Record<string, string>; [key: string]: unknown }`. Connector injects hook groups for 12 `HOOK_EVENTS`, each entry marked via `CODEMIE_COMMAND_MARKER` (`hook --agent claude-code-otlp`), plus 9 fixed `CODEMIE_ENV_KEYS` and one dynamic allowlist env key (`CODEMIE_ANALYTICS_PROJECT_FILTER_ENV`). "Stripped is empty" means the user had zero other top-level settings.json content besides what codemie added.
  - Secrets risk: `OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer ${state.gatewayKey}'` is written into `env` on every connect (line ~220). A stale backup can therefore contain an old/rotated gateway bearer token in plaintext, which gets silently restored to the live settings.json on disconnect.

- `src/cli/commands/proxy/connectors/codex-desktop.ts` — **sibling connector with the already-fixed version of this exact bug class**, and the clear reference implementation:
  - `BACKUP_SUFFIX = '.codemie-backup'` (same literal, independently duplicated — no shared constant).
  - `backupIfUnmanaged()` (lines ~122–157) keys the decision on **marker presence in content**, not backup-file presence:
    1. Not yet managed → fresh `copyFile(configPath, backupPath)` (always re-snapshots, overwriting any stale previous backup).
    2. Already managed and backup exists → keep the existing backup untouched (it is the trustworthy pre-CodeMie original).
    3. Already managed but backup missing → **rebuild** the backup by `stripManagedRegions(currentText)` rather than copying current content wholesale — this avoids enshrining CodeMie's own writes (including secrets) as the "original."
  - Carries an explicit doc comment: *"Keyed on marker presence rather than backup presence on purpose... which is the bug the Kimi hook injector's create-once backup has."*
  - `removeCodexDesktopConfig` (lines ~388–449) does surgical strip (`stripManagedRegions`) as the primary removal path, only falling back to raw backup restore when the strip produces unparseable output. Notably it does **not** unlink the backup after a successful strip — cleanup relies on backup staying correct via the marker-based check on the next connect, not on disconnect-time deletion. **This means AC #2 ("remove backup after successful disconnect") is a claude-code-otlp-specific requirement, not mirrored by codex-desktop's own design** — if implemented literally, add an explicit `unlink(backupPath)` after a successful strip in `removeClaudeCodeOtlpConfig`, analogous to the existing isEmpty-branch unlink.

- `src/agents/plugins/kimi/kimi.hook-config-injector.ts` — a **third, independent implementation of the identical bug**: `backupConfig()` (lines ~205–216) skips backup creation if one already exists (same create-once root cause); `restore()` (lines ~174–193) blindly copies backup over config whenever a backup exists, with no emptiness check and no deletion afterward. This is explicitly cited in codex-desktop.ts's own comment as the known anti-pattern. Out of scope for this ticket but worth flagging as a related latent bug.

- `src/cli/commands/proxy/connectors/vscode.ts` — exports shared `writeAtomically(configPath, content)` (temp-file + rename atomic write), reused by both claude-code-otlp.ts and codex-desktop.ts. No backup logic lives here; it is purely the atomic-write primitive.

- Orchestration / entry points:
  - `src/cli/commands/proxy/connect-orchestrator.ts` (~line 49, 655) — `runClaudeCodeOtlp()` calls `writeClaudeCodeOtlpConfig({ force, scope })`.
  - `src/cli/commands/proxy/disconnect-orchestrator.ts` (~line 13, 60–67) — `disconnectClaudeCodeOtlp()` calls `removeClaudeCodeOtlpConfig({ scope })`.
  - `src/cli/commands/proxy/index.ts` (~lines 304–316 connect, ~343–347 disconnect) — Commander flags `--claude-code-otlp`, `--scope <scope>`, `--force`, `--verbose`.
  - `--force` bypasses conflict detection for existing env values/malformed hooks but does **not** affect backup freshness — even with `--force`, a stale backup is kept as-is.
  - `--scope <user|project>`: `project` scope only touches the allowlist env var; full backup create/restore only happens on the non-project-scoped path.

- `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts` — `getClaudeSettingsPath()` resolves `~/.claude/settings.json` via `resolveHomeDir()`; also owns allowlist parse/add/remove (`CODEMIE_ANALYTICS_PROJECT_FILTER_ENV`).

### Architecture and Layers Affected

- **CLI command / orchestration layer**: `connect-orchestrator.ts`, `disconnect-orchestrator.ts`, `index.ts` (flag wiring).
- **Connector layer**: `src/cli/commands/proxy/connectors/*.ts` — per-target config read/merge/write/backup logic (claude-code-otlp, codex-desktop, vscode, and others not touching this bug).
- **Shared connector utility**: `vscode.ts::writeAtomically` — the only cross-connector shared primitive; there is **no shared backup helper/module** across connectors. Each connector independently duplicates the `.codemie-backup` suffix constant and its own create/restore/cleanup logic.
- **Plugin/agent config-injection layer**: `src/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.ts` (settings path + allowlist), and the structurally-identical but separate `kimi.hook-config-injector.ts`.
- **Test layer**: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts`.

### Integration Points

- `claude-code-otlp.ts` → `vscode.ts` (`writeAtomically`)
- `claude-code-otlp.ts` → `../daemon-manager.js` (`readState()` for live proxy url/gatewayKey used to build the OTLP env block)
- `claude-code-otlp.ts` → `@/agents/plugins/claude-code-otlp/claude-code-otlp.allowlist.js` and `.constants.js`
- `claude-code-otlp.ts` → `@/utils/{errors,logger,security}.js` (ConfigurationError, logger, `sanitizeLogArgs`)
- `connect-orchestrator.ts` / `disconnect-orchestrator.ts` → both `connectors/claude-code-otlp.js` and `connectors/codex-desktop.js`
- No other connector imports or reuses claude-code-otlp.ts's backup logic; `codex-desktop.ts` independently duplicates the same pattern via its own module.
- `src/utils/paths.ts` — `resolveHomeDir()` resolves the OS home dir used by `getClaudeSettingsPath`. Note: `getCodemieHome()`/`getCodemiePath()` resolve `~/.codemie` and are **not** used for this backup path — the backup lives beside the real settings.json (`~/.claude/settings.json.codemie-backup`), not under the CodeMie home dir.

### Patterns and Conventions

- Backup suffix convention `.codemie-backup` is a repeated literal string constant per connector, not a shared helper — confirmed via grep (only string-constant matches found, no common module).
- **Established, already-proven-correct convention** (from codex-desktop.ts, with explicit doc-comment rationale): decide whether to (re)snapshot a backup based on **whether the file currently contains our own managed marker**, not on whether a backup file happens to exist. This is the direct fix pattern for AC #1 and #3.
- When managed-but-backup-missing, reconstruct the backup from the *stripped* current content (removing CodeMie's own additions) rather than copying the file wholesale — this is what prevents a stale/secret-bearing backup from being created from CodeMie's own writes.
- Always write settings/config files via `writeAtomically`, never a bare `writeFile`.
- Disconnect should restore from backup only when it is still trustworthy, then delete the backup afterward — codex-desktop does the delete only implicitly (relies on reconstruction on next connect); claude-code-otlp currently deletes only in the `isEmpty` branch and never in the "other content remains" branch — this gap is exactly AC #2.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` — only a tree-listing mention of `mcp/`; no coverage of connectors or backup/restore patterns.
- `.ai-run/guides/integration/external-integrations.md` — documents OTLP hook ingestion as an integration concept but has no section on settings-file backup/restore conventions.
- `.ai-run/guides/development/development-practices.md` — no matches for backup/restore/proxy/connector/otlp.
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` and `docs/ARCHITECTURE-PROXY.md` — no mentions of backup/restore/`.codemie-backup`; `ARCHITECTURE-PROXY.md` only covers allowlist/hook-filtering, not settings backup.
- Guides are effectively silent on this domain — rely on the sibling-connector precedent (codex-desktop.ts) instead.

### Architectural Decisions

- The bug class is already documented and already fixed once, in `codex-desktop.ts:122-157` (`backupIfUnmanaged`), with an explicit doc comment naming the Kimi hook injector's create-once backup as the known anti-pattern.
- A prior task's artifacts record the same rationale as an ADR-like note: `docs/superpowers/tasks/2026-08-18-codex-desktop-proxy-connect/technical-analysis.md:130` and `plan.md:701` — *"The Kimi injector backs up only when no backup exists, so a second connect leaves a stale backup that restores an ancient config. This keys the decision on whether our marker is already in the file instead."*
- No dedicated ADR exists for claude-code-otlp's own backup behavior; the closest decision record is the codex-desktop comment plus that prior task's docs.
- No CHANGELOG/HISTORY entries reference claude-code-otlp backup handling.

### Derived Conventions

See "Patterns and Conventions" above — derived directly from the codex-desktop.ts sibling implementation since no guide covers this domain.

---

## 4. Testing Landscape

### Existing Coverage

- Sole test file: `src/cli/commands/proxy/connectors/__tests__/claude-code-otlp.test.ts` (990 lines), co-located under `__tests__/` next to the source (no top-level `tests/` mirror for this module).
- Covers `writeClaudeCodeOtlpConfig`: fresh install, scope project/user, foreign-settings preservation + first-backup creation, idempotency on rerun with no file, rerun on pre-existing foreign file ("keeps the original backup untouched and avoids duplicate hooks" — line ~227, **explicitly asserts the current buggy stale-backup-reuse behavior as expected**), force-overwrite of conflicting env/malformed hooks, dedup of stale hook groups, empty-string/"{}" file backup, orphaned-event cleanup.
- Covers `removeClaudeCodeOtlpConfig`: noop when no file, strip codemie keys preserving foreign content, mixed hook-group preservation, "restores the backup and deletes it when stripping leaves settings fully empty" (the isEmpty branch), "deletes the settings file when stripping leaves it fully empty and no backup exists", **"does NOT touch the backup when a mixed group leaves foreign content behind" (line ~762) — explicitly asserts the current buggy stale-backup-left-behind behavior (`result.usedBackup` false, backup still `existsSync`) as expected/current**, noop paths, project-scope allowlist entry removal.
- Plus connect+disconnect round-trip regression tests, including one labeled "reproduces the reported bug scenario end-to-end" (line ~890) — but per Thread B's analysis this test only exercises connect → manual edit → reconnect → disconnect while NOT fully empty, and never actually hits the backup-restore branch (PreToolUse hook is still present), so **it does not reproduce the actual data-loss scenario from the ticket**.
- `src/agents/plugins/claude-code-otlp/__tests__/*.test.ts` (allowlist, types, plugin) test unrelated modules — out of scope for this bug.

### Testing Framework and Patterns

- Vitest ^4.1.5, config at `vitest.config.ts`.
- Real filesystem via `node:fs/promises` (`mkdtemp`, `mkdir`, `writeFile`, `readFile`, `realpath`, `rm`) rooted in `os.tmpdir()` — fs is **not** mocked; only `readState`, `resolveProjectRoot`, `resolveHomeDir`, `logger`, `sanitizeLogArgs` are mocked via `vi.mock`.
- `beforeEach` creates fresh temp `projectDir`/`homeDir`; `afterEach` does `vi.resetAllMocks()` plus recursive `rm` cleanup.
- Local inline helpers (`buildExpectedEnv`, `codemieHookGroup`, `readJson`, `readRaw`) — no shared fixture/factory module across connector tests; each `__tests__` file is self-contained.
- Settings fixtures are inline JS objects serialized via `JSON.stringify`, not external fixture files.

### Coverage Gaps (mapped to the 3 acceptance criteria)

1. **AC #1 (refresh backup on each connect)** — explicitly covered as PASSING *current* (buggy) behavior by the "rerun on pre-existing foreign file keeps the original backup untouched" test and the fresh-install idempotency test. No test asserts a backup gets refreshed/updated when underlying settings legitimately changed between connects (disconnect + manual edit + reconnect, or multiple cycles). This scenario is entirely unaddressed from the "should refresh" angle — these existing tests will need to be rewritten once the fix lands.
2. **AC #2 (remove backup after successful disconnect)** — NOT tested as a bug; the existing "does NOT touch the backup when a mixed group leaves foreign content behind" test asserts the opposite (backup-left-behind) as correct, current behavior. Will need to be retargeted to assert cleanup instead.
3. **AC #3 (disconnect never restores values changed/removed after connect)** — no test covers the full repro sequence: connect (creates backup) → disconnect leaves content (backup kept, per bug) → user edits/removes values in the live settings file → connect again (bug: backup not refreshed) → disconnect to empty (bug: restores stale backup, reverting user's edits). The closest test ("reproduces the reported bug scenario end-to-end") never reaches the empty/restore branch at all.
- No test exercises multiple connect/disconnect cycles alternating foreign content presence — the precise sequence needed to prove/disprove the staleness bug.
- No test asserts backup content reflects the CURRENT settings state at time of restore versus the first-ever snapshot — this is the crux of the bug and is untested in either direction.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides `~/.codemie` root for CodeMie's own data; unrelated to the Claude settings/backup path (which lives beside the real `settings.json`, not under `~/.codemie`), but defines the same `resolveHomeDir`/`getCodemieHome` pattern family.
- `CLAUDE_CODE_ENABLE_TELEMETRY`, `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_LOGS_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_EXPORTER`, `OTEL_LOG_TOOL_DETAILS` — the fixed `CODEMIE_ENV_KEYS` set that connect merges into settings.json's `env` block and disconnect strips back out.
- `CODEMIE_ANALYTICS_PROJECT_FILTER` (`CODEMIE_ANALYTICS_PROJECT_FILTER_ENV`) — JSON array of absolute project paths in the same `env` block, managed separately since its value is per-scope.

### Configuration Files

- `~/.claude/settings.json` — the managed file (path resolved via `getClaudeSettingsPath()`, always user-level regardless of `--scope`).
- `~/.claude/settings.json.codemie-backup` — the backup file at the root of this bug.

### Feature Flags and Deployment Concerns

- `--force` (connect) bypasses conflict detection for env/hooks but does not affect backup freshness — cannot be used as a workaround for the bug.
- `--scope <user|project>` — `project` scope only touches the allowlist env var; full backup create/restore logic only runs on the non-project-scoped path.
- No dry-run/debug flag controls backup/restore behavior.
- **Secrets-in-backup risk**: connect writes `OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer ${gatewayKey}'` into settings.json's `env` on every connect. A stale `.codemie-backup` can contain an old/rotated bearer token that gets silently restored in plaintext on disconnect — this compounds the staleness bug with a credential-exposure concern and should be reflected in the fix's test/acceptance criteria.
- No Docker/CI/install-script references to this backup mechanism — purely a CLI runtime concern.

---

## 6. Risk Indicators

- No existing test exercises the full repro sequence for AC #3 (connect → leave-content disconnect → user edit → reconnect-without-refresh → empty disconnect → stale restore) — the current test suite actively asserts the buggy behavior as correct in at least two places (line ~227 "keeps original backup untouched"; line ~762 "does NOT touch the backup when mixed group leaves foreign content") and those tests must be rewritten/retargeted as part of the fix, not just extended.
- Same bug class exists independently in `src/agents/plugins/kimi/kimi.hook-config-injector.ts` (create-once backup, unconditional restore, no cleanup) — out of scope for this ticket but a near-identical latent defect; worth a follow-up ticket note.
- No shared backup helper exists across connectors — claude-code-otlp.ts, codex-desktop.ts, and kimi's injector each duplicate the `.codemie-backup` suffix and logic independently. Fixing claude-code-otlp.ts in isolation (vs. extracting a shared helper) is a scope decision worth surfacing to the complexity assessor.
- Secrets exposure: a stale backup can contain a previously-valid-but-now-rotated OTLP gateway bearer token (`OTEL_EXPORTER_OTLP_HEADERS`), silently restored to the live settings.json on disconnect. The fix should ensure a refreshed/discarded backup also eliminates this exposure window.
- `codex-desktop.ts`'s reference pattern does not implement AC #2 (backup deletion after disconnect) literally — it relies on marker-based reconstruction on the next connect rather than deleting on disconnect. The claude-code-otlp fix needs an explicit `unlink(backupPath)` after a successful non-empty strip, a divergence from the sibling connector's design that should be called out explicitly in the plan.
- `--force` and `--scope` flags do not interact with or bypass the backup bug — no flag-based escape hatch exists today, so the fix must change the core connect/disconnect logic itself.
- Guides (`.ai-run/guides/`) are silent on this domain; all precedent comes from source code (codex-desktop.ts) and a prior task's artifacts (`docs/superpowers/tasks/2026-08-18-codex-desktop-proxy-connect/`), not from maintained documentation — stale-guide risk is low here since there's no guide to go stale, but future fixes to connector backup logic should consider adding this pattern to `.ai-run/guides/architecture/architecture.md`.

---

## 7. Summary for Complexity Assessment

This is a single-file, single-connector bug fix: the root cause and the full affected surface live in `src/cli/commands/proxy/connectors/claude-code-otlp.ts` (two functions: `writeClaudeCodeOtlpConfig` and `removeClaudeCodeOtlpConfig`), invoked by two thin orchestrators (`connect-orchestrator.ts`, `disconnect-orchestrator.ts`) that pass through unchanged. The fix is not novel — a corrected version of the exact same pattern already exists and is proven in the codebase at `codex-desktop.ts::backupIfUnmanaged` (key on marker-presence rather than backup-file-presence; rebuild backup from stripped content when managed-but-missing; always re-snapshot when not yet managed). The main design decision is whether to port that pattern in-place into claude-code-otlp.ts (low effort, consistent with current no-shared-helper convention) or extract a shared backup helper used by both connectors (slightly higher effort, better long-term maintainability, also fixes the identical latent bug in `kimi.hook-config-injector.ts` if extended there — likely out of scope for this ticket unless explicitly requested).

Test coverage posture is the primary source of effort here, not the production code change. The existing 990-line test suite has at least two tests that assert the current buggy behavior as *correct* ("keeps the original backup untouched" and "does NOT touch the backup when a mixed group leaves foreign content") — these must be rewritten, not just supplemented. In addition, no test today reproduces the actual multi-cycle data-loss scenario in the ticket (connect → partial disconnect → user edit → reconnect → full disconnect → stale restore), so new test scenarios covering all three acceptance criteria must be authored from scratch, including a true end-to-end repro of AC #3.

Risk factors to weigh into complexity scoring: (1) a secrets-exposure dimension — stale backups can replay an old OTLP bearer token in plaintext, which argues for being thorough rather than minimal in the fix; (2) a related but out-of-scope duplicate bug in the Kimi hook injector that may tempt scope creep; (3) a design divergence from the sibling connector regarding explicit backup deletion on disconnect (AC #2), which the codex-desktop reference does not implement the same way, meaning the fix cannot be a pure copy-paste of the sibling's logic and needs its own explicit `unlink` call. Overall this reads as a well-bounded Medium complexity task: one source file to fix with a well-understood, already-validated pattern to follow, but a non-trivial test-rewrite burden given that current tests encode the bug as expected behavior.
