# Session-summary turns regression (EPMCDME-15582) + skill/command dedup (EPMCDME-17201) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the CLI's own `agent.session.summary` event from counting local-only slash commands (`/context`, `/usage`/`/cost`, `/exit`, `/model`, `/clear`, `/quit`, `/resume`) as Turns, and stop a skill-backed slash command from being double-counted as both a Skill and a Slash Command.

**Architecture:** Both fixes live in the pure, I/O-free transcript-signal-extraction layer that already exists for this purpose. Fix 1 adds a static denylist of known non-model-calling command names and a shared helper to read a wrapped command's name, then excludes a denylisted command from `countTurns()` in `session-signals.ts`. Fix 2 restructures `extractOrderedNamedInvocations()` in `claude-named-invocations.ts` with a one-message lookahead so a command whose very next message is the matching `Skill` tool_use call is counted only once, as a skill. The two fixes touch different files and are independently testable/committable.

**Tech Stack:** TypeScript (ES modules), Vitest.

**Spec:** This plan's requirements come directly from Jira ticket EPMCDME-15582 (comments 5-6, 15-16 Nov 2026) and the linked EPMCDME-17201, plus `docs/superpowers/tasks/2026-11-16-session-summary-turns-regression/technical-analysis.md` (tech-analyst research) in this same run directory. No separate spec.md exists for this `sdlc-light` run.

## Global Constraints

- Client-side only; no backend, config, env var, feature-flag, or schema changes.
- Preserve the pure/no-I/O convention of `session-signals.ts`, `session-summary.ts`, and `claude-named-invocations.ts` (documented top-of-file in each).
- `LOCAL_ONLY_COMMANDS` starts with exactly: `context`, `usage`, `cost`, `exit`, `quit`, `clear`, `resume`, `model` (no leading slash, matching how the rest of this subsystem stores command names).
- Do not reuse `isLocalCommandTurn()` (`orchestrator.ts:354-364`) for the turns fix — it matches any command wrapper line and would wrongly exclude `/compact` and skill-backed commands.
- Do not touch the `forkedSlashPromptIds` branch of `extractOrderedNamedInvocations()` (desktop-app forked-skill path) — out of scope for this change.

## Review Focus

- A command name extracted from a line with a `<command-name>` tag but no `<command-message>` sibling must NOT be treated as a genuine wrapper (prose/doc mention) in either fix — matches the existing convention.
- A plain typed prompt (no command wrapper at all) must never match the denylist or the skill-dedup lookahead (both keyed off an actual wrapped command name, which is `''` for plain text).
- A slash command NOT in `LOCAL_ONLY_COMMANDS` (e.g. `/compact`, `/init`, `/commit`) must still count as a turn exactly as today — the fix only removes counting for the 8 denylisted names, nothing else.
- A command immediately followed by a `Skill` tool_use call for a *different* skill name must still count as both a command AND that (unrelated) skill — the dedup only fires on an exact name match.
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

## Task 2: Count a skill-backed slash command once, not as both Skill and Slash Command (EPMCDME-17201)

**Files:**
- Modify: `src/agents/plugins/claude/session/claude-named-invocations.ts`
- Test: `src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (different function; `wrappedCommandName` is not reused here because this fix needs *all* command names on a line plus lookahead, not just the first).
- Produces: no new exports — `extractOrderedNamedInvocations`'s and `extractNamedInvocations`'s signatures and return shapes (`OrderedNamedInvocations`, `NamedInvocationCounts`) are unchanged; only the counts they produce change for the skill-backed-command case.

- [ ] **Step 1: Write the failing tests**

In `claude-named-invocations.test.ts`, inside `describe('extractOrderedNamedInvocations', ...)`, add:

```ts
it('counts a skill-backed slash command once, as a skill, not also as a command (EPMCDME-17201)', () => {
  const out = extractOrderedNamedInvocations([
    userStringContent(commandWrapper('codemie-humanizer')),
    toolUse('Skill', { skill: 'codemie-humanizer' }),
  ]);
  expect(out.skillInvocations).toEqual({ 'codemie-humanizer': 1 });
  expect(out.commandInvocations).toEqual({});
  expect(out.commandsInOrder).toEqual([]);
});

it('still counts a command as a command when no Skill call follows it', () => {
  const out = extractOrderedNamedInvocations([
    userStringContent(commandWrapper('plan')),
    userText('a plain follow-up prompt, no skill'),
  ]);
  expect(out.commandInvocations).toEqual({ plan: 1 });
  expect(out.skillInvocations).toEqual({});
});

it('still counts a command as a command when the next message is a Skill call for a different name', () => {
  const out = extractOrderedNamedInvocations([
    userStringContent(commandWrapper('plan')),
    toolUse('Skill', { skill: 'unrelated-skill' }),
  ]);
  expect(out.commandInvocations).toEqual({ plan: 1 });
  expect(out.skillInvocations).toEqual({ 'unrelated-skill': 1 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run --project unit src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts`
Expected: FAIL on the first new test — `commandInvocations` currently also contains `{ 'codemie-humanizer': 1 }` (double count). The other two new tests pass already (they document unchanged behavior) but run them too as a baseline.

- [ ] **Step 3: Implement the one-message lookahead in `extractOrderedNamedInvocations`**

Change the function from a `for (const raw of messages)` loop to an index-based loop so each iteration can see `messages[i + 1]`. Replace the current `scanCommands(text)` (which both matches *and* bumps `commandInvocations`/`commandsInOrder` as a side effect) with a pure `matchCommandNames(text): string[]` that only returns the matched, slash-stripped names (same genuine-wrapper rule: requires the `<command-message>` sibling), and a small helper `nextMessageSkillName(raw: unknown): string` that returns the trimmed `input.skill` of the first `Skill` `tool_use` block in `raw` when its `message.role === 'assistant'`, else `''`. For each name returned by `matchCommandNames` at message `i` (both the plain-string-content branch and the array text-block branch — NOT the `forkedSlashPromptIds` branch, which keeps calling `bump`/`commandsInOrder.push` directly as today), look up `nextMessageSkillName(messages[i + 1])`: if it equals the command name exactly, skip bumping `commandInvocations`/`commandsInOrder` for that occurrence (the `Skill` tool_use block itself still bumps `skillInvocations` via the existing per-content-block loop when message `i + 1` is visited — no change needed there); otherwise bump `commandInvocations`/`commandsInOrder` exactly as before.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project unit src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-names.test.ts`
Expected: PASS, including all pre-existing tests in both files (no existing test encodes the dual-count scenario, so none should need their expectations changed).

- [ ] **Step 5: Commit**

```bash
git add src/agents/plugins/claude/session/claude-named-invocations.ts src/agents/plugins/claude/session/__tests__/claude-named-invocations.test.ts
git commit -m "fix(agents): count a skill-backed slash command once, not as both skill and command (EPMCDME-17201)"
```

Test-first: yes — the "counts a skill-backed slash command once" test fails against current code (asserts `commandInvocations` is empty where today it is `{ 'codemie-humanizer': 1 }`) before Step 3 and passes after.

---

## Self-Review Notes

1. **Spec coverage:** EPMCDME-15582's four acceptance criteria (exclude non-conversational local commands, `/exit` and `/model` don't increment Turns, one real prompt = 1 turn) are covered by Task 1; the 15 Nov regression's specific repro (`/context`, `/usage` excluded, `/compact`/skill commands/`/init` still count) is covered by both new tests in Task 1. EPMCDME-17201's dual-listing bug is covered by Task 2.
2. **Step scan:** each step names exact file(s), exact signatures, and exact test code where the test's assertions are the contract; implementation steps leave only the function body to the implementer, which the tests pin.
3. **Type consistency:** `wrappedCommandName`, `LOCAL_ONLY_COMMANDS`, `matchCommandNames`, and `nextMessageSkillName` are each named and used consistently within their own task; Task 1 and Task 2 do not share any new identifier.
4. **Review Focus:** all five lines above have a corresponding test in the task that owns the code (prose-wrapper rule, plain-prompt no-op, non-denylisted commands unaffected, mismatched-skill-name no-op, existing turns exclusions preserved via the unmodified pre-existing test assertions).
5. **Proportion:** two small, independent, narrowly-scoped tasks; no task introduces a function whose full body is dictated here beyond the one restructuring algorithm in Task 2 Step 3, which is the one genuinely non-obvious design decision in this plan.
