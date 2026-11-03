# Technical Research

**Task**: copilot-otlp analytics-gate connector-scope project-allowlist proxy-cli
**Generated**: 2026-10-29T00:00:00Z
**Research path**: filesystem (codegraph MCP not present in this environment)

---

## 1. Original Context

Додати механізм аналітики "disable/enable/exclude/include/status" (паралельний до вже реалізованого для Claude Code в EPMCDME-16396, PR #711, гілка EPMCDME-16396_analytics-disable) для двох Copilot OTLP-коннекторів: copilot-cli-otlp і copilot-chat-otlp.

ВАЛІДОВАНИЙ ДИЗАЙН (вже перевірено на сумісність у попередній розмові — досліди деталі реалізації, підтвердь чи спростуй припущення нижче з посиланнями на конкретні рядки коду, не вигадуй дизайн з нуля):

1. Новий окремий CodeMie-owned файл `copilot-analytics.json` (через `getCodemiePath`), keyed по connectorId (та ж схема ключування, що й `copilot-connectors.json`): `{ version, connectors: { [connectorId]: { enabled: boolean, excludedProjects: string[] } } }`. Відсутній запис/файл = `enabled:true, excludedProjects:[]`. Корумпований файл -> fail-closed на hook-шляху; CLI-записи відмовляються перезаписувати корумпований файл. Атомарний запис (temp+rename) — той самий підхід, що в `src/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.ts` і `src/agents/core/copilot-connector-scope.ts`.

КРИТИЧНО: НЕ додавати `excludedProjects` всередину існуючого `CopilotConnectorScope` (`src/agents/core/copilot-connector-scope.ts`) — це ламалось би при звичайному `connect --copilot-cli-otlp`/`--copilot-chat-otlp` (без `--scope project`), бо `resolveScope()` в обох `connectors/copilot-*-otlp.ts` завжди повертає свіжий літерал `{ enabled: true, scope: 'user' }` без збереження попереднього стану. Новий файл має бути повністю окремим і недоторканим для `connect`/`disconnect`/`resolveScope`.

2. Новий `evaluateCopilotAnalyticsGate(connectorId, cwd)` (аналог `src/agents/plugins/claude-code-otlp/claude-code-otlp.gate.ts`): читає нові preferences (corrupt -> blocked, disabled -> blocked, excluded -> blocked через `isPathInside`/`canonicalizePath`/`comparable` з `@/agents/core/project-allowlist.js`), і лише потім делегує існуючому `isCopilotProjectTracked(cwd, await readCopilotConnectorScope(connectorId))` — без жодної зміни самого `isCopilotProjectTracked`/`readCopilotConnectorScope`/`writeCopilotConnectorScope`.

3. Точки підміни в `isTracked()`:
   - `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts` (~рядок 50) — ЗБЕРЕГТИ існуючий guard `if (process.env.CODEMIE_SESSION_ID) return false;` ПЕРЕД новим gate.
   - `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts` (~рядок 40) — ЗБЕРЕГТИ існуючий `hasRequiredIdentity(hookInput)` guard, новий gate додається, не замінює.

4. ДИЗАЙН-РІШЕННЯ (знайдена прогалина): `onUntrackedHook()` в `copilot-chat-otlp.plugin.ts` (~рядки 48-74) окремо перечитує `readCopilotConnectorScope` і будує block-повідомлення для `ENFORCED_EVENTS` (SessionStart/UserPromptSubmit/PreToolUse). Коли новий gate блокує через "disabled"/"excluded", `evaluate()` ніколи не викликається, але `onUntrackedHook()` викликається — і зараз не знає про нову причину. Дослідити точну поточну логіку й запропонувати, як розширити повідомлення без ламання існуючих тестів цього методу.

5. CLI: той самий `codemie proxy analytics` (`src/cli/commands/proxy/analytics-command.ts`), додати прапорці `--claude-code-otlp`/`--copilot-cli-otlp`/`--copilot-chat-otlp` (ТІ Ж САМІ назви констант `*_AGENT_NAME`, що вже використовує `connect`/`disconnect` в `src/cli/commands/proxy/index.ts`). Без прапорця — дефолт `claude-code-otlp` (нуль breaking changes).

6. Edge cases й тести, які треба покрити з самого початку (НЕ повторювати баги, знайдені в ревʼю PR #711 для Claude-реалізації):
   - `exclude`/`include` порівнювати через `comparable()`/`isPathInside()`, не точним рядком (CR-003).
   - `include` перевіряє covering-parent ПІСЛЯ видалення зі списку (баг знайдений 29.10, вже виправлений для Claude в `src/cli/commands/proxy/analytics-command.ts` — перенести вже виправлену версію логіки).
   - `exclude` шляху, вже покритого батьківським записом -> "Nothing to change", без redundant entry; `exclude` батьківського -> прибирає тепер-зайві дочірні записи.
   - corrupt-config fail-closed на hook-шляху; CLI-запис відмовляється перезаписувати.
   - sibling-prefix, trailing slash, cwd undefined, double-exclude ідемпотентність, case-insensitive matching (Win/macOS).
   - `status`/`--json`/реєстрація підкоманд МАЮТЬ бути протестовані одразу (CR-004).
   - для `copilot-cli-otlp`: тест `CODEMIE_SESSION_ID` має бути змістовним (реально показувати різну поведінку), на відміну від Claude, де аналогічний тест правильно зроблено тавтологічним (бо `claude-code-otlp` взагалі не читає цю змінну).

7. Обмеження (НЕ торкатись): `OtlpAgentAdapter.processOtlpEvent`, daemon/spool/completeness-gate, backup/strip/merge логіка в `connectors/copilot-*.ts`, самі hook-файли (`codemie-copilot-cli-hooks.json`, VS Code settings.json hook wiring), існуючі `resolveScope`/`writeCopilotConnectorScope`/`isCopilotProjectTracked`.

Контекст: продовження гілки `EPMCDME-16396_analytics-disable` (та ж, де вже реалізовано Claude-механізм і виправлено 2 PR review finding — коміт `0309ed65`). Головний критерій: нічого не зламати в існуючих флоу (Claude analytics, Copilot connect/disconnect, daemon/spool).

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.ts` — reference preferences store at `getCodemiePath('claude-analytics.json')`; `ClaudeAnalyticsPreferences { version, enabled, excludedProjects }` (L20-24), `DEFAULT_CLAUDE_ANALYTICS_PREFERENCES` (L26-30); `readClaudeAnalyticsPreferences` never throws, returns `{kind:'ok'|'corrupt'}` (L66-101); `updateClaudeAnalyticsPreferences` throws `ConfigurationError` on corrupt, else atomic temp+rename write (L108-131); `isProjectExcluded` uses `canonicalizePath`/`isPathInside` (L134-145). **Single-connector shape — not keyed.**
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.gate.ts` — `evaluateClaudeAnalyticsGate(cwd)` (L24-39): precedence `preferences-corrupt > disabled > project-excluded > not-in-allowlist > tracked`; delegates to `isProjectTracked(cwd, readAllowlistState())`. Only 36 lines — the exact template to replicate per Copilot adapter.
- `src/agents/core/copilot-connector-scope.ts` — `CopilotConnectorScope = {enabled:false} | {enabled:true,scope:'user'} | {enabled:true,scope:'project',paths:string[]}` (L22-25); `CopilotConnectorsFile = {version, connectors: Record<connectorId, CopilotConnectorScope>}` (L29-32) — **this is the exact keyed-by-connectorId shape the new `copilot-analytics.json` must mirror**; `getCopilotConnectorsConfigPath()` → `getCodemiePath('copilot-connectors.json')` (L34-36); `readCopilotConnectorScope` (L66-107); `writeCopilotConnectorScope` merge-write preserving sibling connectors, refuses corrupt file, atomic temp+rename (L115-159); `isCopilotProjectTracked(cwd, scope)` (L165-185). **No `excludedProjects` field exists today** — confirms the "must not add it here" constraint.
- `src/agents/core/project-allowlist.ts` — shared helpers reused everywhere: `canonicalizePath` (L64-72, realpath + strip trailing separators, try/catch falls back to `resolve()` so it cannot throw), `comparable` (L75-77, lowercases only on win32/darwin), `isPathInside` (L80-83, uses `node:path.relative`, never substring match), plus `isProjectTracked`, `addProjectPath`, `removeProjectPath`.
- `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts` — `isTracked()` at **L50-58**: `CODEMIE_SESSION_ID` guard at L54-56 (real divergent behavior — a managed launch sets this env var for its own child process; native invocations never carry it; without the guard, managed sessions would be double-counted by both pipelines), then `isCopilotProjectTracked(input.cwd, await readCopilotConnectorScope(this.name))` at L57. **No `onUntrackedHook` override exists** — relies on base no-op, so CLI enforced events (`userPromptTransformed`, `preToolUse`) currently get zero feedback on any untracked reason.
- `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts` — `isTracked()` at **L40-46**: single composite condition `scope.kind==='corrupt' || !scope.value.enabled || !this.hasRequiredIdentity(hookInput)` at L42, then `isCopilotProjectTracked(...)`. `onUntrackedHook()` at **L48-76**: no-op for non-`ENFORCED_EVENTS` (L49-51); re-reads `readCopilotConnectorScope` independently (L53); corrupt → block message "connector scope configuration is corrupt; repair it and reconnect" (L54-63); `!scope.value.enabled` → **silently returns, no block message at all** (L64-66); otherwise (enabled but `!hasRequiredIdentity`) → block message "required session identity or working directory is missing" (L67-75).
- `src/agents/core/OtlpAgentAdapter.ts` — base class choke point: `processOtlpEvent` (L68-143): `isTracked()` gate at L84; if false → `onUntrackedHook(hookInput)` (L86) then return, `evaluate()` never called. Default `onUntrackedHook` is a no-op (L169). Invariant: `isTracked()` always runs before `ensureOtlpProxy()` — the daemon/SSO/spool are never touched for an untracked hook.
- `src/cli/commands/proxy/analytics-command.ts` — `createProxyAnalyticsCommand()` registers exactly `disable`/`enable`/`exclude [path]`/`include [path]`/`status` (L134-164). Currently hardcoded to Claude Code only (`updateClaudeAnalyticsPreferences`/`getClaudeAnalyticsPreferencesPath`), zero agent-selection flags. `excludeProject` (L55-97) / `includeProject` (L99-128) hold the post-fix (commit `0309ed65`) CR-003/CR-004 logic — see Section 6.
- `src/cli/commands/proxy/index.ts` — `*_AGENT_NAME` constants imported at L26-28; `connect` registers `--${CLAUDE_CODE_OTLP_AGENT_NAME}`/`--${COPILOT_CHAT_OTLP_AGENT_NAME}`/`--${COPILOT_CLI_OTLP_AGENT_NAME}` at L320-322 plus shared `--scope <user|project>` (L323-330); `disconnect` mirrors at L360-362/L363-370; Commander auto-camelCases these to `claudeCodeOtlp`/`copilotChatOtlp`/`copilotCliOtlp` on parsed opts (`UnifiedConnectOptions`, L38-53); `createProxyAnalyticsCommand()` registered at L446 with no flags passed in today.
- `src/cli/commands/proxy/connectors/copilot-cli-otlp.ts` (`resolveScope()` L80-90) and `connectors/copilot-chat-otlp.ts` (`resolveScope()` L164-174) — both confirmed to return a fresh literal `{enabled:true, scope:'user'}` for non-project scope, with no spread of prior state; the `existing` lookup only applies when `opts.scope === 'project'`. This **confirms** the critical "must not add `excludedProjects` to `CopilotConnectorScope`" constraint verbatim.
- `*.constants.ts` files: `CLAUDE_CODE_OTLP_AGENT_NAME='claude-code-otlp'` (claude-code-otlp.constants.ts:2), `COPILOT_CLI_OTLP_AGENT_NAME='copilot-cli-otlp'` (copilot-cli-otlp.constants.ts:2), `COPILOT_CHAT_OTLP_AGENT_NAME='copilot-chat-otlp'` (copilot-chat-otlp.constants.ts:2) — same constants the new analytics flags must reuse.

### Architecture and Layers Affected

- **Storage/persistence layer**: `*.preferences.ts` (Claude, single-connector) / `copilot-connector-scope.ts` (Copilot, keyed-by-connector) — raw JSON read/write with atomic writes. New work adds a Copilot analytics preferences module in this layer.
- **Path/allowlist utility layer**: `project-allowlist.ts` — canonicalization, containment checks, list mutation; shared by all connectors, reused as-is.
- **Gate/decision layer**: `*.gate.ts` (Claude only today) — composes preferences + allowlist into one tracked/blocked decision with a reason enum. New work adds `evaluateCopilotAnalyticsGate` here.
- **Plugin/adapter layer**: `*.plugin.ts` extends `OtlpAgentAdapter`, implements `isTracked()`/`evaluate()`/`onUntrackedHook()`/`onHookError()`. New work wires the new gate into both Copilot plugins' `isTracked()`, and extends `copilot-chat-otlp.plugin.ts`'s `onUntrackedHook()` (and considers adding one to `copilot-cli-otlp.plugin.ts`, currently absent).
- **Base adapter layer**: `OtlpAgentAdapter.ts` — untouched; single choke point enforcing untracked-must-produce-no-side-effects.
- **CLI layer**: `analytics-command.ts` (status/enable/disable/exclude/include) and `proxy/index.ts` (`connect`/`disconnect` option wiring, `*_AGENT_NAME` constants). New work adds agent-selection flags to `analytics-command.ts`.
- **Connector write layer**: `connectors/copilot-cli-otlp.ts` / `connectors/copilot-chat-otlp.ts` — explicitly out of scope, read-only reference for confirming the "fresh literal" constraint.

### Integration Points

- `claude-code-otlp.gate.ts` → `claude-code-otlp.allowlist.ts` (isProjectTracked, readAllowlistState) and → `claude-code-otlp.preferences.ts` (isProjectExcluded, readClaudeAnalyticsPreferences); only importer of the gate module in `src/` besides its own test.
- `claude-code-otlp.preferences.ts` / `copilot-connector-scope.ts` → `@/agents/core/project-allowlist.js` (canonicalizePath, isPathInside), → `@/utils/paths.js` (getCodemiePath), → `@/utils/errors.js`, `@/utils/logger.js`.
- `copilot-cli-otlp.plugin.ts` / `copilot-chat-otlp.plugin.ts` → `@/agents/core/copilot-connector-scope.js` (isCopilotProjectTracked, readCopilotConnectorScope) — no gate module exists yet for Copilot; new work adds this import plus an import of the new gate module.
- `connectors/copilot-*.ts` → `@/agents/core/copilot-connector-scope.js` and → `@/agents/core/project-allowlist.js` — out of scope, untouched.
- `analytics-command.ts` → `@/agents/plugins/claude-code-otlp/claude-code-otlp.preferences.js` and → `@/agents/core/project-allowlist.js` directly; a Copilot-aware command needs analogous imports from a new Copilot preferences module, selected by the new CLI flags.
- `proxy/index.ts` → all three `*.constants.ts` files for `_AGENT_NAME` strings — new analytics flags reuse the same imports.
- External env var: `CODEMIE_HOME` overrides `getCodemiePath`'s root for every CodeMie-owned JSON file, including the new `copilot-analytics.json`.

### Patterns and Conventions

- **Atomic write**: `writeFile(tempPath = path + '.' + process.pid + '.tmp')` then `rename(tempPath, path)`, `unlink(tempPath).catch(() => undefined)` cleanup on error — identical in `claude-code-otlp.preferences.ts` (L120-128) and `copilot-connector-scope.ts` (L150-158). `node:fs/promises`, not fs-extra.
- **Corrupt-file handling**: hook/read path returns `{kind:'corrupt'}` discriminated union, never throws, fails closed. CLI write path throws `ConfigurationError` and refuses to touch bytes on disk when the existing file is corrupt.
- **Merge-write for keyed files**: `writeCopilotConnectorScope` re-reads the whole file, spreads existing `connectors` map, overwrites only the target connectorId key (L117-149) — the new `copilot-analytics.json` writer must follow this exact convention to avoid dropping sibling connectors' records.
- **Gate composition order** (Claude reference, to replicate for Copilot): corrupt → disabled → excluded → delegate to existing tracked/scope check.
- **`isTracked()` substitution pattern**: host-specific guards (session-id / identity checks) run first and are preserved; new gate logic is additive, slotted in between or after, never replacing existing guards.
- **"Fresh literal" scope reset**: `resolveScope()` in both connector files always returns `{enabled:true, scope:'user'}` for non-project scope, discarding any other fields unless `--scope project` — this is exactly why the new analytics file must be fully separate from `CopilotConnectorScope`.
- **CLI constant reuse**: `*_AGENT_NAME` constants shared across `connect`/`disconnect`/(new) `analytics` flags.
- **Per-adapter file set convention** (confirmed via `.ai-run/guides/architecture/architecture.md` L263-271 and `docs/ARCHITECTURE-OTLP-PLUGIN.md`): `<adapter>.gate.ts`, `<adapter>.preferences.ts`, `<adapter>.allowlist.ts` (Claude has its own allowlist; Copilot reuses `project-allowlist.ts` + `copilot-connector-scope.ts` directly — no separate allowlist module needed for Copilot), `<adapter>.constants.ts`.
- **CLI surface convention**: `codemie proxy analytics <disable|enable|exclude|include|status>`; exclude/include take exactly one optional `[path]` argument; `status --json` supported.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` (L263-271) — documents `OtlpAgentAdapter` as a second plugin type registered like `AgentAdapter`, points to `docs/ARCHITECTURE-OTLP-PLUGIN.md` for the dispatch pattern.
- `.ai-run/guides/integration/external-integrations.md` (L268-271, 324-333) — dedicated "OTLP Hook-Event Ingestion" section naming `claude-code-otlp` as the reference implementation; defers deep mechanism to the dedicated OTLP doc (established doc-split convention).
- `docs/ARCHITECTURE-OTLP-PLUGIN.md` — canonical reference. Key points for this task: `isTracked()` always runs before `ensureOtlpProxy()` (§3.5 invariant) — this is exactly the choke point both the existing Claude gate and the new Copilot gate plug into; `evaluate()` contract returns `ForwardDecision` (§3); `forwardOtlpEventsToSpool` is the single shared spool-forward call site, untouched by this work; §39 confirms Copilot Chat and Copilot CLI already exist as full adapters overriding `requiresSpoolAcceptance(input)` for their own enforcement events, so analytics-disable parity work is purely additive per-adapter (gate + preferences files + `isTracked()` wiring), not a base-class change; §6 shows Claude's adapter-owned file pattern as the template to mirror per Copilot adapter; §5 documents the general "adding a new adapter" process (not needed here since both adapters already exist).

### Architectural Decisions

PR #711 review findings and fix commits (exact):

- **CR-001** (round 1, major): two earlier exploratory docs (`specs/2026-10-28-...-investigation.md`, `plans/2026-10-28-...-disable.md`) described a materially different, never-shipped design (personal-subscription/oauthAccount classification) with no in-file "superseded" marker. Fixed in `4b962b0f`.
- **CR-001 round 2**: refuted — `isProjectExcluded()` can't throw (`canonicalizePath()` wraps `realpath()` in try/catch with `resolve()` fallback). Minor nit noted but not actioned (`process.exitCode` not reset in `afterEach`).
- Commit `b68873b4` ("address PR #711 review findings") fixed four CRs:
  - CR-001: added a Global-scope row using the real `[]` allowlist filter `connect --scope user` writes.
  - CR-002: added a native-vs-managed launch dimension to the disable-matrix asserting identical gate decision regardless of `CODEMIE_SESSION_ID`.
  - **CR-003**: exclude/include now compare paths with the same case-insensitive, raw-string-fallback matching the allowlist already uses, instead of exact string equality; include also names the covering parent instead of a generic "Nothing to change."
  - **CR-004**: added test coverage for `status`/`status --json`, five-subcommand registration, and Global/invalid scope mappings.
- Commit `0309ed65` ("close two live PR #711 review findings") — follow-up: exclude/include redundant-nested-entry handling (excluding a path already covered by a parent → "Nothing to change", no duplicate; excluding a parent drops now-redundant children; include re-checks the **post-removal** list so a still-covered subdir is never reported as resumed — this is the exact CR-004 covering-parent-after-removal order to replicate for Copilot from day one); reworded disable-matrix "native vs managed" comments to honestly state the gate never branches on `CODEMIE_SESSION_ID` (pinned invariant, not independent coverage) — **this framing does NOT apply to Copilot**, where `CODEMIE_SESSION_ID` is a real, divergent branch.
- Branch commit history for reference: `9bd1e9e0` (preferences file) → `a488bc8f` (wire gate into isTracked) → `2cbc852a` (CLI disable/enable/exclude/include) → `00e8047e` (CLI status) → `ed199a99` (AC4 regression matrix) → `676dc3fe`/`92f2ad01`/`4b962b0f` (planning docs + supersession fix) → `b68873b4` (CR-001..004 fixes) → `0309ed65` (two more fixes).
- Prior Claude-side plan: `docs/superpowers/tasks/2026-10-28-epmcdme-16396-analytics-disable/plan.md` — 5-task shape (preferences file, gate wired into isTracked, CLI disable/enable/exclude/include, CLI status, AC4 regression matrix + docs) — direct blueprint to repeat per Copilot adapter.
- Documented, twice-accepted scope decision: no automated test spawns a real native binary end-to-end (recorded in plan.md's "Known coverage gap" and mirrored into `docs/superpowers/work-items/EPMCDME-16396.md`) — not to be re-litigated for Copilot parity.
- This run's own task directory (`docs/superpowers/tasks/2026-10-29-epmcdme-16396-copilot-analytics-parity/`) currently contains only `.state.json` (sdlc-light flow marker, phase "main") — no prior plan/spec exists yet; this is a fresh start.

### Derived Conventions

- Doc-hygiene: superseded/obsolete planning docs must carry an in-file "SUPERSEDED — see <path>" banner, not just an external pointer (reinforced by CR-001).
- Git workflow (confirmed pass in both reviews): Conventional Commits `type(scope): subject (EPMCDME-16396 ...)` with AI-generated trailer; ESM `.js` extensions, `@/` alias, no `any`, explicit return types; `sanitizeLogArgs` wraps any new log line that might carry payload data.
- No `NOTE:`/`TODO:`/`HACK:`/`ADR:`/`DECISION:` markers found in `src/agents/plugins/claude-code-otlp/` or `src/agents/core/`.
- CHANGELOG.md `[Unreleased]` currently has no EPMCDME-16396/analytics-disable entry despite the Claude-side feature being implemented and reviewed — worth flagging to the user/planner whether a changelog entry is deferred until final release, and whether Copilot parity should add one at the same time as Claude's.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.preferences.test.ts` — defaults-when-absent/empty, partial-file-fills-defaults, corrupt-JSON/array-root/non-boolean/non-array/non-absolute-path variants → `{kind:'corrupt'}`; atomic update round-trip; corrupt file leaves bytes unchanged + throws; no leftover `.tmp`; `isProjectExcluded` (nested subdir, trailing slash, sibling-prefix false, undefined cwd, empty list).
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.gate.test.ts` — precedence order via mocked preferences/allowlist modules; exclusion wins over allowlist entry covering same path; exclusion applies with allowlist absent; gate is strict superset of `isProjectTracked`; cwd-undefined fallthrough.
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.allowlist.test.ts` — `parseAllowlist`, `inferAllowlistScope`, `isPathInside` real path semantics (not string-prefix), `isProjectTracked`, `addProjectPath`/`removeProjectPath` dedupe.
- `src/cli/commands/proxy/__tests__/analytics-command.test.ts` — full CLI surface, real fs via temp-dir-redirected `getCodemiePath` mock; exclude/include round-trips, CR-003 case-insensitive dedupe (`it.runIf(isCaseInsensitiveFs)`), CR-003 include-of-subdirectory-of-excluded-parent names the parent, CR-004 status/`--json` (exactly one `console.log`, valid JSON), CR-004 subcommand registration exact list check, corrupt-file-on-disable → `process.exitCode===1` + byte-identical file.
- `src/agents/core/__tests__/copilot-connector-scope.test.ts` — existing Copilot scope store tests: fail-closed on absent/empty/corrupt/malformed; per-connector isolation; `isCopilotProjectTracked` for user/project/disabled/corrupt; atomic merge-write preserving sibling connectors.
- `src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts` (L43-65) and `copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts` — cover `isTracked`/guard logic, block-output shapes, secret masking. **Neither has any disable/enable/exclude/include/status test yet** (no feature exists to test).

### Testing Framework and Patterns

- Vitest `^4.1.5`, split via `vitest run --project unit|cli|agent`; `@group unit` docblock tags; `it.each`/`describe.each` table-style; `it.runIf(cond)` for platform-gated cases.
- **fs atomic-write testing**: real `node:fs/promises` against an OS temp dir (`mkdtemp`/`rm` in beforeEach/afterEach); redirect storage path by mocking `@/utils/paths.js`'s `getCodemiePath` to point into tempDir — never mocks `fs` itself, so real atomic-write/tmp-file behavior is exercised; verify no leftover `.tmp` via `readdir`; verify corrupt-file safety via before/after byte-equality.
- **Dynamic-import mocking**: `vi.mock()` hoisted before a dynamic `await import('../module.js')` per test, fresh module instance per mock state; `vi.resetModules()` in beforeEach when needed.
- **Gate-boundary unit tests** mock only the two modules directly below the gate (preferences, allowlist) via `vi.fn()` doubles — isolates precedence logic from real fs. This is the template for the new `copilot-chat-otlp.gate.test.ts`/`copilot-cli-otlp.gate.test.ts`.
- **Matrix/regression tests** (`disable-matrix.test.ts`) mock almost nothing except external I/O, drive the real plugin + real preferences/allowlist end-to-end, `describe.each` crossed with Global/Project scope.
- **Plugin-level tests** mock `@/agents/core/copilot-connector-scope.js` wholesale rather than touching fs — the right template for the new Copilot analytics-gate plugin tests.

### Coverage Gaps

- No `excludedProjects`/preferences concept exists at all for Copilot yet — primary implementation gap before any test can mirror the Claude suite.
- No disable/enable/exclude/include/status tests for either Copilot plugin.
- No CR-003-equivalent comparable/isPathInside test for the (not-yet-existing) Copilot exclude list — though `copilot-connector-scope.test.ts` already proves the project-allowlist helpers work with real path semantics for the existing `paths` field, confirming they should be reused directly, not reimplemented.
- No CR-004-equivalent "subcommand registration + status/--json through real wiring" test for a Copilot analytics CLI surface (doesn't exist yet).
- `copilot-cli-otlp.plugin.ts`'s `CODEMIE_SESSION_ID` guard is already tested meaningfully (L43-65, two tests proving genuinely divergent behavior — one short-circuits, one delegates and asserts the delegate was never called) — this is the correct, non-tautological shape to preserve and extend once the new gate layers on top (verify SESSION_ID still short-circuits before reaching the new exclude-list check).
- `copilot-chat-otlp.plugin.ts` was not confirmed to have an equivalent `CODEMIE_SESSION_ID` guard — its tests only cover `hasRequiredIdentity`/session_id-missing (a different concept). Must verify before assuming parity with `copilot-cli-otlp`.

---

## 5. Configuration and Environment

### Environment Variables

- `CODEMIE_HOME` — overrides the CodeMie home dir root `getCodemiePath` resolves under (`src/utils/paths.ts:368-369`); affects every CodeMie-owned JSON file including the new `copilot-analytics.json`.
- `CODEMIE_SESSION_ID` — read directly by `copilot-cli-otlp.plugin.ts`'s `isTracked()` guard (real divergent behavior, must be preserved before the new gate); not read at all by `claude-code-otlp` (confirmed tautological there); status in `copilot-chat-otlp.plugin.ts` unconfirmed, needs verification.
- `OTLP_ALLOW_HOOKS_ONLY_FORWARD`, `OTLP_ENDED_SESSION_GRACE_MINUTES`, `OTLP_ABANDONED_SESSION_GRACE_MINUTES` — spool/daemon-layer config, out of scope for this task (explicitly excluded in task_context constraint #7).
- No `ANALYTICS_*`-prefixed env vars exist anywhere in the codebase; no env var gates `codemie proxy analytics` itself.

### Configuration Files

- `~/.codemie/claude-analytics.json` (`getCodemiePath('claude-analytics.json')`) — Claude's existing single-connector preferences file; reference shape only, not reused directly (Copilot needs its own keyed file).
- `~/.codemie/copilot-connectors.json` (`getCopilotConnectorsConfigPath()`) — existing Copilot connector-scope store, keyed by connectorId; **this is the exact keying scheme the new `copilot-analytics.json` must mirror**, but the new file must be structurally separate (own module, own file) per the critical design constraint.
- New (not yet created): `~/.codemie/copilot-analytics.json` — per-connector `{enabled, excludedProjects}` records, mirroring `copilot-connectors.json`'s merge-write/atomic/corrupt-refuses-overwrite conventions.

### Feature Flags and Deployment Concerns

- None found specific to analytics enable/disable. No deployment manifests reference this feature area.

---

## 6. Risk Indicators

- No `excludedProjects`/gate concept exists yet for either Copilot connector — this is new, non-trivial per-adapter work (2x gate modules, 2x preferences read paths, 2x `isTracked()` wiring), not a small patch.
- `onUntrackedHook()` gap in `copilot-chat-otlp.plugin.ts` (L48-76): currently silently no-ops (`!scope.value.enabled` branch, L64-66) and has no knowledge of the new gate's "disabled-via-preferences"/"excluded" reasons — if unaddressed, VS Code will get zero feedback on an enforced event (SessionStart/UserPromptSubmit/PreToolUse) blocked for the new reasons, same silent-failure shape already flagged as a pre-existing partial gap.
- `copilot-cli-otlp.plugin.ts` has **no `onUntrackedHook` override at all** — relies on base no-op, so CLI enforced events get zero feedback for any untracked reason today, old or new. Larger pre-existing gap than Chat's; must be explicitly scoped (fix now vs. document as known gap, mirroring the Claude-side "no native binary E2E test" precedent).
- Must not repeat PR #711's two historical bug classes: CR-003 (exact string match instead of `comparable()`/`isPathInside()`) and the `0309ed65` covering-parent-after-removal ordering bug in `include`. Both have an exact, already-fixed reference implementation in `analytics-command.ts` to copy, not reinvent.
- `copilot-chat-otlp.plugin.ts`'s `CODEMIE_SESSION_ID`-guard parity with `copilot-cli-otlp` is unconfirmed — needs a direct grep/read before assuming the same guard exists, otherwise a test claiming parity could be written against a guard that doesn't exist.
- Two connector plugins, two preference files, two gate modules, two sets of CLI flag wiring — roughly double the file-change surface of the already-shipped single-connector Claude feature; risk of inconsistency between the two Copilot adapters if not implemented from one shared template.
- `analytics-command.ts` currently has zero agent-selection validation; adding three mutually-exclusive flags needs new validation logic (reject multiple simultaneous flags) not present anywhere today — `connect-orchestrator.ts`'s first-match-priority pattern (L141-148) is the closest existing precedent but is not a drop-in reuse.
- CHANGELOG.md has no entry yet for the already-shipped Claude-side feature — a process/documentation gap orthogonal to this task but worth surfacing.

---

## 7. Summary for Complexity Assessment

This task touches four architectural layers twice each (once per Copilot connector): storage/persistence (two new preferences read/write modules mirroring `copilot-connector-scope.ts`'s keyed-file conventions), gate/decision (two new `evaluate*AnalyticsGate` functions mirroring the 36-line Claude template almost verbatim), plugin/adapter (wiring into two existing `isTracked()` implementations plus extending one existing `onUntrackedHook()` and potentially adding a new one), and CLI (extending one existing command file with three mutually-exclusive agent-selection flags reusing existing constants). Estimated file-change surface is roughly double the already-shipped single-connector Claude feature: 2 preferences modules, 2 gate modules, 2 plugin wiring changes, 1 CLI command extension, plus matching test files for each — likely 10-14 new/changed files given the Claude precedent's five-task shape (preferences, gate, CLI exclude/include, CLI status, regression matrix) repeated per connector with shared CLI-layer changes.

Technical novelty is low for the gate/preferences mechanics themselves (near-exact copy of an already-reviewed, already-fixed Claude implementation, with a well-documented keyed-file precedent in `copilot-connectors.json` to follow for the connector-keying shape) but moderate for two real integration wrinkles that have no Claude-side analog: (1) the `onUntrackedHook()` message gap in `copilot-chat-otlp.plugin.ts`, which needs new logic to surface the new gate's block reasons without breaking existing corrupt/identity-guard tests, and the complete absence of any `onUntrackedHook` override in `copilot-cli-otlp.plugin.ts`, which raises a scoping question (fix vs. document as a known gap); (2) the `CODEMIE_SESSION_ID` guard in `copilot-cli-otlp.plugin.ts` is a real, non-tautological branch unlike Claude's, so its test must prove actual divergent behavior rather than reuse Claude's "pinned invariant" framing, and the equivalent guard's existence in `copilot-chat-otlp.plugin.ts` is unconfirmed and needs direct verification before writing any parity claims.

Test coverage posture for the surrounding code is strong and the testing conventions are explicit and reusable: `copilot-connector-scope.ts` and both Copilot plugins already have solid existing test suites (fail-closed/corrupt/per-connector-isolation cases, guard-divergence cases) that serve as direct templates, and the Claude-side suite already demonstrates the exact test shapes needed (preferences fs tests via temp-dir path redirection, gate precedence tests via mocked dependencies, CLI tests via real command wiring including CR-003/CR-004 regression cases). However, the feature itself — the new preferences/gate/exclude/include logic — has zero existing coverage for Copilot today, since it doesn't exist yet; all of it is new-from-scratch test writing, with two known historical bug classes (CR-003 string-matching, CR-004 covering-parent-after-removal ordering) that must be avoided from the first commit rather than caught in a second review round, as happened on the Claude side.