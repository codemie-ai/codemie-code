# Jira Context: EPMCDME-15582 & EPMCDME-17201

Fetched read-only via codemie-jira-assistant (no tickets modified).

## EPMCDME-15582 — Local slash commands incorrectly counted as Turns

**Status:** In Progress | **Type:** Bug

**Description:** CLI Analytics counts local Claude Code slash commands (e.g. `/exit`, `/model`) as conversation Turns, inflating turn counts, session-depth buckets, and per-turn metrics. Root cause: Claude Code emits `claude_code.interaction` spans for local slash commands, and the backend aggregates all of them into `turns` without filtering out non-conversational ones.

**Acceptance criteria:**
- Turns excludes non-conversational local slash commands.
- `/exit` and `/model` do not increment Turns.
- One real user prompt yields TURNS = 1.

**Key comments:**
- Fix approach (5 Oct): classify "local command" spans in `vocabulary.py`; update ClickHouse `mv_turns_daily` and PostgreSQL `rollups.py:turns_daily`.
- Chosen approach (12 Oct): `turns_daily` excludes an interaction span lacking a correlated `claude_code.llm_request` span in the same trace; sessions with no llm_request spans (e.g. Cursor) keep current counting.
- **Klim Starykau (21 Oct): PASSED verification** on preview — `/exit`/`/model` no longer count; real prompts and model-calling commands (e.g. `/compact`) still count.
- **Regression found (15 Nov):** on CLI 0.16.8, a session with 1 prompt + 6 slash commands shows TURNS = 7, expected 5. `/context` and `/usage` make no model call and shouldn't count; `/compact`, two skill commands, and `/init` do call the model and should count. The plugin's `agent.session.summary` sends `"turns": 7` directly — flagged as a likely regression since `/context` was in scope during the 21 Oct verification.
- **Anzhalika Staliarova (16 Nov):** links EPMCDME-17201 as a related issue (skill-run-as-slash-command double counting) and recommends fixing both together with shared regression coverage.
- Latest complexity assessment (16 Nov) notes implementation is complete and code-reviewed on branch `EPMCDME-15582_fix-session-summary-turns` (one request-changes round, one approved fix-up).

## EPMCDME-17201 — Skill run as slash command shown as both "command" and "skill"

**Status:** Ready for dev | **Type:** Bug | **No comments.**

**Description:** When a skill is started via a slash command (e.g. `/sdlc-factory:sdlc-standard`) rather than through the model's Skill tool, it is misclassified as kind `command` in Session Detail (no skill bar) while still being counted once under Skills — and in Tools & Models it appears in **both** `skills_invoked` and `slash_commands`, double-counting it. Root cause is in `cli_analytics_handler.py` `_dispatch_label_and_kind()` (lines ~755–772), which returns `("command · {skill}", "command")` for rows that have both `skill_name` and `is_slash_command` set; `reader.py` (~line 3191) and handler lines ~1855–1863 then count the row in both categories.

**Acceptance criteria:**
1. A slash-started skill has kind `skill` in Session Detail.
2. Skills count and timeline skill bars agree for the same session.
3. Tools & Models lists a slash-started skill under Skills only (or under both only if documented/labelled).
4. Plain (non-skill) slash commands remain classified as commands.
5. Cost/tokens/duration attribution for slash-started skills (EPMCDME-16392, EPMCDME-15968) must stay unchanged.

**Regression tests requested:** backend unit tests for `_dispatch_label_and_kind()`; integration tests for mixed slash/Skill-tool sessions and `/tools` deduplication; a UI test for the timeline skill bar.

## Relevance to this branch's commits

- `fix(agents): skip bookkeeping lines in the skill-dedup lookahead, add missing sibling-gate test` — relates to 17201's dedup logic (a skill counted once, not as both skill and command) and to not breaking turn-affecting bookkeeping lines relevant to 15582.
- `fix(agents): count a skill-backed slash command once, not as both skill and command (EPMCDME-17201)` — directly implements 17201's AC #1–#4 (single classification as `skill`, no double count under Skills/Slash Commands) while not regressing plain slash commands (AC #4) or Turns counting (15582's regression noted 15 Nov).

A reviewer should verify: plain commands still classified as `command` (17201 AC4), skill-backed commands classified as `skill` only (17201 AC1–3), and that the fix doesn't reintroduce or worsen the 15 Nov Turns regression on 15582 (non-model-calling commands like `/context`/`/usage` must not inflate Turns, while model-calling ones like `/compact`/`/init`/skill commands should).
