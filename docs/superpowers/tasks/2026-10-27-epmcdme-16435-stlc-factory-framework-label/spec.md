# Spec: STLC Factory session label (EPMCDME-16435)

## Problem
Sessions started by STLC Factory skills (`/stlc-factory:exploratory`, `/stlc-factory:stlc-foundation`, `/stlc-factory:suite-health`, and the unprefixed `/stlc-feature <url>`) are classified "Pure chat". The only label derivation in this repo is the ordered detector list in `src/cli/commands/analytics/report/session-source-detector.ts` (consumed by `payload-builder.ts:188`, rendered data-driven by `report/client/app.js`). It has no STLC entry, so neither the namespaced skills nor `stlc-feature` match.

## Behavior
- A session whose skill, agent or command invocation names (lowercased, as today) include any name starting with `stlc-factory:` is labeled "STLC Factory".
- A session that includes the unprefixed command `stlc-feature` (exact name match) is labeled "STLC Factory". Same shape as the existing unnamespaced SDLC command list (`session-source-detector.ts:48`).
- The new detector is a new entry in `SESSION_SOURCE_DETECTORS` (name `stlc-factory`), placed after `superpowers` and before `openspec`. First-match-wins means a session that also contains SDLC or Superpowers names keeps its current label.
- No other detector, name list, or fallback behavior changes. Non-factory sessions remain "Pure chat".

## Acceptance criteria
1. Each of the four commands, as a first-prompt invocation name, yields label "STLC Factory" from `detectSessionSource`.
2. The Sessions table and session-details header in the HTML report show the same label (they read `sessionSource`; no client change expected).
3. SDLC Factory still yields "CodeMie AI Factory", Superpowers "Superpowers", openspec/speckit/bmad unchanged, no match yields "Pure chat".
4. No change to cost, tokens, duration, turns, tool calls or skills data; only `sessionSource` differs.
5. Matching is case-insensitive like existing detectors.

## Non-goals
- No changes to the `claude-code-otlp` adapter, event fields, spool or forwarder.
- No changes to the report client UI or `types.ts`.
- No generic `stlc` substring or broad `stlc-` prefix matching; other unprefixed `stlc-*` commands are not labeled until named.
- No reclassification of existing detectors or their precedence.
- No changes in codemie-preview or the external STLC repo.
- No new tests beyond updating the existing detector tests (and only when tests are requested per repo policy).

## Test impact (for the plan)
`__tests__/session-source-detector.test.ts` asserts the exact detector name list (~line 59); it needs the new `stlc-factory` entry and STLC cases when tests are in scope.

## Risks
- The ticket's Framework column may be rendered by a backend/UI outside this repo; this fix covers only this repo's `sessionSource` path.
- Real invocation-name forms for STLC skills in OTLP-ingested sessions are unverified (external repo unread).
