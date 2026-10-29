# Pasted-content markup in analytics prompts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove Claude `<pasted_content>` wrapper tags (keeping enclosed text) from the prompt that the `claude-code-otlp` hook sends to analytics, and keep a bounded, masked copy of the original.

**Architecture:** A pure helper in `src/agents/core/` strips the tags. `ClaudeCodeOtlpPlugin.onUserPromptSubmit` overrides `prompt` with the cleaned text and adds `prompt_original`, using the existing spread-override mechanism. `OtlpAgentAdapter.limitPayload` bounds `prompt_original` after masking. `claude.metrics-processor` stores the cleaned text in `userPrompts`.

**Tech Stack:** TypeScript (ES modules, `.js` import suffix, `@/` alias, no `any`), Vitest.

**Spec:** `docs/superpowers/tasks/2026-10-29-epmcdme-16528-pasted-content-session-title/spec.md` (analysis: `technical-analysis.md` in the same dir).

Commit per task using the repository's existing convention (Conventional Commits, see `.ai-run/guides/standards/git-workflow.md`). No push, no PR.

## Global Constraints

- `MAX_ORIGINAL_PROMPT_CHARS = 4000` (UTF-16 units), applied after masking, same `boundedText` semantics as the 200-char `prompt` cut.
- `prompt_original` is NOT added to `UNMASKED_FIELD_KEYS`.
- Whitespace is verbatim: only the tag text is removed, the result is trimmed at both ends, inner newlines are kept, nothing is collapsed.
- Input without the marker is returned unchanged. `prompt_original` is set only when cleaning changed the prompt.
- `prompt_length`, `story_marker`, `ticket_mentions` and `command_name` keep reading the RAW prompt.
- Do not touch `copilot-chat-otlp`, `copilot-cli-otlp`, `claude.conversations-processor`, other metrics processors, analytics loaders, `deriveTitle`, or `session_title` (no bounding or validation).
- The helper must not be imported plugin-to-plugin. It lives in `src/agents/core/`.

## Review Focus

- A paste block that is the whole prompt but empty (`<pasted_content id="x"></pasted_content id="x">`): `prompt` is `''`, `prompt_original` is set, and the metrics prompt count is unchanged.
- A prompt that starts with a paste block whose content begins with `/something`: no `command_name`.
- Prose that merely resembles the tag (`<pasted_contents>`, `pasted_content` without angle brackets) is left alone.
- CRLF and tab whitespace inside a paste block survive untouched.
- A `prompt_original` supplied in the hook input of a typed prompt must not reach the event.

---

### Task 1: Pasted-content stripping helper

**Files:**
- Create: `src/agents/core/pasted-content.ts`
- Test: `src/agents/core/__tests__/pasted-content.test.ts`

**Interfaces:**
- Produces: `export function stripPastedContentTags(text: string): string`

- [ ] **Step 1: Write the failing test** (table-driven with `it.each`). Cases, with the exact expected output:
  - Whole-prompt paste `'<pasted_content id="b23a">\nStep 1\nStep 2\n</pasted_content id="b23a">\n'` gives `'Step 1\nStep 2'`.
  - Typed prefix plus mid-prompt block `'Run smoke\n\n<pasted_content id="b">\nA\nB\n</pasted_content id="b">\n'` gives `'Run smoke\n\n\nA\nB'` (inner newlines verbatim).
  - Two blocks with different ids are both cleaned.
  - Unterminated block (`<pasted_content id="x">\ntext`) gives `'text'`.
  - Orphan closing tag (`text\n</pasted_content id="x">`) gives `'text'`.
  - Tags are removed tag by tag: an opening tag, unrelated text, then a closing tag of another id keeps the text between them.
  - Empty block gives `''`.
  - CRLF and tabs inside the block are preserved.
  - Text with no marker, including leading and trailing whitespace and `<pasted_contents>`, is returned unchanged (`toBe` the same string).
- [ ] **Step 2: Run** `npx vitest run src/agents/core/__tests__/pasted-content.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `stripPastedContentTags`. Use a single global regex that matches one tag at a time and allows attributes on both the opening and the closing form: `/<\/?pasted_content(?:\s[^>]*)?>/g`. If nothing matches, return the input untouched. Otherwise replace the matches with `''` and `.trim()`. Add a one-line comment saying why the closing form must allow attributes (the closing tag repeats the id).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — `stripPastedContentTags('<pasted_content id="b">\nA\n</pasted_content id="b">\n')` must equal `'A'`; it fails because the module does not exist.

### Task 2: Bound `prompt_original` in the base class

**Files:**
- Modify: `src/agents/core/OtlpAgentAdapter.ts:45` (add `export const MAX_ORIGINAL_PROMPT_CHARS = 4000;` next to `MAX_PROMPT_CHARS`) and `:237-240` (`limitPayload`, right after the `prompt` cut: when `limited` has own property `prompt_original`, replace it with `this.boundedText(limited['prompt_original'], MAX_ORIGINAL_PROMPT_CHARS)`).
- Test: `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` (new `it` blocks beside the truncation test at `:482`, reusing its `run`, `forwarded`, `GH`, `AWS` helpers).

**Interfaces:**
- Produces: `MAX_ORIGINAL_PROMPT_CHARS` (exported const) and event field `prompt_original` (string, bounded, masked).

- [ ] **Step 1: Write failing tests:**
  - `prompt_original` of 5000 chars is forwarded with length exactly `MAX_ORIGINAL_PROMPT_CHARS`, while `prompt` is still 200.
  - A `prompt_original` shorter than the bound is kept whole.
  - A secret (`GH`) placed so it straddles index 4000 is masked first: the output contains `[REDACTED]` and not `ghp_` (follow the `tool_response` pattern at `:487`).
  - A payload without `prompt_original` has no `prompt_original` key (opt-in).
- [ ] **Step 2: Run** `npx vitest run src/agents/core/__tests__/OtlpAgentAdapter.test.ts`. Expected: the bound test FAILS (length 5000).
- [ ] **Step 3: Implement** as described in Files. Do not touch `UNMASKED_FIELD_KEYS`; update the `limitPayload` doc comment to mention `prompt_original`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — a 5000-char `prompt_original` must come out at 4000 chars with a boundary-straddling secret masked; it fails because the field is currently forwarded uncut.

### Task 3: Clean the prompt and add `prompt_original` in `onUserPromptSubmit`

**Files:**
- Modify: `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:444-455`. Import `stripPastedContentTags` from `@/agents/core/pasted-content.js`.
- Test: `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`. Extend the `agent.prompt.submit enrichment` describe at `:1462` (helper `promptEvent`). Add `session_title` tests next to the SessionStart tests in the `agent.session.env (SessionStart)` describe at `:1176`, reusing its event helper.

**Interfaces:**
- Consumes: `stripPastedContentTags(text: string): string` (Task 1) and the base-class `prompt_original` bound (Task 2).
- Produces: event field `prompt_original` on `agent.prompt.submit`, present only when the raw prompt contained pasted-content tags.

- [ ] **Step 1: Write failing tests** (each uses the exact fixture shapes from Task 1):
  - Whole-prompt paste: `prompt` and `prompt_body` equal the cleaned text with no `pasted_content` substring; `prompt_original` equals the original markup text.
  - Mid-prompt block and multiple blocks: typed text plus pasted text, no tags.
  - Unterminated block: no dangling tag, text kept.
  - Typed prompt: `prompt` unchanged and the event has no `prompt_original` key. Also a typed prompt whose hook input carries a spoofed `prompt_original` has no `prompt_original` in the event.
  - Spoofed `prompt_original` on a pasted prompt is overwritten with the real original.
  - Derived fields come from the raw prompt: a paste block that starts the prompt and contains `/sdlc-factory:sdlc-standard story: abc-12` gives `command_name === ''`, `story_marker === 'ABC-12'`, `ticket_mentions` including `ABC-12`, and `prompt_length === raw.length`.
  - Cut and masking on cleaned text: a cleaned prompt over 200 chars gives a 200-char `prompt` and `prompt_body` that start with the cleaned text, not the tag. A secret inside the paste is masked in both `prompt` and `prompt_original`. A 5000-char original gives a 4000-char `prompt_original`.
  - Empty block gives `prompt === ''` and `prompt_original` set.
  - `session_title` forwarded unchanged: `'my-name'` on `UserPromptSubmit` and on `SessionStart` (`agent.prompt.submit` and `agent.session.start`), and absent when the hook input has none. These pass immediately, because they pin existing behavior.
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts`. Expected: the pasted-content tests FAIL.
- [ ] **Step 3: Implement.** In `onUserPromptSubmit`, keep `prompt` (raw) as the input to `parsePromptFields` and `resolveCommandFields`. Compute `cleaned = stripPastedContentTags(prompt)` and `changed = cleaned !== prompt`. Build the payload by spreading `hookInput` with `prompt_original` removed, then the two derived-field spreads, then `...(changed && { prompt: cleaned, prompt_original: prompt })`. Update the comment at `:448`. Do NOT override `prompt` when unchanged (a non-string `hookInput.prompt` must pass through as today).
- [ ] **Step 4: Run** the same command. Expected: PASS, including the existing `prompt_length` spoof test.
- [ ] **Step 5: Commit.**

Test-first: yes — a whole-prompt paste must forward `prompt === 'Step 1\nStep 2'` and `prompt_original` equal to the raw markup; it fails because `prompt` is forwarded raw.

### Task 4: Cleaned `userPrompts` in `claude.metrics-processor`

**Files:**
- Modify: `src/agents/plugins/claude/session/processors/claude.metrics-processor.ts:252-253`. Import the helper from `@/agents/core/pasted-content.js`. Keep the `if (textContent)` condition on raw text and store `stripPastedContentTags(textContent)` in `userPromptsMap`.
- Test: new `src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-pasted-content.test.ts`. Copy the temp-`CODEMIE_HOME` harness and the `makeUserMsg`/`makeAssistantMsg` helpers from `claude.metrics-processor-clear.test.ts`.

**Interfaces:**
- Consumes: `stripPastedContentTags` (Task 1).

- [ ] **Step 1: Write failing tests:**
  - String-content paste and `[{type:'text'}]` block-content paste give `userPrompts[0].text` with no `pasted_content` substring and the pasted text intact.
  - A typed prompt is unchanged.
  - An empty paste block still yields one `userPrompts` entry (count unchanged), with text `''`.
  - Two user messages, one pasted and one typed, give two entries (the prompt count equals the message count).
- [ ] **Step 2: Run** `npx vitest run src/agents/plugins/claude/session/processors/__tests__/claude.metrics-processor-pasted-content.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** as described in Files.
- [ ] **Step 4: Run** the new file together with `claude.metrics-processor-clear.test.ts` and `...-names.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit.**

Test-first: yes — a pasted string-content message must produce `userPrompts[0].text` equal to the cleaned text; it fails because the raw markup is stored.

### Task 5: Architecture doc

**Files:**
- Modify: `docs/ARCHITECTURE-OTLP-PLUGIN.md` (line ~87 describing the build order and 200-char `prompt` cut, and the core-file table near line 186).

- [ ] **Step 1:** In the build-order sentence, state that Claude `<pasted_content>` tags are removed from `prompt` first (text kept, whitespace verbatim, derived fields still read the raw prompt). Describe `prompt_original`: set only when the tags were present, masked like `prompt`, cut to 4000 chars after masking (`MAX_ORIGINAL_PROMPT_CHARS`), absent for typed prompts. Add a table row for `src/agents/core/pasted-content.ts` (`stripPastedContentTags`). Keep it to a few sentences.
- [ ] **Step 2: Commit.**

Test-first: no — documentation only.

---

## Self-review notes

- Negative constraints from the spec (Non-goals, "verbatim whitespace", "not in UNMASKED_FIELD_KEYS", "no change to Copilot / conversations / deriveTitle / session_title"): honored by Tasks 1 (no collapsing), 2 (opt-in bound only, `UNMASKED_FIELD_KEYS` untouched), 3 (Claude handler only, `session_title` tests are passthrough pins), 4 (only the `claude` processor). negative-constraints: checked, no task violates them.
- Spec ACs 1-4, 6 map to Tasks 1 and 3. ACs 5 and 7-11 map to Tasks 2 and 3. AC 12 maps to Task 3. AC 13 maps to Task 4. ACs 14 and 15 map to Tasks 1-5. AC 16 is owned by the flow's quality stage.
- Judgment call beyond the spec text: a hook-input `prompt_original` is dropped for typed prompts too, so that "absent means the prompt as sent is the original" holds.
