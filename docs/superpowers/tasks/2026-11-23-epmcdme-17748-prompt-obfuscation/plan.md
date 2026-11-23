# Prompt Obfuscation and Multi-Tracker Attribution Implementation Plan

**Goal:** Opt-in PII/secret obfuscation of analytics text on every CLI route, plus `AB#`, `org/repo#`, `#N` ticket attribution.
**Spec:** `docs/superpowers/tasks/2026-11-23-epmcdme-17748-prompt-obfuscation/spec.md` (analysis: `technical-analysis.md` beside it).
**Stack:** TypeScript ES modules, Vitest co-located `__tests__`, `@/` alias, `.js` import extensions.
Commit per task using the repository's existing convention (Conventional Commits, ticket EPMCDME-17748).

## Global Constraints
- New code is a leaf module beside `src/utils/security.ts`; no heavy imports (proxy daemon graph stays small).
- Default off; with obfuscation off, output equals today's except new attribution forms (AC7, NG4).
- Failure placeholder, never raw text; failures logged without content via `logger`.
- Only the new module imports `maskSecrets*` for analytics text (AC14).
- No dependency added; no git-remote tracker inference.

## Review Focus
- Four-part dotted numbers: `1.2.3`, `v1.2.3.4` unchanged, `10.2.3.4` masked (AC9) — Task 2.
- Ticket text straddling a 200/300 cut or a `[REDACTED:` placeholder — Tasks 2, 4.
- Config unreadable or project "off" with global "on" — Task 3.
- Protobuf nested length growth near 5 MiB, unknown fields — Task 7.
- Idempotence on already-obfuscated text — Task 2.

## Task 1: Multi-tracker ticket parsing and tracker-aware attribution
**Files:** Modify `src/agents/core/ticket-parser.ts:14,310,328`, `src/agents/core/story-resolver.ts:133`; tests `ticket-parser.test.ts`, `story-resolver.test.ts`.
**Interfaces:** Produces exported `TICKET_RE`-based `TICKET_REF_RE` (global regex covering `PROJ-123`, `AB#123`, `org/repo#123`, bare `#123`) and `parsePromptFields(text, tracker?: TicketTracker)`, `resolveStoryFor(..., tracker?)`; `type TicketTracker = 'jira'|'azure-devops'|'github'|'gitlab'`.
- Extend `extractTicketMarker`/mention scan for the new forms; bare `#N` counts only when `tracker` is github or gitlab (or `AB#`/`org/repo#` form used). Priority order in `resolveStoryFor` unchanged. `#fff`, headings, `#42` list numbers without tracker are not attributed.
- Test-first: yes — `parsePromptFields('fix AB#123')` returns mention `AB#123`; `'see #42'` yields none with tracker undefined and `#42` with `github`; `org/repo#7` attributed regardless of tracker.

## Task 2: Obfuscation leaf module and facade
**Files:** Create `src/utils/analytics-obfuscation.ts`, fixture `src/utils/__tests__/fixtures/obfuscation-samples.json`, test `src/utils/__tests__/analytics-obfuscation.test.ts`.
**Interfaces:** Produces `type ObfuscationMode = 'off'|'on'`; `sanitizeText(text: string, mode: ObfuscationMode, opts?: {maxInput?: number}): string`; `sanitizeDeep<T>(value: T, mode: ObfuscationMode, opts?): T`; `OBFUSCATION_RULES_VERSION: string`; `OBFUSCATION_FAILURE_PLACEHOLDER`; `trimBeforeOpenPlaceholder(text: string, limit: number): string`.
- Off mode delegates to existing secret masking (`security.ts:235,244`, `long-text-masking.ts:72`) unchanged. On mode: secrets, then PII rules (email, phone, IPv4, IPv6, Luhn-checked card, IBAN) to `[REDACTED:EMAIL]` etc. Ticket refs protected before PII and restored after, using `TICKET_REF_RE` from Task 1. Linear-time anchored regexes; over-cap field returns failure placeholder; any thrown error likewise. `v`-prefixed four-part numbers are not IPs. Idempotent.
- Set cap by measuring a 1 MB and 5 MB body; record the measurement in a code comment.
- Fixture holds input, expected, limit variants, cut-in-placeholder cases, rules version (backend copies it).
- Test-first: yes — fixture samples match byte-for-byte; second pass is a no-op; `1.2.3`, `v1.2.3.4`, `ABC-1234`, `#42` unchanged, `10.2.3.4` masked; each PII rule worst-case input finishes under a time ceiling (AC13); over-cap input returns placeholder; `PROJ-123` and `AB#5` survive adjacent to an email.

## Task 3: Settings resolver and setup step
**Files:** Create `src/utils/analytics-settings.ts` (+ test); Modify `src/cli/commands/setup.ts` (analytics setup step; check `src/cli/commands/proxy/analytics-connectors.ts` for the existing analytics prompts) and config types per `.ai-run/guides/usage/project-config.md`.
**Interfaces:** Produces `resolveAnalyticsSettings(cwd: string): {obfuscation: ObfuscationMode; ticketTracker?: TicketTracker}`.
- Obfuscation = on if global or project layer on; project cannot turn off. `ticketTracker` resolves project over global, default unset. Cache keyed by config mtime; unreadable config keeps prior value, or on if any layer was on, never off. Setup step offers obfuscation on/off and tracker, each global or current project. Rationale comment: `.claude/analytics.local.json` holds session state, not settings (do not reuse).
- Test-first: yes — project on + global off gives on; project off + global on gives on; default off; corrupt file after a prior "on" read stays on (AC15); mtime change re-reads.

## Task 4: Hook collectors, cowork and Copilot free text
**Files:** Modify `src/agents/core/otlp-field-limits.ts:49` (`maskAndBoundFields` takes mode, uses facade, cuts with `trimBeforeOpenPlaceholder`), `src/agents/core/OtlpAgentAdapter.ts:305,341` (resolve settings once per event from hook cwd; stamp `rules_version` when on), `src/telemetry/runtime/cowork/cowork-events.ts:323` (including branch fields), `src/agents/plugins/copilot-cli-otlp/copilot-cli-otlp.plugin.ts:342` and `copilot-cli-otlp.unhooked-tools.ts:91,100`, `claude-code-otlp.plugin.ts:707-721` (pass tracker to `parsePromptFields`).
- Ticket fields must be derived from the raw prompt before masking/truncation in every collector; fix any adapter that orders otherwise.
- Test-first: yes — per collector (claude-code-otlp, copilot-cli-otlp, copilot-chat-otlp, codemie-code-hooks, cowork) a test with obfuscation on and a prompt `"AB#123 mail a@b.com <long text>"` asserts `story_id`/mentions populated from the raw prompt, `prompt_body` contains `[REDACTED:EMAIL]` and ≤200 chars with no half placeholder (AC4); off mode output equals prior snapshot.

## Task 5: Proxy OTLP/JSON route
**Files:** Modify `src/providers/plugins/sso/proxy/plugins/otlp-json-masking.ts:43` and `otlp.plugin.ts:383-392`.
- `maskOtlpJson(body, mode)` uses the facade. Mode is resolved from the session-to-project mapping (`otlp-spool/session-project.ts`), never the request body; no mapping gives the protective value. A failing string becomes the failure placeholder; record dropped only if placeholder step fails.
- Test-first: yes — with project mapped on, an email in a log attribute is replaced; unmapped session with a known "on" layer obfuscates; a field forced to fail yields the placeholder and other attributes/metrics still forwarded (AC8).

## Task 6: Local report and `analytics sync`
**Files:** Modify `src/cli/commands/analytics/report/redact.ts:39` (title via facade unless `--redact`, which stays stronger), `src/cli/commands/analytics/index.ts:330,370`, sync payload construction in `src/cli/commands/analytics/sync/targets/*` (command cwd for mode).
- Test-first: yes — report with obfuscation on and no `--redact` has title with `[REDACTED:EMAIL]`; `--redact` still blanks title; sync payload to git target is obfuscated; off unchanged.

## Task 7: Protobuf walker
**Files:** Create `src/providers/plugins/sso/proxy/plugins/otlp-protobuf-obfuscate.ts` (+ test); Modify `otlp.plugin.ts` `handleOtlpBinary`.
**Interfaces:** Produces `obfuscateOtlpProtobuf(body: Buffer, mode: ObfuscationMode): Buffer | null` (null = size limit unmet).
- Generic length-delimited walker; rewrites only string `AnyValue` leaves (follow OTLP logs/metrics/traces field numbers), copies unknown/other fields byte-for-byte, recomputes parent varint lengths. No change needed returns the identical buffer. Check re-encoded size before `appendSpool` against `otlp-reader.ts:31,198-205` and `forwarder.ts:453-492` limits; on failure drop the body and increment a content-free log counter. Per-string failure becomes placeholder, rest sent.
- Test-first: yes — body without sensitive strings returns byte-identical; unknown field survives; email string replaced with correct parent lengths and passes the forwarder's range proof; body near 5 MiB passes or is dropped with counter; failing string yields placeholder with metrics intact (AC12, AC8).

## Task 8: Import guard and parity check
**Files:** Test `src/utils/__tests__/analytics-obfuscation-imports.test.ts`.
- Scan non-test `src/` for `maskSecretsInText|maskSecretsDeep|maskSecretsInLongText` imports for analytics text outside the new module; migrate leftover call sites found.
- Test-first: yes — test fails while any analytics-path file outside the module imports the masking functions (AC14).

## Negative-constraint pass
Checked against spec NG1–NG4 and "never raw", "no new dependency", "no git-remote inference", "project cannot turn off":
- NG1/NG3 (no backend, no backend setting read): no task touches them.
- NG2 (no names/addresses, no whole-prompt modes): Task 2 rules list is fixed.
- NG4 / AC7: Tasks 2, 4, 6 assert off-mode parity.
- No dependency: Task 7 hand-written walker.
- No remote inference: Tasks 1, 3 use explicit setting only.
- No retroactive obfuscation of spooled data: no task rewrites the spool.
- Failed field is never raw: Tasks 2, 5, 7.
