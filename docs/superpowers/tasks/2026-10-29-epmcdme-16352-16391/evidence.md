# Evidence: EPMCDME-16352 + EPMCDME-16391

- Baseline: `8b8bedb69389228c51e77a809e762963d925726d` (origin/main). Branch `EPMCDME-16352_16391_skill-invocation-analytics`.
- Code HEAD: `c7f6273eed4431e67937bc0704f402f5b9fcbf5f` (this note is committed after it). Local only, not pushed.
- Mode: ordinary chat, no SDLC cycle. Status: **implementation done, targeted checks pass; not independently reviewed, not MR-ready.**

## Changes
| Path | Change |
|---|---|
| `claude-code-otlp/transcript/fork-skill.ts` (new) | `resolveForkSkills`: names marker-less forks by exact ids from the main transcript |
| `claude-code-otlp/transcript/subagent-usage.ts` | `discoverSubagentFiles` (marker only), `findSubagentFiles` applies the fallback (`skillName`, description `/name` if empty), `resolveSubagentSkillName` |
| `claude-code-otlp/claude-code-otlp.plugin.ts` | SubagentStart/Stop use marker, else fallback, for `skill_name`/description/scope |
| `claude-code-otlp/transcript/orchestrator.ts` | summary passes fork-confirmed prompts to command extraction; `rescopeForkedSubagents` (on `Stop`) + SessionEnd backstop re-derive a fork first recorded as an agent |
| `claude/session/claude-named-invocations.ts` | exported `plainSlashCommandName`; optional `forkedSlashPromptIds` param (default behaviour unchanged) |
| `docs/ARCHITECTURE-OTLP-PLUGIN.md` | row for `fork-skill.ts` |
| tests | `fork-skill.test.ts` (new), additions to `orchestrator.test.ts`, `claude-code-otlp.plugin.test.ts` |

## Correlation rules (exact ids only; no name/time proximity)
- Skill tool fork: `Skill` tool_use id -> tool_result `toolUseResult.agentId` (or `"agentId"` in result text), or fork `.meta.json` `toolUseId`.
- Slash fork: plain user line `/name` (not `<command-message>` wrapper, not meta, lone text) whose `promptId` equals the `promptId` of exactly one subagent with no `toolUseId` and no `agentId` in any tool result; exactly one `/name` line for that prompt. Zero/several candidates -> stays an agent.
- Marker (CLI) keeps precedence; a marker fork is only confirmed for the summary when the line name equals the marker name.
- Summary: a plain line counts only if its `promptId` is fork-confirmed; wrapper lines unchanged, so no double count; hooks (Submit/Expansion) are not read, so they cannot double count.

## Checks (all run once, on the final code except where noted)
| Check | Exit |
|---|---|
| `npm ci --ignore-scripts` (worktree had no node_modules; scripts skipped so husky config is untouched) | 0 |
| `npx tsc --noEmit` (final) | 0 |
| `npx eslint --max-warnings=0` on 6 changed source/test files | 0 |
| vitest: `fork-skill`, `orchestrator`, `claude-code-otlp.plugin` (248 tests) | 0 |
| vitest first run incl. `subagent-usage`, `claude-named-invocations`, `session-summary` (295 pass; the 12 failures were my test mock lacking the new export and one fixture-reuse bug in my own new test, both fixed; those three untouched files passed) | 1 -> fixed, rerun above is 0 |
| vitest `orchestrator -t "forked slash command"` (summary commands `['forkme','inlineme']`, `primary_command` forkme) | 0 |
| commit hooks (husky) | passed, commit exit 0 |
Logs: `C:/codemie-dev/_local/epmcdme-16352-16391/*.log`. Full suite, build and license/secret gates not run.

## Per-run invariants (covered by tests)
- One fork -> one `agent_id`; its `agent.usage.request`, `agent.subagent.usage` (`usage[].scope_kind=skill`, `scope_name`), `agent.subagent.stop`/`start` `skill_name` agree.
- Repeated skill name = separate forks, each its own agent_id. Nested Agent-tool subagents are never skills. Ambiguity (2 candidates, 2 slash lines, missing/other promptId) -> not a skill.
- Replay: second `Stop` after a rescope emits nothing; offsets/keys unchanged; SessionEnd skips covered forks.
- `api_calls` is unaffected (forks keep their own `agent_id`).

## Limitations / remaining gates
1. **Unverified on real desktop data**: no desktop transcript was available. Shapes were taken from the ticket, existing fixtures (`toolUseResult.agentId`) and a local CLI session (subagent lines carry `promptId` matching the spawning main prompt). Assumption to confirm: the slash fork's lines carry the `/name` line's `promptId` (the backend's own join on `prompt_id` relies on the same).
2. A foreground Skill fork's `SubagentStop` precedes the Skill result, so its first `agent.usage.request` / `subagent.stop` / `subagent.usage` go out as `agent`; corrected `skill` versions follow on the next `Stop`/`SessionEnd` (needs a surviving session). The `agent.subagent.stop` itself is not re-sent. Backend must latest-merge by request/agent id (content-hashed event ids -> new rows); not verified against the server.
3. `SubagentStart` may fire before the fork's file exists; it then has no `skill_name` (Stop does). Backend pairs a Skill fork by `fork_agent_id` (already emitted) and a slash fork by `prompt_id`; read-only look at `C:/codemie-dev/codemie/.work/EPMCDME-16074` (`fork_attribution.py`, `cli-analytics-events.md`) suggests the server handles both, but it is a work branch, so **end-to-end Timeline/chart behaviour is not demonstrated**.
4. Cost: each SubagentStop/Stop on a session with subagents re-reads the main transcript once.
5. Needs: independent review, user approval, complexity assessment of the final diff, then `mr-creator`. No push/PR done.
