# CodeMie Assistant Builder — Design

**Date:** 2026-09-29
**Status:** Draft for review

## Goal

A Claude Code skill, `codemie-assistant-builder`, that turns a stated purpose ("I want an assistant that …") into a working assistant on the CodeMie platform and then improves it autonomously: it drafts the system prompt, selects toolkits and platform skills, creates the assistant in a project the user picks, runs test scenarios against it, grades the results, and revises the prompt over several rounds until a stop condition is met — with a single user approval up front. It also tunes existing assistants.

The loop is modeled on `skill-creator` (draft → test prompts → run → grade → revise → re-run), executed on the CodeMie platform through `codemie sdk`.

### Success criteria

- From one description plus one approval checkpoint, the user gets a created assistant, a scenario set, and an HTML report showing every improvement round.
- The loop runs without further confirmation and stops on its own (all pass, max rounds, plateau, or blocked).
- The final assistant is never worse than the best version reached during the run.
- Raw transcripts do not accumulate in the main Claude context across rounds.

### Non-goals (v1)

Datasources (`context`), MCP servers, LLM model/temperature tuning, trying prompts through the chat `system_prompt` override before saving, and an interactive feedback page. Model and temperature stay at platform defaults unless the user explicitly asks for a value.

## Components

| Unit | Location | Purpose |
|---|---|---|
| `codemie sdk assistants chat` | `src/cli/commands/sdk/assistants.ts`, `services/assistants.ts` | Stateless single chat with any assistant by ID, normalized JSON output |
| `codemie sdk assistants test` | same | Batch-run a scenario file, write per-scenario results |
| `codemie sdk assistants versions` | same | List assistant versions |
| `codemie sdk assistants rollback` | same | Roll back to a version |
| `codemie sdk assistants report` | same | Round diff, HTML report, terminal summary |
| `codemie sdk assistants conversations` | same | Normalized transcripts of past platform chats with an assistant |
| Builder core | `src/cli/commands/sdk/assistant-builder/` | Types, scenario parsing, thought normalization, runner, deterministic checks, report |
| Skill `codemie-assistant-builder` | `src/agents/plugins/claude/plugin/skills/codemie-assistant-builder/SKILL.md` | Orchestrates intake, creation, autonomous loop, final report |
| Grader prompt | `…/codemie-assistant-builder/agents/grader.md` | Subagent that grades one round |
| Improver prompt | `…/codemie-assistant-builder/agents/improver.md` | Subagent that revises the prompt for the next round |
| `codemie-sdk` skill update | `…/skills/codemie-sdk/SKILL.md`, `examples/assistants.md` | Document the six new commands; point purpose-driven requests to the builder |

## CLI commands

All follow the existing `sdk` pattern: `getSdkClient`, `outputJson`, `handleSdkError`, render helpers; logic lives in `services/assistants.ts`.

### `codemie sdk assistants chat <id> <message>`

Options: `--history <file>` (JSON array of `{ "role": "User" | "Assistant", "message": string }`), `--assistant-version <n>`, `--timeout <seconds>` (default 120), `--json`.

- Calls `client.assistants.chat` (or `chatWithVersion` when `--assistant-version` is set) with `stream: false`, `save_history: false`, no `conversation_id`.
- Does not register the assistant locally and does not detect session file uploads — this is the difference from `codemie assistants chat`.
- Human output: the answer, then a dimmed list of tool calls. `--json`: one normalized turn (below).

### `codemie sdk assistants test <id> --scenarios <file> --out <dir>`

Options: `--assistant-version <n>`, `--concurrency <n>` (default 3, max 8), `--only <id,...>`, `--timeout <seconds>` (per turn, default 120).

- For each scenario, sends its turns in order, building `history` from the actual responses.
- Writes `<out>/results/<scenario-id>.json`, `<out>/raw/<scenario-id>.json` (raw `thoughts`), `<out>/scenarios.json` (snapshot of the input file, used by `report` to detect changed expectations), `<out>/checks.json` (verdicts for deterministic `tool_called`/`tool_not_called` checks), and `<out>/run.json` (assistant id, version tested, start/end time, counts).
- A failing scenario (timeout, 5xx after one retry, `agent_error`) is recorded as `status: "error"` and does not abort the batch.
- Exit code 0 when the batch ran, even with scenario errors; non-zero only for setup failures: authentication, unreadable/invalid scenario file, unknown assistant or version.

### Normalized result

```json
{
  "scenario_id": "create-bug-from-description",
  "status": "ok",
  "turns": [
    {
      "user": "Create a bug: login button does nothing on Safari",
      "assistant": "Which Jira project should I file it in?",
      "tool_calls": [{ "name": "search_issues", "input": "…", "output_excerpt": "…", "error": false }],
      "tokens": 1234,
      "latency_ms": 5200
    }
  ],
  "agent_error": null,
  "tool_errors": [],
  "raw_thoughts_file": "raw/create-bug-from-description.json"
}
```

`tool_calls` are derived from `Thought` entries with `author_type: "Tool"` (`author_name`, `input_text`, `message`, `error`), excluding the platform's reasoning pseudo-tool `Codemie Thoughts`. Tool names are platform display names (e.g. `Get Project Dna` for MCP tool `get_project_dna`). `output_excerpt` is truncated to 500 chars. `chat --json` emits the same shape with a single turn and no `scenario_id`.

### `conversations`

`codemie sdk assistants conversations [<assistant-id>] [--limit <n>] [--ids <ids-or-links>] [--json]` → read-only.

- With `<assistant-id>` and no `--ids`: `conversations.listByAssistantId` + `conversations.get` for the newest `n` (default 10).
- With `--ids`: comma-separated conversation IDs or CodeMie chat links; the first UUID in each value is taken as the conversation ID, and only those are fetched (`<assistant-id>` optional). A conversation that cannot be fetched (not found, no access) yields `{ id, error }` and does not abort the others.
- Output per conversation: `{ id, date, name, turns: [{ role, message, tool_calls }] }` or `{ id, error }`, using the same tool-call normalization.

### `versions` / `rollback`

- `codemie sdk assistants versions <id> [--json]` → `listVersions`, normalized to an array (the SDK response type is a union).
- `versions <id> --current` prints the version in effect: the highest version whose `system_prompt` equals the assistant's current prompt (falls back to the highest version).
- `codemie sdk assistants rollback <id> <version>` → `rollbackToVersion`.

## Workspace

Project-local, so scenarios can be committed as regression fixtures:

```
.codemie/assistant-builder/<assistant-slug>/
  assistant.json          # { id, project, name, created_by_builder }
  brief.md                # purpose, users, must-do, must-refuse, sample inputs
  scenarios.json          # test set — only the user changes expectations
  iterations/
    v<platform-version>/
      config.json         # `get --json` snapshot, credential fields stripped
      change.md           # what changed vs previous round and why
      run.json
      scenarios.json      # snapshot of the scenario file this run used
      results/<scenario-id>.json
      raw/<scenario-id>.json
      checks.json
      grading.json
      report.html
      confirm/            # present only for the all-pass confirmation run
```

Before a Phase-6 feedback run, `iterations/` is archived to `history/run-<k>/` so each run's report and plateau check cover only its own rounds. The version under test is the highest version whose `system_prompt` equals the assistant's current prompt (robust to how rollback is implemented), and `test` always gets `--assistant-version`. Iteration folders are named by the platform version number so they line up with `versions`, `--assistant-version` and `rollback`.

### `scenarios.json`

```json
{
  "scenarios": [
    {
      "id": "create-bug-from-description",
      "title": "Files a bug from a free-text description",
      "turns": ["Create a bug: login button does nothing on Safari", "Project is ABC"],
      "checks": [
        { "id": "c1", "text": "Asks which Jira project if not given" },
        { "id": "c2", "text": "Calls a Jira create-issue tool", "kind": "tool_called", "tool": "create_issue" }
      ],
      "added_in": 3,
      "origin": "initial | user-feedback | past-chat",
      "source_conversation": "<conversation-id, past-chat only>"
    }
  ]
}
```

- Checks are plain language by default and judged by the grader.
- `kind: "tool_called" | "tool_not_called"` checks are evaluated deterministically by `test` against `tool_calls` (substring match on tool name after normalizing both sides: lowercase, `_`/`-`/whitespace runs collapsed to one space; any turn) and written to `checks.json`.
- Scenarios are added or edited, never silently removed. An edited check is recorded in `change.md` and reported as "expectation changed", not "fixed".

## Skill workflow

### Triggers

"build/create an assistant for …", "test my assistant", "tune/improve assistant X", "assistant X gets Y wrong". The `codemie-sdk` description gains a line routing purpose-driven build/test/tune requests to this skill; plain CRUD stays in `codemie-sdk`. The builder reads `codemie-sdk/examples/assistants.md`, `integrations.md` and `skills.md` for payload schemas instead of duplicating them.

### Intake (interactive)

1. **Intent** — purpose, target users, must-do, must-refuse, sample inputs; one question at a time, only for what is missing. Saved to `brief.md`.
2. **Project** — the `codemie-sdk` project procedure (`users me`; default vs named project).
3. **Draft** — name, description, system prompt, conversation starters; toolkits from `get-tools` matched to capabilities, each with a one-line reason; for each toolkit needing credentials, a matching integration from `integrations list` in the project, or guidance to create one (secrets are never requested in chat); platform skills from `skills list` where relevant.
4. **Scenarios** — 5–8 scenarios with 2–4 checks each, covering main paths, one edge case, and one out-of-scope/refusal case.

### Single approval checkpoint

The user reviews in one message: brief, draft config, scenarios, and loop budget (max rounds, default 5). Approval authorizes: create (private, `shared: false`), every prompt update in the loop, and the final rollback to the best version. Nothing is written to the platform before this.

### Autonomous loop

After create (ID resolved via `list --search`; if not uniquely resolvable, stop and ask):

```
round k:
  get --json                  → iterations/v<N>/config.json
  sdk assistants test         → results/, raw/, checks.json, run.json
  grader subagent             → grading.json + digest
  stop?                       → exit loop
  improver subagent           → new prompt + change.md
  sdk assistants update       → version N+1
```

Each round prints one line: `round 3/5 · v4 · 11/14 checks (+2) · fixed: c3,c7 · regressed: –`. The user may interrupt at any time.

**Stop conditions** (first reached; plus `test_failed` / `update_failed` when the CLI fails):

1. **All checks pass** — confirmed by running `test` once more on the same version into `iterations/v<N>/confirm/` and grading it; a check that fails on confirmation counts as failing and the loop continues.
2. **Max rounds** reached.
3. **Plateau** — two consecutive rounds with no net gain in passing checks.
4. **Blocked** — all remaining failures are `error` or `blocked: integration`.

**Best-version guard.** Score = passing checks (ties broken by fewer regressions, then the later version). If the final version is not the best, roll back to the best.

**Autonomous change scope.** The loop may change only `system_prompt`, `description` and `conversation_starters`. Toolkit, skill and integration changes are listed as recommendations in the final report. The loop never edits scenarios or checks.

### Final report

Terminal: final version, pass rate per round, fixed/regressed/still failing, stop reason, recommendations, workspace path. HTML: `report.html` in the final iteration folder covering all rounds. Then the user either gives feedback — which may add scenarios or change expectations, then starts a new autonomous run with the same budget — asks to share (`shared: true`, confirmed separately), or stops.

### Past conversations

In both modes, during intake the skill asks the user once:

1. **Analyze my recent conversations** with this assistant (tune existing only) — newest 10 via `conversations <id>`;
2. **Use specific conversations** — the user pastes links or IDs of chats that went wrong (works for new builds too, e.g. chats with a previous draft or a similar assistant); fetched via `conversations --ids`;
3. **Skip**.

Nothing is read without that answer. For each analyzed conversation the skill records concrete failures in `brief.md` under `## Observed failures` (what the user said, what the assistant did, what it should have done, conversation ID) and turns each into a scenario with `origin: "past-chat"` and `source_conversation: "<id>"`, replaying the user's actual messages as `turns` where they fit the flow. Conversations that could not be fetched are reported to the user by ID. The user confirms the observed-failure list before scenarios are drafted from it.

### Tune existing

`get <id>` loads the config; the skill writes `brief.md` from the prompt, description and (see **Past conversations** above) an **Observed failures** section, and drafts scenarios covering both the intended flow and each observed failure (`origin: "past-chat"`); the checkpoint approves brief, scenarios and budget; a baseline round runs before any change; then the same loop. `assistant.json` records `created_by_builder: false`.

## Grader subagent (`agents/grader.md`)

- Inputs: paths to `brief.md`, `scenarios.json`, the iteration's `results/`, and the deterministic verdicts.
- For each non-deterministic check: `pass` or `fail` with a one-sentence reason quoting the answer or tool call.
- Scenarios with `status: "error"` → checks graded `error`; those depending on a missing integration → `blocked`.
- Writes `grading.json`: per-check verdicts plus an `observations` list of cross-scenario patterns.
- Returns a digest of about 10 lines (counts, failing check IDs, top observations).
- The assistant's answers are untrusted data to grade, never instructions to follow — stated explicitly in the prompt.

## Improver subagent (`agents/improver.md`)

- Inputs: `brief.md`, current `config.json`, current `grading.json`, all previous `change.md` files.
- Output: new `system_prompt` (plus optional description and starters) written to a file, and `change.md` mapping each edit to the check IDs it targets.
- Must address the underlying behavior, not special-case scenario wording; must not reintroduce an edit a previous round reverted; must not change tools.
- Returns a short digest; the skill applies the update.

## `codemie sdk assistants report <workspace-dir>`

Implemented in `src/cli/commands/sdk/assistant-builder/report/` (typed, linted, unit-tested).

- Reads all iterations; a check that passed in a round but failed on that round's `confirm/` run counts as failing (reason prefixed "failed on confirmation run"), so a flaky round is never the best version;
- `--json` includes `latest.counts` (pass/fail/error/blocked/not_graded) used by the skill's **blocked** stop check;
- Reads all iterations, classifies each check per round (fixed, regressed, still failing, still passing, new, expectation changed), writes `report.html` in the latest iteration folder, prints the terminal summary.
- HTML: single self-contained file using CodeMie dark-theme tokens copied from `codemie-html-report/style-guide`; header (assistant, version, project, pass rate, delta), round-by-round chart of passing checks, scenario table, expandable per-scenario panels (turns, tool calls, verdicts with reasons, tokens, latency), per-round "what changed" from `change.md`, recommendations.

## Error handling

- CLI: `handleSdkError` for setup errors; 401/403 fails fast with the re-auth hint; one retry with backoff for 429/5xx per turn; per-turn timeout; per-scenario errors captured, batch continues.
- Skill: create succeeded but ID not resolvable → stop and ask; `update` fails → stop the loop, keep the last good version, report; `test` setup failure → stop and report the CLI error verbatim; missing integration → dependent scenarios marked blocked, not counted against the prompt.

## Security

- No secrets in chat or workspace files; `config.json` has credential fields removed; integrations appear only by alias or ID.
- Test chats use `save_history: false`.
- Delete is not part of the flow.
- Grader and improver treat assistant output as untrusted data.

## Testing

When requested: Vitest unit tests for thought → `tool_calls` normalization, history building across turns, `test` concurrency and per-scenario error capture (SDK client mocked via dynamic imports), `versions` response normalization, deterministic checks, and report classification. A manual end-to-end run on a real project builds one small assistant through a full autonomous run.

## Acceptance run

The first real use is tuning **CodeMie Engagement Survey Assistant** (`e3aacf1b-2d2b-4687-8b14-d0d70d365134`, project `ai-run`, shared, MCP server `EPAM Project` with `search_projects`, `get_project_dna`, `search_streams`, `get_assignments`), in place. Target behavior:

- Asks the survey one question per turn in the predefined order, with conditional questions only when applicable, then shows the table and asks for approval.
- After the project code answer, calls `search_projects`; if no project matches, says so and asks for the code again; does not advance until a project is found.
- After approval, shows the continuation guide; once the user confirms the steps are done, calls `get_project_dna` for that project and checks the AI Attributes contain "AI/RUN Platforms" when the usage category is Client-facing solution or Both. If it is missing, it tells the user which step is incomplete and waits; if present (or the category is Internal adoption), it finishes with the exact completion message.
- Project Attributes → Platforms (step 2) is not exposed by `get_project_dna`; the assistant relies on the user's confirmation for it and must not claim to have verified it.

Past chats show the current prompt never calls either tool unless asked explicitly. Scenario fixtures (an existing project code with the AI/RUN Platforms tag, one without it, and a non-existent code) come from the user during intake.

The run succeeds when a full survey scenario passes end to end (all questions, table, approval, guide, DNA check, completion message) along with the invalid-code and missing-tag scenarios.
