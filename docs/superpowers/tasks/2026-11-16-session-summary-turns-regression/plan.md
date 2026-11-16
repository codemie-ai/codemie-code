# Session-summary turns regression (EPMCDME-15582) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Status update (2026-11-16, post-PR-824-review):** Task 1 (EPMCDME-15582) shipped. Task 2 (EPMCDME-17201) was implemented as originally planned, then **reverted** after three rounds of PR review each found a new transcript shape its lookahead missed, and real-session data (0/294) showed the scenario it guarded against essentially never occurs. The ticket's actual reported symptom is backend-owned (`agent.skill.dispatch`/OTLP `command_name`), unaffected by this file either way. Task 2's steps below are kept only as a historical record of what was tried and why it didn't stick — do not re-implement from them without first re-reading PR #824's review threads.

**Goal:** Stop the CLI's own `agent.session.summary` event from counting local-only slash commands (`/context`, `/usage`/`/cost`, `/exit`, `/model`, `/clear`, `/quit`, `/resume`, plus `/mcp`, `/agents`, `/hooks`, `/skills`, `/tasks`, `/release-notes`, `/export`, `/effort`, `/status`, `/config` added during review) as Turns. (Originally also aimed to stop a skill-backed slash command from being double-counted as both a Skill and a Slash Command — see status note above: that part was reverted.)

**Architecture:** The shipped fix lives in the pure, I/O-free transcript-signal-extraction layer that already exists for this purpose: a static denylist of known non-model-calling command names plus a shared, start-anchored helper to read a wrapped command's name, excluding a denylisted command from `countTurns()` in `session-signals.ts`. (The reverted Task 2 would have restructured `extractOrderedNamedInvocations()` in `claude-named-invocations.ts` with a one-message lookahead so a command whose very next message is the matching `Skill` tool_use call was counted only once, as a skill — see the status note above for why this was dropped. `extractOrderedNamedInvocations()` counts commands and skills independently, as it did before this plan.)

**Tech Stack:** TypeScript (ES modules), Vitest.

**Spec:** This plan's requirements come directly from Jira ticket EPMCDME-15582 (comments 5-6, 15-16 Nov 2026) and the linked EPMCDME-17201, plus `docs/superpowers/tasks/2026-11-16-session-summary-turns-regression/technical-analysis.md` (tech-analyst research) in this same run directory. No separate spec.md exists for this `sdlc-light` run.

## Global Constraints

- Client-side only; no backend, config, env var, feature-flag, or schema changes.
- Preserve the pure/no-I/O convention of `session-signals.ts`, `session-summary.ts`, and `claude-named-invocations.ts` (documented top-of-file in each).
- `LOCAL_ONLY_COMMANDS` started with exactly: `context`, `usage`, `cost`, `exit`, `quit`, `clear`, `resume`, `model` (no leading slash, matching how the rest of this subsystem stores command names); review added `mcp`, `agents`, `hooks`, `skills`, `tasks`, `release-notes`, `export`, `effort`, `status`, `config`. It is explicitly NOT synced against the backend's `SENTINEL_EXACT` list (different purpose, and that list includes `/compact`, which must keep counting here) — see the in-code comment above the constant for the up-to-date rule.
- Do not reuse `isLocalCommandTurn()` (`orchestrator.ts:354-364`) for the turns fix — it matches any command wrapper line and would wrongly exclude `/compact` and skill-backed commands.
- Do not touch the `forkedSlashPromptIds` branch of `extractOrderedNamedInvocations()` (desktop-app forked-skill path) — out of scope for this change.

## Review Focus

- A command name extracted from a line with a `<command-name>` tag but no `<command-message>` sibling must NOT be treated as a genuine wrapper (prose/doc mention) — matches the existing convention.
- A plain typed prompt (no command wrapper at all) must never match the denylist (keyed off an actual wrapped command name, which is `''` for plain text).
- A slash command NOT in `LOCAL_ONLY_COMMANDS` (e.g. `/compact`, `/init`, `/commit`) must still count as a turn exactly as today — the fix only removes counting for the denylisted names, nothing else.
- A typed prompt that merely quotes a wrapper mid-text (not at the start) must still count as a turn — `wrappedCommandName` is anchored at the start of the text for exactly this reason (a review finding fixed after the plan was first written; see PR #824).
- `countTurns()` must still correctly skip `isMeta`/`isSidechain`/`isCompactSummary`/tool_result-only lines and the existing `SELF_WRITTEN_PREFIXES`/`AUTO_PROMPT_PREFIXES` exclusions — the new check is additive, not a replacement of the existing ones.

---

## Task 1: Exclude local-only commands from Turns (EPMCDME-15582)

**Files:**
- Modify: `src/agents/plugins/claude/session/claude-named-invocations.ts`
- Modify: `src/agents/plugins/claude-code-otlp/transcript/session-signals.ts`
- Modify: `docs/ARCHITECTURE-OTLP-PLUGIN.md` (the `session-signals.ts` row of the file table, ~line 241)
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts`
- Test: `src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`

**Interfaces:**
- Consumes: nothing new from elsewhere in this plan.
- Produces: `wrappedCommandName(text: string): string` exported from `claude-named-invocations.ts` — the single command name (leading slash stripped) in a genuine `<command-name>` wrapper within `text` (i.e. one that also carries the `<command-message>` sibling tag), or `''` when none. `LOCAL_ONLY_COMMANDS: ReadonlySet<string>` exported from `session-signals.ts`. Task 2 does not consume either of these.

- [ ] **Step 1: Write the failing tests**

In `session-signals.test.ts`, inside the existing `describe('countTurns', ...)` block, add:

```ts
it('excludes known local-only commands (no model call) from turns, EPMCDME-15582 regression', () => {
  const user = (content: unknown): SignalLine => ({ type: 'user', message: { content } });
  const wrapped = (name: string) =>
    `<command-name>/${name}</command-name>\n<command-message>${name}</command-message>`;
  expect(
    countTurns([
      user('typed prompt'),
      user(wrapped('context')),
      user(wrapped('usage')),
      user(wrapped('cost')),
      user(wrapped('exit')),
      user(wrapped('quit')),
      user(wrapped('clear')),
      user(wrapped('resume')),
      user(wrapped('model')),
      user(wrapped('compact')), // calls the model, must still count
      user(wrapped('init')), // calls the model, must still count
    ])
  ).toBe(3); // typed prompt + /compact + /init
});
```

In `orchestrator.test.ts`, add a new `it` alongside `'counts typed prompts as turns, not an interrupt line or a task notification'` (same `describe` block, using the existing `userLine`/`commandText`/`runFinalSummary` helpers):

```ts
it('excludes local-only commands like /context and /usage from turns, but still counts model-calling commands', async () => {
  const summary = await runFinalSummary('session-local-only-commands', [
    userLine('hello'),
    userLine(commandText('context')),
    userLine(commandText('usage')),
    userLine(commandText('compact')),
  ]);
  expect(summary.turns).toBe(2); // 'hello' + '/compact'; /context and /usage are local-only
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: FAIL — both new assertions get the current (buggy) higher count (11 vs expected 3; 4 vs expected 2).

- [ ] **Step 3: Implement `wrappedCommandName` in `claude-named-invocations.ts`**

Add it near the existing `COMMAND_TAG`/`scanCommands` code. It must apply the exact same "genuine wrapper" rule already used by `scanCommands` (requires the `<command-message>` sibling before trusting any `<command-name>` match) and return only the *first* match's name (slash stripped, trimmed), `''` if none. Do not change `scanCommands`, `plainSlashCommandName`, or any existing export's behavior.

- [ ] **Step 4: Implement `LOCAL_ONLY_COMMANDS` and the `countTurns` exclusion in `session-signals.ts`**

Add the exported `LOCAL_ONLY_COMMANDS: ReadonlySet<string>` constant with exactly the 8 names from Global Constraints, with a comment noting it is the client-side analogue of the backend's `SENTINEL_EXACT` list and that a new local-only command must be added in both places (no shared source of truth across repos). Import `wrappedCommandName` from `../../claude/session/claude-named-invocations.js`. In `countTurns()`, after the existing `isSelfWrittenUserText`/`AUTO_PROMPT_PREFIXES` check and before incrementing `turns`, skip the line when `LOCAL_ONLY_COMMANDS.has(wrappedCommandName(text))` (note `wrappedCommandName('')` is `''`, which is never in the set, so this never affects a plain prompt).

- [ ] **Step 5: Update the `session-signals.ts` row of the file table in `docs/ARCHITECTURE-OTLP-PLUGIN.md`**

Add one clause noting `countTurns` also excludes a genuine command wrapper whose name is in `LOCAL_ONLY_COMMANDS` (no model call behind it), and that this is the client-side analogue of the backend's `SENTINEL_EXACT` list with no shared source of truth across repos.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run --project unit src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts`
Expected: PASS, including all pre-existing assertions in both files (e.g. the `/plan`/`/commit` cases, which are untouched since none of those names are in `LOCAL_ONLY_COMMANDS`).

- [ ] **Step 7: Commit**

```bash
git add src/agents/plugins/claude/session/claude-named-invocations.ts src/agents/plugins/claude-code-otlp/transcript/session-signals.ts docs/ARCHITECTURE-OTLP-PLUGIN.md src/agents/plugins/claude-code-otlp/transcript/__tests__/session-signals.test.ts src/agents/plugins/claude-code-otlp/transcript/__tests__/orchestrator.test.ts
git commit -m "fix(agents): exclude local-only slash commands from session turns (EPMCDME-15582)"
```

Test-first: yes — the two tests above (expected turns=3 and turns=2) fail against current code before Steps 3-5 and pass after.

---

## Task 2 (REVERTED): skill/command dedup attempt (EPMCDME-17201)

**Outcome: implemented, then reverted. Do not re-implement from this plan without re-reading PR #824's review threads first.**

The original plan called for a one-message lookahead in `extractOrderedNamedInvocations()` (`claude-named-invocations.ts`) so a slash command whose very next message was the matching `Skill` tool_use call would be counted once, as the skill, not also as a command. It was implemented largely as specified (the lookahead needed extra hardening across three PR-review rounds — skipping `isMeta`/`isSidechain` bookkeeping lines, prep tool_use/tool_result round-trips, and no-role system lines like `compact_boundary` — each round surfacing a new transcript shape the previous version missed).

It was reverted (commit `b9dbeda8`, PR #824) rather than hardened further, because:
- A fourth reviewer finding showed the dedup provided no real-world benefit: across 294 real slash-command invocations, none was followed by a matching `Skill` call of the same name — the shape this code existed to handle essentially never occurs.
- Neither Session Detail nor Tools & Models in the backend reads `commands`/`commandInvocations` from this summary — EPMCDME-17201's actual reported symptom comes from the backend (`agent.skill.dispatch` row, OTLP `command_name`), so this client-side change could not fix the ticket regardless of correctness.
- The dedup also made this summary diverge from `src/cli/commands/analytics/cost/dispatch-extractor.ts`, which independently (and intentionally) counts the same transcript shape without dedup.

`extractOrderedNamedInvocations()` now counts commands and skills independently, same as before this plan started. EPMCDME-17201 is back in "Ready for dev" with a comment pointing at the backend-owned root cause.

---

## Self-Review Notes

1. **Spec coverage:** EPMCDME-15582's four acceptance criteria (exclude non-conversational local commands, `/exit` and `/model` don't increment Turns, one real prompt = 1 turn) are covered by Task 1; the 15 Nov regression's specific repro (`/context`, `/usage` excluded, `/compact`/skill commands/`/init` still count) is covered by both new tests in Task 1. EPMCDME-17201's dual-listing bug was addressed by Task 2 and then reverted (see Task 2) — the ticket's backend-owned root cause remains unfixed by this plan.
2. **Step scan:** Task 1's steps name exact file(s), exact signatures, and exact test code where the test's assertions are the contract; implementation steps leave only the function body to the implementer, which the tests pin.
3. **Type consistency:** `wrappedCommandName` and `LOCAL_ONLY_COMMANDS` (Task 1) are named and used consistently; `matchCommandNames` and the lookahead helpers from the original Task 2 design no longer exist in the shipped code (reverted).
4. **Review Focus:** the current Review Focus list (revised post-revert) has a corresponding test for each line — prose-wrapper rule, plain-prompt no-op, non-denylisted commands unaffected, mid-text wrapper quote no-op, existing turns exclusions preserved via the unmodified pre-existing test assertions.
5. **Proportion:** one shipped, narrowly-scoped task (Task 1) plus one reverted attempt kept as a condensed historical record (Task 2) rather than full step detail, since that detail no longer describes the shipped code.
