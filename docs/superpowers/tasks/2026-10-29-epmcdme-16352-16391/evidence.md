# Evidence: EPMCDME-16352 + EPMCDME-16391

- Baseline: `8b8bedb69389228c51e77a809e762963d925726d` (origin/main). Branch `EPMCDME-16352_16391_skill-invocation-analytics`.
- Revision 1 `c7f6273e` and revision 2 `72f911d0` were rejected by review; revision 3 is the commit after `72f911d0` (`fix(analytics): close finished tool calls ...`). Local only, not pushed.
- Status: **implementation done, targeted checks pass; awaiting independent review and user approval; not MR-ready.**

## Review findings and resolution
**P1 scope correction vs backend.** Backend `origin/main` `7578a3e36`, `postgres/rollups.py` `tr` CTE (lines ~435-458): requests are grouped by session / request-or-message id / raw model and `max(scope_kind)`, `max(scope_name)` are taken independently. Initial `(agent, general-purpose)` + corrected `(skill, forkme)` would give kind `skill` but name `general-purpose` (`'general-purpose' > 'forkme'`). Latest-merge is **not** supported, so revision 1's "emit, then re-scope" was wrong. Fix inside the CLI: **never send a scope that could still be wrong.** A subagent that may yet prove to be a skill fork is `pending`; its `SubagentStop` sends no `agent.usage.request`/`agent.subagent.usage` (the lifecycle hook event `agent.subagent.stop` is still forwarded, without `skill_name`) and records its id in `deferredAgentIds` (parse state). The next `Stop` sends it once, with the final scope; `SessionEnd` ends an unproven one as an agent. Consumer-sequence check by SQL reading: each request now arrives with a single scope, so `max()` per group is that scope (a streaming re-parse repeats the same scope). The backend was read, not executed (no DB).

**P1 pending Agent child misclassified.** Reproduced probe adapted into `fork-skill.test.ts`. Rules now (`transcript/fork-skill.ts`):
- Skill fork: `Skill` `tool_use` -> result `agentId`, or fork `meta.toolUseId`. A `Skill` call with no result yet holds every metadata-less, tool-less subagent `pending`.
- Slash fork: plain `/name` line + exactly one tool-less subagent with that `promptId` + exactly one `/name` line, **and** no `Agent`/`Task`/`Skill` call without a result (main and subagent transcripts, so nested and concurrent calls count). Otherwise `pending`, or an agent when evidence cannot lift the ambiguity.
- Agent/Task result `agentId` or `meta.toolUseId` -> definitively an agent.
- **Open call = no result yet** (revision 3). Any result (error, denial, completed without an agent) closes the call; open calls are counted per user turn (the call's `promptId`, from the latest preceding user line; a subagent without a `promptId` sees all). A failed/earlier-prompt Agent or Skill call therefore no longer blocks a later slash fork, an unanswered call of the same prompt still holds it pending (and an agent at `final`).
- **Result parsing** (revision 3): typed `toolUseResult.agentId` wins; else the result text (string, or the text blocks of a content array) is parsed only when it is itself a JSON object (a cut-off object falls back to the `"agentId"` pattern). Prose is never searched; only Skill/Agent/Task results are consulted. Covered for both Skill and Agent.
- `final` (SessionEnd summary and backstop): pending -> agent.

## Changes (vs baseline)
`transcript/fork-skill.ts` (new), `subagent-usage.ts` (`discoverSubagentFiles`, `findSubagentFiles(…, {final})`, `pending`, `resolveSubagentSkill`), `claude-code-otlp.plugin.ts` (Start/Stop use marker, else resolution; pending -> deferral), `transcript/orchestrator.ts` (`openSubagentPass` defers, `settleDeferredSubagents` on `Stop`, SessionEnd `final`, summary passes fork-confirmed prompts), `parse-state.ts` (`deferredAgentIds?`), `claude/session/claude-named-invocations.ts` (`plainSlashCommandName`, optional `forkedSlashPromptIds`), `docs/ARCHITECTURE-OTLP-PLUGIN.md`, tests (`fork-skill.test.ts`, `orchestrator.test.ts`, `claude-code-otlp.plugin.test.ts`).

## Checks (revision 2)
| Check | Exit |
|---|---|
| `npx tsc --noEmit` | 0 |
| `npx eslint --max-warnings=0` on `src/agents/plugins/claude-code-otlp` | 0 |
| `npx vitest run src/agents/plugins/claude-code-otlp` + `claude-named-invocations.test.ts` (18 files, 531 tests; includes the two review-boundaries cases and sibling cases as permanent regressions) | 0 |
Revision 3 reran this scope once because `fork-skill.ts` changed; unchanged behaviour (orchestrator, plugin, summary) is covered by the same run. `vitest9.log`.
Intermediate failures while editing: two test-file syntax slips from my generator script and one fixture missing `agentType`; fixed, not product failures. Full suite, build, license and secret gates not run. Logs in `C:/codemie-dev/_local/epmcdme-16352-16391/`.

## Per-run invariants (tests)
- A fork's requests, `agent.subagent.usage` and the Start/Stop `skill_name` agree; before resolution **no** event of a pending subagent is sent, so no wrong scope exists to correct.
- Repeated skill name = separate agent_ids; concurrent fork + Agent child resolve only after the Agent result names the child; nested Agent child (call only in the fork's transcript) stays an agent.
- Replay: a second `Stop` / `SessionEnd` re-sends nothing; deferral is cleared when derived.
- Summary: plain `/name` counted once, in order, only for a prompt whose fork is confirmed; wrapper lines untouched; pending at the final summary -> not counted.

## Evidence sources
- Real recorded session (local, `repro-16074`): a foreground `Agent` child has `meta.toolUseId`, `toolUseResult.agentId`, and its first line `promptId` equals the spawning main prompt's; inline slash uses the `<command-message>` wrapper. Used as a fixture shape.
- Not available: any desktop-app forked-skill transcript.

## Backend contract review (origin/main `7578a3e36`, read-only)
- `rollups.py` `tr` CTE (~435-458): `max()` of `scope_kind`/`scope_name` per request group -> no latest-merge; hence deferral.
- `fork_attribution.py`: a Skill call's `agent.tool.end` names its fork by `fork_agent_id` (already emitted, uncut) else `agentId` in `tool_response`; a slash fork is joined to its `agent.skill.dispatch` by `prompt_id` when that is the only dispatch of the prompt (fork with `skill_name` matches by name, else a foreground fork without one). A `skill_name` on `agent.subagent.start` marks a skill fork. So a deferred fork's start/stop without `skill_name` is joined by those exact keys; its usage (skill-scoped, same `agent_id`) arrives later and is attributed through `agent_id`.
- `rollups.py` ~1219: summary `commands`/`primary_command` are stored as sent, so the chart consumes the emitted summary unchanged.
- Not executed (no DB): whether the Timeline shows one row with the fork's cost for a desktop fork is **not demonstrated**.

## Remaining gates / limitations
1. **Validation gate (real desktop data) - open**: that a slash fork's transcript lines carry the `/name` line's `promptId`, and that its meta has no `toolUseId`, is still an assumption (backend's `prompt_id` join suggests it). If wrong, the fork stays an agent (safe failure), 16391 for desktop would not appear. Needs one real desktop session.
2. A deferred fork's `agent.subagent.stop` **is forwarded** at hook time, but without `skill_name`/`started_at`/`duration_ms`/derived description (never replayed, to avoid a duplicate stop row); only its usage events are deferred. `SubagentStart` has no `skill_name` when its file is missing or the fork is pending. The server pairs a Skill fork by `fork_agent_id` (already sent) and a slash fork by `prompt_id`; end-to-end Timeline behaviour for these, and for a fork whose usage arrives after its stop, depends on the server and is **not demonstrated**.
3. Deferred usage is sent only on a later `Stop`/`SessionEnd`; a session killed before either loses it (same exposure as other backstop data).
4. Cost: pending checks read the main and subagent transcripts on SubagentStop/Stop for sessions with unresolved subagents.
5. Needs independent review, user change approval, complexity assessment of the final diff, then `mr-creator`. No push/PR.
