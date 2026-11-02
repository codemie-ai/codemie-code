# EPMCDME-16013 Story mention false positives - Implementation Plan

**Goal:** `extractTicketMentions` stops returning UUID fragments and listed non-ticket tokens, and the mention tier prefers an upper-case key, for every OTLP adapter, with no adapter-file change. Spec: `spec.md` (rules 1-3, AC1-AC14).

**Conventions:** Commit nothing and stage nothing (user reviews; never touch `.codemie/codemie-cli.config.json`). Extend existing test files in place, no new files. ES modules, `.js` import suffixes, `@/` alias, explicit return types, no `any`, no TODO placeholders. Tests run per task with `npx vitest run --project unit <file>`; the whole-suite gates belong to a later stage.

**Shape of the change (all in `src/agents/core/ticket-parser.ts`):** `TICKET_RE` stays exported and unchanged. `extractTicketMentions(text, limit, options?: { source?: 'prompt' | 'branch'; preferUpperCase?: boolean })`, defaults `'prompt'` and `false`. Iterate a fresh RegExp with `matchAll` (positions are needed; replace the "use `match()`" comment at :6-12). Split each match at its first `-` into key and number segment instead of re-reading the shape.

---

### Task 1: Shared tokenizer and UUID-shape rule (rule 1)

**Files:** modify `src/agents/core/ticket-parser.ts` (:13-46); test `src/agents/core/__tests__/ticket-parser.test.ts` (extend the `extractTicketMentions` describe).

Add one internal tokenizer `tokenizeRuns(text, { joinDigitDot })` returning runs `{ start, end, segments: { start, end, text }[] }` in a single pass. Segments are maximal `[A-Za-z0-9]+`, joined by a single `-` (the join set is one named constant); when `joinDigitDot` is set a `.` between two digits also joins. Resolve a match to its run by sweeping a pointer (matches arrive in increasing order, no per-match rescan). Add `UUID_GROUP_LENGTHS = [8, 4, 4, 4, 12]` and a predicate `isUuidShaped(run, segmentIndex)` implementing rule 1: read at most four segments either side of the key or number segment, drop on a 3+ window of consecutive all-hex segments matching consecutive UUID groups that includes that segment and contains the 8 or 12 group; also drop a key segment that is exactly 12 hex characters. Rule 1 uses `joinDigitDot: false` unless executing AC1-AC3 and AC10-AC11 with `true` changes no outcome. Thread `options.source` through (rule 1 applies to both sources). Dedupe, upper-casing, limit unchanged.

Test-first: yes - a `ticket-parser.test.ts` case that `extractTicketMentions('look at session 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87', 5)` is `[]` fails today (returns `['A43E-20']`).

- [ ] Write failing cases for every AC1-AC3 example: the UUID, `session-<uuid>`, `agent-<uuid>`, `<uuid>-v2`, `5da24492-df51-48cd-aeac-0b276375bb30`, partial `df51-48cd-aeac-0b276375bb30`, `...aeac-a43e8c1f66c8-2` and `-123`, `session-` prefixed form, upper-case form, bare `a43e8c1f66c8-123`, `session_<uuid>`, `id=<uuid>`, `<uuid>.json` (letter-led and digit-led last group). All give `[]`.
- [ ] Write keep-cases: `ABC-1234-added`, `feature/ABC-1234-fade`, `ABC-123-add`, `fix-ABC-123` keep `ABC-1234` / `ABC-123`; `ME-4`, `XYZ-3`, `A1-1`, `EPMCDME-15301` kept; a UUID followed by a real key returns the key.
- [ ] Linearity: a 1 MB `'a1-1-'.repeat(...)` input and a 200 KB dash-separated hex run each finish under a generous bound (for example 2 s) and return normally.
- [ ] Implement until `npx vitest run --project unit src/agents/core/__tests__/ticket-parser.test.ts` passes, existing cases included.

### Task 2: Known non-ticket prefix rule (rule 2, prompt source only)

**Files:** modify `src/agents/core/ticket-parser.ts`; test `ticket-parser.test.ts`.

Add one closed data constant next to `TICKET_RE` (name it e.g. `NON_TICKET_PREFIXES`, a `ReadonlySet<string>` of upper-case entries) with the spec's list (standards, protocols, model and vendor families). Its comment says: closed and extendable, add one entry plus one assertion in `ticket-parser.test.ts`, and whoever adds a model family to `src/utils/pricing.json` adds the family's first segment here. Condition (a): the candidate's key part, upper-cased, is in the set (exact match). Condition (b): the run containing the candidate, tokenized with `joinDigitDot: true`, has a first segment in the set, so every candidate in that run is dropped. Both are skipped when `source` is `'branch'`. Tokenize in dot mode only for the prompt source and sweep once.

Test-first: yes - `extractTicketMentions('explain what sha-256 and utf-8 are', 5)` is `[]` fails today.

- [ ] Failing cases, one per AC4 token (`GPT-4`, `gpt-4o`, `X86-64`, `UTF-16`, `ISO-8601`, `CVE-2024`, `COVID-19`, `claude-3-5-sonnet`, `gemini-2.5`, `llama-3`, `qwen-2`, `http-2`, `TLS-1`, `grok-4`, `GROK-4`, `grok-code-fast-1`, `codex-1`, `chatgpt-4`, `mistral-7b`, `deepseek-67b`, `kimi-k2-6`), plus `LLAMA3-8` kept (exact key) and `my-sha-256` dropped.
- [ ] AC10: each full model id (`gpt-4o-mini-2024-07-18`, `gemini-2.0-flash-001`, `claude-3-5-sonnet-20241022`, `gpt-4o-2024-08-06`, `gpt-4-turbo-2024-04-09`, `gemini-1.5-pro-002`, upper-case form, `openai/gpt-4o-mini-2024-07-18`) gives `[]`.
- [ ] AC11: `gpt-4o-mini-2024-07-18 then EPMCDME-15301`, `use gemini-2.0-flash-001, EPMCDME-15301`, `claude-3-5-sonnet-20241022: EPMCDME-15301`, `gpt-4o_EPMCDME-15301` give `['EPMCDME-15301']`; `gpt-4o-EPMCDME-15301` and `gpt-4o-mini-2024-07-18-EPMCDME-15301` give `[]` (pinned accepted loss).
- [ ] `{ source: 'branch' }` keeps `feature/GPT-4-support` -> `GPT-4` and `feature/gpt-4o-mini-2024-07-18` -> `GPT-4` (AC12), and still drops a UUID.

### Task 3: Upper-case preference (rule 3)

**Files:** modify `src/agents/core/ticket-parser.ts`; test `ticket-parser.test.ts`.

After rules 1 and 2, when `preferUpperCase` is set, order survivors: upper-case-key ids first, then lower-case, each in first-seen order, before the limit. Upper-case key = key part (text before the dash, as written) with no `[a-z]`; an id is upper-case if any surviving occurrence is. One pass, dedupe by upper-cased id. Default `false` keeps first-seen order.

Test-first: yes - `extractTicketMentions('use node-20 for EPMCDME-15301', 1, { preferUpperCase: true })` expecting `['EPMCDME-15301']` fails (option unknown, returns `['NODE-20']`).

- [ ] Cases for every AC13 prompt via `preferUpperCase: true`, limit 1 (`check epmcdme-15301`, `use node-20 or java-17`, `node-20 then epmcdme-15301`, `Node-20 then EPMCDME-1`, `node-20 abc-9 ABC-9`, `a1-1 then EPMCDME-1` vs `A1-1 then EPMCDME-1`, `EPMCDME-1 and EPMCDME-2`, `RFC-2616 for EPMCDME-15301`, `sha-256 then epmcdme-1`, `<uuid> then epmcdme-1`).
- [ ] Without the option, `use node-20 for EPMCDME-15301` with limit 20 stays `['NODE-20','EPMCDME-15301']`; `parsePromptFields('story: abc-12 and see XYZ-3, abc-12').ticket_mentions` stays `['ABC-12','XYZ-3']`; a UUID or `sha-256` in a prompt is absent from `ticket_mentions` while real keys keep first-seen order.

### Task 4: Wire the resolver tiers and update doc comments

**Files:** modify `src/agents/core/story-resolver.ts` (:70-113) and the remaining comments in `ticket-parser.ts` (:6-12, :28-31, :60); test `src/agents/core/__tests__/story-resolver.test.ts` (extend `resolveBranchStory`, `resolveMentionStory`, `resolveStoryFor`).

`resolveBranchStory` passes `{ source: 'branch' }`; `resolveMentionStory` passes `{ preferUpperCase: true }`. Write the full rule once in the `extractTicketMentions` doc comment (state both option defaults, that rules 1-2 use their own segment layout and not the UUID patterns at `src/utils/paths.ts:252` / `assistant-builder/conversations.ts:38`, and why). Shorten the `story-resolver.ts` comments at :71 and :100 to point to it. `parsePromptFields` and `OtlpAgentAdapter.ts:311` need no change.

Test-first: yes - a `resolveMentionStory('look at session 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87')` -> `null` case fails until the tier uses the filter, and `resolveMentionStory('use node-20 for EPMCDME-15301')` -> `EPMCDME-15301` fails until `preferUpperCase` is passed.

- [ ] Mention negatives and key-after-noise (AC1-AC5): UUID forms, `explain what sha-256 and utf-8 are`, `sha-256 then EPMCDME-15301`, UUID with suffix then key, `try grok-4 for EPMCDME-15301`, `check EPMCDME-15301 please` still `mention`.
- [ ] Model-id tails and glued-key loss (AC10-AC11 through `resolveStoryFor`); upper-case preference (AC13), including `use node-20 or java-17` -> `NODE-20` and `RFC-2616 for EPMCDME-15301` -> `RFC-2616`.
- [ ] Pin the accepted AR-8 consequence: `fix epmcdme-15301, see PR-123` resolves `PR-123` (mention), commented as accepted behaviour of the upper-case preference.
- [ ] Branch unchanged (AC6, AC12): `feature/EPMCDME-16013-x`, `feature/epmcdme-16013-x` -> `EPMCDME-16013`; `feature/ABC-1234-fade` -> `ABC-1234`; `feature/ISO-77-login` -> `ISO-77`; `feature/GPT-4-support` -> `GPT-4`; `1ABC-123` -> null; `ABC-123X` -> `ABC-123`. Marker: `story: ABC-5 do nothing` -> `ABC-5`, `story: ISO-77` -> `ISO-77`. A UUID prompt on a ticket-less branch through `resolveStoryFor` -> null.

### Task 5: Shared-chain and adapter assertions

**Files:** test only: `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` (near :222-260, `detectGitBranchMock` already mocked and the `run({ prompt })` helper exists); `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts` (near :1487-1524); `src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts`; `src/agents/plugins/copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts`.

Test-first: yes - the new base-class and adapter cases assert empty story for a UUID prompt and a mention story for a real key; the base-class UUID case fails before Task 1-4 land and the Copilot real-key case depends on the branch mock.

- [ ] `OtlpAgentAdapter.test.ts`: with branch `main`, `run({ prompt: 'look at session 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87' })` forwards `story_id: ''`, `story_source: ''`; `run({ prompt: 'check EPMCDME-15301 please' })` forwards `EPMCDME-15301` / `mention`; `run({ prompt: 'use node-20 for EPMCDME-15301' })` forwards `EPMCDME-15301`.
- [ ] `claude-code-otlp.plugin.test.ts`: add one assertion that a prompt holding a UUID and `SHA-256` plus a real key yields `ticket_mentions` containing only the real key.
- [ ] Both Copilot suites: add `vi.mock('@/utils/processes.js', ...)` spreading `vi.importActual` and replacing `detectGitBranch` (and `detectGitRemoteRepo` if the base class needs it) with `vi.fn()`; set it to a ticket-less branch such as `main` in `beforeEach`, and set `ensureCodeMieSsoAuth` to `{ ok: true }` in the new cases. Chat: `UserPromptSubmit` with `prompt`; CLI: `codemieEventName: 'userPromptTransformed'`. Read the forwarded event from `forwardOtlpEventsToSpool.mock.calls[0][0][0]`. Assert `detectGitBranch` was called with `/repo` (so the empty result is not an accident of a missing path), then: UUID prompt -> `story_id: ''`, `story_source: ''`; `check EPMCDME-15301 please` -> `EPMCDME-15301` / `mention`. One assertion pair per suite.

### Task 6: Architecture doc

**Files:** modify `docs/ARCHITECTURE-OTLP-PLUGIN.md` lines 90, 100, 186.

Test-first: no - documentation only.

- [ ] Line 90: define the mention tier as a ticket-shaped match excluding UUID-shaped tokens, the named non-ticket prefixes and the rest of a dash-joined run led by one, preferring the first upper-case-key survivor; say the prefix list is closed, lives in `ticket-parser.ts` next to `TICKET_RE`, does not apply to the branch tier; name EPMCDME-16013 as superseding the stage 1.1 "bare `TICKET_RE` match" wording and the old `story-resolver.ts` comment. Line 100 (the longer Known-limitations bullet): add the closed-list, prompt-only and residual-loss limitation (glued key, real project key on the list, off-list tokens like `us-east-1`, `story_id` may differ from `ticket_mentions[0]`). Line 186: show `extractTicketMentions(text, limit, { source, preferUpperCase })`. Leave lines 98, 99, 101 alone and do not edit the stage 1.1 files or the technical analysis. Point to the `extractTicketMentions` doc comment rather than restating the rule.

---

## Negative-constraint pass

- No new test files / duplicates: Tasks 1-5 only extend named existing files.
- No adapter-file change; only assertions in two Copilot test files and the claude test: no task edits a `*.plugin.ts`.
- No allowlist, config or env var; `TICKET_RE`, `MARKER_RE`, tier order and `story_source` values untouched: Tasks 1-4 touch only the extractor and its two call sites.
- Branch tier not subject to rule 2 or rule 3: Task 2 (branch cases) and Task 4 (`source: 'branch'`, no `preferUpperCase`).
- No commit, no staging of `.codemie/codemie-cli.config.json`: header Conventions; no commit task.
- No whole-suite or browser verification task: the AC examples and linearity checks live as test cases in Tasks 1-5.
