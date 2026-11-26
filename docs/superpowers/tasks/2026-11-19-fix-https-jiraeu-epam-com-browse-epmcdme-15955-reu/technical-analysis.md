# Technical Research

**Task**: codemie-opencode launcher argument parsing pass-through session resume -s working directory change directory Windows opencode agent
**Generated**: 2026-11-17
**Research path**: filesystem
**Workspace root**: C:/code/codemie-dev | **Repository**: codemie-code (`C:/code/codemie-dev/codemie-code`, HEAD 7f28135e, package 0.16.9) | read-only, node_modules absent, nothing executed

---

## 1. Original Context

Bug EPMCDME-15955: codemie-opencode treats an OpenCode session ID as a directory when resuming a session on Windows. Running `codemie-opencode -s ses_ecbca38f2ffeOhmXaZtW85punW` from a project directory fails with "Error: Failed to change directory to <cwd>\ses_ecbca38f2ffeOhmXaZtW85punW" instead of forwarding `-s <id>` to OpenCode. Expected: the launcher recognizes -s <session-id> as OpenCode's session-resume arg, forwards it unchanged, cwd stays the project directory, CodeMie launcher options and native OpenCode options keep working without collision or reinterpretation, starting a new session is unchanged, automated regression tests cover session resumption through codemie-opencode incl. Windows path handling and ses_* IDs. Affected areas listed on the ticket: codemie-opencode launcher, CodeMie CLI agent argument parsing and pass-through, OpenCode session-resume integration, Windows path and working-directory handling, OpenCode v2 support. Likely cause to confirm: the launcher has its own `-s`/short option (e.g. a --directory / working-dir style option or a session option) that captures the value and then does a chdir.

(Also asked: where "Failed to change directory to" originates, which option is bound to `-s`, bin entry parsing vs `codemie opencode`, pass-through forwarding, existing arg-parsing tests, whether other repos are touched.)

---

## 2. Codebase Findings

### Repository impact
- codemie-code: **affected** (all evidence below).
- codemie, codemie-ui, codemie-sdk: **not_affected** by evidence in codemie-code (nothing in the failing path calls them; per instruction they were not searched). Not touched.

### Direct answers
- **Option bound to `-s`**: the wrapper's own `-s, --silent` (boolean), `codemie-code:src/agents/core/AgentCLI.ts:72-75,89`. `getSilentFlags()` returns long-only `--silent` just for `['codex','gemini']` (line 73); `opencode`, `opencode-acp`, `codemie-code`, `claude`, `kimi`, `pi`, ... get `-s, --silent`. No `--directory`/working-dir/session option exists on the launcher; the task's hypothesis (an option capturing the value + chdir) is **contradicted**: `-s` is a value-less flag, so it captures nothing.
- **Mechanism (traced from code, not executed)**: Commander sees `-s` -> `silent=true`; `ses_...` is not consumed (boolean) and falls into the catch-all `[args...]` (AgentCLI.ts:104). `collectPassThroughArgs` (AgentCLI.ts:671-697) skips `silent` (config-only list, line 677) -> agentArgs=`['ses_...']`. opencode `enrichArgs` (opencode.plugin.ts:489-512): first arg is not a subcommand, no `--task`, `startsTui = args[0].startsWith('-')` is false -> args returned unchanged. `BaseAgentAdapter.run` (BaseAgentAdapter.ts:705-715, 933-938) spawns the `opencode` binary with `ses_...` as a bare positional. OpenCode's TUI treats a leading positional as a project directory.
- **Where "Failed to change directory to" originates**: **not in codemie-code**. Grep of `Failed to change directory` over the repo (excluding dist/openwiki) = 0 hits; the only `process.chdir(` hits are tests (`pi.paths.test.ts:124`, `stale-session-reconciliation.test.ts:1444`, `proxy-otlp-respawn-recovery.test.ts`). Production code never chdirs and `spawn` passes no `cwd` (BaseAgentAdapter.ts:933-938). The message and the `<cwd>\ses_...` resolution come from the upstream OpenCode binary: **unverified** (native binary / `opencode-ai` not in reach; `codemie-code-binary.ts` only resolves it). Settling it: OpenCode source for its TUI `[project]` positional, or run `opencode ses_x`.
- **bin entry vs `codemie opencode`**: `bin/codemie-opencode.js:8-18` = `AgentRegistry.getAgent('opencode')` -> `new AgentCLI(agent).run(process.argv)`; all 14 `bin/codemie-*.js` shims are the same shape (opencode-acp: `bin/codemie-opencode-acp.js`). `package.json:15` maps `codemie-opencode`. There is **no `codemie opencode` subcommand**: `src/cli/index.ts:85-112` registers commands (only `opencode-metrics`, `src/cli/commands/opencode-metrics.ts:23`, which has its own unrelated `-s, --session`); the only AgentCLI use in `src/cli` is the `--task` shortcut for the built-in `codemie-code` agent (`src/cli/index.ts:115-133`). So the failing path is one parser, AgentCLI, for every `codemie-<agent>` bin. (`tests/integration/agent-opencode.test.ts:2` describes `codemie opencode --task` loosely; it runs `bin/codemie-opencode.js`.)
- **Pass-through forwarding**: Commander `allowUnknownOption()` + `[args...]` (AgentCLI.ts:103-104) -> `handleRun` -> `collectPassThroughArgs`: positional args kept, then every non-config-only parsed option re-emitted as `-x`/`--key [value]` (AgentCLI.ts:671-697; config-only list `profile, provider, apiKey, baseUrl, timeout, model, silent, status, jwtToken, reasoningEffort, analyticsReport`) -> lifecycle `enrichArgs` -> `transformFlags` with `flagMappings` (`flag-transform.ts:38-95`) -> reasoning-effort -> spawn (Windows: `shell: true`, args re-joined and quoted only when they contain space/`"()&|<>^%[]{}`, BaseAgentAdapter.ts:924-931; `ses_*` ids need no quoting).

### Existing Implementations
Purpose A - "`-s <session-id>` reaches OpenCode as its native session-resume flag":
- `-s, --silent` registration, AgentCLI.ts:72-75,89: swallows `-s`; per-agent opt-out list is the existing mechanism (`codex`, `gemini`). Documented in `docs/COMMANDS.md:379,401` ("long form only for codex and gemini"). Consumers: every `AgentCLI` instance (14 bins); `options.silent` read at AgentCLI.ts:210.
- Wrapper `--resume <id>` -> `-s <id>`: `opencode.plugin.ts:232-237` (`flagMappings['--resume'] = {type:'flag', target:'-s'}`). So OpenCode already receives `-s <id>` on the wrapper's own path (after Commander, no collision). `opencode-acp` overrides `flagMappings: {}` (opencode-acp.plugin.ts:31); `codemie-code` plugin has no `flagMappings`. Covered by `plugin-effort-resume.test.ts:116-121`.
- Native resume detection: `extractNativeResumeId` -> `flagValue(args, ['--session'])` only (`opencode.plugin.ts:625-629`, `codemie-code.plugin.ts:520-524`, `flag-transform.ts:128-141`); `continuesNativeSession` reads `--continue`/`-c` (`opencode.plugin.ts:632`). Both carry a comment that `-s` "never reaches opencode". AgentCLI uses them to set `CODEMIE_RESUME_SESSION_ID`/`CODEMIE_CONTINUE_SESSION` and run the ownership check (AgentCLI.ts:447-532, 469-471). Consumers of the resume env: `session/types.ts:52-68`, `opencode.run-session.ts` (resumeSessionId; test `opencode.run-session.test.ts:156-185`).
Purpose B - "A bare positional must not be misread by OpenCode as a directory": `codemie-code.plugin.ts:399-403` rewrites a leading bare positional to `run ...args` (comment: "the underlying binary interprets the first arg as a directory to chdir into"). The `opencode` plugin has no such guard; it forwards a bare positional untouched (opencode.plugin.ts:508-511). Note for built-in agent `codemie-code`: `-s ses_x` -> silent + positional `ses_x` -> `run ses_x` (the id would be sent as a message, a different symptom of the same root).
Other touched code: `bin/codemie-opencode.js`, `src/agents/registry.ts` (not read in detail).

### Decisions Already in the Code
- Per-agent `-s` ownership via a hard-coded name list (`['codex','gemini']`, AgentCLI.ts:73); alternative: metadata-driven flag; reason recorded in the JSDoc at AgentCLI.ts:67-71 (agents whose native CLI uses `-s`). Convention: the list entry + a `describe.each` block in `AgentCLI-silent-flag.test.ts`.
- `-s` was deliberately treated as wrapper-owned for opencode/claude and is pinned by a test (below); recorded rationale: none found beyond the comments at opencode.plugin.ts:627 / codemie-code.plugin.ts:522.
- Adjacent, same shape: `-m, --model` is wrapper-owned (AgentCLI.ts:93) while upstream `-m` = model (comment opencode.plugin.ts:503-504); it is config-only and not forwarded.
- Wrapper `--resume` is the documented resume form (`docs/COMMANDS.md:404`); native OpenCode resume forms are `--session` (detected) and `-s` (not detected).
- Spawn inherits process cwd; the wrapper resolves config from the nearest `.codemie` up from `process.cwd()` (AgentCLI.ts:228-240) but never changes cwd.

### Task Statements Checked Against the Code
- "treats the id as a directory (chdir)": holds as observed behaviour, but the chdir is done by the OpenCode binary, not the launcher (see above); in-repo evidence supports the id arriving as a bare positional. Binary behaviour **unverified**.
- "launcher has its own -s/short option that captures the value and chdirs": **contradicted** - `-s` is boolean `--silent`; no chdir/`--directory` option in `src` (grep `--directory` hits only `bmad.plugin.ts:217`, an unrelated framework installer).
- "`-s <id>` is OpenCode's session-resume arg": holds (repo's own `--resume`->`-s` mapping, opencode.plugin.ts:232-237).
- "CodeMie launcher options and native OpenCode options keep working without collision": **keeps in place** `-s, --silent` for every non-opted-out agent (docs/COMMANDS.md:379,401; test `AgentCLI-silent-flag.test.ts:149-163` asserts opencode `-s chat` -> silent, args `['chat']`); also `-m, --model`.
- "starting a new session is unchanged": no code path contradicts; unverified without a run.
- "OpenCode v2 support": `opencode.plugin.ts` comments reference v2 (plugin-effort-resume.test.ts:101); whether v2 changed `-s`/positional behaviour is **unverified** (binary not in reach).
- "Windows path handling": wrapper has no path handling in this flow; Windows quoting at BaseAgentAdapter.ts:924-931 does not affect `ses_*` ids.

### Consumers of Changed Contracts
Contract: which agents own `-s` (AgentCLI.ts:73) / what `-s` means for opencode.
- `AgentCLI-silent-flag.test.ts:149-164` (`describe.each(['claude','opencode'])`) asserts the current behaviour for opencode.
- `docs/COMMANDS.md:379,401` states the codex/gemini-only rule.
- `opencode.plugin.ts:627`, `codemie-code.plugin.ts:522` comments state `-s` never reaches opencode; `extractNativeResumeId` ignores `-s`, so a forwarded native `-s <id>` would bypass the `CODEMIE_RESUME_SESSION_ID` / resume-ownership path at AgentCLI.ts:454-532 (AgentCLI-resume.test.ts:380-421 covers only `--session` forms).
- Scripts/users relying on `codemie-opencode -s` as silent (non-interactive callers; AgentCLI.ts:198-210 also auto-silences on non-TTY, so only interactive use changes). Consumers outside this repo: none found.
- Sibling agents sharing the parser: `opencode-acp` (inherits metadata, `name: 'opencode-acp'` is a different list key), `codemie-code` (same OpenCode-derived binary, `OPENCODE_SUBCOMMANDS` in codemie-code.plugin.ts:38), claude/kimi/pi/openwiki/copilot. Native `-s` meaning for these upstream CLIs: **unverified**.

### Architecture and Layers Affected
CLI entry shim (`bin/`) -> `AgentCLI` (Commander parse, pass-through) -> agent plugin metadata (`flagMappings`, lifecycle `enrichArgs`, `extractNativeResumeId`) -> `BaseAgentAdapter.run` (spawn). Registry: `src/agents/registry.ts`.

### Integration Points
OpenCode binary resolved via `metadata.cliCommand` (`CODEMIE_OPENCODE_BIN`); session sync reads opencode.db keyed by run (opencode.run-session.ts); proxy/hook config injected in `beforeRun`.

### Patterns and Conventions
Plugin-per-agent metadata; per-agent differences expressed in plugin metadata or small name lists in AgentCLI; tests use real Commander parsing with a fake adapter (`AgentCLI-silent-flag.test.ts`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` listed in AGENTS.md (architecture, testing-patterns, external-integrations, exposed-api) - not read in full (research scoped to the failing path). `docs/COMMANDS.md:375-405` documents `-s, --silent`. Prior task analysis `docs/superpowers/tasks/2026-11-13-epmcdme-17189-resume-codemie-session-id/technical-analysis.md:125` records the `--resume` mapping per agent (opencode `-s`).

### Architectural Decisions
Only the code comments cited above. No ADR on `-s` ownership found.

### Derived Conventions
See Patterns and Conventions.

---

## 4. Testing Landscape

### Existing Coverage (agent argument parsing)
- `src/agents/core/__tests__/AgentCLI-silent-flag.test.ts` - `-s` ownership: codex/gemini forward `-s`; claude/opencode consume `-s` as silent (lines 149-164). Seam: `new AgentCLI(fakeAdapter).run(['node','codemie-<agent>',...])`, inspect `adapter.run` args and `setSilentMode`.
- `src/agents/core/__tests__/AgentCLI-resume.test.ts` - `--resume`, native resume extraction (`--session`, `--session=`), `continuesNativeSession` (`-c`, `--`), ownership env (lines 360-475).
- `src/agents/core/__tests__/flag-transform.test.ts` (incl. `flagValue` 246-250) and `src/agents/plugins/__tests__/flag-transform-contract.test.ts`, `plugin-effort-resume.test.ts:116-121` (`--resume`->`-s`).
- Other AgentCLI seams: `AgentCLI-effort`, `-print-config`, `-model-source`, `-analytics-report`, `-project-seam` tests; `tests/integration/agent-resume-codemie-id.test.ts`.
- Integration/agent tier: `tests/integration/agent-opencode.test.ts` (real binary, `--task` only, gated on SSO_AVAILABLE; harness `tests/helpers/agent-smoke.ts:86-104` spawns `bin/codemie-opencode.js`), `tests/integration/opencode/print-config.test.ts`.

### Testing Framework and Patterns
Vitest; `vi.spyOn(ConfigLoader,...)`, stdin/stdout `isTTY` forced true to defeat auto-silent (AgentCLI-silent-flag.test.ts:94-95); `process.chdir` unsupported in vitest workers (commands.test.ts:57), so cwd is spoofed.

### Coverage Gaps
- No test of `codemie-opencode -s <ses_id>` or any `ses_*` positional through the real opencode plugin `enrichArgs`; silent-flag tests use a fake adapter, so plugin `enrichArgs`/`flagMappings` are not in that seam.
- No test of `opencode-acp`/`codemie-code` `-s` behaviour.
- No test asserting a native `-s <id>` populates `CODEMIE_RESUME_SESSION_ID`.
- No Windows-specific args test for ids (Windows quoting in BaseAgentAdapter.ts:924-931 has no `ses_*` case found).

---

## 5. Configuration and Environment

### Environment Variables
`CODEMIE_OPENCODE_BIN` (binary override, via `metadata.cliCommand`), `CODEMIE_RESUME_SESSION_ID`, `CODEMIE_CONTINUE_SESSION` (AgentCLI.ts:470-471), `CODEMIE_DEBUG=true` (debug logs print `collected agentArgs`, AgentCLI.ts:541), `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` (beforeRun).

### Configuration Files
`package.json:15` (bin map), `docs/COMMANDS.md`.

### Feature Flags and Deployment Concerns
None found. Bin shims import from `../dist/`, so tests/builds must rebuild `dist` for shim-level checks.

---

## 6. Risk Indicators

- Existing mechanism kept in place: `-s, --silent` owned by the wrapper for opencode, pinned by `AgentCLI-silent-flag.test.ts:149-164` and documented at `docs/COMMANDS.md:379,401` (see Consumers of Changed Contracts).
- The `Failed to change directory` text and the Windows `<cwd>\ses_...` form come from the OpenCode binary, which is not in reach; the in-repo cause is traced from code, not reproduced.
- `extractNativeResumeId` ignores `-s` and comments assert `-s` never reaches opencode: any change in `-s` ownership leaves resume-ownership/analytics env detection out of step with what the binary receives (AgentCLI.ts:454-532).
- Same root affects `codemie-code` (built-in): `-s ses_x` becomes `run ses_x`; `opencode-acp` shares the opencode plugin.
- `-m` has the same wrapper-vs-upstream ambiguity (comment opencode.plugin.ts:503-504).
- Speculative: any fix that changes which agents own `-s` changes a user-visible short flag for those agents (silent mode).
- Speculative: OpenCode v2 behaviour of `-s`/bare positional is unconfirmed; the ticket lists v2 as an affected area.
- Guides under `.ai-run/guides/` were not read in full.

---

## 7. Summary for Complexity Assessment

The failing path runs through one place: `AgentCLI` (shared by all 14 `bin/codemie-*.js` shims), where `-s, --silent` is registered for every agent except codex and gemini. For `codemie-opencode -s ses_X`, Commander consumes `-s` as a boolean, drops it from pass-through, and the id travels to the `opencode` binary as a bare positional, which OpenCode (not codemie-code) treats as a directory. There is no `--directory`/chdir option and no cwd handling in the wrapper; no `codemie opencode` subcommand exists, so there is no second parser. Layers touched: CLI parse (AgentCLI), plugin metadata (opencode, opencode-acp, codemie-code), docs. Repos other than codemie-code are not touched.

Technical novelty is low: the code already has a per-agent `-s` ownership mechanism and a test pattern for it. The surface to account for is small in files (AgentCLI.ts, two plugin files' resume helpers and comments, one test file that pins the current behaviour, COMMANDS.md) but crosses shared behaviour: the same list and flag affect sibling agents, and resume-detection (`extractNativeResumeId`) assumes `-s` never reaches opencode.

Test posture: strong coverage for `-s` ownership and resume extraction through fake adapters, but nothing exercises `-s <ses_*>` through the real opencode plugin `enrichArgs`/spawn args, Windows quoting of ids, or opencode-acp/codemie-code. The OpenCode binary's behaviour (error text, v2) cannot be confirmed from this repo.

---

## 8. External References

None named by the task. (The OpenCode binary / `opencode-ai` source was not in reach; claims about its positional-directory behaviour and v2 are marked unverified.)
