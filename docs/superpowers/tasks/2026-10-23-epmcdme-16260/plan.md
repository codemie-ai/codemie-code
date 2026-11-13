# EPMCDME-16260 Non-Latin-1 Header Values Implementation Plan

> **Superseded by `2411a576` and `2282a595`:** conditional encoding for Repository/Branch (only non-printable-ASCII segments), raw Project. This plan describes the original always-encode design. See `backend-handoff.md` for the current contract.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** codemie-claude works in folders with non-Latin-1 path characters, with attribution preserved, and invalid-header errors are no longer reported as authentication errors.

**Architecture:** One shared helper always percent-encodes the value of `X-CodeMie-Repository`, `X-CodeMie-Branch` and `X-CodeMie-Project`, one `/`-separated segment at a time, so `/` stays readable. It is applied at the three header writers. `normalizeError` stops mapping CodeMie-owned header failures to `AuthenticationError`.

**Tech Stack:** TypeScript (ESM, `.js` import extensions), Vitest.

**Spec:** requirements inline (no spec.md); research in `docs/superpowers/tasks/2026-10-23-epmcdme-16260/technical-analysis.md`.

Commit per task using the repository's existing convention (Conventional Commits, ticket EPMCDME-16260).

## Decisions

- Always encode (no "only when invalid" branch), so the wire format is one rule for every value.
- `/` stays unescaped: each `/`-separated segment is encoded with `encodeURIComponent` and the segments are re-joined with `/`. So `clients/репо-тест` becomes `clients/%D1%80%D0%B5%D0%BF%D0%BE-%D1%82%D0%B5%D1%81%D1%82`, and `org/repo` and `feature/x` are unchanged. Chosen to keep repository and branch values readable in logs and proxies. A backend that applies `decodeURIComponent` to the whole value decodes this correctly, since `/` is not escaped.
- A literal `%` is escaped to `%25`, so decoding is unambiguous.
- Same helper for all three headers, including project, for consistency.

## Acceptance criteria

- [ ] Every value written to `X-CodeMie-Repository`, `X-CodeMie-Branch` and `X-CodeMie-Project` is encoded by the shared helper, at all three writers (proxy plugin, metrics-api-client, skills-metrics).
- [ ] A proxy request with repository `clients/репо-тест` succeeds (no ERR_INVALID_CHAR) and upstream receives the encoded value from the Decisions section.
- [ ] ASCII, Latin-1 and non-Latin-1 values all come out encoded and round-trip through `decodeURIComponent` to the original.
- [ ] `normalizeError` does not return `AuthenticationError` for invalid-char errors on `X-CodeMie-*` headers; genuine cookie/auth header errors still map to `AuthenticationError`.
- [ ] `docs/ARCHITECTURE-PROXY.md` documents the always-encode rule.
- [ ] A backend handoff note exists in the task dir stating that the backend must decode all values, plus the rollout order.

## Backend dependency (hard prerequisite)

The backend must `decodeURIComponent` the values of `X-CodeMie-Repository`, `X-CodeMie-Branch` and `X-CodeMie-Project` before storing or attributing them. This applies to ALL values, not only non-ASCII ones, because the CLI now always encodes. This repo cannot make that change.

- Rollout order: the backend decode MUST ship BEFORE this CLI fix. Otherwise existing repository, branch and project attribution breaks for all users on old backends: any value containing a space, `%`, `@`, `+` or other reserved/non-ASCII characters is stored in its encoded form, and non-ASCII values are unreadable. Plain values such as `org/repo` are unchanged on the wire, so most existing attribution is unaffected.
- Task 5 produces the handoff note. The PR description must link it and mark the backend ticket as a release blocker for this change.
- Backend behavior is not verifiable from this repo. Verify live in CLI Analytics after both sides are deployed.

## Negative constraints pass

- "values are NOT dropped": Tasks 1-2 encode, never omit.
- "stop reporting CodeMie header errors as AuthenticationError while keeping real cookie/auth recovery": Task 3, tested both ways.
- The earlier "leave valid values byte-identical" constraint is superseded by the always-encode decision.
- No task violates a stated constraint.

## Assumptions and follow-ups (record in PR description)

- Branch/project non-Latin-1 behavior is not verified live; covered by tests only.
- `X-CodeMie-CLI-Model` and `X-CodeMie-Integration` are out of scope.
- Project values containing `/` are also segment-encoded (same helper); harmless.

## Review Focus

- `clients/репо-тест` encodes per segment: the `/` survives and round-trips through `decodeURIComponent`.
- A literal `%` (`100%/done`) becomes `100%25/done`, which decodes back to the original.
- Latin-1 non-ASCII (`café`) is encoded too (`caf%C3%A9`).
- Control characters / newline in a value (header-injection risk) are encoded.
- Empty or undefined value: not written, as today (the helper is only called for non-empty values).
- Desktop resolver path (`attribution.repository/branch`) is encoded too.

---

### Task 1: Shared helper `encodeAttributionHeader`

**Files:**
- Create: `src/utils/header-value.ts`
- Test: `src/utils/__tests__/header-value.test.ts`

**Interfaces:**
- Produces: `export function encodeAttributionHeader(value: string): string`. Splits `value` on `/`, applies `encodeURIComponent` to each segment, and re-joins with `/`. No validity check: it always encodes.

- [ ] **Step 1: Write failing tests** in `header-value.test.ts`:
  - `encodeAttributionHeader('org/repo')` returns `'org/repo'`.
  - `encodeAttributionHeader('café')` returns `'caf%C3%A9'`.
  - `encodeAttributionHeader('clients/репо-тест')` returns `'clients/' + encodeURIComponent('репо-тест')`.
  - `encodeAttributionHeader('100%/done x')` returns `'100%25/done%20x'`.
  - `encodeAttributionHeader('a\nb')` returns `'a%0Ab'`.
  - Round trip: for each of the inputs above, `decodeURIComponent(encodeAttributionHeader(v)) === v`.
  - Every encoded result is accepted by `http.validateHeaderValue('X', result)` (does not throw).
- [ ] **Step 2: Run** `npx vitest run src/utils/__tests__/header-value.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Implement** the helper in `src/utils/header-value.ts` per the Interfaces block, with an explicit return type and a one-line comment on why (the backend decodes with `decodeURIComponent`; `/` kept readable).
- [ ] **Step 4: Run** the same command. Expected: PASS.

Test-first: yes — `encodeAttributionHeader('clients/репо-тест')` has no implementation yet; the test fails on the missing module.

### Task 2: Apply helper at all three header writers

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts:92-113` (wrap repository at L92 and L105, branch at L95 and L109, project at L112 with `encodeAttributionHeader`; import from `../../../../../utils/header-value.js`).
- Modify: `src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts:155-157` (wrap the three values; keep the project spread conditional).
- Modify: `src/cli/commands/skills/lib/skills-metrics.ts:270-272` (wrap the three values inside the existing `if`s).
- Test: `tests/integration/proxy-header-contract-extended.test.ts`; `src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts`; `src/cli/commands/skills/lib/__tests__/skills-metrics.test.ts`.

**Interfaces:**
- Consumes: `encodeAttributionHeader(value: string): string` from Task 1.

- [ ] **Step 1: Write failing tests**
  - In `proxy-header-contract-extended.test.ts`, add cases using `startHarness({ repository: 'clients/репо-тест', branch: 'фича/икс', project: 'проект' })`. Assert the request succeeds (not 401) and captured upstream `x-codemie-repository`, `x-codemie-branch`, `x-codemie-project` equal `encodeAttributionHeader(...)` of each, and that `decodeURIComponent` of each returns the original.
  - Add a case with `repository: 'my repo', branch: 'fix/100%'` asserting the upstream values are `my%20repo` and `fix/100%25` (ASCII values are encoded as well).
  - Existing assertions of raw `org/repo` and `feature/x` stay valid because those encode to themselves.
  - In the metrics-api-client and skills-metrics tests, add one case each with a Cyrillic repository asserting the outgoing header is encoded, following each file's existing header-capture style.
- [ ] **Step 2: Run** `npx vitest run tests/integration/proxy-header-contract-extended.test.ts src/providers/plugins/sso/session/processors/metrics/__tests__/metrics-upload-contract.test.ts src/cli/commands/skills/lib/__tests__/skills-metrics.test.ts`. Expected: new cases FAIL.
- [ ] **Step 3: Apply the edits** listed under Files.
- [ ] **Step 4: Re-run** the same command. Expected: PASS.

Test-first: yes — a proxy request with repository `clients/репо-тест` currently fails with a 401, and `my repo` is forwarded unencoded.

### Task 3: Stop mislabelling CodeMie header errors as AuthenticationError

**Files:**
- Modify: `src/providers/plugins/sso/proxy/proxy-errors.ts:85-101`.
- Create test: `src/providers/plugins/sso/proxy/__tests__/proxy-errors.test.ts` (check the directory for an existing `__tests__` convention first).

**Interfaces:**
- Consumes: existing `normalizeError(error, context?): ProxyError`, `AuthenticationError`, `ProxyError`.

- [ ] **Step 1: Write failing unit tests** for `normalizeError`:
  - Error with `code: 'ERR_INVALID_CHAR'` and message `Invalid character in header content ["X-CodeMie-Repository"]` returns a `ProxyError` that is not an `AuthenticationError`. It has statusCode 500 and its details retain `originalError`.
  - The same for `ERR_HTTP_INVALID_HEADER_VALUE` naming `x-codemie-branch` (case-insensitive).
  - Error with `code: 'ERR_INVALID_CHAR'` and message `Invalid character in header content ["Cookie"]` is still an `AuthenticationError`.
  - Plain `Error('bad cookie value')` is still an `AuthenticationError`.
  - An existing `ProxyError` passes through unchanged; an unrelated error (for example a TLS code) keeps its current mapping.
- [ ] **Step 2: Run** `npx vitest run src/providers/plugins/sso/proxy/__tests__/proxy-errors.test.ts`. Expected: the two X-CodeMie cases FAIL.
- [ ] **Step 3: Implement.** Inside the existing header-error branch, first detect a CodeMie-owned header with `/x-codemie-/i.test(message)`. If matched, return `new ProxyError(message, 500, 'INVALID_HEADER_VALUE', { originalError: message, errorCode, ...context })` (match the `ProxyError` constructor signature at L11). Otherwise fall through to the existing `AuthenticationError` mapping unchanged. Update the comment so it states that CodeMie-owned headers are excluded.
- [ ] **Step 4: Re-run.** Expected: PASS.

Test-first: yes — `normalizeError` of an ERR_INVALID_CHAR error naming `X-CodeMie-Repository` currently returns `AuthenticationError`.

### Task 4: Document the encoding

**Files:**
- Modify: `docs/ARCHITECTURE-PROXY.md:632` (and the Branch/Project rows if present nearby).

- [ ] **Step 1:** In the header table, state that Repository, Branch and Project values are always percent-encoded per `/`-separated segment with `encodeURIComponent` (so `/` stays readable and `%` becomes `%25`), and that the backend must decode all values (see Backend dependency). Mention that invalid-header errors from `X-CodeMie-*` headers are not reported as authentication errors.

Test-first: no — documentation only.

### Task 5: Backend handoff note

**Files:**
- Create: `docs/superpowers/tasks/2026-10-23-epmcdme-16260/backend-handoff.md`

- [ ] **Step 1:** Write a short note (under ~40 lines) for the backend team containing:
  - Contract: `X-CodeMie-Repository`, `X-CodeMie-Branch` and `X-CodeMie-Project` values are ALWAYS percent-encoded by the CLI, per `/`-separated segment with `encodeURIComponent` (`/` is left as is). The backend must `decodeURIComponent` every value of these headers before storing or attributing, so the repository shows as `clients/репо-тест` in CLI Analytics. The same applies to the metrics upload and skills-metrics endpoints, which carry the same headers.
  - Before/after example: before, `X-CodeMie-Repository: clients/репо-тест` could not be sent (the CLI failed the request) and `my repo` was sent raw. After, the CLI sends `X-CodeMie-Repository: clients/%D1%80%D0%B5%D0%BF%D0%BE-%D1%82%D0%B5%D1%81%D1%82` and `my%20repo`; `org/repo` is sent unchanged; a literal `%` is sent as `%25`. The backend stores the decoded text.
  - Edge notes: decode must not fail on malformed escapes from older CLI versions, which still send raw values (fall back to the raw value). Old CLIs keep sending unencoded values, so the backend must handle both during the transition.
  - Rollout order (hard prerequisite): the backend decode MUST ship BEFORE this CLI fix. Otherwise existing repository, branch and project attribution breaks for users on old backends (encoded strings are stored).
  - Verification after deploy: run `codemie-claude` in a folder like `~/qa/clients/репо-тест` and confirm CLI Analytics shows repository `clients/репо-тест`; also confirm a repo with a space in the name shows decoded.

Test-first: no — documentation only.
