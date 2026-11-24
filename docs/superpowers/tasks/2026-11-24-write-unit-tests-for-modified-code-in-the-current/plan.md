# Tools-guard unit tests Implementation Plan

**Goal:** Add Vitest unit tests for the SSO proxy tools-guard helper, plugin and registration (spec ACs 1-10). No production source changes, no module mocks.

**Conventions:** Commit per task using the repository's existing convention. Each file opens with a docblock containing `@group unit`, imports vitest explicitly (`describe, it, expect`), uses `.js` import suffixes, one concept per `it`, and `it.each` tables for variants (`.ai-run/guides/testing/testing-patterns.md`). Dir for both files: `src/providers/plugins/sso/proxy/plugins/__tests__/`. Narrow run: `npx vitest run <file>`.

**Source-vs-spec notes (source verified; source wins, pin actual behavior; record in a test comment):**
- `claude-tools-guard.ts:98-109`: an Anthropic block anywhere wins over OpenAI markers (`:31-52`); `messages` shapes win over `input` (`:59-61`).
- `:67-71`: a string `tool_choice` is forcing only for `required`/`any`; any record whose `type` is not `auto`/`none` is forcing, including `{}`; `null`, numbers, other strings are kept.
- `tools-guard.plugin.ts:59-74`: content-type is matched by `includes('application/json')`; a missing header returns early; arrays pass the object guard and are a no-op.

## Task 1: Helper tests (`claude-tools-guard.test.ts`)

**Files:** Create `.../__tests__/claude-tools-guard.test.ts`; imports `applyToolsGuard` from `../claude-tools-guard.js`.

**Test-first: yes** — a failing test: `applyToolsGuard({messages:[{role:'user',content:[{type:'tool_use'}]}]})` must return `'anthropic'` and set `tools[0].name === 'noop_placeholder_tool'` with `input_schema`; fails/does not compile until the helper is exercised. (The helper already exists, so write the tests and confirm each one fails when its assertion is inverted once, to prove it bites.)

Steps, each a `describe` in the file (small local builder helpers only):
- AC1: non-empty `tools` array returns null and the body is deep-equal to a clone; no tool history (plain text messages, no `messages`/`input`) returns null with no `tools` added; a `tool_use` history with non-empty `tools` is untouched.
- AC2 `it.each` table over `[body, expectedShape]`: `tool_use` block and `tool_result` block -> anthropic; `role:'tool'` and non-empty `tool_calls` -> openai; `input` items `function_call` and `function_call_output` -> responses. Assert the returned shape and the wire shape of `tools[0]`: anthropic has `name` + `input_schema` and no `type`; openai `{type:'function', function:{name, parameters}}`; responses flat `{type:'function', name, parameters}`. Assert name and structure only, never the description text.
- AC3: anthropic wins when an openai message precedes it; `messages` history wins over `input` history; `tools: []` replaced; non-array `tools` (`{}`, `'x'`) treated as absent and replaced; `tool_calls: []` alone is not history; malformed entries (`null`, `42`, `'s'` in `messages`/`content`/`input`) do not throw and return null; non-array `messages`/`input` return null.
- AC4 `it.each` on `tool_choice` (with an anthropic-history body): deleted for `'required'`, `'any'`, `{}`, `{type:'any'}`, `{type:'tool',name:'x'}`, `{type:'function',function:{name:'x'}}`; kept for `'auto'`, `'none'`, `{type:'auto'}`, `{type:'none'}`, absent, and (characterization, with a comment) `null` and a number. Also assert `tool_choice` is untouched when the guard returns null (non-empty tools).
- Do not test the `SET_TOOL_CHOICE_NONE=true` branch (spec non-goal).

## Task 2: Plugin, interceptor and registration tests (`tools-guard.plugin.test.ts`)

**Files:** Create `.../__tests__/tools-guard.plugin.test.ts`; imports `ToolsGuardPlugin` from `../tools-guard.plugin.js`, `registerCorePlugins`, `getPluginRegistry`, `resetPluginRegistry` and `ToolsGuardPlugin` re-export from `../index.js`, `CLAUDE_DESKTOP`/`VSCODE_CLAUDE_CODE` from `../../proxy-clients.js`, types from `../types.js` and `../../proxy-types.js`.

**Test-first: yes** — a failing test: a `/v1/messages` request with `tool_use` history and no `tools`, run through `plugin.createInterceptor(ctx)` then `onRequest`, must leave `requestBody` JSON with `tools[0].name === 'noop_placeholder_tool'` and `content-length === String(Buffer.byteLength(newBody))`.

Steps:
- Helpers modeled on `claude-request-normalizer.plugin.test.ts:33-63`: `createPluginContext()` (config + real `logger` from `@/utils/logger.js`, no mocks) and `createProxyContext(body, {url, contentType})`. Use a body with anthropic history and a non-ASCII char so byte length differs from string length.
- AC5: `id` is `@codemie/proxy-tools-guard`, `priority` 14, and `clients` toEqual the eight entries `'codemie-code','codemie-claude','codemie-claude-acp','codemie-opencode','codemie-opencode-acp','codemie-copilot', CLAUDE_DESKTOP, VSCODE_CLAUDE_CODE` (literal strings for the six, imported constants for the two, never the plugin's own list).
- AC6, one `it.each` path table: acted on `/v1/messages`, `/v1/messages/`, `/v1/chat/completions`, `/chat/completions`, `/v1/responses`, `/v1/messages?beta=true`; ignored (body byte-identical) on `/v1/messages/count_tokens`, `/v1/models`, `/v1/messages/batches`, `/`.
- AC7: early return with unchanged body and header for `requestBody: null`, content type `text/plain`, no content-type header, invalid JSON, JSON `null`, JSON primitives (`5`, `"s"`), plus an array body as characterization only (no injection). Content type `application/json; charset=utf-8` is accepted.
- AC8: after injection `requestBody` parses to the rewritten body and `content-length` equals its byte length; with no history (and with non-empty `tools`) the buffer reference and `content-length` are unchanged. Assert via the returned/mutated `proxyCtx`, not `logger.debug`.
- AC9: in a `describe` with `beforeEach`/`afterEach` calling `resetPluginRegistry()`, call `registerCorePlugins()`, then `getPluginRegistry()['getEnabledPluginsSorted']()` (as in `plugin-order.test.ts:17`) and assert by presence only: some plugin has id `@codemie/proxy-tools-guard` and priority 14 and is an instance of `ToolsGuardPlugin`; do not assert count or full order. Confirm the `index.js` re-export is the same class as the `tools-guard.plugin.js` one (`toBe`).
