# Technical Research

**Task**: compaction litellm bedrock qwen opencode modify_params tools
**Generated**: 2026-06-24T00:00:00Z
**Research path**: codegraph + filesystem (codegraph for codemie-code, filesystem for opencode and codemie repos)

---

## 1. Original Context

codemie-opencode compaction fails for Bedrock Qwen3 Coder 480B due to LiteLLM missing tools parameter error. When using codemie-opencode with Bedrock Qwen3 Coder 480B A35B, the compaction flow fails with a LiteLLM UnsupportedParamsError. The error is: 'Bedrock doesnt support tool calling without tools= param specified. Pass tools= param OR set litellm.modify_params = True // litellm_settings::modify_params: True to add dummy tool to the request. Received Model Group=qwen.qwen3-coder-480b-a35b-v1'. The fix should either pass the tools= parameter or set modify_params=True in LiteLLM configuration. The fix should be applied in the correct configuration/runtime layer so users do not need to manually patch local settings.

---

## 2. Codebase Findings

### Existing Implementations

**Compaction entry points — two independent code paths exist:**

**Path A — New opencode core (packages/core, used in v2 session runner):**
- `/home/taras_spashchenko/TS/github/opencode/packages/core/src/session/compaction.ts` — `SessionCompaction.make()` builds an `LLMRequest` with `tools: []` (empty array) and calls `llm.stream(request)` directly. This is the new path used by `packages/core/src/session/runner/llm.ts`.
- `/home/taras_spashchenko/TS/github/opencode/packages/core/src/session/runner/llm.ts:104` — creates the compaction instance via `SessionCompaction.make({ events, llm, config })`, then calls `compaction.compactIfNeeded(...)` and `compaction.compactAfterOverflow(...)` during each turn.
- `/home/taras_spashchenko/TS/github/opencode/packages/llm/src/protocols/bedrock-converse.ts:387-390` — `fromRequest` function: when `request.tools.length > 0` is false, `toolConfig` is set to `undefined`. No `toolConfig` key is sent to Bedrock. This is correct for Claude but triggers LiteLLM's validation for Qwen3.

**Path B — Old opencode (packages/opencode, current production path for codemie-opencode):**
- `/home/taras_spashchenko/TS/github/opencode/packages/opencode/src/session/compaction.ts:338-424` — `processCompaction` function. At line 414, `processor.process(...)` is called with `tools: {}` (empty object). This flows through `LLM.Service` → `LLMRequestPrep.prepare()` → `streamText(ai-sdk)` → LiteLLM proxy.
- `/home/taras_spashchenko/TS/github/opencode/packages/opencode/src/session/llm/request.ts:148-165` — `LLMRequestPrep.prepare()`: when `tools` is empty and provider is `github-copilot`, it injects a `_noop` dummy tool. **No equivalent handling exists for Bedrock/Qwen3.**
- `/home/taras_spashchenko/TS/github/opencode/packages/opencode/src/session/llm.ts` — `LLM.Service` wires `LLMRequestPrep.prepare()` and then calls `streamText(...)` from the AI SDK, which goes to the LiteLLM proxy endpoint.

**LiteLLM proxy configuration:**
- `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml` — Main LiteLLM proxy configuration. Already has `drop_params: true` under `litellm_settings` (line 423). **Does NOT have `modify_params: true`**. The Qwen3 Bedrock models are defined at lines 305-349.
- `litellm_settings.drop_params: true` — drops unsupported params but does NOT add a dummy tool. This is a separate concern from `modify_params`.

**LiteLLM source (installed package):**
- `/home/taras_spashchenko/EPAM/cm/codemie/.venv/lib/python3.12/site-packages/litellm/llms/bedrock/chat/converse_transformation.py:1450-1466` — The exact location of the validation that raises `UnsupportedParamsError`. The condition is: if `tools` not in `optional_params` AND messages contain tool-call blocks, raise unless `litellm.modify_params` is True (in which case it injects `add_dummy_tool()`).

**Qwen3 model configuration in codemie-code:**
- `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code/src/agents/plugins/opencode/opencode-model-configs.ts:430-455` — Static config for `qwen.qwen3-coder-480b-a35b-v1` has `tool_call: true`.
- `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code/src/agents/plugins/opencode/opencode.plugin.ts:112` — When `provider === 'bedrock'`, `activeProvider` is set to `'amazon-bedrock'` (OpenCode's native Bedrock, NOT routed through LiteLLM proxy). When routed through LiteLLM (`provider === 'litellm'` or SSO), all traffic goes through the LiteLLM proxy.

### Architecture and Layers Affected

| Layer | Component | Change Needed |
|---|---|---|
| LiteLLM Proxy Config | `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml` | Add `modify_params: true` to `litellm_settings` |
| OpenCode LLM request prep | `/home/taras_spashchenko/TS/github/opencode/packages/opencode/src/session/llm/request.ts` | Optionally: extend dummy-tool injection to Bedrock (mirrors GitHub Copilot pattern) |
| OpenCode core compaction | `/home/taras_spashchenko/TS/github/opencode/packages/core/src/session/compaction.ts` | No immediate change (tools=[] does not trigger the error; error requires tool-call blocks in history) |

The error is triggered when LiteLLM sees prior tool-call message blocks in the conversation history but no `tools` parameter in the compaction request. This happens only in Path B (old opencode) via the LiteLLM proxy.

### Integration Points

- **codemie-opencode → LiteLLM proxy**: OpenCode (Path B) routes all LLM calls through the LiteLLM proxy at `CODEMIE_BASE_URL` when provider is `litellm` or `ai-run-sso`. The proxy translates OpenAI-compatible requests to Bedrock Converse.
- **LiteLLM → AWS Bedrock**: LiteLLM uses `bedrock/qwen.qwen3-coder-480b-a35b-v1:0` model string, routes via `default_aws_bedrock_credential`.
- **Compaction prompt path**: `compaction.ts:processCompaction` → `processor.process({ tools: {}, messages: [...], ... })` → `LLM.service.stream(...)` → `LLMRequestPrep.prepare(...)` → `streamText(ai)` → LiteLLM proxy POST → Bedrock Converse transformation → raises `UnsupportedParamsError` if prior assistant messages contain tool-call blocks and `tools` is absent.
- **GitHub Copilot noop pattern**: `packages/opencode/src/session/llm/request.ts:150-165` — already has a provider-specific dummy tool injection. Same pattern can be applied to Bedrock.

### Patterns and Conventions

- **LiteLLM `litellm_settings`**: Global runtime behaviour is configured in the `litellm_settings` section of `litellm_config.yaml`. Setting `modify_params: true` here is a single-line, zero-code-change fix at the proxy layer.
- **`drop_params: true`** is already present in `litellm_settings` (line 423). The `modify_params` key follows the same pattern.
- **Dummy-tool injection pattern** (GitHub Copilot path in `request.ts`): Provider-specific tool injection is already established in the codebase. This is the opencode-side fix alternative.
- **No model-specific workaround needed** — `modify_params: true` is a global setting; it is safe because it only activates when tool blocks appear in history without an explicit tools list (it adds a dummy tool to satisfy the Bedrock API, then the model is told not to call it).

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/integration/external-integrations.md` — covers LiteLLM as a provider. Does not document `modify_params` or Bedrock-specific parameter handling.
- No ADRs found specifically for LiteLLM `modify_params` configuration.

### Architectural Decisions

- The `drop_params: true` setting in `litellm_config.yaml` (line 423) establishes a precedent for tolerant/permissive parameter handling at the proxy layer. Adding `modify_params: true` is consistent with this posture.
- OpenCode's GitHub Copilot dummy-tool injection in `request.ts` shows the team is willing to add provider-specific workarounds at the LLM request preparation layer.

### Derived Conventions

- LiteLLM proxy config changes are the preferred place for Bedrock-specific workarounds — avoids patching the OpenCode binary or codemie-code.
- Model-specific `litellm_params` sections in `litellm_config.yaml` can carry per-model overrides if a global setting is too broad.

---

## 4. Testing Landscape

### Existing Coverage

- `/home/taras_spashchenko/TS/github/opencode/packages/core/test/session-compaction.test.ts` — Unit test for `serializeToolContent`. Does not test the LLM call pathway or tools parameter.
- No integration tests found covering the compaction → LiteLLM → Bedrock Converse flow for Qwen3.
- `/home/taras_spashchenko/EPAM/cm/codemie/tests/enterprise/litellm/test_litellm_dependencies.py` — Tests LiteLLM dependencies but not `modify_params` or Bedrock Qwen3.

### Testing Framework and Patterns

- OpenCode: Bun test runner (`bun:test`), unit tests co-located in `packages/*/test/`.
- Codemie: pytest, tests under `tests/enterprise/litellm/`.
- No mock or fixture for the LiteLLM proxy / Bedrock Converse integration path.

### Coverage Gaps

- No test for the compaction flow producing an empty `tools` list when prior messages contain tool-call blocks — the exact scenario triggering this bug.
- No test validating that `modify_params: true` prevents `UnsupportedParamsError` for Qwen3 Bedrock models during compaction.
- No test for the GitHub Copilot–style dummy-tool injection path in `request.ts` (if applied to Bedrock).

---

## 5. Configuration and Environment

### Environment Variables

- `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` — Bedrock authentication, read from `default_aws_bedrock_credential`.
- `AWS_REGION` / `CODEMIE_AWS_REGION` — AWS region for Bedrock endpoint routing.
- `CODEMIE_BASE_URL` — Base URL of the LiteLLM proxy, used by OpenCode when provider is `litellm` or SSO.
- `CODEMIE_PROVIDER` — Controls whether OpenCode uses native Bedrock (`'bedrock'`) or LiteLLM proxy route.
- No environment variable controls `modify_params` — it must be set in `litellm_config.yaml`.

### Configuration Files

- `/home/taras_spashchenko/EPAM/cm/codemie/litellm_config.yaml` — Primary LiteLLM proxy config. Governs model routing, credentials, and global LiteLLM settings. **This is the correct file to add `modify_params: true`.**
- `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code/src/agents/plugins/opencode/opencode-model-configs.ts` — Static OpenCode model registry (not the fix location).
- `/home/taras_spashchenko/EPAM/codemie-ai/codemie-code/src/agents/plugins/opencode/opencode.plugin.ts` — OpenCode plugin lifecycle; controls which provider route is used.

### Feature Flags and Deployment Concerns

- `litellm_settings.drop_params: true` is already active — adding `modify_params: true` to the same section is a one-line config change requiring LiteLLM proxy restart/redeploy.
- `modify_params: true` is a global LiteLLM setting. It affects all Bedrock Converse calls through the proxy, not just Qwen3. For all Anthropic Claude models routed through LiteLLM, the dummy-tool injection would only trigger when tool-call history exists without tools — a scenario that should not occur in normal flows. Risk is low.

---

## 6. Risk Indicators

- **Root cause is confirmed**: `litellm_config.yaml` line 419-424 (`litellm_settings`) does not include `modify_params: true`. LiteLLM's `converse_transformation.py:1457` checks `litellm.modify_params` to decide whether to inject a dummy tool or raise `UnsupportedParamsError`.
- **Two valid fix layers exist**: (1) `litellm_config.yaml` (`modify_params: true` — single-line, no code change, requires proxy redeploy), (2) `packages/opencode/src/session/llm/request.ts` (extend the GitHub Copilot dummy-tool pattern to include Bedrock providers — requires OpenCode binary change).
- **Only Path B is affected**: The new `packages/core` compaction path sends `tools: []` directly to the Bedrock Converse protocol (not via LiteLLM) — `bedrock-converse.ts:388` already gates on `tools.length > 0`, so `toolConfig` is omitted cleanly. The Bedrock Converse API itself does not require `toolConfig` when there are no tools. The error only occurs when LiteLLM transforms the request and detects prior tool-call message blocks.
- **The bug is Bedrock-provider-scoped in codemie-opencode**: it only occurs when Qwen3 480B is selected AND the LiteLLM proxy route is active AND the session contains prior tool calls before compaction triggers.
- **`modify_params: true` scope**: Global — it applies to all Bedrock Converse calls going through this LiteLLM instance. This includes Claude, Kimi, and Qwen3 on Bedrock. In practice, the check is only triggered when a request lacks `tools` but messages contain `tool_call` blocks — a pattern that should only arise in the compaction path.
- **No test coverage** for the compaction → LiteLLM → Bedrock Qwen3 path. Any fix should be manually verified end-to-end.
- **Proxy redeploy required** for the `litellm_config.yaml` fix. If OpenCode-side fix is preferred, an OpenCode binary update is required.

---

## 7. Summary for Complexity Assessment

The bug has a single, precisely identified root cause: `litellm_config.yaml` in `/home/taras_spashchenko/EPAM/cm/codemie/` is missing `modify_params: true` under its `litellm_settings` section. LiteLLM's Bedrock Converse transformation (`converse_transformation.py:1457`) checks this flag when it detects tool-call blocks in the message history but no `tools` parameter in the request. Compaction deliberately sends an empty tools list, which, combined with prior tool-call history in the Qwen3 session, triggers the `UnsupportedParamsError`. The fix at the proxy layer is one line: add `modify_params: true` to `litellm_settings` in `litellm_config.yaml`.

The task touches the Configuration layer (one YAML file) and optionally the LLM Request Preparation layer in the opencode package (`packages/opencode/src/session/llm/request.ts`). The minimal change surface is 1 file, 1 line. The broader change — adding a Bedrock-specific dummy-tool injection in `request.ts` — mirrors the already-present GitHub Copilot pattern (lines 150-165) and would involve approximately 10 lines of TypeScript in 1 file. No architectural changes are needed.

Test coverage for the affected path is absent. The compaction → LiteLLM → Bedrock Converse pipeline has no integration tests; the only existing compaction test verifies tool-output serialization, not the LLM call pathway. This means the fix requires manual end-to-end verification with a live Qwen3 Bedrock session. Technical novelty is low — both fix options follow established patterns already present in the codebase. The primary risk is the global scope of `modify_params: true` in LiteLLM, which is acceptable given that the flag only activates under the specific condition of tool-history-without-tools-parameter (a condition that should not arise outside compaction).
