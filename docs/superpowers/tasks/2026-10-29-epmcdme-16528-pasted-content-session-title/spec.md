# EPMCDME-16528 (CLI): pasted_content markup must not reach analytics prompts

## Problem

Claude Code wraps pasted text in the prompt as `<pasted_content id="x">\n...\n</pasted_content id="x">\n`. The closing tag repeats the id. The block can be the whole prompt, can sit mid-prompt after typed text, can occur more than once, and after the 200-char cut it can be unterminated.

The Claude `UserPromptSubmit` hook forwards this raw text. `claude-code-otlp.plugin.ts` `onUserPromptSubmit` (~:444) passes `hookInput.prompt` through, then `OtlpAgentAdapter.ts` (:237-239) masks it and cuts it to `MAX_PROMPT_CHARS=200`. The backend derives the session title from that value, so the markup shows up as the title in Session List and Detail.

`claude.metrics-processor.ts:231-256` also collects the raw text into `userPrompts`. That text stays local, and the local report's `deriveTitle` (`aggregator.ts:772`) already strips tags.

## Goal

Pasted-content wrapper tags are removed from the prompt used for titles, and the enclosed text is kept. The ticket also says to keep the original prompt available where analytics requires it, so the hook event additionally carries a bounded, masked copy of the original prompt. The cleaned `prompt`/`prompt_body` remain the title source.

## Approach

1. **Shared helper.** Add a pure helper in `src/agents/core/` (agent-agnostic string handling, next to `ticket-parser.ts`). It must not be imported plugin-to-plugin. Behavior:
   - Remove `<pasted_content ...>` opening tags, and `</pasted_content ...>` closing tags with any attributes. The id-tolerant closing match is required because the closing tag repeats the id.
   - Keep all enclosed text byte-for-byte.
   - Handle several blocks and mid-prompt blocks.
   - Remove a dangling opening tag when the block is unterminated (text kept) and a dangling closing tag when the opening was cut off.
   - Match tag by tag, never pairing an opening tag with a far-away closing tag across unrelated text.
   - **Whitespace is verbatim.** Only the tag text is removed. Leading and trailing whitespace of the result is trimmed. Inner newlines are kept and nothing is collapsed.
   - Input without the marker is returned unchanged.
2. **Hook path, cleaned prompt.** `onUserPromptSubmit` overrides `prompt` with the cleaned text in the payload spread, after the derived fields. This is the existing override mechanism that the `prompt_length` spoof test relies on. The cleaning therefore runs before the base-class mask and the 200-char cut, and `prompt_body` follows from the cleaned `prompt`.
   - `prompt_length`, ticket mentions, story marker and `command_name` keep reading the RAW prompt. A prompt that starts with a paste block must not become a command.
3. **Hook path, original prompt retention.**
   - **Field.** A new top-level event field `prompt_original`, set by the Claude handler in the same spread (after `...hookInput`, so a spoofed value in the hook input is overwritten). It carries the original, uncleaned prompt text.
   - **When set.** Only when cleaning changed the prompt (the raw text contained pasted-content tags). A typed prompt gets no new field, so its event is unchanged and no bytes are duplicated. Absence of `prompt_original` means the prompt as sent is the original.
   - **Masking.** It goes through the same `maskSecretsDeep` pass as `prompt`; it is not added to `UNMASKED_FIELD_KEYS`.
   - **Bound.** `MAX_ORIGINAL_PROMPT_CHARS = 4000` UTF-16 units, applied in `OtlpAgentAdapter.limitPayload` after masking, next to the existing `prompt` cut and with the same `boundedText` semantics (cut after masking so a secret straddling the cut is already masked). Reason: the field must be bounded because pasted content is unbounded and can carry secrets or large blobs, while 200 would defeat its purpose; 4000 is 20x the title cut, covers typical pasted prompts, and keeps an event within a few KB. Handling is opt-in: only events that contain the field are touched, so other adapters and events are unaffected.
   - **Backend landing.** It is not a known key, so the backend stores it in the residual `attrs` JSON, like `session_title`. Any use of it (display, search, retention) is the backend run's decision.
4. **Metrics processor.** `claude.metrics-processor` stores the cleaned text in `userPrompts` (:252-253). The prompt count and the condition that decides whether a message counts keep using the raw text, so counts are unchanged. This text stays local, so no original copy is added.
5. **session_title.** No code change. `session_title` already reaches `agent.session.start` and `agent.prompt.submit` unmodified. Tests pin that passthrough for both events.
6. **Docs.** Update `docs/ARCHITECTURE-OTLP-PLUGIN.md`. It states that `prompt` is cut to 200 chars after masking. Add that Claude pasted-content tags are removed first, and describe `prompt_original`: when it is set, that it is masked, and its 4000-char bound applied after masking.

## Acceptance criteria

1. A whole-prompt multiline paste gives `prompt` and `prompt_body` with no tags and the pasted text preserved in order.
2. A typed prefix plus a mid-prompt paste block gives the typed text plus the pasted text, with no tags.
3. Multiple blocks are all cleaned.
4. An unterminated block leaves no dangling tag and keeps its text.
5. A typed prompt with no markup is unchanged, and its event has no `prompt_original`.
6. Inner newlines are preserved, and only leading and trailing whitespace is trimmed.
7. `prompt_length`, ticket mentions, story marker and `command_name` come from the raw prompt, and a prompt that starts with a paste block does not yield a command.
8. Secret masking still applies to the cleaned text, and the 200-char cut is on cleaned text.
9. When the prompt contained pasted-content tags, the event carries `prompt_original` with the original markup and text intact, up to the bound.
10. `prompt_original` is secret-masked, and masking happens before the cut so a secret straddling the 4000-char boundary is not leaked.
11. `prompt_original` is cut at `MAX_ORIGINAL_PROMPT_CHARS` (4000); a shorter original is kept whole; a `prompt_original` in the hook input is overwritten by the handler.
12. `session_title` is forwarded unchanged on `agent.session.start` and `agent.prompt.submit`, for --name and unnamed sessions.
13. `claude.metrics-processor` `userPrompts` text has no pasted_content tags, and the prompt count is unchanged.
14. Regression tests cover typed, pasted whole, mid-prompt, multiple, unterminated and --name cases, plus `prompt_original` (present, masked, bounded, absent for a typed prompt). They live in a helper unit test, `claude-code-otlp.plugin.test.ts`, `OtlpAgentAdapter.test.ts` (the bound and masking order) and the metrics-processor tests.
15. `docs/ARCHITECTURE-OTLP-PLUGIN.md` describes the cleaning and `prompt_original`.
16. Lint, typecheck and build stay green.

## Non-goals

- No change to `copilot-chat-otlp`, `copilot-cli-otlp`, or the semantics of `prompt` and `prompt_body` for any adapter. The only base-class change is the opt-in `prompt_original` bound.
- No original-prompt field on Copilot events, and none on typed prompts.
- No change to `claude.conversations-processor` (conversation sync).
- No change to other metrics processors, the analytics loaders or `deriveTitle`.
- No bounding, trimming or validation of `session_title`.
- No whitespace collapsing, and no removal of the pasted text or of the whole block.
- No backend work: reading, displaying, searching or retaining `prompt_original`, and title precedence, belong to the separate backend run.

## Assumptions and evidence (for the spec gate)

- **Scope evidence.** Only three adapters extend `OtlpAgentAdapter`: claude-code-otlp, copilot-chat-otlp and copilot-cli-otlp. Nothing in `src` references `<pasted_content` outside these task docs. A scan of local Copilot data found 0 files containing the marker, against 116 Claude transcripts that contain it. The Copilot scan covered `~/.copilot` (414 files, 39 with prompt-like keys) and VS Code workspaceStorage (44 files, only 1 with a prompt-like key). That is why the fix is Claude-only. The VS Code Copilot Chat store was thin, so this is absence of evidence, not proof.
- **Ticket interpretation.** The ticket says "Normalize pasted-content markup in the CLI metrics and native hook ingestion paths, preserving the enclosed prompt text" and "Keep the original prompt available where required for analytics." The hook path and `claude.metrics-processor` `userPrompts` use the shared helper; the hook event also carries `prompt_original`.

## Open risks

- **Privacy and size.** `prompt_original` ships up to 4000 chars of user-pasted content to the backend, where it lands in residual `attrs` JSON. Masking is pattern-based and may miss secrets, and pasted content can be large or sensitive. The backend run must decide storage, access and retention. The 4000 bound is a judgment call and the user may want a different value, or no field.
- The paste format variants (mid-prompt, multiple, unterminated) are verified only by the repro script, not by a fixture in this repo.
- Copilot hosts may emit the markup. The evidence is thin (see above).
- Conversation sync still ships raw markup to the backend conversation store. Flag this to the backend run for Session Detail.
- Old CLI versions keep sending raw markup, so the backend must still normalise server-side, and cannot rely on `prompt_original` being present.
- `event_id` is content-hashed (`event-id.ts:75`), so a resend across an upgrade gets a different id, and the new field changes the hash input. Harmless, but a test that pins ids may need updating.
- Whether Claude populates `session_title` depends on the client version, and there is no capture in this repo, so tests use synthetic payloads.
