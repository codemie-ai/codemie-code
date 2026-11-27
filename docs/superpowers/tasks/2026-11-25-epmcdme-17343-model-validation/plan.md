# Model value validation (launcher + local proxy) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One shared `validateModelValue` rule, applied by the `codemie-claude` launcher and by a new request-level proxy hook on the Claude path, with a shared test-value table.

**Architecture:** Pure util in `src/utils/` (importable by Core and proxy Plugin). `AgentCLI.handleRun` calls it for the Claude adapter only. A new `handleRequest` plugin at priority 8.5 answers a 400 Anthropic-style error. The normalizer, `runHook` swallowing and the "blocked" 200 stay untouched.

**Tech Stack:** TypeScript (ES modules, `.js` import suffix), Vitest, Commander.

**Spec:** `docs/superpowers/tasks/2026-11-25-epmcdme-17343-model-validation/spec.md` (analysis: `technical-analysis.md` next to it).

Commit per task using the repository's existing convention (Conventional Commits, scopes `utils`/`agents`/`proxy`; no ticket key in the subject).

## Global Constraints

- Rule order, first match wins: `not_text`, `empty`, `too_long` (more than 256 code points; 256 is valid), `invalid_characters` (any `\p{White_Space}`, `\p{Cc}`, U+FEFF, U+200B; nothing trimmed).
- Message: `Invalid model value: <rule description>. Received length: <n>.`; non-text reports the JSON type instead of a length. The value or any part of it never appears in console, logger, or response.
- Proxy error: 400, `Content-Type: application/json`, `{"type":"error","error":{"type":"invalid_request_error","message":<message>}}`, return `true`.
- Proxy clients: `codemie-claude`, `codemie-copilot`, `claude-desktop`, `vscode-claude-code` only. Hook priority is fractional, 8.5.
- Not touched: normalizers, `runHook`, blocked-200, profile `model`, tier env vars, other agents, `claude-acp`, catalog checks.

## Review Focus

- Astral characters count as one code point: 256 astral chars valid, 257 rejected (Task 1).
- A multi-megabyte model value is counted by iteration (no `[...value]` array) and the message stays constant size (Task 1).
- `-m ''`, `CODEMIE_MODEL=''`, a bad `CODEMIE_MODEL` that only appears after `.env` is loaded, and a valid `-m` next to an invalid env value (Task 2).
- Commander delivers `-m ''` as an empty string, and the pre-`handleRun` debug log never echoes the model (Task 2).
- A bad `model` under a missing or non-JSON `content-type`; array, scalar, unparsable and non-`{` bodies pass and never produce a 500 (Task 3).

---

### Task 1: Shared rule and test-value table

**Files:**
- Create: `src/utils/model-value.ts`
- Create: `src/utils/__tests__/model-value-cases.json` (data), `src/utils/__tests__/model-value-cases.ts` (loader)
- Test: `src/utils/__tests__/model-value.test.ts`

**Interfaces:**
- Produces (`model-value.ts`): `MODEL_VALUE_MAX_LENGTH = 256`; `type ModelValueRule = 'not_text' | 'empty' | 'too_long' | 'invalid_characters'`; `interface ModelValueViolation { rule: ModelValueRule; length?: number; jsonType?: string }`; `validateModelValue(value: unknown): ModelValueViolation | null`; `describeModelValueViolation(v: ModelValueViolation): string` (the full message above).
- Produces (`model-value-cases.ts`): `interface ModelValueCase { name: string; value: unknown; valid: boolean; rule?: ModelValueRule; nonText: boolean }`; `MODEL_VALUE_CASES: ModelValueCase[]` (expanded rows); `leakProbe(value: string): string | null` (first 8 chars, `null` when shorter or empty).
- The JSON is the cross-repository contract. Row forms: `{name, value, valid, rule?}` (text, JSON escapes such as `\u0000`), `{name, gen: {char, count}, ...}` (expanded by the loader), `{name, json, nonText: true, valid: false, rule: "not_text"}` (`json` may be `null`).

**Test-first: yes — table-driven test fails because `validateModelValue` does not exist; after implementation each row returns the listed rule or `null`.**

- [ ] **Step 1: Write the table.** Rejected text rows embed `claude-sonnet-4-5` around the offender so a leaked prefix is detectable (`claude-s`): 257 `z`; 7,500 `z`; newline; CRLF; tab; U+00A0; leading space; trailing space; U+3000; U+2028; U+0085; NUL; U+FEFF; U+200B; 257 astral (`\u{1F600}`); empty string (rule `empty`). Non-text rows: `null`, `42`, `true`, `["a"]`, `{"a":1}`. Accepted: 256 `z`; 256 astral (UTF-16 length 512); `claude-sonnet-4-5`; `anthropic.claude-sonnet-4-5-20250929-v1:0`; `claude-sonnet-4@20250514`; `claude-x-0a1b2c3d`; `sonnet`; U+200C, U+200D, U+2060 embedded in a valid name (pinned as accepted).
- [ ] **Step 2: Write `model-value.test.ts`**, asserting: every row from `MODEL_VALUE_CASES` gives `null` when valid, else `violation.rule === row.rule`; `length` equals the code-point count for `too_long`/`empty`/`invalid_characters`; `jsonType` is `'null'`, `'number'`, `'boolean'`, `'array'`, `'object'` for the non-text rows; a 300-char string containing a space reports `too_long` (order); a 5,000,000-char value reports `length: 5000000` and its message is under 120 chars; every rejected text row's message contains the rule words and the length and does not contain `leakProbe(value)`.
- [ ] **Step 3: Run `npx vitest run src/utils/__tests__/model-value.test.ts`**; expected FAIL (module missing).
- [ ] **Step 4: Implement `model-value.ts`.** Count code points with a `for...of` loop (no spread); test characters with `/[\p{White_Space}\p{Cc}﻿​]/u` only after the length check passes; descriptions: `empty`, `longer than 256 characters`, `contains whitespace or control characters`, non-text `must be text` with `Received type: <jsonType>.`. Implement the loader (`gen` expands with `char.repeat(count)`).
- [ ] **Step 5: Re-run the test**; expected PASS.

### Task 2: Launcher check in `AgentCLI.handleRun`

**Files:**
- Modify: `src/agents/core/AgentCLI.ts:114` (debug log) and immediately after the `ConfigLoader.load` call (`:235-243`)
- Test: `src/agents/core/__tests__/AgentCLI-model-validation.test.ts` (mocking pattern of `AgentCLI-model-source.test.ts` and `process.exit` spy of `AgentCLI-bedrock-gate.test.ts`)

**Interfaces:**
- Consumes: `validateModelValue`, `describeModelValueViolation` (Task 1), `MODEL_VALUE_CASES`, `leakProbe`.
- Produces: no new exports.

**Test-first: yes — a claude launch with each bad row fails to exit 1 today (it reaches `run`); an `-m ''` row and a `.env`-sourced row fail for the same reason.**

- [ ] **Step 1: Write the test file.** With `ConfigLoader.load` / `exportProviderEnvVars` spied and `process.exit` throwing, for each text row (`nonText` false):
  - Bad via `options.model`, and bad via `process.env.CODEMIE_MODEL` (`vi.stubEnv`): `handleRun` rejects with `process.exit:1`, `run` not called, `console.error` and `logger.error` output contain the rule description and the length text, name the source (`--model` or `CODEMIE_MODEL`), and do not contain `leakProbe(value)`.
  - Bad via a `.env`-style value: the `ConfigLoader.load` spy sets `process.env.CODEMIE_MODEL` as a side effect; same expectations.
  - Valid rows via both sources: `run` called, no exit.
  - Extra cases: valid `-m` with invalid env passes (`-m` wins); `-m ''` rejects as `empty`; a non-claude adapter (`name: 'codex'`) with a bad `-m` is not rejected.
- [ ] **Step 2: Add a debug-log test.** Spy `logger.debug` and `handleRun` (mocked), call the action through the real Commander program (`cli.program.parseAsync(['-m', marker], { from: 'user' })`, cast to reach it) for a claude and a codex adapter: no debug call contains the marker; the options log carries the model's length instead. A second call with `['-m', '']` asserts `handleRun` receives `model === ''`.
- [ ] **Step 3: Run `npx vitest run src/agents/core/__tests__/AgentCLI-model-validation.test.ts`**; expected FAIL.
- [ ] **Step 4: Implement the launcher check.** Under `this.adapter.name === ClaudePluginMetadata.name` and right after `ConfigLoader.load` returns (dotenv has filled `process.env` by then; this deliberately sits after the call rather than before it, so a `.env` value is validated): pick `options.model` if `!== undefined`, else `process.env.CODEMIE_MODEL` if `!== undefined`; on violation `console.error(chalk.red(...))` of `\n✗ <source>: <message>\n` (source is the flag or variable name only), the same text to `logger.error`, `process.exit(1)`. Do not read `config.model`.
- [ ] **Step 5: Redact the options debug log** at `AgentCLI.ts:114` for every agent: log a copy of `opts` whose string `model` is replaced by `<length N>`.
- [ ] **Step 6: Grep for other pre-`handleRun` echoes** of `-m` / `CODEMIE_MODEL` in `src/cli/index.ts`, `bin/codemie-claude.js`, and the logger's start-up dump (and `AgentCLI.ts:112`); redact any found in the same way and add them to the Step 2 assertions.
- [ ] **Step 7: Re-run the test**; expected PASS. Also run `npx vitest run src/agents/core/__tests__/AgentCLI-model-source.test.ts` (unchanged behavior).

### Task 3: Proxy hook plugin

**Files:**
- Modify: `src/providers/plugins/sso/proxy/proxy-clients.ts` (add `CLAUDE_PATH_CLIENTS`)
- Create: `src/providers/plugins/sso/proxy/plugins/model-value-guard.plugin.ts`
- Test: `src/providers/plugins/sso/proxy/plugins/__tests__/model-value-guard.plugin.test.ts` (pattern of `gateway-key.plugin.test.ts`: local `makeProxyContext`, `makeMockRes`, `interceptor.handleRequest!(ctx, {}, res, {})`)

**Interfaces:**
- Consumes: Task 1 util and table.
- Produces: `CLAUDE_PATH_CLIENTS: readonly string[]` (`'codemie-claude'`, `'codemie-copilot'`, `CLAUDE_DESKTOP`, `VSCODE_CLAUDE_CODE`); `class ModelValueGuardPlugin implements ProxyPlugin` with `id = '@codemie/proxy-model-value-guard'`, `priority = 8.5`, `clients = CLAUDE_PATH_CLIENTS`. Import style follows `gateway-key.plugin.ts`.

**Test-first: yes — the plugin does not exist; every bad row must get 400 and `true`, every valid row `false`.**

- [ ] **Step 1: Write the test.**
  - Each row: text rows as `JSON.stringify({ model: value, messages: [] })`, non-text rows via `json`. Bad: `res.statusCode === 400`, header `Content-Type: application/json`, body parses to `{type:'error', error:{type:'invalid_request_error', message}}` with `message === describeModelValueViolation(...)`, returns `true`; response body and every `logger.warn` argument do not contain `leakProbe(value)`; warn text carries the rule, `ctx.agentName` and the length only. Valid: returns `false`, `res` untouched.
  - Passes (`false`): body without a `model` key; array body; scalar body; invalid JSON starting with `{`; body not starting with `{`; empty/`null` `requestBody`.
  - A bad model with `content-type: text/plain` and with no content-type is rejected (400, `true`).
  - `new ClaudeRequestNormalizerPlugin().clients`, `new BackgroundRequestNormalizerPlugin().clients` and the guard's `clients` all equal `CLAUDE_PATH_CLIENTS`; `'codemie-codex'` and `'codemie-opencode'` are not in it.
- [ ] **Step 2: Run `npx vitest run src/providers/plugins/sso/proxy/plugins/__tests__/model-value-guard.plugin.test.ts`**; expected FAIL.
- [ ] **Step 3: Implement the plugin.** `handleRequest`: return `false` when `requestBody` is null/empty or its first non-blank byte (space, tab, CR, LF; checked on the Buffer, no string copy) is not `{`; `JSON.parse` inside `try/catch` (a throw would answer 500 with the wrong envelope), `false` on failure; return `false` unless the result is a non-array object with an own `model` key; no `content-type` check. On violation, `logger.warn` (rule, client, length or type), write the 400 envelope exactly as `gateway-key.plugin.ts:62-68` does, return `true`.
- [ ] **Step 4: Re-run the test**; expected PASS.

### Task 4: Registration, ordering and end-to-end rejection

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/index.ts` (register after `ClientAttributionPlugin`, comment priority 8.5; add to the re-exports)
- Modify: `src/providers/plugins/sso/proxy/plugins/__tests__/plugin-order.test.ts`
- Modify: `docs/ARCHITECTURE-PROXY.md` (one line listing the new `handleRequest` plugin beside the gateway-key one at `:551,560`, if that section lists plugins by priority)
- Test: `src/providers/plugins/sso/proxy/__tests__/sso.proxy.model-value-guard.test.ts` (real `CodeMieProxy` + local upstream server, pattern of `sso.proxy.gateway-public-endpoints.test.ts` and `sso.proxy.client-gate.test.ts`)

**Interfaces:**
- Consumes: `ModelValueGuardPlugin` (Task 3).
- Produces: none.

**Test-first: yes — the order test fails until the plugin is registered (extended expectation: gateway-key, client-attribution, model-value-guard, desktop-models); the real-proxy test fails because the bad request reaches the upstream.**

- [ ] **Step 1: Extend `plugin-order.test.ts`** to register the guard in reverse order too and expect `[gateway-key, client-attribution, model-value-guard, desktop-models]`. Add a test that the guard's priority is strictly between 8 and 10 and unequal to 9.
- [ ] **Step 2: Write the real-proxy test.** As `codemie-claude`: a request with a 7,500-char model gets 400 in the Anthropic envelope and the upstream server records zero requests; a request with a valid model and one without `model` reach the upstream unchanged. As `codemie-codex` (not on the list) the same bad model is not rejected by the guard (reaches the upstream).
- [ ] **Step 3: Run both test files**; expected FAIL.
- [ ] **Step 4: Register the plugin in `index.ts`** (and the doc line). Confirm in this step no plugin logs the body before `handleRequest` hooks run (the body logger acts in `onRequest`, `logging.plugin.ts:59-97`).
- [ ] **Step 5: Re-run `plugin-order.test.ts`, the new real-proxy test, and the existing `claude-request-normalizer.plugin.test.ts` and `gateway-key.plugin.test.ts`**; expected PASS.
