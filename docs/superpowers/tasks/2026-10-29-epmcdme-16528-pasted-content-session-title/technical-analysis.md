# Technical Research

**Task**: claude-code-otlp hook prompt metrics-processor analytics session-title
**Generated**: 2026-10-29
**Research path**: filesystem (CLI repo only; backend facts taken as given)

---

## 1. Original Context

EPMCDME-16528 — [CLI Analytics] Raw markup (<pasted_content id="…">…</pasted_content id="…">) displayed as session title. Fix in BOTH repos: backend <backend-repo> (epm-cdme/codemie: rollups.py _PROMPT_OK / first_prompt derivation, reader/handler `prompt`, title precedence with Claude hook `session_title`) and CLI <cli-repo> (strip tags before 200-char truncation in claude-code-otlp onUserPromptSubmit and claude.metrics-processor userPrompts, preserving enclosed text). Reproduction already done: CLI scratch /tmp/repro-16528/repro.mjs; backend scratch /tmp/repro-16528/test_repro_16528.py against disposable Postgres container pg-16528 on port 55432 (TEST_LOCAL_PG_URL=<local-test-pg-url>; never use the dev Postgres on 5432). Findings: pasted prompt is stored and served raw in sessions list and detail, also when the paste is mid-prompt; backend has no title column (session_dims.first_prompt only); Claude --name puts session_title in SessionStart/UserPromptSubmit hook payloads and custom-title/agent-name in transcript; hook fields not on the drop list are forwarded and unknown keys land in backend residual attrs. Acceptance criteria: 1) multiline pasted prompts produce readable titles; 2) no <pasted_content> identifiers in Session List or Detail; 3) pasted text preserved; 4) explicit session names respected per the supported title contract; 5) regression tests for typed prompts, pasted prompts and --name sessions.

Scope of THIS run: the CLI repo only (<cli-repo>, branch EPMCDME-16528_pasted-content-session-title). The backend is a separate repository and a separate run; treat the backend facts above as given context and reference the backend only where it constrains the CLI contract (e.g. whether the prompt should be sent raw or cleaned, what field carries session_title). Research in particular: (a) every place in the CLI where a user prompt is read from a Claude transcript or hook and sent to analytics (claude-code-otlp onUserPromptSubmit + parsePromptFields + the base-class 200-char truncation of `prompt`; claude.metrics-processor userPrompts; any other agent adapter that sends prompt text), with file:line; (b) the exact on-disk/hook format of pasted content: `<pasted_content id="x">…</pasted_content id="x">` (closing tag repeats the id), may be mid-prompt, may be multiple blocks, may be truncated so the closing tag is missing; (c) whether session_title reaches the forwarded hook event for UserPromptSubmit and SessionStart (onSessionStart not yet read); (d) existing tests and utilities to reuse (shared sanitizing helpers, similar prompt normalisers, the existing /clear sentinel handling), and where a shared helper should live per .ai-run/guides/architecture/architecture.md; (e) risks.

---

## 2. Codebase Findings

### Existing Implementations

Prompt text paths (all verified by reading source):

- **Hook path (the one that reaches the backend as the session `prompt`)**
  - `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:444-455` `onUserPromptSubmit`: forwards `{ ...hookInput, ...parsePromptFields(prompt), ...resolveCommandFields(prompt) }`. The comment at :448 says derived fields use the full prompt because the base class truncates later. `hookInput.prompt` passes through untouched.
  - `src/agents/core/OtlpAgentAdapter.ts:45` `MAX_PROMPT_CHARS = 200`. `limitPayload()` (:~224-250) first runs `maskSecretsDeep`, then `limited['prompt'] = boundedText(prompt, 200)` (:239). `buildEvent()` (:200) sets `prompt_body = boundedText(limited['prompt'], 200)`. So the forwarded event carries both `prompt` and `prompt_body`, each the first 200 chars of the raw masked text. `boundedText` is `text.slice(0, 200)` (UTF-16 units, no word boundary).
  - `ClaudeCodeOtlpPlugin.extractHookContext` (:~88-93) hands the raw `prompt` to the base class for story-marker/mention resolution (`story-resolver.ts`). That must stay raw (ticket ids inside pasted text are legitimate signal).
  - `src/agents/core/ticket-parser.ts:~100-115` `parsePromptFields` returns only derived values (`story_marker`, `ticket_mentions`, `prompt_length`), never text. `prompt_length` is documented as the full prompt length in UTF-16 units. `event-fields/command-fields.ts` `resolveCommandFields(prompt)` reads the leading `/command` token via `trimStart()`.
  - The other two hook adapters share the same base-class truncation and send `prompt` for their own prompt-submit events: `copilot-chat-otlp.plugin.ts:36`, `copilot-cli-otlp.plugin.ts:46,159`. Nothing in the repo mentions `pasted_content` for those tools; they would only benefit from a change placed in the base class.
- **Transcript path**
  - `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts:231-258` builds `userPromptsMap` per user message. For array content it takes the first `text` block only (break at :250); for string content the whole string. Skips tool-result-parented messages via `isSyntheticUserPrompt` (:402). Attached to the first delta at :370-378 as `userPrompts: [{count: 1, text}]` (text is NOT truncated here).
  - **That text does not reach the backend.** `metrics-aggregator.ts:193-196` only counts `userPrompts.length`; `metrics-sync-processor.ts:141-153` / `metrics-api-client.ts:130` send only `total_user_prompts`. The raw text stays in the local `<session>_metrics.jsonl` delta file and feeds the local `codemie analytics` report.
  - Other `userPrompts` producers (text lands in local deltas only): gemini `gemini.metrics-processor.ts:229`, kimi `:82-102,264`, pi `:344`, copilot-cli `copilot-cli.session.ts:255` / `copilot-cli.metrics-processor.ts:56`, opencode metrics-processor, analytics loaders `native-loader.ts:238-262,392` (`firstUserText`) and `otel-loader.ts:439-495`.
- **Local report title** (existing normaliser): `src/cli/commands/analytics/aggregator.ts:772-812` `deriveTitle` strips `<system-reminder>`, `<command-message>`, unwraps `<command-name>`/`<command-args>`, then `.replace(/<[^>]+>/g, ' ')` (removes any remaining tag, so `<pasted_content id="x">` and `</pasted_content id="x">` already disappear, text kept), collapses whitespace, skips `TITLE_NOISE`. The local report is therefore already readable; the defect is on the hook path to the backend.
- **Conversation sync** (`claude.conversations-processor.ts`, filters at :735-780) sends full turns to the backend conversation store and passes the raw tags through. It has no 200-char cut and is not the title source; not named in the ticket, but it is a place where the markup is "served raw".
- **/clear sentinel**: `src/agents/plugins/claude/session/strip-clear.ts` (marker `<command-name>/clear</command-name>`; handles string and text-block content); consumed by `claude.metrics-processor` and `native-loader.ts`.

### Architecture and Layers Affected

Plugin layer (`claude-code-otlp` plugin; `claude` session metrics processor), Core layer (`OtlpAgentAdapter` base class, `src/agents/core/` pure helpers), Utils layer (candidate home for a pure string helper). No CLI/registry change.

### Integration Points

`codemie hook --agent claude-code-otlp` -> `OtlpAgentAdapter.processOtlpEvent` -> `evaluate()` -> `buildEvent()` -> proxy-daemon spool -> `otlp-spool/forwarder.ts` -> analytics API. The spool/forwarder contains no `prompt` handling (grep of `otlp-spool/*.ts` is empty), so the base-class event is what the backend ingests.

### Patterns and Conventions

- Per-event handler returns `{decision:'forward', payload:[{...hookInput, ...derivedFields}]}`; derived values spread AFTER the hook payload so they override it (a test, `claude-code-otlp.plugin.test.ts:1534`, asserts a spoofed `prompt_length` is overwritten). The same mechanism can override `prompt` with a cleaned string.
- Pure, no-I/O helpers live in `src/agents/core/` (e.g. `ticket-parser.ts`) or plugin-local `event-fields/` (Claude-specific payload shapes, `claude-code-otlp/event-fields/command-fields.ts`). Guide: Plugin -> Core -> Utils, no plugin -> plugin imports (`.ai-run/guides/architecture/architecture.md`, lines ~149-155). `claude.metrics-processor` (plugin `claude`) cannot import from `claude-code-otlp` (sibling plugin); a shared helper must therefore sit in `src/agents/core/` or `src/utils/`. A Claude-specific tag helper shared by both plugins fits `src/agents/core/` (agent-agnostic string handling, next to `ticket-parser.ts`), or `src/utils/parsers.ts` if treated as generic.
- Secrets: masking runs before the cut in `limitPayload`; a pre-cleaning step in the handler runs before masking (mask still applies to cleaned text).
- Coding rules: ES modules, `.js` import suffix, `@/` alias, no `any`, explicit return types on exports.

---

## 3. Documentation Findings

### Guides and Architecture Docs

- `.ai-run/guides/architecture/architecture.md` (layering, where utils/core live), `docs/ARCHITECTURE-OTLP-PLUGIN.md` (the base-class build order: drop fields -> mask -> truncate `prompt` to 200 -> `prompt_body`; opt-in field resolvers; Claude event list; docs lines ~87-90, 186, 228).
- That doc will need a sentence if the cleaning is added (it states `prompt` is cut to 200 chars from the masked value).

### Architectural Decisions

- Derived prompt values are computed from the full prompt before truncation (`ticket-parser.ts` doc; plugin comment :448). Cleaned `prompt` text must not change `prompt_length`/ticket/command derivation, which stay on raw text.
- `agent.session.summary.title` is a different thing: the transcript's latest `ai-title`, capped at 200 (`transcript/session-signals.ts:188-195`, `session-summary.ts:16,40`).

### Derived Conventions

No guide mentions `pasted_content` or `session_title` (grep of `src`, `docs`, `.ai-run`, excluding specs, found only the SDK typings). Existing analytics code treats tag-wrapped text by regex-stripping (aggregator) rather than a shared helper; there is no existing shared prompt-sanitiser.

---

## 4. Testing Landscape

### Existing Coverage

- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`: `describe('... agent.prompt.submit enrichment')` at :1462 (helper `promptEvent(prompt, overrides)`, asserts `prompt_body`, `prompt_length`, 500-char prompt cut :1499-1504), plain mapping test :1094. No assertion on `session_title`.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts:482-524` (truncation, masking straddling the cut, empty `prompt_body`), `ticket-parser.test.ts`.
- `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-clear.test.ts` (temp `CODEMIE_HOME` harness, `makeUserMsg`/`makeAssistantMsg`, asserts `userPrompts`) and `...-names.test.ts`; `session/__tests__/strip-clear.test.ts`.
- `src/cli/commands/analytics/__tests__/aggregator.test.ts:276-328` ('session title - derived from first user prompt').

### Testing Framework and Patterns

Vitest; module mocks via `vi.mock('@/utils/logger.js'...)` (aliased, not relative, see comment in the clear test), temp-dir `CODEMIE_HOME`, dynamic imports after mocks. Repo policy: tests only on explicit request; the ticket acceptance criterion 5 explicitly asks for regression tests, so that request is part of the ticket.

### Coverage Gaps

No test for pasted-content, mid-prompt blocks, multiple blocks, unterminated block, `session_title` passthrough on `SessionStart`/`UserPromptSubmit`, or `--name` sessions. `onSessionStart` has existing tests in the same file but none on `session_title`.

---

## 5. Configuration and Environment

### Environment Variables

None governs the prompt path. `CODEMIE_ANALYTICS_PROJECT_FILTER` (settings.json allowlist) gates tracking only. `CODEMIE_HOME` is used by the metrics-processor tests.

### Configuration Files

`~/.claude/settings.json` (allowlist read, `claude-code-otlp.allowlist.ts`). No feature flag exists for prompt handling.

### Feature Flags and Deployment Concerns

Hook events are built in the short-lived `codemie hook` process, so a fix ships only with the CLI release (users on old CLIs keep sending raw markup; backend cleanup is needed for them, which is the backend run's concern).

**(b) Format facts.** Taken from the task/repro: `<pasted_content id="x">\n...\n</pasted_content id="x">\n`, closing tag repeats `id`, string content on disk (also possible as a `text` block). Confirmed the repro script `/tmp/repro-16528/repro.mjs` uses exactly this shape (prompt with a typed prefix + mid-prompt block, and a pasted-only message). I did not find a Claude source or fixture in this repo that documents the format, so mid-prompt, multiple-block and unterminated variants are inferred and unverified here. Note a standard HTML-style regex `<pasted_content[^>]*>...</pasted_content>` will NOT match the closing tag because of the repeated id; the closing form must allow attributes.

**(c) session_title.**
- `SessionStart`: `onSessionStart` (`claude-code-otlp.plugin.ts:202-232`) builds `{...hookInput, ...envFields, ...identityCandidateFields, ...gitHeadStart, git_head_start}` and deletes only `model`. So `session_title` (declared `SessionStartHookInput.session_title?`, `claude-agent-sdk-hooks.d.ts:534`) is forwarded on `agent.session.start`.
- `UserPromptSubmit`: `...hookInput` spread (:452), so `session_title` (d.ts:718) is forwarded on `agent.prompt.submit`.
- It is not in `ALWAYS_DROPPED_FIELDS` (plugin.ts:~77-82) or the Notification drop list; `limitPayload` secret-masks it (not in `UNMASKED_FIELD_KEYS`) and applies NO length cap. It lands at the top level of the event, so the backend sees it as an unknown key (matches the "residual attrs" finding). The `sessionTitle` fields in d.ts:557/724 are hook OUTPUT (a hook setting a title), unused by the CLI.
- Whether Claude Code actually populates `session_title` depends on the client version; the repo has no capture. Transcript `custom-title` / `agent-name` lines are not read anywhere in `src` (grep empty); the only title the CLI derives is `ai-title` on `agent.session.summary`.

---

## 6. Risk Indicators

- Speculative: the fix location is a design choice with different blast radius: (1) Claude handler only (`onUserPromptSubmit` overriding `prompt`) leaves copilot-chat/copilot-cli adapters untouched; (2) base-class `limitPayload` changes every adapter and `prompt_body` semantic.
- The 200-char cut happens in the base class after the handler; a cleaning step must run before it (handler or `limitPayload` ahead of `boundedText`). Cleaning only `prompt` leaves `prompt_body` consistent because it derives from limited `prompt`.
- Derived fields must keep reading the raw prompt (`prompt_length`, ticket ids, story marker, `command_name`). `resolveCommandFields` uses `trimStart()`: a prompt that starts with a paste block is not a command, and cleaning must not turn a pasted `/path` into a command if applied before it.
- Speculative: content-hash `event_id` (event-id.ts:75) for `agent.prompt.submit` includes the payload, so a cleaned `prompt` changes the id of a resend across an upgrade; harmless, but tests that pin ids may move.
- Format edge cases: unterminated block (truncation) leaves a dangling opening tag; multiple blocks; id values with quotes/spaces; nested or literal mentions of the tag in user prose (regex must not eat text between an unrelated opening and a far-away closing). Whitespace/newlines inside the paste: multiline text collapsing for a title is a separate decision (aggregator.ts already collapses `\s+` for titles; the hook path does not).
- Truncation by 200 chars may land mid-surrogate pair or in the middle of a masked secret region; existing behavior, not new.
- `claude.metrics-processor` only takes the first text block and its text never leaves the machine except in the local report, whose `deriveTitle` already strips tags: changing it has limited user-visible value; changing it consistently with the hook path is still cheap. Do not add a plugin -> plugin import (`claude` <- `claude-code-otlp`).
- `session_title` is forwarded uncapped and unvalidated; whether the CLI should cap/trim it or the backend should take it as the explicit-name source is an open contract question for the backend run.
- Conversation sync (`claude.conversations-processor`) still ships raw markup to the backend conversation store; out of the named scope but affects "no identifiers in Session Detail" if Detail reads conversations.
- Old CLI versions in the field continue to emit raw markup; backend-side sanitising is still required.
- No ADR/guide covers prompt shape; behavior has to be pinned by tests and the OTLP architecture doc.

---

## 7. Summary for Complexity Assessment

The prompt reaches analytics through one real path: the Claude `UserPromptSubmit` hook (`claude-code-otlp.plugin.ts:444`) -> `OtlpAgentAdapter` (`:200`, `:239`, 200-char `prompt`/`prompt_body`) -> spool -> backend. The `claude.metrics-processor` `userPrompts` text (`:231-258`, `:370-378`) never leaves the machine (only the count is synced) and is consumed by the local report, whose `deriveTitle` (`aggregator.ts:772`) already strips all tags. Layers touched: plugin (claude-code-otlp, optionally claude), core (base class and/or a new pure helper in `src/agents/core/`), docs. Expected change surface is small: roughly 1 new helper file, 1-2 handler/base-class edits, 1 doc paragraph, and 3-4 test files extended.

Technical novelty is low (pure string transform, existing spread-override pattern), but two points carry judgment: the transform must run before the base-class cut while derived fields stay on the raw text, and the closing tag repeats the id so the naive paired-tag regex fails; unterminated and multiple blocks need explicit handling. The pasted-content on-disk format is only documented by the repro, not by a fixture in this repo.

Test posture: good scaffolding exists (`promptEvent` helper, metrics-processor temp-home harness, aggregator title tests), none cover pasted content or `session_title`. `session_title` already reaches both `agent.session.start` and `agent.prompt.submit` as an unmodified top-level field; no CLI change is needed for it to arrive, the open question is the backend's precedence rule and whether the CLI should bound it. Main risks: scope choice (Claude-only vs base class), unverified format variants, conversation sync still sending raw markup, and old CLI versions in the field.

---

## 8. External References

- `/tmp/repro-16528/repro.mjs` — resolved. Builds a temp `CODEMIE_HOME`, imports `dist/agents/plugins/claude/session/processors/claude.metrics-processor.js` and runs `MetricsProcessor.process` over four cases (typed control; pasted in `[{type:'text',text}]` content; pasted as string content; pasted-only message), printing `userPrompts`. The pasted fixture: `'Perform a complete Production E2E Smoke Test\n\n<pasted_content id="b23a">\nStep 1: log in\nStep 2: open Control Plane\nStep 3: verify sessions\n</pasted_content id="b23a">\n'`; pasted-only: `'<pasted_content id="b23a">\nPerform a complete Production E2E Smoke Test\nStep 1: log in\n</pasted_content id="b23a">\n'`. Comment in script: "Real on-disk shape captured from ~/.claude/projects/*.jsonl: string content ... id repeated on the closing tag." It exercises dist (needs a build) and covers only the metrics-processor path, not the hook path.
- `/tmp/repro-16528/test_repro_16528.py` — exists, backend side, not read (out of scope for this run). `/tmp/repro-16528/probe/` (cwd, settings.json) exists, not read.
- No other external path named; the backend repo `<backend-repo>` was deliberately not read.
