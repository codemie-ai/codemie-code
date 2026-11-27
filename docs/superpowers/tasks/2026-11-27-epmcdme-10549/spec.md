# Spec: COMMANDS.md covers every registered command, with a drift check

Ticket EPMCDME-10549 (part A, repo `codemie-code`). Story: `story.md`. Research: `technical-analysis.md`. Size S (14/36).

This spec supersedes the story's premises where they differ from the code: 30 registered commands (not 29), 11 without a section (not 10), registry in `src/cli/program.ts` (not `index.ts`), size 14/36 (not 13/36).

## Problem

`docs/COMMANDS.md` is the user-facing command reference. The registry is `src/cli/program.ts:93-122` (`createProgram()`) with **30** top-level commands. 19 have a dedicated section. 11 do not: the story's 10 (`assistants`, `hook`, `sound`, `skill`, `skills`, `models`, `sdk`, `tips`, `whatsnew`, `test-metrics`) plus `completion`, which has only the index line at `COMMANDS.md:23` and `docs/SHELL-COMPLETIONS.md`. The "Core Commands" index (`COMMANDS.md:5-30`) lists 18 of the 30 (it also lacks `proxy` and `opencode-metrics`). Nothing checks the doc against the registry, so it drifts again. (story AC1, AC3)

## Requirements

**R1. Eleven new sections.** One section per command above, as ``### `codemie <name>` `` headings placed after the `codemie version` section (before `### Analytics for every client of a vendor`) in the existing style: one-line purpose, `bash` synopsis plus at least one example, `**Options:**` bullets, and a pointer to the dedicated doc where one exists (`HOOKS.md`, `SKILLS.md`, `SHELL-COMPLETIONS.md`). (story AC1)

**R1a. Index.** Add one Core Commands line for each of the 12 commands that lack one: the 10 new ones other than `completion` (which already has line 23) plus `proxy` and `opencode-metrics`. New lines only; existing lines are not edited (story NG5). After this the index lists all 30.

**R2. Accuracy from the implementation.** Text is written from the command sources under `src/cli/commands/` (per-command list in the analysis, section 2), not pasted from `--help`. `dist/` is stale (29 commands, no `completion`), so any manual `--help` run follows a rebuild. Known traps: `sdk <group> --help` examples print `codemie assistants ...` where the real path is `codemie sdk assistants ...`; `--cwd` defaults embed a local absolute path (write "current directory"); `--load-history` help prints its default twice; `hook` exits 2 to block (`hook.ts:721`). No invented flags. (story AC2)

**R3. `sdk`, `skills`, `skill` summarize.** List groups/actions in one list each and point to `--help` for the rest. (story NG3)

**R4. `assistants` is distinguished.** The section opens with one plain contrast: `codemie assistants chat` talks to a CodeMie assistant; `codemie setup assistants` registers assistants as Claude subagents or skills. It links to the `setup assistants` section. The existing section is not edited. (story AC5)

**R5. Coverage test** `src/cli/__tests__/commands-doc-coverage.test.ts` (unit project, so `npm run ci` runs it with no config change). It imports `createProgram()` dynamically as `program.test.ts` does, finds the repo root as `tips-validator.test.ts` does, and skips hidden commands via `isHiddenCommand` as `sync-guard.test.ts` does. Structure: a **parser** reads the doc and returns `{level, heading, commandPath, body}` per heading; **rules** read `commandPath[0]`. The doc path is held as a one-entry list. A later nested-coverage, option check or split of COMMANDS.md then changes rules, not the parser. (story AC3, AC4, AC6)

- *Parsing.* Headings of levels 2-4 outside fenced code blocks, using the fence rule of `tips-validator.ts:145` copied as is (`/^\s*(```|~~~)/` with a toggle; production code is out of scope, so no export). Body text never counts, so passing mentions (`codemie hook`, `codemie sound`, `codemie models list`, `setup assistants`) document nothing.
- *Heading to command.* (a) Form ``### `codemie <name> ...` ``: `<name>` is the first word after `codemie`, so ``#### `codemie setup assistants` `` maps to `setup`. (b) A fixed alias table in the test for the 11 legacy headings: `Codebase Memory Commands`->codebase, `Documentation & Knowledge Tools`->docs, `Proxy Commands`->proxy, `OpenCode Metrics Commands`->opencode-metrics, `Workflow Commands`->workflow, `Plugin Commands`->plugin, `MCP Command`->mcp, `MCP Proxy Command`->mcp-proxy, `Analytics Commands`->analytics, `Log Management Commands`->log, `Profile Management Commands`->profile. Every other heading is a sub-feature heading and is ignored.
- *Two command sets.* **Forward** uses visible top-level commands (hidden skipped). **Reverse** uses every name in `program.commands`, hidden included, so a deprecated hidden command keeps its section during the deprecation window. None is hidden today.
- *Rule 1, forward.* Every visible command has at least one mapped heading with a non-empty body (any non-blank line before the next heading). Several sections per command (analytics, log, profile, workflow) are fine.
- *Rule 2, reverse.* Every name mapped from form (a) or the alias table is a registered command; every alias key still exists as a heading, so a renamed legacy heading fails loudly.
- *Rule 3, index.* Every visible command appears as the first word after `codemie` on a line of the first fenced block under `## Core Commands`. Tokens starting with `-` (`codemie --help`) are ignored. The index is not checked in reverse.
- Failure messages name the command or heading and say what to add.
- Limits: the test proves a section exists and is non-empty, not that it has a synopsis or example. R1 and R2 are reviewed by hand.

## Acceptance criteria

1. Each of the 11 commands has a ``### `codemie <name>` `` section with a synopsis and at least one example. (story AC1)
2. Every synopsis, option and example in the new text matches the implementation; none is copied from the known-bad help output in R2. (story AC2)
3. The test passes on the final tree and fails when a registered command has no mapped section, a mapped heading or alias names an unregistered command, or a visible command is missing from the index. Three runs prove it:
   (i) against the unmodified COMMANDS.md it reports the 11 missing sections and the 12 missing index lines;
   (ii) after the edit it passes;
   (iii) on a scratch copy of COMMANDS.md with ``### `codemie nosuch` `` added and `## MCP Command` renamed, it fails and names each. The scratch copy is deleted afterwards. (story AC3)
4. A command mentioned only in body text (hook, sound, models, `setup assistants`) is reported as undocumented. (story AC4)
5. `assistants` states its difference from `setup assistants` in its first lines and links to it. (story AC5)
6. The test runs under `npm run ci` (unit project) and on Linux and Windows CI. (story AC6)
7. `tips-validator.test.ts` still passes: the new text has no retired or deprecated forms. The external follow-up EPMCDME-17510 exists and is linked; no work here. (story AC7)
8. No existing heading or index line is renamed, edited or removed, so README and doc anchors still resolve. (story NG5)

## Decisions

- Add a `completion` section over exempting it: the check needs no exemption list, and one short section pointing at `SHELL-COMPLETIONS.md` costs less than an exception to explain.
- Match on headings only over body-text or substring matching: substring matching passes hook, sound, models and assistants today.
- Alias table in the test for the 11 legacy headings over renaming them: renaming breaks anchors (`#documentation--knowledge-tools`, `#mcp-proxy-command`) and violates story NG5. New sections use the backtick form, so the table never grows. Retire condition: it goes when a docs change renames the legacy headings and keeps the old links with explicit `<a id>` anchors. All 11 entries stay, although 5 (Proxy, Workflow, Analytics, Log, Profile) already have a backtick heading and add no forward coverage, because they give the reverse rule a second chance to catch a stale section.
- Guard the Core Commands index with Rule 3 over declaring it an unguarded convenience list: a reader scans it first, and an unchecked second command list drifts at the next command, the failure this ticket exists to stop.
- Add 12 index lines (not 11, not 10): `completion` already has one and `proxy`, `opencode-metrics` lacked one.
- Reverse rule checks all registered names including hidden, forward only visible, over one shared set: a deprecated hidden command keeps its section for the deprecation window.
- Reverse direction checks only headings that map to a command, over checking every heading: sub-feature headings are not command sections.
- Any one mapped section satisfies a command over exactly one: four commands already have two sections.
- Test in the unit project at `src/cli/__tests__/` over `tests/integration/`: it needs no built binary, as `program.test.ts` does.
- Fence detection copies the `tips-validator.ts:145` rule over defining a second one.
- Enforcement is `npm run ci` only, with no lint-staged rule for `docs/COMMANDS.md`, over a second mechanism: AC6 allows either, and `ci.yml` runs on every pull request. A docs-only commit gets no commit-time check; that is accepted.
- D3: coverage granularity is top-level commands, not nested subcommands. (story D3)
- D4: the check is a vitest test walking `program.commands`, bidirectional, substring matching rejected. The precedent references are corrected: `tips.ts` is a runtime command; the test precedents are `sync-guard.test.ts` and `tips-validator.test.ts`. (story D4)
- The ticket text is the explicit test request that AGENTS.md requires, for this one test only: no other tests are written or run. (story D4)

## Non-goals

- NG1: Revalidating the "Mastering CodeMie Code CLI" Kata (EPMCDME-17510). (story NG1)
- NG2: The `codemie analytics show` vs UI discrepancy (EPMCDME-17510). (story NG2)
- NG3: Exhaustive documentation of the `sdk` and `skills` nested trees. (story NG3)
- NG4: Changes to `codemie`, `codemie-ui` or `codemie-sdk`. (story NG4)
- NG5: Rewriting, renaming or restructuring the 19 existing sections or the existing index lines. (story NG5)
- Checking nested subcommands, or that a section has a synopsis or example, by test.
- Production code, registry, `package.json` or CI config changes; docs outside `docs/COMMANDS.md`; hand-editing `openwiki/`.

## Risks

- A legacy section with an empty body would fail Rule 1; per NG5 the fix is to loosen the test, not edit the section. The first run against the current file shows it.
- Rule 2 runs over the 19 legacy headings for the first time; a false positive there is possible, and run (i) and (iii) of AC3 are where it shows.
- Commit time: lint-staged skips docs-only changes. At implementation, run `vitest related --run src/cli/program.ts` once with the test present; if it picks the test up, this gap is smaller than stated.
- Deeper (nested) coverage later rewrites the rules, not the parser; it has no owner or follow-up.
- NG4 is unverified outside this repository.
- Windows CI: read with `utf8` and split on `\r?\n`.
