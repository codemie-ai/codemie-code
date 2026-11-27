# COMMANDS.md coverage and drift check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every registered top-level command a dedicated section and a Core Commands index line in `docs/COMMANDS.md`, guarded by one vitest check that fails when doc and registry drift.

**Architecture:** One new unit-project test parses `docs/COMMANDS.md` headings (parser) and applies three rules (forward, reverse, index) against `createProgram()`. Docs are then written until the test is green. No production, config or CI change.

**Tech Stack:** TypeScript ESM, Vitest (unit project), commander, Markdown.

**Spec:** `docs/superpowers/tasks/2026-11-27-epmcdme-10549/spec.md` (supersedes the story: 30 commands, 11 missing sections, registry in `src/cli/program.ts`). Analysis: `technical-analysis.md` in the same directory.

Commit per task using the repository's existing convention.

## Global Constraints

- ES modules, `.js` import extensions, `@/` alias where it helps, no `any`, no `console.log`.
- Only the one coverage test is written or run (ticket is the explicit test request); no other tests added.
- Do not edit, rename or remove any existing heading or Core Commands line in `docs/COMMANDS.md` (NG5; README anchors depend on them).
- Public repo: no private hostnames, no machine-specific paths in docs.
- New text must contain no retired or deprecated command forms (`src/utils/__tests__/tips-validator.test.ts:90-101` scans `docs/*.md`).
- Production code, `package.json`, CI config, other docs and `openwiki/` are out of scope.
- No whole-suite gate here; Stage 7 owns lint, typecheck, build and the full run.

## Review Focus

- A command named only in body text (`codemie hook`, `codemie sound`, `codemie models list`, `setup assistants`) must be reported undocumented.
- Fenced `bash` lines starting with `#` (comments) must not be parsed as headings.
- CRLF checkout on Windows CI must not break parsing or the empty-body rule (read as `utf8`, split on `\r?\n`).
- A legacy heading renamed or a section left for a removed command must fail with a message naming it.
- A hidden command stays valid for the reverse rule but is not demanded by the forward rule.

## File Structure

- Create `src/cli/__tests__/commands-doc-coverage.test.ts`: parser, three rules, parser self-checks.
- Modify `docs/COMMANDS.md`: 12 index lines in the first fenced block under `## Core Commands`; 11 ``### `codemie <name>` `` sections inserted after the `codemie version` section (it ends before `### Analytics for every client of a vendor`, currently line 1922).

### Task 1: Coverage test (parser and rules)

**Files:**
- Create: `src/cli/__tests__/commands-doc-coverage.test.ts`

**Interfaces:**
- Produces (file-local, not exported): `interface DocHeading { level: number; heading: string; commandPath: string[]; body: string }`; `parseHeadings(markdown: string): DocHeading[]`; `const DOC_PATHS: string[]` (one entry, `docs/COMMANDS.md`); `const LEGACY_ALIASES: Record<string, string>` (the 11 spec entries, heading text to command).
- Consumes: `createProgram()` via `await import('../program.js')`; `isHiddenCommand` from `../hidden.js`.

Test-first: yes — rules 1 and 3 fail against the unmodified `docs/COMMANDS.md`, reporting exactly 11 missing sections (assistants, hook, sound, skill, skills, models, sdk, tips, whatsnew, test-metrics, completion) and 12 missing index lines; parser self-checks pass.

- [ ] **Step 1: Write the test file.** Conventions to copy: repo root `join(import.meta.dirname, '..', '..', '..')` as `src/utils/__tests__/tips-validator.test.ts:7` (this file sits in `src/cli/__tests__/`, same depth); dynamic import of `../program.js` as `tips-validator.test.ts:16`; hidden skip as `tests/integration/completion/sync-guard.test.ts:27-41`.
  - `parseHeadings`: split on `\r?\n`; toggle `fenced` on `/^\s*(```|~~~)/` (copied from `src/utils/tips-validator.ts:145`); outside fences match `/^(#{2,4})\s+(.+?)\s*$/`; `commandPath` = words after `codemie` for form (a) ``` `codemie <name> ...` ```, or `[LEGACY_ALIASES[heading]]` for an alias heading, else `[]`; `body` = text until the next level 2-4 heading outside fences.
  - Rule 1 (forward): each visible top-level command has a heading with `commandPath[0] === name` and a body with a non-blank line. Message: `COMMANDS.md has no non-empty section for "codemie <name>"; add a ### \`codemie <name>\` section`.
  - Rule 2 (reverse): every `commandPath[0]` is in the set of ALL `program.commands` names (hidden included); every `LEGACY_ALIASES` key still appears as a heading text. Messages name the heading or alias.
  - Rule 3 (index): in the first fenced block after the `## Core Commands` heading, match lines with `/^codemie\s+(\S+)/`, skip tokens starting with `-`; every visible command must appear. Message names the missing command and says to add a line to Core Commands.
  - Parser self-checks (fixture strings, no files): fenced `# comment` is not a heading; body-only `codemie hook` yields no mapped heading; CRLF input parses the same as LF; ``#### `codemie setup assistants` `` maps to `setup`.
  - Tests: `it('every visible command has a section')`, `it('every mapped heading names a registered command')`, `it('every legacy alias heading still exists')`, `it('every visible command is in the Core Commands index')`, plus the parser self-checks.
- [ ] **Step 2: Run** `npx vitest run src/cli/__tests__/commands-doc-coverage.test.ts`. Expected: red as described (AC3 run i). If a legacy heading shows an empty body or rule 2 gives a false positive, loosen the test, never the doc (NG5), and note it in a test comment.
- [ ] **Step 3: Run** `npx vitest related --run src/cli/program.ts` once with the test present and record whether it lists `commands-doc-coverage.test.ts` (spec risk "Commit time"). Report the result in the task digest only; no file change.

### Task 2: Core Commands index lines

**Files:**
- Modify: `docs/COMMANDS.md:5-30` (insert only; existing lines untouched).

Test-first: no — rule 3 of Task 1's test is the red check; it goes green when these lines exist.

- [ ] **Step 1: Add 12 new lines** to the first fenced block, in the existing `codemie <name>   # description` alignment, placed near related lines: `assistants`, `hook`, `sound`, `skill`, `skills`, `models`, `sdk`, `tips`, `whatsnew`, `test-metrics`, `proxy`, `opencode-metrics`. Do not add `completion` (line 23 exists). Descriptions: one short phrase each, from each command's `.description()` under `src/cli/commands/` (`proxy/index.ts`, the opencode-metrics command file, `assistants/index.ts`, `hook.ts`, `sound.ts`, `skill.ts`, `skills/`, `models.ts`, `sdk/index.ts`, `tips.ts`, `whatsnew.ts`, `test-metrics.ts`). Run the test: rule 3 passes.

### Task 3: Sections for assistants, hook, sound, models, tips, whatsnew, test-metrics, completion

**Files:**
- Modify: `docs/COMMANDS.md` (insert after the ``### `codemie version` `` section, before `### Analytics for every client of a vendor`).
- Read for facts (do not paste `--help`): `src/cli/commands/assistants/index.ts`, `hook.ts` (exit code 2 blocks, `hook.ts:721`), `sound.ts`, `models.ts`, `tips.ts`, `whatsnew.ts`, `test-metrics.ts`, `completion.ts`, all under `src/cli/commands/`; plus `docs/HOOKS.md`, `docs/SHELL-COMPLETIONS.md`.

Test-first: no — Task 1 rule 1 is the failing check; each section turns one missing command green.

- [ ] **Step 1: Write eight ``### `codemie <name>` `` sections**, each in the existing style (one-line purpose, `bash` synopsis plus at least one example, `**Options:**` bullets with backticked flags, pointer link where a dedicated doc exists: hook to `HOOKS.md`, completion to `SHELL-COMPLETIONS.md`). Facts to honor:
  - `assistants`: first lines contrast `codemie assistants chat` (talks to a CodeMie assistant) with `codemie setup assistants` (registers assistants as Claude subagents or skills) and link to that existing section; subcommand `chat [assistant-id] [message]` with `-v/--verbose`, `--conversation-id <id>`, `--load-history` (state the default once), `-f/--file <path>` (repeatable), `--jwt-token <token>`.
  - `hook`: `--agent <name>`, `--event <name>`; called by agent plugins; exit code 2 blocks.
  - `sound <event>`: no options. `models`: only `list`, no options.
  - `tips`: `--random`, `--category <name>`. `whatsnew [version]`: `--all`; reads CHANGELOG.md.
  - `test-metrics`: `-a/--agent <name>` (default codemie-code), `-m/--model <id>` (default test-model), `--client-type <type>`, `--project <name>`, `--dry-run`, `-v/--verbose`.
  - `completion <shell>`: bash, zsh, fish; confirm shells and options in `completion.ts`.
  Verify every flag against source; none invented.
- [ ] **Step 2: Run the test.** Rule 1 now reports only skill, skills, sdk.

### Task 4: Sections for skill, skills, sdk

**Files:**
- Modify: `docs/COMMANDS.md` (directly after Task 3's sections).
- Read for facts: `src/cli/commands/skill.ts`, `src/cli/commands/skills/` (all subcommand files), `src/cli/commands/sdk/index.ts` and its group files, `docs/SKILLS.md`.

Test-first: no — Task 1 rule 1 is the failing check for these three commands.

- [ ] **Step 1: Write three ``### `codemie <name>` `` sections** that summarize (spec R3): list groups or actions in one list each and point to `codemie <name> --help` for the rest.
  - `skill`: `list [--mode --agent --cwd]`, `validate [--cwd]`, `reload`, `sync [--target <agent> (default claude) --clean --dry-run --cwd]`; write the `--cwd` default as "current directory", never an absolute path; link `SKILLS.md`.
  - `skills`: `add <source> [-g -s -a -y --copy]`, `update [skills...]`, `remove [skills...]`, `list [-g -a --json]`, `find [query] [--json --limit <n>]`; one sentence that it wraps the upstream skills CLI and the catalogs, confirmed in source.
  - `sdk`: the 8 groups (assistants, workflows, datasources, integrations, llm, skills, users, assistant-categories); examples use the real path `codemie sdk assistants list`, not the `codemie assistants ...` text printed by `sdk <group> --help`.
- [ ] **Step 2: Run the test.** Expected: all rules green.

### Task 5: Acceptance proofs

**Files:**
- Create then delete: a scratch copy of `docs/COMMANDS.md` (under the OS temp dir).
- Temporarily modify, then restore: the `DOC_PATHS` entry in the test.

Test-first: no — verification of Task 1's reverse rule and doc accuracy; no new behavior.

- [ ] **Step 1: AC3 run (iii).** In the scratch copy add ``### `codemie nosuch` `` with a body line and rename `## MCP Command` to another title; point the `DOC_PATHS` entry at the copy; run the test. Expected: failures naming `nosuch` and `MCP Command`. Restore the entry to `docs/COMMANDS.md`, delete the scratch copy, confirm `git status` shows no scratch file.
- [ ] **Step 2: AC4 spot check.** Temporarily rename only the new `hook` heading in `docs/COMMANDS.md` (body text still mentions `codemie hook`); the test must still report hook undocumented. Restore.
- [ ] **Step 3: AC7.** Run `npx vitest run src/utils/__tests__/tips-validator.test.ts` (the existing file that scans the new text). Expected: PASS; fix new doc text if it flags a retired form.
- [ ] **Step 4: Final run** of `npx vitest run src/cli/__tests__/commands-doc-coverage.test.ts`: PASS (AC3 run ii).
- [ ] **Step 5: Diff review.** `git diff docs/COMMANDS.md` must show additions only (no changed or removed existing lines, AC8).

## Negative-constraint pass

- NG5, no edits to existing headings or index lines: Tasks 2-4 insert only; Task 5 Step 5 verifies.
- Substring matching rejected, body text never counts: Task 1 parser (headings only) and self-check; Task 5 Step 2.
- No production/config/CI change, no tests beyond the one file: Global Constraints; no task touches them.
- No pasted `--help`, no invented flags, no machine paths: Tasks 3-4 name the source files and the traps.
- Existing sections not rewritten to fit a heading rule: alias table in Task 1.
- No exhaustive `sdk`/`skills` trees (NG3): Task 4 summarizes.
