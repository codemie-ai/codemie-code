# Technical Analysis — `--conversation-id` in assistant-to-skill/agent generators

## Investigation

`codemie assistants setup` reads remote assistants from the platform and writes them as local Claude skills/agents (and Codex/Gemini equivalents). Four generators produce the local files:

| Generator | Output path | Bad invocations |
|---|---|---|
| `src/cli/commands/assistants/setup/generators/claude-skill-generator.ts` | `~/.claude/skills/<slug>/SKILL.md` | lines 63, 70, 77, 82 |
| `src/cli/commands/assistants/setup/generators/claude-agent-generator.ts` | `~/.claude/agents/<slug>.md` | lines 62, 69, 76, 81 |
| `src/cli/commands/assistants/setup/generators/codex-skill-generator.ts` | Codex assistant skill file | lines 48, 54 |
| `src/cli/commands/assistants/setup/generators/gemini-skill-generator.ts` | Gemini assistant skill file | lines 48, 54 |

All four emit the same `dedent`-templated boilerplate:

```
## Instructions
1. Extract the user's message from the conversation context
2. Execute the command with the message
3. Return the response

**Command format:**
codemie assistants chat "${assistant.id}" "message"
```

No `--conversation-id` is passed. There is no documented rule for multi-turn workflows. There is no documented verification step after writes.

## Codebase Findings — supporting context

* `src/cli/commands/assistants/chat/index.ts:39` declares `--conversation-id <id>`.
* `src/cli/commands/assistants/chat/index.ts:83` falls back to `process.env.CODEMIE_SESSION_ID` when no flag is given.
* `src/cli/commands/assistants/chat/historyLoader.ts:35-82` reads JSONL history from `~/.codemie/sessions/<id>/conversations/…`.
* `src/cli/commands/assistants/chat/index.ts:366` sends `conversation_id: conversationId` on every wire call.
* `src/agents/core/BaseAgentAdapter.ts:482` injects `CODEMIE_SESSION_ID` into every spawned agent child process.
* `src/cli/commands/assistants/setup/helpers.ts:95` is the orchestrator that calls every generator and overwrites the file on every run — so generator template changes propagate to users the next time they re-run setup, and any hand-edits to the produced SKILL.md / agent.md are clobbered.

So the CLI adapter and the env-var injection are already correct. The bug is purely in the four template strings.

## Failure mode confirmed in this session

Two distinct failures, both caused by the missing `--conversation-id`:

1. **Cross-topic context bleed.** A second call to brianna inside the same Claude session received state from an unrelated earlier conversation (an "OSS collector deployment" topic) because both calls shared the implicit `CODEMIE_SESSION_ID` and the server-side history merged them. The assistant attempted to draft a Story for OSS collector deployment instead of a Task for msgraph sync.

2. **Apply-confirmation corruption.** A multi-turn draft → confirm → apply workflow caused the Jira ticket's Description field to be overwritten with the literal text `Please provide the updated Description content to apply to EPMCDME-12918.` — the assistant's own previous-turn fallback prompt was persisted as content because the confirmation message arrived without any "draft" context to apply against.

Both were resolved manually by sending a single self-contained message with the full final content.

## Risk Indicators

1. **No existing tests** exercise the template contents of the four generators beyond verifying that files get written. A snapshot or regex test for the `--conversation-id` substring would prevent regression but is not in scope per AGENTS.md rule 2 (tests on explicit request only).
2. **Live brianna users** already have a broken `~/.claude/skills/brianna/SKILL.md` written by the current generator. After the fix lands and ships, those files persist until the user re-runs `codemie assistants setup`. The fix release notes must call out the `setup` rerun.
3. **`CODEMIE_SESSION_ID` env-var fallback is a footgun.** Leaving it in place is correct for the codemie-shipped CLI skills (analytics, sdk, msgraph) that don't talk to assistants, but assistant skills should explicitly opt in via `--conversation-id`. The fix relies on the template instructing the caller to pass a per-workflow id — not on removing the env-var fallback.
4. **No new Microsoft Graph / Jira / CodeMie API surface** is touched by this change. Pure template edits.
5. **Four generators must stay in sync.** Future template edits should be replicated across all four to avoid divergence between Claude / Codex / Gemini.
