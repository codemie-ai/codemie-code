# Technical Research

**Task**: statusline claude-code cost branch
**Generated**: 2026-09-30
**Research path**: filesystem

---

## 1. Original Context

CLI status line hides spend amount on small displays when branch name is long.

Description: The CLI status line does not display the user spend amount on small laptop displays when the current branch name is long. The spend value is pushed out of the visible terminal area, so the user cannot see how many dollars were spent.
Preconditions: User works in the CodeMie CLI; small laptop display (~13"-14"); terminal width limited; current Git branch name is long.
Steps: Open CodeMie CLI on 13-14" display; use a branch with a long name; start/continue a CLI session where the status line is displayed; observe status line content.
Expected: Status line remains readable on small displays and always shows the spend amount, even when the branch name is long.
Actual: Long branch name consumes horizontal space; spend amount is pushed out of the visible area.
Affected areas: CodeMie CLI, CLI status line layout, spend/cost visibility, small display / limited terminal width.
Acceptance criteria:
1. The CLI status line displays the spend amount on 13"-14" displays with limited terminal width.
2. Long branch names do not hide or push the spend amount out of the visible area.
3. The status line gracefully truncates or reorders less critical information when horizontal space is limited.
4. (Screenshot attachment to Jira bug — not a code concern.)

Repo: /Users/yanaasadchaya/Projects/epam/airun/codemie-dev/codemie-code (Node/TS, ESM, Vitest). Recent commit 01a9f1ff "make statusline session cost match the analytics report" is relevant. Locate the statusline implementation (likely under src/agents/plugins/claude/ or similar; a statusline script/command), how segments (branch, cost, model, context, etc.) are composed, whether terminal width is detected (process.stdout.columns / COLUMNS / stdin JSON), existing truncation logic, and existing tests.

---

## 2. Codebase Findings

### Existing Implementations

- `src/agents/plugins/claude/plugin/statusline.ts` (831 lines) — the single live statusline implementation. Plain-JS-style TypeScript (mostly untyped params), no classes; exported pure functions plus `main()`. Key symbols:
  - `buildStatusLine({ projectName, branch, model, actualModel, ctxPct, tokIn, tokOut, cost, costExact, durationMs, budget, budgetError })` (lines 610-640) — the segment composer, and the place the reported bug lives. Returns one string: `parts.join(' | ')`.
  - Current segment order (left to right): `[projectName]` (purple) | budget text `$X.XX (NN%) resets <date>` (green/yellow/red by pct) or `⚠ <budgetError>` | `(branch)` (blue) | `[model]` or `[model → actualModel]` (cyan) | context bar (10 block chars + `NN%`) | `in:X out:Y` (gray) | session cost `[~]$N.NNNN` (yellow) | duration `Xm Ys` (gray).
  - So the session-cost segment is near the END of the line, after the unbounded-length `(branch)`, model (possibly two names with an arrow), context bar and token stats. The budget segment (which also carries a dollar amount, `current_spending`) sits early, before the branch.
  - `extractBasicInfo(ctx)` (99-113) — maps Claude Code stdin JSON to fields: `workspace.current_dir`/`cwd`, `transcript_path`, `model.id`, `model.display_name`, `context_window.used_percentage`, `total_input_tokens`, `total_output_tokens`, `cost.total_cost_usd`, `cost.total_duration_ms`. No width/columns field is read.
  - `gitBranch(cwd)` (652-665) — `git symbolic-ref --short HEAD` then `rev-parse --short HEAD`; returns the full branch name with no length cap.
  - `main()` (778-815) — reads stdin, then in parallel `resolveBudget()`, `gitBranch`, `resolveActualModel` (router-only), `computeSessionCost`; writes `buildStatusLine(...)` to `process.stdout` with no trailing newline.
  - `ctxBar`, `formatDuration`, `fmt`, `formatBudgetSegment`, colour table `C` and helper `c(color, text)` (585-595). Colours are raw ANSI escape strings appended to every segment, so any visible-width computation has to strip escapes (`strip-ansi ^7.1.2` is already a dependency, used in `src/providers/plugins/sso/session/processors/metrics/`, but statusline.ts does not import it).
  - `computeSessionCost` / `lookupRate` / `messageCost` (333-570) — transcript-priced session cost (commit 01a9f1ff); `costExact` false renders `~$`. Cost formatting is `cost.toFixed(4)`, e.g. `$0.3959` (7+ chars).
  - `resolveBudget` (669-776) — CodeMie budget API with 60s file cache; segment text is ~`$12.34 (41%) resets 7/15/2026` (roughly 30 chars).
- `src/agents/plugins/claude/statusline-installer.ts` — deploys the bundle to `~/.claude/codemie-budget-status.js`, writes `settings.json` `statusLine = { type: 'command', command: 'node "<path>"', refreshInterval: 3 }`. `refreshStatuslineIfStale()` re-copies the bundle on each Claude launch if the content differs, so a fix reaches installed users automatically on next launch. Its header comment (line 12) says "The budget segment was removed" and `STATUSLINE_DESCRIPTION` omits it, yet statusline.ts still renders the budget segment — stale comment/description, not a functional issue.
- `scripts/bundle-statusline.mjs` — esbuild bundle of `statusline.ts` into `dist/agents/plugins/claude/plugin/statusline.bundle.mjs`, with the rate card inlined via `define`. Run from `npm run build` (`bundle-statusline`). Anything new statusline.ts imports must be esbuild-bundleable (the file already notes `security.js`/`keytar` cannot be bundled).
- `src/agents/plugins/claude/plugin/session-status.mjs` — older standalone script (`[Model] dir | branch / context bar % | $cost | duration`); grep finds no reference to it in `src/` or `scripts/` besides being copied as a plugin asset (`dist/.../plugin/session-status.mjs` exists). Appears to be legacy/not the deployed statusline. Not verified whether anything deploys it; treat as out of scope unless the spec decides otherwise.
- `src/agents/plugins/claude/claude.plugin.ts` — lines ~309-333 refresh/install the statusline (`--status` flag), ~456-477 export `CODEMIE_ROUTER_MODEL_IDS` and `CODEMIE_MODEL_LABELS` env vars consumed by the statusline, ~553-576 remove `statusLine` from settings.json after session if it installed it.

### Architecture and Layers Affected

- Agent plugin layer (`src/agents/plugins/claude/`) only: the statusline script (presentation/composition) and its installer/bundler. No CLI-registry, provider, or proxy involvement in the layout logic.
- Runtime model: statusline runs as a detached `node` subprocess spawned by Claude Code on its own event triggers plus `refreshInterval: 3`. It is invoked with stdin = JSON and (presumably) stdout piped back to Claude Code, not a TTY.

### Integration Points

- Claude Code -> statusline: stdin JSON in, stdout string out (Claude Code's own statusline contract, https://code.claude.com/docs/en/statusline — not fetched during this research).
- Statusline -> git (`exec` from `@/utils/exec.js`), CodeMie budget API, transcript JSONL files, `~/.codemie` caches, env (`CODEMIE_HOME`, `CODEMIE_PROFILE_NAME`, `CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`).
- Shared modules bundled in: `@/utils/routing-headers.mjs`, `@/utils/bedrock-pricing.mjs`, `@/utils/credential-crypto.js`, `@/utils/price-resolution.js`.

### Patterns and Conventions

- Pure, exported, unit-testable functions taking plain values; side effects isolated in `main()`/`resolveBudget()`/`computeSessionCost()` with injectable dependencies (guide: `.ai-run/guides/testing/testing-patterns.md` "Testing Dependency-Free Scripts via Parameter Injection").
- Never throw from the statusline; `main().catch(() => process.stdout.write(''))`.
- Segments are pushed to a `parts` array and joined with `' | '`; each segment is `c(color, text)`.
- Terminal-width handling exists elsewhere in the repo (`src/cli/commands/shared/selection/ui.ts:83,104` uses `process.stdout.columns || 80`), but there is no width handling, truncation, or ellipsis anywhere in statusline.ts (grep for `columns|COLUMNS|truncat|slice(|padEnd|width|stripAnsi` finds only stdin/ANSI/tail-window hits).

**Terminal-width detection answer**: none currently. `process.stdout.columns`, `COLUMNS`, and any stdin-JSON width field are all unused. Whether Claude Code exposes width to the statusline command (stdin JSON field, `COLUMNS` env, controlling TTY reachable via `/dev/tty` or `process.stderr`) was NOT verified in this research; `process.stdout.columns` is undefined whenever stdout is a pipe, which is the expected situation for a statusLine command. See Risk Indicators.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/testing/testing-patterns.md` — Vitest conventions, dynamic-import mocking, parameter-injection for dependency-free scripts (references statusline tests at lines 147 and 162; those references cite `statusline.mjs` line numbers, which no longer exists, i.e. the guide is stale about the file name).
- `.ai-run/guides/quality-gates.md:47` — `.gitattributes` LF rule that exists because of the statusline's shebang line; also mentions `statusline.mjs` (stale name).
- `.ai-run/guides/architecture/architecture.md`, `development/development-practices.md`, `standards/code-quality.md` are the general guides named in `AGENTS.md` (not deeply read; not statusline-specific).
- `docs/ANALYTICS-REPORT.md:148` — note about live statusline cost vs report cost (predates the 01a9f1ff alignment; possibly stale).
- No design doc or ADR for statusline layout or width. `CHANGELOG.md` has no statusline entries found by grep.

### Architectural Decisions

- Inline comments in statusline.ts record the decisions: statusline is bundled to one file (esbuild) because it runs detached with no node_modules; cost is priced from the transcript rather than trusting `cost.total_cost_usd` (router alias mispricing, 8x); `~` prefix marks non-exact cost; only the `reauthenticate` budget error is rendered.
- Installer comment: `refreshInterval` is 3s so event-trigger lag self-corrects.

### Derived Conventions

- ESM, `.js` extensions on imports, `@/` alias for project imports inside statusline.ts (esbuild resolves via tsconfig), explicit-color ANSI via the local `C` table, no `console.log` (stdout write only).

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude/plugin/__tests__/statusline.test.ts` (705 lines) — `describe('buildStatusLine')` at lines 173-220 has 5 tests, all with short fixtures (`projectName: 'my-project'`, `branch: 'main'`, model `Claude Sonnet 5`): basic content present, colours/bar, `~` estimate marker, budget segment ordering (project < budget < branch), budget-error display, non-numeric cost. Also covers `matchBudgetRow`, `formatBudgetSegment`, `extractBasicInfo`, `isRoutingConfigured`, `lookupNominalLabel`, `formatDuration`, `ctxBar`, `resolveBudget`, `isMainModule`, `lookupRate` (+ parity with `resolvePrice`), `canonicalizeModelId`, `computeSessionCost`.
- `src/agents/plugins/claude/__tests__/statusline-installer.test.ts`, `claude.plugin.statusline.test.ts` — installer and plugin wiring.
- Tests assert with `toContain` on substrings and `indexOf` ordering, using raw ANSI constants (`YELLOW`). The budget-ordering test (`indexOf('[my-project]') < indexOf('$12.34') < indexOf('(main)')`) would be affected by any reorder decision.

### Testing Framework and Patterns

- Vitest `^4.1.5`, projects `unit` (`src/**/*.test.ts`), `cli`, `agent`/integration (`tests/integration/**`); tests import statusline.ts source directly (not the bundle). Per `AGENTS.md`, tests are written/run only on explicit user request.

### Coverage Gaps

- No test of `buildStatusLine` with a long branch, long project name, router `model → actualModel` string, or any width budget; no test of visible-width/ANSI-aware measuring; no test of `main()` end-to-end (stdin -> stdout) or of width detection. `gitBranch` has no tests. No test that the bundled artifact (`statusline.bundle.mjs`) runs.

---

## 5. Configuration and Environment

### Environment Variables

- Used by statusline: `CODEMIE_HOME`, `CODEMIE_PROFILE_NAME`, `CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`. No width-related var (`COLUMNS`) is read.

### Configuration Files

- `~/.claude/settings.json` `statusLine` block (written by installer): `type: command`, `command`, `refreshInterval: 3`. Has no padding/width option set by CodeMie.
- `~/.codemie/codemie-cli.config.json` (profiles, `workspace.codeMieUrl`, `userEmail`), `~/.codemie/budget-cache.json` (60s TTL, schema 2), `~/.codemie/statusline-cost-cache.json` (schema 2).
- `tsconfig.json` path alias `@/*`; `scripts/bundle-statusline.mjs` esbuild config (target node20).

### Feature Flags and Deployment Concerns

- No feature flags. Deployment is via `npm run build` (bundle) then auto-refresh of `~/.claude/codemie-budget-status.js` by `refreshStatuslineIfStale()` on Claude launch (only when the script already exists). Filename `codemie-budget-status.js` must not change (would orphan existing settings.json commands).

---

## 6. Risk Indicators

- Terminal width availability is unverified and is the central unknown. The statusline runs detached with (very likely) piped stdout, so `process.stdout.columns` is probably undefined; `COLUMNS` is typically not exported to child processes; the stdin JSON schema handled by `extractBasicInfo` has no width field. Not confirmed against Claude Code's statusline docs or a live run. Speculative: if no width signal exists, layout would have to rely on fixed per-segment caps or priority ordering rather than measured width.
- Speculative: if the fix caps/truncates the branch or reorders segments so cost precedes the branch, it changes the order asserted by existing test 'renders the budget segment right after the project name' (`statusline.test.ts:201-206`).
- Multiple dollar figures exist: the budget segment (`$current_spending (pct%) resets date`, early in the line) and the session cost (`$N.NNNN`, late). The ticket says "spend amount" without saying which; ambiguity affects which segment must be protected. Session cost is the one at the end and the one actually pushed off-screen in the current order; budget precedes the branch.
- Other unbounded-length segments besides branch: `projectName` (directory basename), `[model → actualModel]` for routers (catalog labels), budget text with locale-formatted `resets` date (`toLocaleDateString()` varies by locale). A branch-only fix may leave the problem for long project or model names.
- Width measurement must ignore ANSI escapes (every segment is wrapped by `c()`), and block glyphs (`█░`, `⚠`, `→`) and emoji-width branches may not be one column; `strip-ansi` is available but statusline.ts does not currently import it (bundle size and esbuild-compat unchecked, likely fine).
- Detached-process constraint: any new import must be esbuild-bundleable; `security.js` is known to break the bundle.
- Claude Code itself may truncate/wrap the statusline or reserve space for its own UI (notifications, padding); behavior not verified. Also unverified whether the statusline contract permits multi-line output (would be an alternative to truncation).
- Stale documentation surrounding the file (installer header comment says budget segment removed; guides cite non-existent `statusline.mjs`; legacy `session-status.mjs` still ships in `dist`). Risk of editing the wrong file or being misled; `session-status.mjs` is apparently not the deployed script (unconfirmed).
- Coverage: `buildStatusLine` tests use short fixtures only; `main()` and `gitBranch` are untested, so a width-detection change in `main()` has no existing safety net.
- Change surface appears small (one production file, `statusline.ts`, plus its test file), but the bundle/deploy path (`npm run build`, refresh-on-launch) needs a rebuild to verify the deployed artifact.

---

## 7. Summary for Complexity Assessment

The statusline is one self-contained module, `src/agents/plugins/claude/plugin/statusline.ts`, whose `buildStatusLine()` joins segments with `' | '` in the fixed order project, budget, branch, model, context bar, token stats, session cost, duration. The session cost sits near the end, after the unbounded branch name, and nothing in the file measures width, truncates, or reorders. The likely change surface is `buildStatusLine()` and possibly `main()` (width detection) plus `statusline.test.ts`, with the build/bundle and installer refresh path already in place. That points at one production file and one test file in a single layer (agent plugin).

The technical unknown is where a width signal would come from. `process.stdout.columns`, `COLUMNS` and the stdin JSON are all unused, and the script runs as a detached subprocess likely with piped stdout. I did not verify whether Claude Code provides width by any channel. The design (measure width versus fixed caps/priority ordering) depends on that. Related concerns: ANSI-aware width measuring, several unbounded segments (project, branch, routed model, budget date), and ambiguity between budget spend and session cost.

Test posture is decent for pure functions in this file (5 `buildStatusLine` tests, extensive cost tests), but there is no coverage for long inputs, width, `main()`, or `gitBranch`; one existing ordering test may need updating if segments are reordered. Documentation is thin and partly stale (installer comment, guide file names, legacy `session-status.mjs`). Overall this looks like a small, well-contained fix with one meaningful research gap (width signal) that spec should settle first.

---

## 8. External References

None named by the task. (The task's references to the Jira bug and the recent commit 01a9f1ff were used only as context; the commit's changed files were reviewed via `git show --stat`. Claude Code's statusline docs at https://code.claude.com/docs/en/statusline are cited in installer comments but were not fetched here.)
