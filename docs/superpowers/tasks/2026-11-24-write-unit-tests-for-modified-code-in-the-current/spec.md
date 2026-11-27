# Spec: Unit tests for the SSO proxy tools-guard

## Goal
Add Vitest unit tests for the code this branch adds relative to main: the tools-guard helper, plugin and registration. Today none of it is covered (technical-analysis.md section 4). The tests pin current behavior so the shim can later be removed or changed safely.

Scope: `src/providers/plugins/sso/proxy/plugins/claude-tools-guard.ts`, `tools-guard.plugin.ts`, and the `index.ts` registration and export. No source changes.

## Deliverables
- `src/providers/plugins/sso/proxy/plugins/__tests__/claude-tools-guard.test.ts` covers the pure helper `applyToolsGuard`.
- `src/providers/plugins/sso/proxy/plugins/__tests__/tools-guard.plugin.test.ts` covers plugin metadata, the interceptor reached through `createInterceptor`, and registration.
- Both follow the sibling conventions: `@group unit` docblock, explicit vitest imports, `.js` import suffixes, and context helpers modeled on `claude-request-normalizer.plugin.test.ts`. No module mocks.

## Acceptance criteria
1. AC1: Helper returns null and leaves the body untouched when `tools` is a non-empty array, or when the body has no tool history.
2. AC2: Helper detects history in all three shapes and injects `noop_placeholder_tool` in the matching wire shape. Anthropic: `tool_use`/`tool_result` blocks and `input_schema`. OpenAI: `role:'tool'` or non-empty `tool_calls`, with `{type:'function',function:{...}}`. Responses: `function_call`/`function_call_output` input items, with a flat `{type:'function',name,...}`.
3. AC3: Anthropic wins over OpenAI when both appear. An empty `tools: []` is replaced. A non-array `tools` is treated as absent. Malformed message entries do not throw.
4. AC4: Forcing `tool_choice` is deleted: string `required`/`any`, or an object whose type is not `auto`/`none`. `auto`, `none` and absent are kept.
5. AC5: Plugin exposes id `@codemie/proxy-tools-guard`, priority 14, and the expected client list.
6. AC6: The interceptor acts on `/v1/messages`, `/chat/completions` and `/responses`, including a trailing slash and a query string. It ignores `/v1/messages/count_tokens` and other URLs.
7. AC7: The interceptor early-returns without changing the request when there is no body, the content type is not JSON, the JSON is invalid, or the JSON is non-object (`null` or a primitive).
8. AC8: After injection, `requestBody` holds the rewritten JSON and `content-length` equals its byte length. Without injection, the body and header are unchanged.
9. AC9: `registerCorePlugins()` registers `ToolsGuardPlugin`, and `index.ts` re-exports it. This is checked with `PluginRegistry`, as in `plugin-order.test.ts`.
10. AC10: The new tests pass under `npm run test:unit` or an equivalent narrow Vitest run, and lint and typecheck stay clean.

## Non-goals
- No changes to production source, including exporting `ToolsGuardInterceptor` or making `SET_TOOL_CHOICE_NONE` configurable.
- No test of the `SET_TOOL_CHOICE_NONE=true` branch. It is unreachable (module-private constant) and would need module mocking.
- No assertions on `logger.debug` output.
- No edits to `plugin-order.test.ts` or other existing tests, and no integration or e2e tests.
- No tests for code outside the tools-guard files, and no docs changes.

## Decisions
- Two test files (helper, plugin) over one combined file: they mirror the source split and the sibling layout.
- Test the interceptor through `ToolsGuardPlugin.createInterceptor` over exporting it: this avoids source changes.
- Leave the dead `SET_TOOL_CHOICE_NONE` branch untested over module-mocking it: the cost outweighs the value for a dead branch.
- Registration is asserted in the plugin test file over editing `plugin-order.test.ts`: existing tests stay untouched.
- Array JSON bodies are covered as characterization only (no injection), not as intended behavior.
- Parameterized `it.each` tables for shape and `tool_choice` variants over one test per case: this keeps the files compact.

## Assumptions
- Behavior descriptions come from technical-analysis.md section 2 and were not re-read from source. The implementer should confirm them against the code, and pin actual behavior where a detail differs.
- The testing-patterns guide was not read at the analysis stage. The implementer should check it before writing.
