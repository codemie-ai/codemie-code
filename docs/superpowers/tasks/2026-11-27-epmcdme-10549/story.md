---
schema_version: 1
id: epmcdme-10549-commands-md-coverage
mode: single
repository: codemie-code
---
# Document the 10 undocumented CLI commands in COMMANDS.md — Story

**Date**: 2026-11-18
**Status**: Approved
**Architecture review**: intent, 2026-11-18, approve (see arch-review/arch-review-brief.local.md)
**Ticket**: EPMCDME-10549

---

## Context

- The CLI registry composes exactly 29 subcommands via `program.addCommand(...)` in `codemie-code/src/cli/index.ts:84-112`; `docs/COMMANDS.md` has dedicated sections for 19 of them. The 10 without a section: `assistants`, `hook`, `sound`, `skill`, `skills`, `models`, `sdk`, `tips`, `whatsnew`, `test-metrics`.
- The only mentions of those 10 in COMMANDS.md today are incidental pass-throughs (`codemie hook`, `codemie sound` inside the self-update section at line 1514; `codemie models list` in the proxy section at line 351) — a naive name-in-file check would wrongly count them as documented.
- No doc-vs-registry check exists anywhere: nothing in `src/`, `scripts/`, `package.json` or `tests/` validates COMMANDS.md against the registry. A runtime precedent for registry-walking drift detection exists in `src/cli/commands/tips.ts` (walk the commander tree, compare against an artifact).
- `hook` and `sdk` are the deepest commands: `hook` is a plugin-invoked event handler (also the OTLP adapter entry point, documented in `docs/HOOKS.md`); `sdk` has 8 asset subcommands with ~20+ nested actions under `sdk skills`. Full subcommand enumeration would bloat the doc; concise sections with pointers fit the existing style.
- `assistants` (chat with a CodeMie assistant) is easily confused with the already-documented `codemie setup assistants` (registration flow); the new section must disambiguate.
- Cross-repo non-impact confirmed: no consumer or duplicator of COMMANDS.md or the command registry exists in `codemie`, `codemie-ui` or `codemie-sdk` (workspace-wide grep).

---

## Complexity

**Size**: S (13/36) · **Recommended flow**: sdlc-light

Documentation-primary change: one doc file (10 sections in an established style) plus one small coverage-check asset; all 10 command sources are self-contained commander factories and a near-exact registry-walking precedent exists (`tips.ts`).

---

## Story

**As a** CodeMie CLI user reading `docs/COMMANDS.md` to discover what the tool can do, **I want** every registered command to have a dedicated section with a synopsis and a working example, and a check that keeps the doc complete as commands are added, **so that** I am not surprised by undocumented commands and the documentation cannot silently drift out of date again.

---

## Background

A backlog audit on 2026-09-25 rescoped EPMCDME-10549 to its part A: ten registered CLI commands have no documentation in `docs/COMMANDS.md`, which is the CLI's user-facing command reference (linked from README and four other docs). The companion problem from the original report — revalidating the LMS-hosted "Mastering CodeMie Code CLI" Kata and reconciling `codemie analytics show` with the UI — belongs to a separate external ticket (an acceptance criterion of this one). This story covers only the codemie-code documentation gap and its drift check.

---

## Acceptance Criteria

- [ ] AC1: Given `docs/COMMANDS.md` after this change, when a reader opens it, then each of the 10 commands `assistants`, `hook`, `sound`, `skill`, `skills`, `models`, `sdk`, `tips`, `whatsnew`, `test-metrics` has a dedicated section containing a synopsis and at least one example, in the established style of the existing 19 sections.
- [ ] AC2: Given the new sections, when their text was produced from source, then every synopsis, option and example matches the command's actual registered behavior (verified from `codemie <command> --help` output or the implementation), with no invented flags or examples.
- [ ] AC3: Given a doc-vs-registry coverage check added to the repository, when a command is registered without a dedicated COMMANDS.md section (or a section exists for a removed command), then the check fails; when all registered top-level commands have a dedicated section, then it passes.
- [ ] AC4 (negative): Given the coverage check's matching rule, when a command is only mentioned in passing inside an unrelated section (as `codemie hook`, `codemie sound` and `codemie models list` are today), then the check still reports it as undocumented.
- [ ] AC5: Given the `assistants` section, when a reader compares it with the existing `setup assistants` section, then the two commands' distinct purposes (chatting with an assistant vs registering assistants) are stated plainly enough to prevent confusion.
- [ ] AC6: Given the coverage check exists, when it is wired into the merge gate (`npm run ci`) or the pre-commit flow, then a future drift-introducing change cannot merge green unnoticed.
- [ ] AC7: Given this story is done, when Jira is updated, then the external follow-up ticket for the LMS Kata revalidation and the `analytics show`/UI reconciliation exists and is linked to EPMCDME-10549.

---

## Out of Scope

- NG1: Revalidating the "Mastering CodeMie Code CLI" Kata content (hosted in the LMS, not in any repository) — external ticket (AC7).
- NG2: Investigating or fixing the `codemie analytics show` vs UI count discrepancy — external ticket (AC7).
- NG3: Exhaustive subcommand documentation for `sdk` and `skills` nested trees; sections summarize and point to source/`--help`.
- NG4: Changes to `codemie`, `codemie-ui` or `codemie-sdk` (analysis found no impact).
- NG5: Rewriting or restructuring the 19 already-documented commands.

---

## Decisions

- D1: Single repository, no per-repo subtask decomposition → `codemie-code` only — proposed by PO: the rescoped ticket names one change-owning repo; workspace-wide grep confirms no other repo consumes COMMANDS.md or the registry, and the user's decomposition rule applies only when multiple repos are involved.
- D2: The external follow-up ("Ticket B") is created as a separate standalone Jira ticket linked to EPMCDME-10549, not a subtask — proposed by PO: the ticket's own rescope note says it "was to be opened separately for the LMS/content and backend team".
- D3: Coverage-check granularity is top-level commands (the 29 registry names), not every nested subcommand — proposed by PO: `sdk skills` alone has ~20 nested actions; checking full recursion would flag intentional summarization forever. Subcommands get prose pointers.
- D4: Coverage-check shape: a vitest test that builds the program, walks `program.commands` (the `tips.ts` convention) and asserts each top-level name has a dedicated COMMANDS.md section/heading — bidirectionally: every registry name maps to a doc section and every documented top-level section maps to a registered name (architecture review finding O1), wired so it runs in the merge gate or pre-commit — proposed by PO: ticket AC explicitly authorizes the check; lint-staged already runs `vitest related` on changed `.ts` files and `npm run ci` is the merge gate. A substring match is rejected (defeated by the incidental mentions at COMMANDS.md:351 and :1514).

---

## Constraints

- Public GitHub repository: commits and PRs must not contain private hostnames or internal config (see `.ai-run/guides/standards/git-workflow.md`).
- `codemie-code` AGENTS.md: tests only on explicit request — the ticket AC ("a doc-vs-registered coverage check is added or noted") is the explicit request for the check; no other tests are added.
- COMMANDS.md is user-facing and linked from README and four other docs; a large edit may trigger OpenWiki wiki-regeneration noise (AGENTS.md OpenWiki section) — acceptable, do not hand-edit generated wiki pages.
- Quality gates for any code asset: `npm run ci` (license-check + lint + build + vitest) and `check:pre-commit` (typecheck + lint) must stay green.

---

## Open Questions

- None

---

## Sources

- `codemie-code/docs/COMMANDS.md` · codemie-code | documents — the file under change
- `codemie-code/src/cli/index.ts` · codemie-code | code — authoritative registry (29 commands)
- `codemie-code/src/cli/commands/{assistants,hook,sound,skill,skills,models,sdk,tips,whatsnew,test-metrics}` · codemie-code | code — per-command behavior source
- Jira EPMCDME-10549 (via codemie-jira-assistant lookup, 2026-11-18) · tracker | ticket — rescoped scope and acceptance criteria
