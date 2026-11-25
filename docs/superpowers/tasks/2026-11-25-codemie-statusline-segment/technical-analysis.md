# Technical Research

**Task**: claude statusline plugin
**Generated**: 2026-11-25
**Research path**: filesystem

---

## 1. Original Context

Add a CodeMie-branded segment to the Claude Code statusline to indicate a CodeMie-managed session (Jira EPMCDME-16966).
Summary: When launching Claude Code through CodeMie (e.g. codemie-claude), there is no persistent in-session indicator that the session is CodeMie-managed rather than plain claude. The CodeMie welcome banner disappears once Claude Code's TUI takes over.
Current State: buildStatusLine() in src/agents/plugins/claude/plugin/statusline.ts (~lines 626-656) is the only persistent UI element CodeMie injects into an active session. Segments: project name, budget, branch, model, session cost, context bar, token counts, duration — none reference "CodeMie".
Requested Behavior: Add a persistent, unobtrusive "via CodeMie" (or similar) indicator to the statusline so users can tell at a glance, and in screenshots/screen shares, whether a session is CodeMie-managed.

---

## 2. Codebase Findings

### Existing Implementations

**Purpose: render the persistent statusline**
- `src/agents/plugins/claude/plugin/statusline.ts` (883 lines). `buildStatusLine({projectName, branch, model, actualModel, ctxPct, tokIn, tokOut, cost, costExact, durationMs, budget, budgetError})` at ~line 626 is a pure function. It builds `parts[]` in this order: project `[name]` (purple), budget or `⚠ reauthenticate`, `(branch)` (blue), `[model]` (cyan), cost (yellow), ctx bar, `in:/out:` (gray), duration (gray). It joins with `' | '`. Colors are the `C` map (~line 595) and the `c(color, text)` helper. There is no bold or dim color and no CodeMie literal.
- `main()` (~line 836) reads Claude's stdin JSON, then calls `buildStatusLine({...basic, budget, budgetError, branch, actualModel, cost, costExact})`. It is the only production caller. The file runs standalone, so it must not import ConfigLoader (see comment at `sessionCodeMieUrl`).
- The script is bundled by `scripts/bundle-statusline.mjs` (esbuild) to `plugin/statusline.bundle.mjs`. `statusline-installer.ts` deploys it as `~/.claude/codemie-budget-status.js` and registers `settings.statusLine` (`type: command`, `refreshInterval: 60`).
- `src/agents/plugins/claude/statusline-installer.ts` holds `STATUSLINE_DESCRIPTION` ("Project, branch, model, context usage, session cost & duration for Claude Code"). It also holds `refreshStatuslineIfStale()`, which rewrites the deployed script on launch when the bundle differs, so an updated segment reaches already-installed users on the next `codemie-claude` launch.
- `claude.plugin.ts` `beforeRun` (~lines 374-400, 521-545) refreshes the script, installs it when `--status` is passed, and exports statusline-only env vars (`CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`).

**Purpose: tell whether a Claude session is CodeMie-managed (already computed elsewhere)**
- `src/agents/core/evidence/routing.ts:54` `launchMode(env)` returns `'managed'` when `env.CODEMIE_SESSION_ID` is set, else `'native'`. It is used by `identity-fields.ts:214`. It is not importable into the standalone statusline without bundling, but esbuild inlines project imports.
- `CODEMIE_SESSION_ID` is set at `BaseAgentAdapter.ts:605`. `CODEMIE_PROFILE_NAME` is set at `AgentCLI.ts:430`. The statusline already reads `process.env.CODEMIE_PROFILE_NAME` (~line 720, `resolveBudget`) to find the launch profile. Claude Code passes its env to the statusline subprocess.

**Other touched code**: `README.md` lines ~550-570 ("Claude Code Statusline", with an example line that has no CodeMie segment).

### Decisions Already in the Code
- The statusline is installed globally in `~/.claude/settings.json`, so it also renders in plain `claude` sessions run outside CodeMie. The installer comments say it "appears automatically in every claude session". The only existing managed-session discriminator is the env var (`CODEMIE_SESSION_ID` / `CODEMIE_PROFILE_NAME`). This is stored at launch and read at render time.
- Per-session state reaches the statusline through env vars exported in `beforeRun` rather than the global config. The reason is recorded at `resolveBudget`: `activeProfile` is global mutable state.
- The statusline must never crash Claude Code (`main().catch(() => write(''))`) and must work without project imports at runtime (bundle).
- Segment order and the ` | ` join are fixed by the `parts[]` convention. Truncation caps exist only for project and branch (20 chars each).

### Task Statements Checked Against the Code
- "buildStatusLine() ... ~lines 626-656": holds (function starts ~626, ends ~656).
- "only persistent UI element CodeMie injects": holds for the statusline. The model picker settings and hooks are not UI indicators.
- "none reference CodeMie": holds. `statusline.ts` contains CodeMie only in config and URL logic.
- Statement implied by the task, "plain claude vs CodeMie-managed": contradicted as a statusline property today. The installed statusline is global and renders in both. Distinguishing them needs the env discriminator above. Nothing in the task says whether a plain `claude` run should show the segment.
- "Welcome banner disappears once TUI takes over": unverified (outside the repo, Claude Code TUI behavior).

### Consumers of Changed Contracts
- `buildStatusLine` consumers: `main()` and `plugin/__tests__/statusline.test.ts` (`describe('buildStatusLine')`, ~line 216). Assertions there: `plain.match(/^\[([^\]]*)\]/)` (project name must be first), `toContain` on individual segments, and `\x1b[0;33m$1.5000` for the cost. A new leading segment would break the `^\[` regex test (line ~237). A trailing segment, or one that uses a non-bracket form, would not.
- `statusline-url-contract.test.ts` and `claude.plugin.statusline.test.ts` / `statusline-installer.test.ts` exist. No hits were seen for segment text, but I did not read them in full.
- README example line and `STATUSLINE_DESCRIPTION` describe the segments. Both are documentation only.

### Architecture and Layers Affected
Agent plugin layer, Claude plugin: the statusline script (render function and `main`). Possibly the installer description string. No registry, provider, or proxy layer.

### Integration Points
Env passes from `AgentCLI`/`BaseAgentAdapter` through Claude Code to the statusline subprocess. The installer's `refreshStatuslineIfStale` is the deployment path.

### Patterns and Conventions
ES modules with `.js` import suffixes. Pure render function with ANSI helper `c()`. Segments are pushed to `parts[]`. Standalone-script constraints (no ConfigLoader). Env-var export in `beforeRun` for per-session data.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` exists (architecture, development, integration, standards, testing, usage). None of them is specific to the statusline. `docs/ARCHITECTURE-OTLP-PLUGIN.md` is unrelated. `plugin/README.md` was not found to mention the statusline. The README "Claude Code Statusline" section is the only user doc.

### Architectural Decisions
Inline comments only (see Decisions Already in the Code). No ADR.

### Derived Conventions
See Patterns and Conventions.

---

## 4. Testing Landscape

### Existing Coverage
`plugin/__tests__/statusline.test.ts` (vitest) covers `buildStatusLine`, `ctxBar`, `truncate`, `resolveBudget`, pricing, and `computeSessionCost`. Installer and plugin tests are in `claude/__tests__/`.

### Testing Framework and Patterns
Vitest. Tests strip ANSI with a regex and assert on plain text or on raw color codes. Project policy: write tests only when the user asks.

### Coverage Gaps
No test covers `main()` env-driven behavior, and no test reads a CodeMie indicator.

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_SESSION_ID` (set per managed launch), `CODEMIE_PROFILE_NAME`, `CODEMIE_HOME`, `CODEMIE_ROUTER_MODEL_IDS`, `CODEMIE_MODEL_LABELS`.

### Configuration Files
`~/.claude/settings.json` (statusLine registration) and `~/.codemie/codemie-cli.config.json`. `.codemie/codemie-cli.config.json` in the repo has uncommitted local changes that are unrelated.

### Feature Flags and Deployment Concerns
No flags for the statusline. It is deployed as a copy and refreshed on managed launch.

---

## 6. Risk Indicators

- Speculative: a segment shown unconditionally would also appear in plain `claude` sessions, because the installed statusline is global. That defeats the "managed vs plain" purpose. See Decisions Already in the Code.
- `statusline.test.ts` ~line 237 asserts the project segment is first (`/^\[/`). Placement of a new segment interacts with it.
- Width: the line already carries 8 segments, and Claude Code may truncate. Project and branch are capped at 20 chars, and there is no priority or overflow handling.
- Speculative: `CODEMIE_SESSION_ID` vs `CODEMIE_PROFILE_NAME` as the discriminator. Both are in use, and `launchMode()` already exists for the first.
- Documentation drift: README example and `STATUSLINE_DESCRIPTION` do not mention the segment.
- Existing installs get the change only through `refreshStatuslineIfStale` on a managed launch.

---

## 7. Summary for Complexity Assessment

The change sits in one layer: the Claude plugin statusline script. `buildStatusLine` is a pure function that pushes to `parts[]`, and `main()` is its only production caller. The surface is small: one source file, plus optional doc strings (README, `STATUSLINE_DESCRIPTION`) and one existing test file. Nothing novel is needed. The ANSI helper, the segment pattern, and an env discriminator (`CODEMIE_SESSION_ID`, with `launchMode()` as precedent) all exist.

The main open point is behavioral. The statusline is installed globally and also renders in plain `claude` sessions, so whether the segment is gated on a managed-session env var or always shown is not stated in the task. Test coverage of the render function is good, and an existing assertion about segment order may be affected. There are no config, schema, or migration surfaces, and delivery reuses the existing stale-refresh path.

---

## 8. External References

None named by the task.
