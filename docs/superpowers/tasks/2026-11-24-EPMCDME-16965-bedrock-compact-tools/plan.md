# EPMCDME-16965 Tools Guard Implementation Plan

**Goal:** Keep tool-history requests with absent/empty `tools` valid for Bedrock via a proxy-side placeholder tool (spec: `spec.md`).

**Architecture:** New pure helper `claude-tools-guard.ts` plus new interceptor plugin `tools-guard.plugin.ts` (priority 14) in `src/providers/plugins/sso/proxy/plugins/`. `claude-request-normalizer.plugin.ts` is not touched.

**Conventions:** ES modules with `.js` import suffixes, `@/` alias, `logger.debug`, no `any`, explicit return types. No git operations in tasks (calling flow owns commits; use the repository's existing convention if asked). Tests are not part of this run (repo policy, spec non-goal).

---

### Task 1: Pure helper `claude-tools-guard.ts`

**Files:** Create `src/providers/plugins/sso/proxy/plugins/claude-tools-guard.ts`

Export `applyToolsGuard(body: Record<string, unknown>): 'anthropic' | 'openai' | null`, which mutates `body` and returns the injected shape, or `null` when untouched.

- Tool history: Anthropic when any `messages[].content[]` block has `type` `tool_use` or `tool_result`; OpenAI when any message has `role: "tool"` or a non-empty assistant `tool_calls`. Anthropic wins if both match.
- Trigger only when tool history exists and `body.tools` is absent, not an array, or empty. Never change a non-empty `tools`.
- Inject one placeholder in the matching wire shape, per spec Approach (Anthropic `{name, description, input_schema: {type: 'object', properties: {}}}`; OpenAI `{type: 'function', function: {name, description, parameters: {type: 'object', properties: {}}}}`). Description says never call it.
- When `body.tool_choice` is undefined, set `{type: 'none'}` (Anthropic) or `'none'` (OpenAI). Gate this behind one module constant `SET_TOOL_CHOICE_NONE = true`. It cannot be confirmed from this repo that the gateway and Bedrock accept it. Flip the constant to `false` (description-only fallback) if the AC5 compaction-shaped request is rejected.
- Must not depend on `model`; never throw on odd shapes (non-array `messages`, string `content`).

Test-first: no — tests not requested (repo policy)

### Task 2: Plugin `tools-guard.plugin.ts`

**Files:** Create `src/providers/plugins/sso/proxy/plugins/tools-guard.plugin.ts`

Mirror the skeleton and imports of `background-request-normalizer.plugin.ts:88-134` (`ProxyPlugin` + `ProxyInterceptor`, JSON content-type guard, parse in try/catch with pass-through). Define `ToolsGuardPlugin` with id `@codemie/proxy-tools-guard`, priority 14, and `clients = ['codemie-code', 'codemie-claude', 'codemie-copilot', CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE]` (import the two constants as the background plugin does). In `onRequest`, call `applyToolsGuard`. Only when it returns non-null, re-serialize into `context.requestBody`, set `content-length`, and write one `logger.debug` line prefixed `[tools-guard]`. Header comment states the shim status and removal condition from spec AC6.

Test-first: no — tests not requested (repo policy)

### Task 3: Register the plugin

**Files:** Modify `src/providers/plugins/sso/proxy/plugins/index.ts` (imports ~19-25, register ~47-50, exports ~77-83)

Import `ToolsGuardPlugin`, add `registry.register(new ToolsGuardPlugin()); // Priority 14 - injects a placeholder tool when tool history has no tools (Bedrock compatibility shim)` after the Codex normalizer line, and add it to the export list. Read `plugins/__tests__/plugin-order.test.ts` to confirm priority 14 keeps its constraints; do not run it.

Test-first: no — tests not requested (repo policy)

### Task 4: Update `docs/ARCHITECTURE-PROXY.md`

**Files:** Modify `docs/ARCHITECTURE-PROXY.md` (diagram line ~75, list ~202, §6.6 at 589-598, file tree ~1040-1042)

Add the Tools Guard to the priority-14 mentions and to §6.6 as a bullet. The bullet records: clients, body-shape-only trigger, the placeholder and `tool_choice: none` behavior, that the rejecting layer is LiteLLM's Bedrock Converse transformation, that it is a shim superseded by an effective `modify_params` in the `codemie` repo (owner: proxy plugin owner), and the removal condition (server flag confirmed effective for the Claude aliases). Add `tools-guard.plugin.ts` and `claude-tools-guard.ts` to the file tree.

Test-first: no — tests not requested (repo policy)

---

negative-constraints (pass done): no change to `claude-request-normalizer.plugin.ts` or its clients (no task touches it); no Bedrock detection (body shape only, Task 1); no change to `logBedrockUpstreamError`, the `codemie` repo or `litellm_config.yaml` (none touched); no compaction detection (Task 1 trigger); no other clients or `/v1/responses` bodies (client list in Task 2); no tests; no git operations.
