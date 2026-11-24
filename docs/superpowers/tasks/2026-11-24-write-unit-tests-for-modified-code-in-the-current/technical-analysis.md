# Technical Research

**Task**: proxy tools-guard bedrock tests
**Generated**: 2026-11-24
**Research path**: filesystem

---

## 1. Original Context

task_context: write unit tests for modified code in the current branch
(Context: branch EPMCDME-16965_bedrock-compact-tools3, base main. "Modified code" = the diff of this branch vs main, via `git diff main...HEAD`. Commits include proxy tools-guard work: placeholder tools injection for tool-history requests, scoped to generation endpoints. The repo uses Vitest; see .ai-run/guides/testing/testing-patterns.md. Note the user explicitly requests tests, so the repo's "tests only on request" rule is satisfied. Identify changed source files, existing tests covering them, coverage gaps, and test conventions/mocking patterns.)

---

## 2. Codebase Findings

### Existing Implementations
Purpose: the proxy must keep Bedrock (LiteLLM Converse) from rejecting tool-history requests that have no `tools`.
- `src/providers/plugins/sso/proxy/plugins/claude-tools-guard.ts` — pure helper `applyToolsGuard(body): 'anthropic'|'openai'|'responses'|null`, mutates body. Rules: returns null if `tools` is a non-empty array; detects history from `messages` (content blocks `tool_use`/`tool_result` -> anthropic; `role:'tool'` or non-empty `tool_calls` -> openai; anthropic wins over openai even if openai appears earlier) else `input` items of type `function_call`/`function_call_output` -> responses. Injects `noop_placeholder_tool` in the matching wire shape (anthropic `input_schema`; openai `{type:'function',function:{...parameters}}`; responses flat `{type:'function',name,...parameters}`). Deletes forcing `tool_choice` (string `required`/`any`; object with `type` not `auto`/`none`); keeps `auto`/`none`/absent. `SET_TOOL_CHOICE_NONE=false` constant (module-private, so that branch is unreachable from tests). Replaces empty `tools: []`; non-array `tools` (e.g. object/string) is treated as absent.
- `.../plugins/tools-guard.plugin.ts` — `ToolsGuardPlugin` (id `@codemie/proxy-tools-guard`, priority 14, `clients` = codemie-code, codemie-claude, codemie-claude-acp, codemie-opencode, codemie-opencode-acp, codemie-copilot, CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE). `createInterceptor` returns `ToolsGuardInterceptor` (not exported; reach it via the plugin). `onRequest` returns early on: no `requestBody`, content-type lacking `application/json`, URL not matching `/\/(?:messages|chat\/completions|responses)\/?$/` (query string stripped first; `/v1/messages/count_tokens` excluded), invalid JSON, non-object JSON (note `null` and primitives hit the `!body || typeof body !== 'object'` guard; arrays pass the guard). On injection it rewrites `context.requestBody` and sets `headers['content-length']` to new byte length, logs via `logger.debug`.
- `.../plugins/index.ts` — registers `ToolsGuardPlugin` in `registerCorePlugins()` and re-exports it.
- `docs/ARCHITECTURE-PROXY.md` — doc only.
- Other branch files: `docs/superpowers/tasks/...` SDLC artifacts (no code).

### Decisions Already in the Code
- Trigger is body shape only, never model (header comments). Generation endpoints only (commit 7fd9c0ca).
- Test convention: tests live in `src/providers/plugins/sso/proxy/plugins/__tests__/<name>.test.ts`, with `@group unit` header (vitest include `src/**/*.test.ts`, globals true, node env).

### Task Statements Checked Against the Code
- "placeholder tools injection ... scoped to generation endpoints": holds (`tools-guard.plugin.ts` GENERATION_PATH_PATTERN).
- "Vitest; testing-patterns.md": holds (vitest.config.ts); guide not read in this pass.

### Consumers of Changed Contracts
`applyToolsGuard` consumed only by `tools-guard.plugin.ts`; `ToolsGuardPlugin` consumed only by `index.ts` (registration and export). Searched `ToolsGuard|tools-guard` across `src` and `tests`: no other hits, no test hits.

### Architecture and Layers Affected
Provider plugin layer: SSO proxy request-interceptor plugins (priority 14).

### Integration Points
`../types.js` (ProxyPlugin/PluginContext/ProxyInterceptor), `../proxy-types.js` (ProxyContext), `../proxy-clients.js` (CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE), `@/utils/logger.js`, `registry.ts` (priority sort).

### Patterns and Conventions
Sibling test `claude-request-normalizer.plugin.test.ts` pattern: `createPluginContext(...)` returns `{config:{targetApiUrl,provider,sessionId,clientType,model}, logger}`; `createProxyContext(body, contentType)` builds `{requestId,sessionId,agentName,method:'POST',url:'/v1/messages',headers:{'content-type','content-length'},requestBody:Buffer,requestStartTime}`; then `plugin.createInterceptor(ctx)` and `interceptor.onRequest!(proxyCtx)`; assertions JSON-parse `proxyCtx.requestBody`. Uses `vi.mock` for heavy imports, not needed here (tools-guard imports are light). `plugin-order.test.ts` shows priority-order check via `new PluginRegistry()` and `registry['getEnabledPluginsSorted']()`.

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/testing/testing-patterns.md` exists per AGENTS.md (not read here); `docs/ARCHITECTURE-PROXY.md` section 6.6 describes Tools Guard.

### Architectural Decisions
Shim to be removed when LiteLLM `modify_params` is effective (header of tools-guard.plugin.ts).

### Derived Conventions
Test files named `*.test.ts` in the plugin's `__tests__`, `@group unit` docblock, `.js` import suffixes, vitest imports explicit.

---

## 4. Testing Landscape

### Existing Coverage
None for `claude-tools-guard.ts`, `tools-guard.plugin.ts`, or its registration. `plugin-order.test.ts` does not mention it.

### Testing Framework and Patterns
Vitest, globals true, node env; explicit `import { describe, it, expect } from 'vitest'`. Tests use hand-built context helpers, no fakes needed.

### Coverage Gaps
All of the above: helper (shape detection, precedence, empty/non-array tools, tool_choice handling, malformed message entries), interceptor (early returns, endpoint regex incl. query string and trailing slash, content-length update, invalid JSON, mutation absent when no history), plugin metadata (id, priority, clients), `registerCorePlugins`/index export.

---

## 5. Configuration and Environment

### Environment Variables
None used by the feature.

### Configuration Files
`vitest.config.ts` (unit project includes `src/**/*.test.ts`).

### Feature Flags and Deployment Concerns
Module constant `SET_TOOL_CHOICE_NONE=false` (not configurable; non-exported).

---

## 6. Risk Indicators

- Speculative: the `SET_TOOL_CHOICE_NONE=true` branch cannot be exercised without module mocking or code change; it is dead under current constant.
- `ToolsGuardInterceptor` is not exported; tests must go through `ToolsGuardPlugin.createInterceptor`.
- Array JSON bodies pass the object guard in the interceptor (`typeof [] === 'object'`); behaviour then falls out of `applyToolsGuard` (no `tools`, no history -> null). Characterization only.
- `logger.debug` call can be spied (`vi.spyOn(logger,'debug')`) but is low value.
- Testing-patterns guide not read in this pass.

---

## 7. Summary for Complexity Assessment

The branch changes three source files in one layer (SSO proxy request-interceptor plugins): a pure helper `claude-tools-guard.ts` (~110 lines), the `ToolsGuardPlugin` and its non-exported interceptor, and a registration/export edit in `index.ts`; the rest is documentation and SDLC artifacts. Test surface is two new files at most, plus an optional assertion on plugin ordering or registration.

There is no technical novelty: sibling plugins already have tests (`claude-request-normalizer.plugin.test.ts`, `plugin-order.test.ts`) that provide the context-helper and invocation pattern. No mocks are required because imports are light. Existing coverage of the changed code is zero.

Main risks are the unreachable `SET_TOOL_CHOICE_NONE` branch and branch-case enumeration in the helper (three wire shapes, tool_choice variants, endpoint regex edge cases).

---

## 8. External References

None named by the task.
