# EPMCDME-16965: Keep tool-history requests valid for Bedrock (proxy-side tools guard)

## Problem

`/compact` and auto-compaction send a request whose message history holds tool calls and tool results but whose `tools` is absent or empty. Bedrock Converse via LiteLLM rejects it with `UnsupportedParamsError: Bedrock doesn't support tool calling without 'tools=' param`. The session then stays broken, because every later request carries the same history.

Nothing in the SSO proxy reads or writes `tools` (analysis, Codebase Findings). `logBedrockUpstreamError` (`sso.proxy.ts:784-802`) only logs after the response, and its model filter does not match `claude-sonnet-4-6`. The server-side `modify_params` remedy lives in the `codemie` repo and cannot be verified here.

The ticket repro is a `codemie-code` session. That agent talks to the proxy through `@ai-sdk/openai-compatible` (`codemie-code.plugin.ts:112,144,155`), so its bodies are most likely OpenAI chat-completions shaped (assistant `tool_calls`, `role: "tool"` messages). It is not in the Claude normalizer's clients (`claude-request-normalizer.plugin.ts:191`).

## Approach

A new small plugin, `tools-guard.plugin.ts`, in `src/providers/plugins/sso/proxy/plugins/`, backed by a pure helper `claude-tools-guard.ts`. It is registered in `plugins/index.ts` next to the other normalizers (priority 14, existing `plugin-order` constraints kept). The Claude normalizer is not changed, so enabling the guard for `codemie-code` does not enable the sampling, effort, thinking or model-rewrite handlers for it.

- **Clients**: `codemie-code` plus the Claude normalizer's clients (`codemie-claude`, `codemie-copilot`, `CLAUDE_DESKTOP`, `VSCODE_CLAUDE_CODE`). The list lives in the new plugin only.
- **Trigger** (body shape only, no Bedrock signal exists in the plugin context): the body has tool history and `tools` is absent, not an array, or empty. Tool history means either Anthropic blocks (`tool_use` / `tool_result` in `messages[].content[]`) or OpenAI messages (assistant `tool_calls`, or `role: "tool"`).
- **Action**: set `tools` to one minimal placeholder tool in the same wire shape as the body: Anthropic `{name, description, input_schema: {type: object, properties: {}}}`, or OpenAI `{type: "function", function: {name, description, parameters: {type: object, properties: {}}}}`. The description tells the model never to call it.
- **tool_choice**: when the body has none, also set "no tool use" (`{type: "none"}` Anthropic, `"none"` OpenAI), so a compaction reply stays text. The plan must check that the gateway and Bedrock accept it for the Claude aliases. If not, the description-only form is kept and `tool_choice` is left untouched.
- **Safety**: a non-empty `tools` or an existing `tool_choice` is never changed, and a request with no tool history is never touched. The handler does not depend on `model`, so requests without a model are covered. It never throws, passes through on parse error, and updates `content-length` only on change. One `logger.debug` line with the `[tools-guard]` prefix is written on injection.

## Acceptance criteria

1. A request from a listed client with tool history (either shape) and absent or empty `tools` leaves the proxy with a one-entry placeholder `tools` array in that request's own shape (ticket AC1, AC3).
2. A request with tool history and no `tools` is accepted, and a following request that already carries `tools` leaves this plugin byte-identical (ticket AC2).
3. Requests without tool history, or with a non-empty `tools`, are byte-identical to today (ticket AC5).
4. Requests from clients outside the guard's list are unchanged, and the Claude normalizer's behavior for `codemie-code` is unchanged (ticket AC5).
5. The injected request carries "no tool use" when it had no `tool_choice` and the plan confirmed that it is accepted. The compaction reply is expected to be a text block, confirmed by one compaction-shaped request sent through the proxy.
6. Records (PR description and `docs/ARCHITECTURE-PROXY.md` near lines ~592 and ~1040): the rejecting layer is LiteLLM's Bedrock Converse transformation. The guard is a compatibility shim, superseded by an effective `modify_params` in the `codemie` repo. Its owner is the proxy plugin owner. Removal condition: the server flag is confirmed effective for the Claude aliases. Why `modify_params` did not prevent the error is not verifiable here and is flagged for the `codemie` repo (ticket AC4).
7. The failing request shape (client name, wire shape, `tools` absent or empty) is confirmed from one captured request or GitHub issue #283 before implementation completes. If it differs, the trigger is adjusted before merge (ticket AC1).

## Non-goals

- No change to `claude-request-normalizer.plugin.ts` and none to its clients list.
- No Bedrock/Vertex backend detection.
- No change to `logBedrockUpstreamError`, the `codemie` repo or `litellm_config.yaml`.
- No compaction-request detection.
- No other clients (for example `codemie-opencode*`), and no Responses API (`/v1/responses`) bodies.
- Tests are not part of this run: repo policy is tests only on request, and the task says not to write them. The ticket's AC6 is deferred.
- No git operations.

## Decisions

- Separate guard plugin over a handler inside the Claude normalizer — user, answers AR-1: it reaches `codemie-code` without enabling the normalizer's other handlers.
- `codemie-code` covered over left out of scope — user, answers AR-1.
- Both Anthropic and OpenAI wire shapes over Anthropic only: `codemie-code` uses `@ai-sdk/openai-compatible`.
- Body-shape-only condition over Bedrock-specific detection: the plugin has no backend signal.
- Fixed minimal placeholder tool over copying earlier tool definitions: they are not in the request and the helper stays pure.
- "No tool use" `tool_choice` set when absent over leaving it unset, with description-only as the fallback: keeps the compaction reply textual (AR-2).
- Guard declared a shim with a named removal condition over an open-ended second mechanism (AR-3).
- Tests deferred over writing them now: task instruction and repo policy.

## Open risks

- The wire shape and client name of the failing traffic are inferred from the agent's config, not captured (AC7).
- `modify_params` state in the `codemie` repo is unverified.
- `tool_choice: none` acceptance by the gateway and Bedrock is unverified.
- The placeholder changes the tools-prefix prompt cache of compaction requests, billed at the uncached rate. This cost is accepted.
- The placeholder is visible to request logging and analytics. It applies to all backends behind the listed clients. A proxy daemon restart is likely needed for running sessions (speculative).
