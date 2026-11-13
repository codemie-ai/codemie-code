# Technical Research

**Task**: story-resolver mention analytics otlp (EPMCDME-16013)
**Generated**: 2026-11-02
**Research path**: filesystem

---

## 1. Original Context

EPMCDME-16013 (Bug, Major): [CLI Analytics] Story "mention" detection treats UUID fragments and tokens like SHA-256 / UTF-8 as ticket IDs.

Description: The lowest-priority story tier ("mention") takes the first text in a prompt that matches TICKET_RE (letters or digits, a dash, digits, case-insensitive). The pattern also matches fragments of UUIDs and common tokens, so `agent.prompt.submit` gets a wrong story_id with story_source=mention. Introduced in PR #609 (`src/agents/core/story-resolver.ts`, `resolveMentionStory`).

Steps to reproduce: Fresh Claude Code session on branch main (connected via claude-code-otlp), no story env var or file. Prompts: "look at session 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87" -> story_id=A43E-20, story_source=mention; "explain what sha-256 and utf-8 are" -> story_id=SHA-256, story_source=mention. Another live session: prompts containing user UUID 5da24492-df51-48cd-aeac-0b276375bb30 gave DF51-48 and F031-4. Also matched by the same pattern: UTF-8, GPT-4, X86-64. Correct cases that must keep working: "check EPMCDME-15301 please" -> EPMCDME-15301 (mention); "story: ABC-5 do nothing" -> ABC-5 (marker). The final agent.session.summary has an empty story_id.

Expected: Text that is not a ticket (UUID fragments, SHA-256, UTF-8, GPT-4) yields no story: story_id empty, story_source empty.

Notes: Only prompt events affected. The mention tier needs prompt text and is the last tier (explicit, marker, branch, mention). Suggested fix: limit the mention tier to known project keys (e.g. EPMCDME), or ignore matches inside a longer dashed hex token. The spec for sub-stage 1.1 defines mention tier as first ticket-shaped match, so may be a design gap. Related: EPMCDME-16441, EPMCDME-16389.

User constraints/notes for the whole run: (1) Update existing code and existing tests rather than creating new duplicates. (2) Since the ticket was created, new integrations were added (e.g. Copilot: copilot-chat-otlp, copilot-cli-otlp, copilot-cli managed plugin, claude-code-otlp, etc.). Research must check whether the issue is still present for them - find EVERY place where story/ticket IDs are detected from prompts, branches, env, markers (not only src/agents/core/story-resolver.ts; look for other TICKET_RE-like regexes, duplicated resolvers, per-agent adapters, hook handlers, metrics/session code) and which agents' pipelines call them. The goal is a GENERIC fix at the shared resolver level, not per-agent patches. (3) Report existing tests covering these resolvers (paths) so they can be extended rather than duplicated. Repo guidelines are in AGENTS.md and .ai-run/guides/ (architecture, development-practices, code-quality); docs/ARCHITECTURE-OTLP-PLUGIN.md is relevant.

---

## 2. Codebase Findings

### Existing Implementations

Purpose A: **detect which ticket/story a hook event belongs to (explicit, marker, branch, mention)**.
- `src/agents/core/ticket-parser.ts:13` `TICKET_RE = /(?<![A-Za-z0-9])[A-Z][A-Z0-9]+-\d+(?!\d)/gi` - the ONLY ticket-shaped regex in `src/` (grep for `TICKET_RE` and for `-\d+` patterns outside tests: only `ticket-parser.ts:13` and `:23`). Rules: starts on a letter, preceded by a non-alphanumeric, one or more letters/digits, `-`, digits not followed by a digit; case-insensitive (so `sha-256`, hex fragments and `utf-8` all qualify). No project-key list, no hex/UUID guard. Observed matches (run with node on the current regex): `38a8bb8d-39d4-49b2-a43e-20c8e1f66c87` -> `a43e-20`; `5da24492-df51-48cd-aeac-0b276375bb30` -> `df51-48`, `aeac-0`; `sha-256`, `utf-8`, `GPT-4`, `X86-64`, `ISO-8601`, `CVE-2024`, `COVID-19`, `PR-123`, `v1-2`, `e2e-1`, `abc-123` (from `abc-123-def`). Correct: `EPMCDME-15301`, `ABC-5`.
- `ticket-parser.ts:23` `MARKER_RE = /\b(?:story|ticket)\b\s*[:#]\s*([A-Za-z][A-Za-z0-9]+-\d+)/i` - marker tier; requires `story:`/`ticket #` prefix, so unaffected by the bug (but accepts any `word-digits` after the marker, e.g. `story: sha-256`).
- `ticket-parser.ts:32` `extractTicketMentions(text, limit)` - builds a fresh RegExp from `TICKET_RE.source/flags`, upper-cases, de-dupes, caps. Consumers: `story-resolver.ts:80` (branch tier, limit 1), `:111` (mention tier, limit 1), `ticket-parser.ts:70` (`parsePromptFields`, limit 20).
- `ticket-parser.ts:49` `extractTicketMarker`; `:67` `parsePromptFields(prompt)` emits `story_marker`, `ticket_mentions` (up to 20, same TICKET_RE), `prompt_length`.
- `src/agents/core/story-resolver.ts`: `resolveExplicitStory` (:47, env `SDLC_ANALYTICS_STORY_ID`, then `<cwd>/.claude/analytics.local.json`), `resolveBranchStory` (:75), `resolveMarkerStory` (:90), `resolveMentionStory` (:106, the bug site: `extractTicketMentions(promptText, 1)`), `resolveStoryFor` (:131, priority explicit -> marker -> branch -> mention; marker and mention run only if `prompt` truthy).
- `src/agents/core/event-fields/repo-fields.ts:28` `resolveRepoFields({cwd, prompt})` - sole caller of `resolveStoryFor` (:34); emits `story_id`/`story_source` (`''` when no story or on failure).
- `src/agents/core/OtlpAgentAdapter.ts:280-317` base class: `resolveCommonFields` -> `resolveRepoFields(context)` for EVERY adapter; `mergeCommonFields` lets an event's own non-empty `story_id`/`story_source` win (`OVERRIDABLE_FIELD_KEYS`, :33) and calls `resolveBranchStory(ownBranch)` (:311) only for branch/empty story source. The prompt comes from the adapter's `extractHookContext`.

Who feeds `prompt` into `OtlpHookContext` (i.e. who reaches the mention/marker tiers) - all three OTLP adapters, so the bug is present for all of them via the shared base class:
- `src/agents/plugins/claude-code-otlp/claude-code-otlp.plugin.ts:92-97` - `prompt` on `UserPromptSubmit`. Additionally spreads `parsePromptFields(prompt)` at :463 (`ticket_mentions` / `story_marker` also affected by TICKET_RE).
- `src/agents/plugins/copilot-chat-otlp/copilot-chat-otlp.plugin.ts:34-37` - `prompt` on `UserPromptSubmit`. Does NOT call `parsePromptFields`.
- `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:44-47` - `prompt` on `userPromptTransformed` (event type `agent.prompt.submit`). Does NOT call `parsePromptFields`. `copilot-cli-otlp.usage.ts:98` only lists `story_id`/`story_source` among passthrough keys.
- Non-prompt events of these adapters pass no prompt, so only branch/explicit tiers apply (consistent with "only prompt events affected").

Not story detectors (searched, none found): managed `copilot-cli` plugin (`src/agents/plugins/copilot-cli/**`, only conversation/metrics processors, no story/ticket logic), other agent session/metrics/conversation processors (`claude`, `codex`, `gemini`, `opencode`, `pi`, `kimi`), `src/providers/**` (the OTLP spool forwarder/daemon no longer references `story_id`; `grep story_id|story_source|storyId|resolveStory|ticket_mentions` in `src/providers` returns nothing outside tests - a test fixture `copilot-usage-enrichment.test.ts:37` just carries `story_id: 'EPMCDME-16018'`), `src/telemetry/**`, `src/cli/commands/analytics/**` (redact.ts mentions branch/ticket only in a comment), `src/hooks/**`, `src/cli/commands/hook.ts` (dispatches to `processOtlpEvent` at :1567; no story logic). Only 7 files in `src/` mention `story_id|storyId|story_source` at all: story-resolver, repo-fields, OtlpAgentAdapter, copilot-cli-otlp.usage, plus three test files. Case-insensitive "story" hits elsewhere are `history`/`Story` unrelated noise.

Other touched code: none beyond the above. Doc: `docs/ARCHITECTURE-OTLP-PLUGIN.md` describes the tiers (lines ~89-90, 98-99, 185-186) and `ticket-parser.ts` fields; it states mention is a "bare TICKET_RE match".

### Decisions Already in the Code

- Convention: ticket-shaped text scanning is centralised in `ticket-parser.ts`; `story-resolver.ts` holds tiers and delegates (doc comment `ticket-parser.ts:1-4`, `story-resolver.ts:3`). Resolvers are pure/sync apart from the explicit tier.
- Decision: one shared regex serves branch tier, mention tier and `ticket_mentions` (`ticket-parser.ts:13,37`). Alternative: a distinct, stricter pattern per use. Reason: none recorded beyond the stage 1.1 spec (below). Any change to `TICKET_RE`/`extractTicketMentions` therefore changes all three consumers together.
- Decision: mention tier = "first `TICKET_RE` match anywhere in the prompt", lowest priority (`story-resolver.ts:99-113`; plan.md:114 of `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/` "bare `TICKET_RE` match anywhere in the text"; spec.md:97 priority chain). Alternative: known project keys, hex-token guard (the ticket's suggestions). Reason: none found for accepting any `LETTERS-digits`.
- Decision: no list of known Jira project keys exists in the code (searched `projectKey|ticketPrefix|jiraProject|storyKeys|PROJECT_KEYS`; only unrelated analytics path allowlists in `project-allowlist.ts` / `copilot-connector-scope.ts`). The repo's own `.codemie/codemie-cli.config.json` names Jira project `EPM-CDME`, but that is per-assistant config, not read by the resolver.
- Decision: case-insensitive match plus `.toUpperCase()` on return (`ticket-parser.ts:13,40`); tests assert lowercase input is accepted (`ticket-parser.test.ts:7`, `story-resolver.test.ts:87`).
- Decision: hook-time resolution in the short-lived hook process; story is per-invocation, no cross-turn memory (ARCHITECTURE-OTLP-PLUGIN.md:97 "Story granularity"). A mention-derived wrong id is not carried to later events (`agent.session.summary` has none, matching the ticket).
- Decision: `mergeCommonFields` never rebases a mention/marker/explicit story (`OtlpAgentAdapter.ts:304-314`).
- Rollout note (doc :99): older proxy daemon recomputes story fields until restarted; the current code no longer references story fields in `src/providers`, so this appears stale (unverified against released daemon versions).

### Task Statements Checked Against the Code

- "mention tier takes the first text matching TICKET_RE ... also matches UUID fragments and tokens": holds (`story-resolver.ts:111`, `ticket-parser.ts:13`; node run confirmed `a43e-20`, `sha-256`, `utf-8`, `df51-48`, `GPT-4`, `X86-64`).
- "Only prompt events affected": holds for story fields (prompt only supplied for the three prompt-submit events, `extractHookContext` in each adapter). Contradicted in part for adjacent data: on claude-code-otlp prompt events `ticket_mentions` (`ticket-parser.ts:70`, `claude-code-otlp.plugin.ts:463`) uses the same regex and carries the same false positives, and the branch tier uses it on branch names (`resolveBranchStory`).
- "Introduced in PR #609": holds (git log: `e0f79aa` #609 created story-resolver; `cc61883` #634 later changed it).
- "Reproduced on claude-code-otlp": holds; the issue also holds for `copilot-chat-otlp` and `copilot-cli-otlp` (same base class, same `resolveRepoFields`, prompt provided). The managed `copilot-cli` plugin and other agents have no story logic, so are not affected.
- "Correct cases that must keep working: `check EPMCDME-15301 please` (mention), `story: ABC-5 do nothing` (marker)": holds today (node run; `story-resolver.test.ts:135-163,185-189`).
- "Expected: no story: story_id empty, story_source empty": `resolveRepoFields` yields `''`/`''` when `resolveStoryFor` returns null (`repo-fields.ts:38-39`); the fallthrough to null is already supported. With branch `main` the branch tier resolves nothing (`OtlpAgentAdapter.test.ts:243`).
- "Suggested fix: limit mention tier to known project keys": keeps no existing mechanism in place; no key list exists (see Decisions). "Ignore matches inside a longer dashed hex token": no existing guard (`(?<![A-Za-z0-9])` lookbehind only blocks alphanumeric neighbours; `-` before a match is allowed, which is why `a43e-20` inside a UUID matches).
- "The spec for sub-stage 1.1 defines mention tier as first ticket-shaped match": holds (spec.md:97, plan.md:114 under `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/`).
- "Related: EPMCDME-16441, EPMCDME-16389": unverified (no reference in the repo; Jira only).

### Consumers of Changed Contracts

Contract: `TICKET_RE` / `extractTicketMentions` / `resolveMentionStory` / `resolveStoryFor` output.
- `TICKET_RE` (exported): referenced only in `ticket-parser.ts:37` (no importer elsewhere in `src/`; only mentioned in comments at `story-resolver.ts:71,100` and a test title `story-resolver.test.ts:101`).
- `extractTicketMentions`: `story-resolver.ts:80` (branch), `:111` (mention), `ticket-parser.ts:70` (`ticket_mentions`); tests `ticket-parser.test.ts:5-23`.
- `parsePromptFields`: only `claude-code-otlp.plugin.ts:463`; tests `ticket-parser.test.ts:37-57`, `claude-code-otlp.plugin.test.ts:1487-1550`.
- `resolveStoryFor`: only `repo-fields.ts:34` -> `resolveRepoFields` -> `OtlpAgentAdapter.resolveCommonFields` (:280) -> all three OTLP adapters.
- `resolveBranchStory`: `story-resolver.ts` (via `resolveStoryFor`) and `OtlpAgentAdapter.ts:311`.
- Downstream: `story_id`/`story_source` fields in events forwarded to the spool/analytics backend (`copilot-cli-otlp.usage.ts:98` passthrough key list). A changed `story_source` value set would also reach the backend; current values: explicit, marker, branch, mention, `''`.
- Existing test expectations on the contract: `story-resolver.test.ts:98-130` (branch edge cases `1ABC-123` -> null, `ABC-123X` -> `ABC-123`), `:185-216` (mention `ABC-42`), `:246-258` (`ME-4` mention), `ticket-parser.test.ts:7,11` (`xyz-3`, `A1-1`, `B2-2`, `C3-3` accepted as tickets), `claude-code-otlp.plugin.test.ts:1488-1523` (`ABC-12`, `XYZ-3`, `ABC-99`). Short/synthetic keys are asserted as valid in these tests; a known-project-key restriction would conflict with them, a hex/UUID guard would not.

### Architecture and Layers Affected

Agent adapter layer, shared core (`src/agents/core/`: `ticket-parser.ts`, `story-resolver.ts`, `event-fields/repo-fields.ts`, `OtlpAgentAdapter.ts`), then the proxy spool forwarder/daemon (transport only, no story logic). Layered per `.ai-run/guides/architecture/architecture.md`; the fix surface lies entirely in the shared core.

### Integration Points

`codemie hook --agent <name>` (`src/cli/commands/hook.ts:1567`) -> `OtlpAgentAdapter.processOtlpEvent` -> `resolveRepoFields` -> `resolveStoryFor`; events then go to the proxy spool and analytics API. Git branch from `detectGitBranch` (`src/utils/processes.js`).

### Patterns and Conventions

ES modules with `.js` import suffixes, `@/` alias, explicit return types on exports, `interface` for shapes, no `any` (AGENTS.md). Pure parser module plus tier module; resolvers return `null`/`''` on no match rather than throwing. Fresh `RegExp` built from `TICKET_RE.source/flags` per call because of the `g` flag (`ticket-parser.ts:6-12`) - a new regex or guard must keep that (stateful `lastIndex`).

---

## 3. Documentation Findings

### Guides and Architecture Docs
`.ai-run/guides/` present (architecture, development, integration, security, standards, testing, usage, project.md, quality-gates.md); no guide covers story resolution. `docs/ARCHITECTURE-OTLP-PLUGIN.md` covers it: tier priority and "bare TICKET_RE" mention wording (~lines 90, 98-99), module table rows 185-186. It would need to stay consistent with any behaviour change. Spec/plan for the original feature: `docs/superpowers/tasks/2026-10-01-epmcdme-15301-stage-1-1/{spec.md,plan.md}`.

### Architectural Decisions
No ADR. Decision on tier order and mention definition is recorded only in the stage 1.1 spec/plan (above). CHANGELOG has no entry for this.

### Derived Conventions
Unit tests colocated under `__tests__/`, dynamic `await import('../story-resolver.js')` per test in the story-resolver suite.

---

## 4. Testing Landscape

### Existing Coverage
- `src/agents/core/__tests__/story-resolver.test.ts` - explicit (:28-81), branch (:83-131 incl. `1ABC-123`, `ABC-123X`), marker (:133-181), mention (:183-217: `ABC-42` mention, none, empty, repeat-call stability), `resolveStoryFor` priority (:219-282). No UUID/hex/SHA/UTF-8 negative cases.
- `src/agents/core/__tests__/ticket-parser.test.ts` - `extractTicketMentions` (order, limit, empties, repeated calls), `extractTicketMarker`, `parsePromptFields`.
- `src/agents/core/__tests__/OtlpAgentAdapter.test.ts` - common fields through the base class with a fake adapter: explicit/marker/branch/none cases (:200-256, e.g. `run({ prompt: 'story: MK-3' })` at :230); no mention-tier case here.
- `src/agents/plugins/claude-code-otlp/__tests__/claude-code-otlp.plugin.test.ts:1487-1550` - `story_marker`/`ticket_mentions`/`prompt_length` stamping on prompt events.
- `src/agents/plugins/copilot-chat-otlp/__tests__/copilot-chat-otlp.plugin.test.ts` and `.../copilot-cli-otlp/__tests__/copilot-cli-otlp.plugin.test.ts` - no assertions on `story_id`/`story_source`/`ticket_mentions` (grep found none).
- `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/copilot-usage-enrichment.test.ts:37` - fixture only.

### Testing Framework and Patterns
Vitest (`vitest.config.ts`, project `unit` includes `src/**/*.test.ts`), run with `npm test` / `vitest run --project unit`. Repo policy: tests only on explicit user request (AGENTS.md).

### Coverage Gaps
No negative tests for hex/UUID fragments, SHA-256, UTF-8, GPT-4 in any suite; no mention-tier test through the base class; no story assertions in the Copilot adapter tests.

---

## 5. Configuration and Environment

### Environment Variables
`SDLC_ANALYTICS_STORY_ID` (explicit tier, `story-resolver.ts:51`). No env var for project keys or mention toggles.

### Configuration Files
`<cwd>/.claude/analytics.local.json` `{storyId}` (explicit tier). No config for ticket prefixes.

### Feature Flags and Deployment Concerns
None for the story tiers. Daemon outlives CLI upgrades (doc :99), but story fields are computed hook-side.

---

## 6. Risk Indicators

- Shared regex: `TICKET_RE` feeds the branch tier, mention tier and `ticket_mentions` (`ticket-parser.ts:37,70`, `story-resolver.ts:80,111`); a change there reaches all three, and branch names such as `feature/EPMCDME-16013-x` must still resolve.
- Same defect reachable in `copilot-chat-otlp` and `copilot-cli-otlp` (not only Claude) through `OtlpAgentAdapter` -> `resolveRepoFields`; their test suites have no story coverage.
- `ticket_mentions` (claude-code-otlp prompt events only) uses the same regex and has the same false positives; the ticket text covers only story_id.
- Existing tests assert short, synthetic keys (`ME-4`, `XYZ-3`, `A1-1`, `B2-2`) as valid; a known-project-key allowlist has no source in the code today (Speculative: it would need a new config source and would conflict with those assertions).
- False-positive classes beyond the ticket's list that match today: `ISO-8601`, `CVE-2024`, `COVID-19`, `PR-123`, `e2e-1`, `v1-2`; any rule chosen leaves some of these open or loses real keys (design decision for spec).
- `MARKER_RE` accepts any `word-digits` after `story:`, e.g. `story: sha-256` (explicit marker, arguably intentional).
- Doc `docs/ARCHITECTURE-OTLP-PLUGIN.md` lines ~90, 98 and stage 1.1 spec wording ("bare TICKET_RE") will go out of date with a behaviour change.
- Legacy-daemon note in doc :99 looks stale (no story logic left in `src/providers`); unverified.

---

## 7. Summary for Complexity Assessment

Story/ticket detection is concentrated in two pure-ish files, `src/agents/core/ticket-parser.ts` (the only ticket-shaped regex, `TICKET_RE`) and `src/agents/core/story-resolver.ts` (tiers), reached from a single call chain `OtlpAgentAdapter.resolveCommonFields -> resolveRepoFields -> resolveStoryFor`. All three OTLP adapters (claude-code-otlp, copilot-chat-otlp, copilot-cli-otlp) pass prompt text into that chain on their prompt-submit events and are therefore all affected; the managed copilot-cli plugin and other agents' session/metrics code contain no story logic. No duplicate resolvers exist. A generic fix therefore sits in the shared parser/resolver layer, with a file-change surface of roughly 2 source files, 2-3 existing test files and one doc.

Technical novelty is low (regex/pattern refinement in an existing module; no new dependencies, config or schema). The one open point is rule choice: the shared regex also drives the branch tier and the `ticket_mentions` field, existing tests assert synthetic short keys as valid, and there is no existing known-project-key source. The Stage 1.1 spec defines the current behaviour, so it is a spec-level design gap.

Test posture: unit suites exist and can be extended (`story-resolver.test.ts`, `ticket-parser.test.ts`, `OtlpAgentAdapter.test.ts`, `claude-code-otlp.plugin.test.ts`); there are no negative cases for UUID/hex/SHA/UTF-8, and the Copilot adapter suites have no story assertions. Key risks are listed in Section 6.

---

## 8. External References

None named by the task. (Jira EPMCDME-16441 / EPMCDME-16389 are referenced as related but are not in the repository and were not readable from here; the internal stage 1.1 spec/plan paths above were read.)

## Facts Added by Review

Researched for the names the spec relies on, after the analysis above was written. Read like the facts layer; where a line here contradicts one above, this one was read later.

- `src/utils/paths.ts:252` - `UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Anchored whole-string, case-insensitive, any version.
- `paths.ts:274` `isValidUuid(str)` and `paths.ts:299` `isValidUuidFilename(filename, ext)` (strips the extension, then calls `isValidUuid`) are the exports.
- Consumers: none found. A search of `src` and the repo for `isValidUuid`/`isValidUuidFilename`/`UUID_PATTERN` hits only `paths.ts` (definitions and JSDoc examples); no test and no caller imports them. The file header (`paths.ts:8`) says "UUID validation for session files".
- `src/utils/paths.ts:396-397` - `CLAUDE_DESKTOP_SANDBOX_RE`, an inline second full-UUID shape (`\/local_<8-4-4-4-12>(?:\/|$)`, case-insensitive). The comment at `paths.ts:395` records why the full shape is required: "avoids false positives on user directories named `local_<8hex>`".
- Consumer: `extractRepository` at `paths.ts:412`, which returns `'Cowork'` for matching working directories. That is the only use found.
- `src/cli/commands/sdk/assistant-builder/conversations.ts:38` - `const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i`. Unanchored, case-insensitive, not exported.
- `conversations.ts:40` `extractConversationId(value)` returns the first UUID substring of a string (a bare ID or a chat URL) or `null`.
- Consumers: `loadTranscriptsByIds` in the same file (`conversations.ts:50`), called from `assistant-builder/commands.ts:281` for a comma-separated `--ids` option, and `__tests__/conversations.test.ts:47-52` (bare UUID, URL containing a UUID, "not a link" -> null).
- A match with no UUID yields `{ id: value, error: "No conversation ID found" }` (`conversations.ts:51-53`).
- Result: three independent copies of the same 8-4-4-4-12 shape exist (`paths.ts:252`, `paths.ts:397`, `conversations.ts:38`). None is imported by `ticket-parser.ts` or `story-resolver.ts`. A search of `src/agents/core/{ticket-parser,story-resolver}.ts` for `uuid`/`0-9a-f` found no match, so the mention tier has no UUID handling today.
- Consumers: `src/utils/pricing.ts:126` reads it with `readFileSync(join(HERE, 'pricing.json'))` at runtime. `lookupPrice`, `resolvePrice`, `priceTable` and `canonicalizeModelId` are imported by `cost-enricher.ts`, `cost-calculator.ts`, `dispatch-allocation.ts`, `otel-pricing.ts`, `pi.models.ts` and `claude/plugin/statusline.ts`. None of them is on the story or ticket path.
- `src/utils/pricing.ts:63` adds CodeMie-only rows over the vendored file (`claude-smart-router`).
- `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.types.ts:11-45` - `CopilotCliHookInput`. `userPromptTransformed` is not a field. It is a member of `CliEventName`, which is derived from `CLI_HOOK_EVENT_NAMES` (`copilot-cli-otlp.constants.ts:11-24`). The payload field it uses is `prompt?: string` (`types.ts:24`).
- The comment at `types.ts:22-23` reads: "userPromptTransformed - the ORIGINAL prompt (bounded <=200 by the base class), never the unbounded transformed text."
- The `[key: string]: unknown` index signature at `types.ts:44` allows undeclared fields, but none are declared that carry transformed text or injected context.
- `copilot-cli-otlp.plugin.ts:16-19` maps `userPromptTransformed` to `agent.prompt.submit`.
- `copilot-cli-otlp.plugin.ts:44-48` `extractHookContext` passes `input.prompt` to the base class for `userPromptTransformed` only. `OtlpAgentAdapter.ts:116` calls it, and `event-fields/repo-fields.ts:28-34` hands that `prompt` to `resolveStoryFor({cwd, branch, prompt})`. The story tiers read the raw `input.prompt`.
- The 200-char bound is applied later, at `OtlpAgentAdapter.ts:45` (`MAX_PROMPT_CHARS = 200`), lines `:200` and `:239`, on the emitted `prompt_body`/`prompt` fields. Nothing in the files read bounds `input.prompt` before `extractHookContext` hands it to the story tiers, so the "bounded <=200" comment describes the emitted field, not the string the mention tier scans.
- Whether the CLI's `prompt` can carry injected context (attached file contents): not settled by the repo. The only fixtures are `prompt: 'hi'` in `__tests__/copilot-cli-otlp.plugin.test.ts:139,179`. No recorded GitHub payload or specification is in the repo. `copilot-cli-otlp.constants.ts:7-9` states prompt telemetry is owned entirely by `userPromptTransformed`, and `types.ts:47-51` says the replaced prompt is fixed text. This is unverified, and a captured payload would settle it.
- Whole-string UUID check (`paths.ts:252`) and substring UUID extraction (`conversations.ts:38`) were chosen separately for their callers. Alternative: one shared helper. Reason: none found. The sandbox regex (`paths.ts:395`) records an explicit reason for needing the full 8-4-4-4-12 shape (avoid `local_<8hex>` false positives).
- Spec: "`src/utils/pricing.json` prices grok-*, codex-mini and kimi-* models" - holds (`pricing.json:571`, `:367`, `:1171-1209`).
- Spec: "`copilot-cli-otlp.types.ts:22` says the original prompt" - holds as a comment. Whether it carries injected context is unverified (see above).
- Spec: "existing UUID detection near `paths.ts:252` and `conversations.ts:38`" (as named in the top-up request) - holds, and neither is used by the ticket path.
