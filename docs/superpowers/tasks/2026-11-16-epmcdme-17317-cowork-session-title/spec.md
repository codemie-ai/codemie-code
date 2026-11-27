# Spec: Stop sending Claude Desktop's auto-title as `session_title` (Cowork)

**Ticket:** [EPMCDME-17317](https://jiraeu.epam.com/browse/EPMCDME-17317), [CLI Analytics][Claude Desktop] Claude Desktop and Cowork sessions show Desktop's auto-generated chat name as the session prompt (Bug, Minor, epic EPMCDME-12917)
**CLI PR:** [#829](https://github.com/codemie-ai/codemie-code/pull/829), branch `EPMCDME-17317_cowork-session-title`
**Backend MR:** [!4884](https://gitbud.epam.com/epm-cdme/codemie/-/merge_requests/4884), `codemie-dev/codemie`, branch `EPMCDME-17317_desktop-session-title`
**Owner:** Yauheni Hil. **Cowork code owner:** Aliaksei Piatrovich. **Origin of the served-name rule:** EPMCDME-16528 (Viktoriya Ponkratina).
**Companion document:** `handoff.md` in this folder (the record of what was done and what was found by live testing). This spec states the intended behaviour, the decisions behind it, and how to verify it.

## 1. Problem

CLI Analytics (Sessions list, Session Detail header "Prompt: ...", and Efficiency's `worst_session_prompt`) serves a session's **name** instead of its first prompt whenever the session has one. EPMCDME-16528 defines that name as an **explicit** one: `claude --name` or `/rename`.

Claude Desktop names every chat automatically. Both Desktop paths deliver that auto-name as if it were explicit:

| Path | How the auto-name reaches analytics |
|---|---|
| Code tab | Desktop writes it as the session's `custom-title` (the same record `/rename` writes). Claude Code sends it in the hooks' `session_title`. |
| Cowork | The CLI's Cowork producer sent the `title` field of Desktop's `local_<id>.json` as `session_title` on session start and on every prompt. |

Result: every Desktop and Cowork session is labelled with Desktop's auto-name, while a native `claude` session in the same situation shows its first prompt. No data is lost (the first prompt is stored and searchable); the wrong value is served.

Reproduction sessions from the ticket: Code tab `f17aca9c-8d00-43c8-8682-a14ccd196bda` (shown as "Hello world text and PDF"), Cowork `c9edfb02-e43f-4ac1-8122-720c3d9c24c5` (shown as "Helloworld.txt to PDF").

## 2. Goals and non-goals

**Goals**
1. Desktop and Cowork sessions show the user's first prompt, as native `claude` and `codemie-claude` sessions do, in the Sessions list, Session Detail and `worst_session_prompt`.
2. The Cowork producer stops sending Desktop's auto-title, as the ticket's Expected Result states unconditionally for Cowork.
3. Native sessions keep working exactly as before, including an explicit `--name` or `/rename`.

**Non-goals**
- No CLI-side attempt to separate an auto-name from a real rename on the Code tab. The hook payload cannot tell them apart; that is why the Code tab is fixed in the backend.
- No change to the Code tab hook path (`claude-code-otlp.plugin.ts`).
- No change to the label text "Prompt:".
- No backend change in this repo's PR (see section 4).

## 3. Decision: where each half is fixed

| Surface | Where | Why |
|---|---|---|
| Code tab | **Backend** (MR !4884) | The auto-name is sent exactly like a `/rename`, so only the entrypoint distinguishes it. The backend also fixes sessions already stored and every CLI version in the field. The ticket allows this ("or the backend serves the first prompt for those entrypoints"). |
| Cowork, served value | **Backend** (MR !4884) | Same rule, keyed on entrypoint. Covers already-sent events and older CLI versions. |
| Cowork, sent value | **CLI** (this PR) | The ticket states it unconditionally: "the CLI's Cowork producer does not send Desktop's `title` as `session_title`". A backend that is merely sufficient does not satisfy an explicit requirement for this surface. |

The CLI change is therefore required by the ticket, not cleanup. It is also independent of the backend: either can ship first.

## 4. Behaviour

### 4.1 Backend (MR !4884, for reference)
`_served_prompt` ignores `session_title` when the session's entrypoint, trimmed and lowercased, is one of `claude-desktop`, `claude-desktop-3p`, `local-agent`, `remote_cowork`. It then serves the first prompt, else the repository, else the branch. A blank or missing entrypoint keeps the old behaviour. The SQL search also stops matching a session through its hidden Desktop title, so a search result never shows a session under a name the list does not display.

### 4.2 CLI (this PR)
The Cowork producer no longer puts `session_title` on any wire event.

Files changed in `src/telemetry/runtime/cowork/`:
- `cowork-events.ts`: removed the `session_title` stamp from `stampCoworkEvent`; removed `CoworkEnvelope.title` and the `TITLED_TYPES` set, whose only consumer was that line.
- `CoworkEventProducer.ts`: removed `title: discovered.title` from the envelope.
- `types.ts` and `claude-desktop.discovery.ts`: removed the now-unused `LocalTelemetryDiscoveredSession.title` field and the code that filled it from Desktop's metadata (found dead by code review).

The first prompt reaches analytics through the existing `agent.prompt.submit` events built from the transcript's first genuine user turn.

## 5. Acceptance criteria

| # | Criterion | Verified by |
|---|---|---|
| AC1 | No Cowork wire event carries `session_title`, including `agent.session.start` and `agent.prompt.submit`, even when Desktop's metadata has a `title`. | `CoworkEventProducer.test.ts` full-pipeline test; `cowork-events.test.ts` `stampCoworkEvent` test |
| AC2 | The Cowork first prompt is still sent (`agent.prompt.submit` with the first prompt). | existing producer pipeline tests |
| AC3 | Code tab and Cowork sessions are served with their first prompt in Sessions list, Session Detail and `worst_session_prompt`. | backend MR !4884 integration tests |
| AC4 | A native `claude` / `codemie-claude` session with and without `--name` is unchanged. | backend regression tests; no CLI change on that path |
| AC5 | `claude-code-otlp` hook behaviour is unchanged. | not touched by the diff |

## 6. Findings that shape the scope

- **Cowork entrypoint comes from the transcript, not the environment.** `cowork-events.ts:213` sets `state.entrypoint = line.entrypoint`. The Code tab uses `CLAUDE_CODE_ENTRYPOINT` (`claude-code-otlp.plugin.ts:315`). Local-VM Cowork uses `local-agent`, matching Desktop's `local-agent-mode-sessions` directory name; both repos' fixtures hard-code it.
- **A second Cowork entrypoint exists.** Live testing on a real Desktop build found `remote_cowork` (a cloud-hosted workspace linked to the local machine). It has no footprint in this repo. The CLI change is not scoped to an entrypoint (the stamp is removed for every Cowork event, and the entrypoint is read per transcript line), so any `remote_cowork` session this producer handles no longer sends the title. Whether Desktop discovery hands such sessions to this producer at all is **not verified**. The backend list includes it either way.
- **No information is lost.** Cowork has no `--name` or `/rename` equivalent, so removing the auto-title drops nothing a user typed.
- **No other consumer.** `envelope.title` and `TITLED_TYPES` each had exactly one consumer, so both were deleted rather than left as dead code.

## 7. Trade-offs and risks

1. **A deliberate rename inside Desktop is also hidden** by the backend rule, because it cannot be told apart from the auto-name. Accepted by the ticket.
2. **Entrypoint list is a closed set.** A new Desktop entrypoint value would show its auto-name again until added in the backend. The backend keeps the SQL list and the handler constant equal with a test.
3. **`remote_cowork` discovery unverified.** If those sessions never reach this producer, the CLI sends nothing for them and only the backend rule covers them. Nothing in this repo emits a `session_title` for Cowork any more.
4. **Stored rows.** This PR does not change `session_title` already stored; the backend rule corrects how it is served.

## 8. Alternatives considered

- **Backend only, CLI untouched.** Functionally sufficient for Cowork, rejected: the ticket states the CLI requirement for Cowork unconditionally.
- **CLI strips `session_title` for Desktop entrypoints in the hook path.** Rejected: the Code tab cannot be separated from a real `/rename` at the hook, it affects only sessions sent after the CLI update, and it would put the decision in two places.
- **Keep the field and send an empty value for Cowork.** Rejected: leaves dead plumbing; deletion is simpler and safer.

## 9. Verification

Reported in `handoff.md` (not re-run while writing this spec): 177 tests pass across `src/telemetry/runtime/`; `npm run typecheck` and `eslint --max-warnings=0` are clean on the four changed files; the producer test was shown failing before the production change and passing after.

Manual check on a real Desktop build, after both PRs are deployed: open the two reproduction sessions in CLI Analytics, Sessions and Session Detail, and confirm the first prompt is shown; run the same prompt with native `claude` as a control.

## 10. Reviewer notes

- The CLI diff is small: two source files with deletions only, plus two test files.
- Review the backend MR together with this PR; the entrypoint list and the rule live there.
- The open question for review is `remote_cowork`: whether Desktop discovery hands those sessions to the Cowork producer, or only the backend rule covers them.
