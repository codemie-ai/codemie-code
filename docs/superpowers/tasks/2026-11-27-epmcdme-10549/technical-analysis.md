# Technical Research

**Task**: cli commands documentation coverage
**Generated**: 2026-11-27
**Research path**: filesystem

---

## 1. Original Context

Jira EPMCDME-10549 (https://jiraeu.epam.com/browse/EPMCDME-10549), Bug, rescoped to part A, repo codemie-code only.

Summary: Outdated or misleading CLI command documentation — "Mastering CodeMie Code CLI" AI Kata. Rescoped 2026-09-25 to: document the 10 registered-but-undocumented CLI commands in docs/COMMANDS.md and add (or note) a doc-vs-registered coverage check. The Kata revalidation and `codemie analytics show` vs UI reconciliation was split off to EPMCDME-17510 (external, out of scope).

The 10 undocumented commands: assistants, hook, sound, skill, skills, models, sdk, tips, whatsnew, test-metrics. The CLI registry composes 29 subcommands (src/cli/index.ts ~lines 84-112); COMMANDS.md has dedicated sections for 19.

Acceptance criteria (from the approved product-owner story, full text in <run_dir>/story.md):
- AC1: each of the 10 commands gets a dedicated COMMANDS.md section with synopsis + at least one example, in the style of the existing 19.
- AC2: every synopsis/option/example matches actual registered behavior (no invented flags).
- AC3: a doc-vs-registry coverage check fails when a registered command lacks a dedicated section (or a section exists for a removed command), passes otherwise.
- AC4 (negative): passing mentions (e.g. `codemie hook`/`codemie sound` near COMMANDS.md:1514, `codemie models list` near :351) must not count as documented.
- AC5: the `assistants` section must be clearly distinguished from the existing `setup assistants` section.
- AC6: the check is wired into the merge gate (`npm run ci`) or the pre-commit flow.
- AC7: external follow-up ticket exists and is linked (already done: EPMCDME-17510).
Decisions in story: top-level command granularity (not nested subcommands); check is a vitest test walking program.commands (precedent: src/cli/commands/tips.ts), bidirectional; substring matching rejected.
Repo constraints: AGENTS.md says tests only on explicit request — the ticket AC explicitly requests the coverage check; public repo (no private hostnames).

Verify these claims against the code rather than trusting them (29 vs 19 counts, line numbers, the tips.ts precedent, how npm run ci / lint-staged / vitest are configured, how existing COMMANDS.md sections are structured, whether something like `codemie doctor --agent` is relevant — it is not in scope).

feature_area: cli commands documentation coverage
run_dir: docs/superpowers/tasks/2026-11-27-epmcdme-10549

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: a reader finds every registered top-level command in COMMANDS.md.
- Registry: `src/cli/program.ts:48-127` `createProgram()` (no argv parsing, no side effects beyond reading package.json; "can be loaded from tests"). 30 `addCommand` calls at `program.ts:93-122`: setup profile assistants list install uninstall update self-update doctor version workflow analytics log hook sound skill skills plugin opencode-metrics test-metrics models sdk mcp mcp-proxy proxy codebase docs tips whatsnew completion. `src/cli/index.ts` only calls `createProgram()` and parses argv (52 lines).
- Dedicated COMMANDS.md sections today (19, counted from headings in `docs/COMMANDS.md`, 2122 lines): `## Codebase Memory Commands` :32, `## Documentation & Knowledge Tools` :47, `## Proxy Commands` :84, `## OpenCode Metrics Commands` :1162, `## Workflow Commands` :1214 (+ `### codemie workflow` :1679), `## Plugin Commands` :1242, `## MCP Command` :1271, `## MCP Proxy Command` :1298, `## Analytics Commands` :765, `## Log Management Commands` :1073, `## Profile Management Commands` :730, and under `## Detailed Command Reference` :1384 ``### `codemie setup` ``:1386, `list`:1468, `install [agent]`:1486, `uninstall [agent]`:1504, `update [agent]`:1513, `self-update`:1556, `doctor`:1627, `profile`:1648, `workflow`:1679, `analytics`:1704, `log`:1741, `version`:1908. Distinct top-level commands covered: setup, profile, list, install, uninstall, update, self-update, doctor, version, workflow, analytics, log, plugin, opencode-metrics, mcp, mcp-proxy, proxy, codebase, docs = 19.
- The "Core Commands" code block `COMMANDS.md:3-30` is a one-line-per-command index (not a section). It lists `codemie completion <shell>` at :23 and `setup assistants` at :12.
- Heading shapes are irregular: ``### `codemie <name>` `` (Detailed Reference), `## <Title> Commands`, `## MCP Command`, `## MCP Proxy Command`, `## Proxy Commands`, `## Documentation & Knowledge Tools` (maps to `docs`), `## Codebase Memory Commands` (maps to `codebase`). A name-to-heading rule cannot be derived from the command name alone for ~8 of the 19.
- Command-specific docs elsewhere (not COMMANDS.md): `docs/HOOKS.md` (hook), `docs/SHELL-COMPLETIONS.md` (completion), `docs/SKILLS.md`, `docs/PLUGINS.md` (linked from the Plugin section :1268).

Purpose B: a doc-vs-registry drift check that runs in the merge gate.
- Nothing validates COMMANDS.md against the registry (searched `COMMANDS.md` across src, tests, scripts, package.json, .github: only README/docs links reference it).
- Nearest mechanisms:
  - `src/utils/__tests__/tips-coverage.test.ts:23-31` dynamic-imports `createProgram` and calls `validateCommandExample(program, c)` for every tip command (tips against the tree, not docs against the tree).
  - `src/utils/__tests__/tips-validator.test.ts:90-101` reads README.md, AGENTS.md and every top-level `docs/*.md` (`readdirSync(join(ROOT,'docs'))`) and checks them against the registry for retired flags: the only existing test that reads docs files against the live tree.
  - `tests/integration/completion/sync-guard.test.ts:15-135` walks the tree with its own plain recursive walk (`cmd.commands`, `isHiddenCommand`) and compares to generated completion scripts; explicitly avoids reusing production code for expectations.
  - `src/cli/commands/tips.ts:18-84`: the story's "precedent". It is a runtime user command; `rootOf(command)` climbs to the root and `markStaleTips` validates each tip's example against the tree. It does not walk `program.commands` against a doc artifact, and it is not a test. Closest accurate description: tree-walk-against-an-artifact at runtime.
- Hidden handling: `src/cli/hidden.ts:11-13` `isHiddenCommand(cmd)` (private `_hidden`); no top-level command is hidden today (only `proxy inspect`, `proxy/index.ts:501`; deprecated/removed stubs go through `src/cli/deprecation.ts`).

Per-command source of truth for AC2 (from `node bin/codemie.js <cmd> --help` against current source/dist; locations `src/cli/commands/`):
- `assistants` (`assistants/index.ts`): "Chat with CodeMie assistant"; one subcommand `chat [assistant-id] [message]` with `-v/--verbose`, `--conversation-id <id>`, `--load-history` (help prints "(default: true) (default: true)"), `-f/--file <path>` (repeatable), `--jwt-token <token>`. Separate from `setup assistants` (`COMMANDS.md:1432-1466`, registration into Claude subagents/skills; also `assistants/setup/`).
- `hook` (`hook.ts` + `hook/`): "Unified hook event handler (called by agent plugins)"; options `--agent <name>`, `--event <name>`; exits 2 to block (`hook.ts:721`).
- `sound <event>` (`sound.ts`): "Play a random sound for the given hook event"; no options.
- `skill` (`skill.ts`): `list [--mode --agent --cwd]`, `validate [--cwd]`, `reload`, `sync [--target <agent> (default claude) --clean --dry-run --cwd]`.
- `skills` (`skills/`): `add <source> [-g -s -a -y --copy]`, `update [skills...]`, `remove [skills...]`, `list [-g -a --json]`, `find [query] [--json --limit <n>]`; wraps the upstream skills CLI and the EPAM/skills.sh catalogs.
- `models` (`models.ts`): one subcommand `list`, no options.
- `sdk` (`sdk/index.ts`): 8 groups: assistants, workflows, datasources, integrations, llm, skills, users, assistant-categories; `sdk skills` has list/get/create/update/delete/import and more.
- `tips` (`tips.ts`): `--random`, `--category <name>`.
- `whatsnew` (`whatsnew.ts`): `[version]`, `--all`; reads CHANGELOG.md.
- `test-metrics` (`test-metrics.ts`): `-a/--agent <name>` (default codemie-code), `-m/--model <id>` (default test-model), `--client-type <type>`, `--project <name>`, `--dry-run`, `-v/--verbose`.

### Decisions Already in the Code

- Convention for one-off tests that need the whole tree: call `createProgram()` from `src/cli/program.ts` (not `index.ts`, which parses argv at import). Used with a dynamic `await import('../program.js')` in `program.test.ts`, `tips-coverage.test.ts`, `removal-date.test.ts`; static `import { createProgram } from '@/cli/program.js'` in `tests/integration/completion/*.test.ts` and `src/cli/completion/__tests__/tree.test.ts`.
- Convention for hidden commands in tree walks: skip via `isHiddenCommand` (`sync-guard.test.ts:27-41`).
- Vitest projects (`vitest.config.ts`): `unit` includes `src/**/*.test.ts`; `cli` includes `tests/integration/**/*.test.ts` minus `agent-*`; `agent` is real-network and excluded from `npm run ci`. Both `unit` and `cli` set `clean-env` setup and `alias '@' -> /src`.
- Docs-reading tests locate the repo root via a `ROOT` constant and `readdirSync`/`readFileSync` (`tips-validator.test.ts:90-93`).
- COMMANDS.md style for command sections (e.g. `setup assistants` :1432-1466; `Plugin Commands` :1242-1269): short description, `bash` fenced synopsis/examples (often with `#` comments), `**Options:**` bullet list with backticked flags, optional `**Features:**` / `**Workflow:**`, pointer to a dedicated doc via "For full documentation, see [X](./X.md)".
- Output defaults that embed local paths (`skill list/validate/sync --cwd` default is the process cwd) appear in `--help` as machine-specific strings.

### Task Statements Checked Against the Code

- "The CLI registry composes 29 subcommands (src/cli/index.ts ~84-112)": **contradicted on both counts**. The registry is `src/cli/program.ts:93-122` and has **30** `addCommand` calls: `completion` (`program.ts:40,122`, added by commit f005d97c, #895) is the 30th. `dist/` is stale and enumerates 29 (no `completion`); `src/cli/index.ts` has no `addCommand` calls.
- "COMMANDS.md has dedicated sections for 19": **holds** (19 by the heading count above), but then 30 - 19 = 11 lack a dedicated section: the 10 named plus `completion`, which has only the one-line index entry `COMMANDS.md:23` and a dedicated doc `docs/SHELL-COMPLETIONS.md`.
- "The 10 undocumented commands: assistants, hook, sound, skill, skills, models, sdk, tips, whatsnew, test-metrics": **holds** for those 10 (no heading or section for any); incomplete (see completion).
- "Passing mentions near :1514 and :351": line numbers are slightly off. Actual: `codemie hook`/`codemie sound` at `COMMANDS.md:1597` (self-update section; :1513 is the `update [agent]` heading) and 2047 (`codemie hook` without `--agent`); `codemie models list` at `COMMANDS.md:403` (oh-my-pi section; :351 is Claude Desktop troubleshooting). Substance holds: incidental mentions only. Also `setup assistants` at :12, :1416, :1432.
- "Precedent: src/cli/commands/tips.ts walking the commander tree": **partly holds**, see Existing Implementations (runtime command validating tips against the tree, not docs). `sync-guard.test.ts` and `tips-validator.test.ts` are closer precedents for a test that walks the tree and reads docs.
- "lint-staged already runs `vitest related` on changed `.ts` files": **holds** (`package.json:64-72`: `*.ts` -> eslint + `vitest related --run --exclude tests/integration/agent-*.test.ts --exclude tests/integration/cli-commands/models.test.ts`; `package.json` -> `license-check`). A change to only `docs/COMMANDS.md` triggers no lint-staged task; `vitest related` follows module imports and a test that reads the md by path has no import edge to it.
- "`npm run ci` is the merge gate": **holds** (`package.json:58`: license-check, lint, build, `vitest run --project unit`, `vitest run --project cli`). A new test under `src/**/*.test.ts` or `tests/integration/**` is picked up by `ci` without config changes. `.github/workflows/ci.yml:106-109,142-145` runs the same two vitest projects directly (not `npm run ci`) on Linux and Windows; `publish.yml:55` runs `npm run ci`. `.husky/pre-commit` runs lint-staged, `typecheck`, `validate:secrets`.
- "Tests only on explicit request (AGENTS.md)" with the ticket as the request: **holds** as stated in AGENTS.md "Tests Only On Explicit Request"; whether the ticket text counts is outside what the code can settle.
- "Substring match rejected": consistent with code; `docs/COMMANDS.md` contains `codemie hook`, `codemie sound`, `codemie models list`, `setup assistants` as substrings today, so a substring rule would pass for hook, sound, models, assistants.
- "No consumer of COMMANDS.md in codemie, codemie-ui, codemie-sdk": **unverified** here (outside this repository). In this repo COMMANDS.md is linked from `README.md` (:270, :623, :698, :709, :740, :779, :826, :881), `docs/ANALYTICS-REPORT.md:419`, `docs/ANALYTICS-SYNC.md:817`, `docs/ARCHITECTURE-PROXY.md:952`, `docs/HOOKS.md:578` by file and anchor.
- "`codemie doctor --agent` not in scope": not verified, not needed.

### Consumers of Changed Contracts

- Anchors into COMMANDS.md: README and docs link by heading slug (`#documentation--knowledge-tools`, `#claude-desktop-3p`, `#claude-code-otlp-analytics`, `#analytics-for-every-client-of-a-vendor`, `#team-lead-setup-analytics-sync-bootstrap`, `#copilot-cli-and-copilot-chat-analytics--disable`, `#mcp-proxy-command`). New sections add headings and do not rename these; renaming a heading to satisfy a heading-convention rule would break them.
- Registry consumers that react to a new/removed top-level command: completion generator (`src/cli/completion/`, guarded by `sync-guard.test.ts`), `src/cli/related-commands.ts` (`RELATED` keyed by path, `applyRelatedHelp` at `program.ts:124`; test `related-commands.test.ts`), tips (`tips-validator`, `tips-coverage`), `hint-prefix-ban.test.ts`. None read COMMANDS.md.
- `docs/COMMANDS.md` readers in tests: `tips-validator.test.ts:90-101` scans it (with all `docs/*.md`) for retired flags; new sections must not contain retired flags or deprecated forms or that test fails (`docs/superpowers`, `docs/stories` are excluded). Sample text copied from `sdk assistants --help` shows `codemie assistants list` (help examples print the wrong prefix; the real path is `codemie sdk assistants list`).
- OpenWiki (`openwiki/`, generated): not hand-edited per AGENTS.md.

### Architecture and Layers Affected

- Documentation layer: `docs/COMMANDS.md` only.
- Test layer: one new vitest file (unit project `src/cli/__tests__/` or cli project `tests/integration/`); reads `src/cli/program.ts` output and `docs/COMMANDS.md`.
- No production code, config, or registry change is needed for documentation; commands are self-contained commander factories.

### Integration Points

- `createProgram()` pulls in `../providers/index.js` and `../frameworks/plugins/index.js` (self-registering plugin side effects) on import; other tests already import it under the same vitest env.
- No external services involved in the check; the sections describe commands that call CodeMie API (`assistants chat`, `sdk`, `test-metrics`) and `skills.sh`, which are not exercised.

### Patterns and Conventions

- ESM with `.js` import extensions and `@/` alias; `.test.ts` co-located in `__tests__/` under `src/`, or under `tests/integration/`.
- Existing tests that walk the tree avoid depending on production helper output for the expected set (`sync-guard.test.ts` header comment).
- AGENTS.md pitfalls: no private hostnames, no `console.log`, zero-warning lint (`--max-warnings=0`, eslint over `{src,tests}/**/*.ts`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
- `.ai-run/guides/` exists (architecture, development, integration, security, standards, testing, usage, `project.md`, `quality-gates.md`). `quality-gates.md` line 83 documents `npm run ci` as `license-check && lint && build && vitest run --project unit && vitest run --project cli`; no guide mentions COMMANDS.md or doc-vs-registry checks.
- `docs/HOOKS.md`, `docs/SKILLS.md`, `docs/SHELL-COMPLETIONS.md`, `docs/PLUGINS.md` are the per-feature docs that new COMMANDS.md sections can point to.

### Architectural Decisions
- `docs/stories/` and `docs/specs/` hold earlier run artifacts; none concerns COMMANDS.md coverage.

### Derived Conventions
- See "Decisions Already in the Code" for the section style.

---

## 4. Testing Landscape

### Existing Coverage
- `src/cli/__tests__/` : `program.test.ts` (tree structure and argv parsing via `createProgram`), `related-commands.test.ts`, `removal-date.test.ts`, `hidden.test.ts`, `deprecation.test.ts`, `hint-prefix-ban.test.ts`. `src/cli/commands/__tests__/` (hook, install, self-update, whatsnew, completion, etc.). `tests/integration/completion/sync-guard.test.ts` (registry vs generated completion scripts). `src/utils/__tests__/tips-coverage.test.ts`, `tips-validator.test.ts`.
- Nothing asserts COMMANDS.md covers the registry.

### Testing Framework and Patterns
- Vitest (`vitest.config.ts`), projects `unit` / `cli` / `agent`, `globals: true`, 30 s timeouts, env isolated through `tests/setup/clean-env.ts`. `npm test` also runs `agent` project; `npm run ci` does not.

### Coverage Gaps
- COMMANDS.md vs registry (the task). 
- `src/cli/index.ts` has no test.

---

## 5. Configuration and Environment

### Environment Variables
- None used by the feature area. Test env comes from `vitest.config.ts:16-24` (`CODEMIE_HOME` temp dir, `NODE_ENV=test`).

### Configuration Files
- `package.json:37-72` scripts and lint-staged; `vitest.config.ts`; `eslint.config.mjs`; `.husky/pre-commit` (lint-staged, typecheck, validate:secrets); `.github/workflows/ci.yml` and `publish.yml`.

### Feature Flags and Deployment Concerns
- None. CI installs zsh and fish for the completion tests (`ci.yml` Linux job) — irrelevant to this check. Windows CI runs both projects, so a docs-reading test must work on Windows (CRLF is prevented by `.gitattributes` `* text=auto eol=lf`).

---

## 6. Risk Indicators

- Registry has 30 top-level commands, not 29 (`completion` is the 30th; `COMMANDS.md:23` one-line index entry only). A bidirectional check that passes the "dedicated section" rule on 29 would fail on `completion` unless it gets a section or an explicit exemption. Speculative: the story's 10-command scope and the check cannot both be satisfied without a decision on `completion`.
- Stale `dist/`: running `node bin/codemie.js` lists 29 commands, so manual `--help` verification (AC2) reads a build that lacks `completion` and may differ from `src/`. A vitest check using `createProgram()` from source is not affected.
- Heading shapes are inconsistent across the 19 existing sections (`## ... Commands`, `## MCP Command`, ``### `codemie x` ``, `## Documentation & Knowledge Tools` for `docs`, `## Codebase Memory Commands` for `codebase`). Any matching rule needs either a mapping/aliases or a normalized heading form; story NG5 forbids restructuring the 19. Speculative: a rule over only ``### `codemie <name>` `` headings would reject 9+ existing sections.
- Reverse direction ("a section exists for a removed command") needs a way to identify which headings are command sections; sub-feature headings (e.g. `### Claude Desktop 3P`, `### Headless Mode`, `#### codemie setup skills`) are not command sections.
- Duplicate sections for the same command already exist (`analytics`, `log`, `profile`, `workflow` each have a `## ... Commands` section and a ``### `codemie x` `` entry); a one-section-per-command assertion would conflict.
- `tips-validator.test.ts:90-101` scans COMMANDS.md for retired/deprecated forms; new text must stay clean.
- Passing mentions: `codemie hook`/`codemie sound` (:1597, :2047), `codemie models list` (:403), `setup assistants` (:12, :1416, :1432); the story's cited lines :1514 and :351 are off.
- `sdk` and `skills`/`skill` have wide nested trees; `sdk * --help` examples print `codemie assistants ...` instead of `codemie sdk assistants ...`; `--cwd` defaults print the local absolute path; `--load-history` help shows "(default: true)" twice. Copying help output verbatim would introduce wrong or machine-specific text (AC2, public repo).
- AGENTS.md "tests only on explicit request" is in tension with adding the check unless the ticket counts as the request (story D4 asserts it does).
- Pre-commit: a docs-only edit does not trigger `vitest related`; coverage is enforced at `npm run ci` / the GitHub Actions vitest jobs, not at commit time for md-only changes.
- OpenWiki regeneration noise from a large COMMANDS.md edit (AGENTS.md OpenWiki section).

---

## 7. Summary for Complexity Assessment

The change touches the documentation layer (`docs/COMMANDS.md`, ~10-11 new sections in an established markdown style) and adds one test file. No production code or configuration is involved: every command is a self-contained commander factory whose `--help` output gives the option list, and `createProgram()` (`src/cli/program.ts`) already exposes the tree to tests. Both a unit-project and a cli-project location are already included in `npm run ci`, so wiring (AC6) needs no config change.

Technical novelty is low; similar tests exist (`sync-guard.test.ts`, `tips-validator.test.ts`, `tips-coverage.test.ts`). The real complexity is in the matching rule: the 19 existing sections use irregular heading shapes and some commands have two sections, the reverse direction needs a notion of which headings are command sections, and passing mentions (hook, sound, models, setup assistants) must not count. The task's premises differ from the code: the registry has 30 commands (`completion` has no dedicated section), and it lives in `program.ts`, not `index.ts`.

Test posture: no existing check on COMMANDS.md; surrounding registry tests are solid and show the patterns. Key risks: the `completion` gap, heading-shape irregularity, stale `dist/` during manual verification, and copying inaccurate help text.

---

## 8. External References

None named by the task. (The story file `docs/superpowers/tasks/2026-11-27-epmcdme-10549/story.md` is the run's own input and was read; Jira EPMCDME-10549 and EPMCDME-17510 were not opened — outside this repository.)
