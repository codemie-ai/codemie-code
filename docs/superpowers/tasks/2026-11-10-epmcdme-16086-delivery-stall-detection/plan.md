# EPMCDME-16086 follow-up: `classification_unreachable` delivery-health reason — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new, additive `DeliveryReason` — `classification_unreachable` — so `codemie proxy status` / `codemie proxy analytics status` stop reporting `Delivery: healthy` for the whole duration of an outage when a session's local classification never completed because the backend never answered.

**Architecture:** Read-only, two layers. The otlp-spool layer (`delivery-summary.ts`) gains a boolean computed from already-persisted state (`status.holds.session.reason` + a backend `Capability` passed in). The CLI presentation layer (`delivery-health.ts`) resolves that `Capability` once per call from the on-disk stored credential (never the daemon's live one, never a network probe) and appends the new reason last in the existing precedence chain.

**Tech Stack:** TypeScript, Vitest.

## Global Constraints

- Strictly read-only: no `refreshPolicy` call, no network probe, no `status.holds`/`status.delivery` write, no change to `evaluateSessionEvidence` or any `tick-processor.ts` write path (spec Approach / Non-goals).
- Exactly two qualifying hold reasons — `publication_contract_unavailable` and `organization_encoding_unsupported` — combined with capability `!== 'evidence'`; never `publication_stopped` (spec Decision 3/4).
- When the active `NamespaceId` cannot be resolved at all, `classification_unreachable` must never fire, for any session — a false negative is required, a false positive is forbidden (spec AC3, Decision 2-3).
- New reason is strictly last in `collectDeliveryHealth`'s precedence chain, after `send_failed` (spec Decision 7 / AC5).
- No minimum dwell/debounce window (spec Decision 5 / Non-goals).
- `DELIVERY_REASONS` stays a `Record<DeliveryReason, ...>` so an unhandled reason fails to compile (spec AC6).
- No task in this plan commits. Implementation stops at working, tested code with nothing staged or committed; the user commits manually afterward.

---

### Task 1: `classificationUnreachable` in the spool delivery summary

**Files:**
- Modify: `src/providers/plugins/sso/proxy/plugins/otlp-spool/delivery-summary.ts:1-55`
- Test: `src/providers/plugins/sso/proxy/plugins/otlp-spool/__tests__/delivery-summary.test.ts`

**Interfaces:**
- Consumes: `Capability` (`'evidence' | 'legacy' | 'unknown'`, exported from `./policy-cache.js:26`).
- Produces: `SpoolDeliverySummary.classificationUnreachable: boolean`; `summarizeSpoolDelivery(capability: Capability = 'evidence')`; `summarizeSession(sessionId: string, capability: Capability)` — both signatures change, default keeps every existing no-argument call site (incl. this file's own tests) compiling and behaving as "never flag" until Task 2 supplies a real capability.

Test-first: yes — a session held `publication_contract_unavailable` with pending bytes and capability `'unknown'` must report `classificationUnreachable: true`; the same session with capability `'evidence'`, or held `stamp_pending`/`publication_stopped` instead, must report `false`.

- [ ] **Step 1: Write the failing tests** in `delivery-summary.test.ts`, alongside the existing `mismatchHeld`/`sendFailed` cases (near line 58-70):
  - `summarizeSpoolDelivery('unknown')` on a session held `publication_contract_unavailable` with pending bytes → `classificationUnreachable: true`.
  - same session, called with `'evidence'` → `false`.
  - a session held `organization_encoding_unsupported`, capability `'unknown'` → `true`.
  - a session held `publication_stopped`, capability `'unknown'` → `false` (explicitly excluded).
  - every existing assertion in this file (`toEqual({ pendingBytes, mismatchHeld, sendFailed })`) must add `, classificationUnreachable: false` or switch to `toMatchObject` — update them in this same step so the suite compiles against the widened interface.
- [ ] **Step 2: Run** `npm run test -- delivery-summary.test.ts` — expect FAIL (`classificationUnreachable` does not exist / type errors).
- [ ] **Step 3: Implement.** In `delivery-summary.ts`: add `import type { Capability } from './policy-cache.js';`; add `classificationUnreachable: boolean` to `SpoolDeliverySummary` (line 12-19); add a module-level `const CLASSIFICATION_UNREACHABLE_REASONS = new Set(['publication_contract_unavailable', 'organization_encoding_unsupported']);`; change `summarizeSession(sessionId: string, capability: Capability)` (line 21) to compute `classificationUnreachable = pendingBytes > 0 && capability !== 'evidence' && CLASSIFICATION_UNREACHABLE_REASONS.has(status.holds?.session?.reason ?? '')` alongside the existing `mismatchHeld` line (30), returning it in both the early `!status` return (line 28, as `false`) and the final return (line 32); change `summarizeSpoolDelivery(capability: Capability = 'evidence')` (line 39) to seed `classificationUnreachable: false` (line 40), pass `capability` into `summarizeSession(id, capability)` (line 44's map callback), and OR it in next to the other flags (line 47-48).
- [ ] **Step 4: Run** `npm run test -- delivery-summary.test.ts` — expect PASS.

---

### Task 2: Resolve capability and wire `classification_unreachable` into `collectDeliveryHealth`

**Files:**
- Modify: `src/cli/commands/proxy/delivery-health.ts:1-66`
- Test: `src/cli/commands/proxy/__tests__/delivery-health.test.ts`

**Interfaces:**
- Consumes: `summarizeSpoolDelivery(capability)` and `SpoolDeliverySummary.classificationUnreachable` (Task 1); `getStoredAnalyticsCredentials(ssoUrl, env, overrides)` returning `PlatformCredentials | null` (`@/providers/core/codemie-auth-helpers.js`); `forwarderIdentity(credentials): {api_identity, owner_hash} | null` (`@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js`); `getPolicyState(id): Promise<PolicyState>` and `type Capability` (`@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js`).
- Produces: `DeliveryReason` gains `'classification_unreachable'`; new private `resolveCapability(state: DaemonState): Promise<Capability>`.

Test-first: yes — with the new reason wired, a stalled session (either qualifying hold reason, capability never `'evidence'`) must report `classification_unreachable`; the same hold with capability `'evidence'` must not; and when the capability resolution yields `'evidence'` because no `NamespaceId` could be built (mocked identity/credential lookup returning `null`), it must never fire regardless of hold state.

- [ ] **Step 1: Write the failing tests** in `delivery-health.test.ts`. Add `getStoredAnalyticsCredentials` and `forwarderIdentity` and `getPolicyState` to the existing `vi.hoisted(...)` block (lines 4-11) and their own `vi.mock(...)` calls (alongside lines 13-29, mocking `@/providers/core/codemie-auth-helpers.js`, `@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js`, `@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js`); default each to a value that resolves a `NamespaceId` and capability `'evidence'` in `beforeEach` (line 58-63), matching the existing default-to-healthy pattern. Add cases:
  - `summarizeSpoolDelivery` stub returns `classificationUnreachable: true` with capability resolving to `'unknown'` → `collectDeliveryHealth` reports `reason: 'classification_unreachable'`.
  - same, with `getPolicyState` resolving `capability: 'evidence'` → the `summarizeSpoolDelivery` mock (driven by the real capability argument it receives) must not need to be asserted again — instead assert `resolveCapability`'s result is threaded through by checking `summarizeSpoolDelivery` was called with `'evidence'` when the mocked policy state says so.
  - `forwarderIdentity` mocked to return `null` → even with `classificationUnreachable: true` stubbed on `summarizeSpoolDelivery`'s return, assert `collectDeliveryHealth` still reports healthy/unknown (no `classification_unreachable`) — this is the AC3 case, and must additionally assert `summarizeSpoolDelivery` was called with `'evidence'` (the safe default) via the same stub.
  - precedence: `send_failed` stubbed true alongside `classificationUnreachable: true` → reason stays `'send_failed'` (extend the existing "applies the precedence" test, line 149-158).
  - extend the `DELIVERY_REASONS` coverage test (line 176-188) to include `'classification_unreachable'` in the `codes` array and assert it has a label and no `run`.
- [ ] **Step 2: Run** `npm run test -- delivery-health.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** In `delivery-health.ts`: add `'classification_unreachable'` to the `DeliveryReason` union (line 9); add `classification_unreachable: { label: 'analytics backend has never answered for this session' }` to `DELIVERY_REASONS` (line 22-27); add `getStoredAnalyticsCredentials` to the existing import from `@/providers/core/codemie-auth-helpers.js` (line 2); add `import { forwarderIdentity } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/spool-io.js';` and `import { getPolicyState, type Capability } from '@/providers/plugins/sso/proxy/plugins/otlp-spool/policy-cache.js';`. Add, above `collectDeliveryHealth`:

  ```ts
  /**
   * The backend capability for the active profile's namespace, read from the on-disk stored
   * credential — never the daemon's live one, never a network probe. `'evidence'` is also the
   * safe fallback whenever no NamespaceId can be resolved, so an unresolved identity can never
   * produce a false `classification_unreachable` (spec AC3).
   */
  async function resolveCapability(state: DaemonState): Promise<Capability> {
    const stored = await getStoredAnalyticsCredentials(state.syncCodeMieUrl, {}, {
      provider: state.provider,
      baseUrl: state.targetUrl,
    });
    if (!stored) return 'evidence';
    const identity = forwarderIdentity(stored.credentials);
    if (!identity) return 'evidence';
    const policy = await getPolicyState({ ...identity, profile: state.profile });
    return policy.capability;
  }
  ```

  In `collectDeliveryHealth` (line 36-66): change `const [marker, spool] = await Promise.all([...])` (line 46-49) to resolve `marker` and `capability` in parallel (`applicableAuthMarker(...)`, `resolveCapability(state)`), then `const spool = await summarizeSpoolDelivery(capability);` on the next line; append `: spool.classificationUnreachable ? 'classification_unreachable'` to the `reason` ternary chain (line 51-56), directly before the trailing `: undefined`.
- [ ] **Step 4: Run** `npm run test -- delivery-health.test.ts` — expect PASS.

---

## Self-Review

**Spec coverage:** AC1 (fires on either hold reason + non-`'evidence'` capability) — Task 1 + Task 2 tests. AC2 (capability `'evidence'` → no false positive) — Task 1 + Task 2 tests. AC3 (unresolvable `NamespaceId` → never fires) — Task 2, `resolveCapability`'s `'evidence'` fallback + dedicated test. AC4 (no write-path change) — satisfied by construction; both tasks touch only `delivery-summary.ts`/`delivery-health.ts` plus their tests. AC5 (precedence last) — Task 2 Step 3 + precedence test. AC6 (exhaustive `DELIVERY_REASONS`) — Task 2 Step 3 + DELIVERY_REASONS test. AC7 (test coverage for all of the above) — Task 1 + Task 2 test steps.

**Negative constraints:** no network call — `getPolicyState` is a pure cache-file read, `resolveCapability` calls no `refreshPolicy`/`fetch` (Task 2). No false positive on unresolvable identity — `resolveCapability`'s two early `'evidence'` returns (Task 2). No widening beyond the two named hold reasons / no `publication_stopped` — `CLASSIFICATION_UNREACHABLE_REASONS` set is exactly the two, tested explicitly for `publication_stopped` exclusion (Task 1). No reordering of existing precedence — new check appended last (Task 2). No dwell/debounce — no timing logic added anywhere in this plan. No touch to `evaluateSessionEvidence`/`tick-processor.ts`/`refreshPolicy`/`status.holds`/`status.delivery` writes — neither task's file list includes them. No commits — neither task has a commit step; the Global Constraints state explicitly that implementation stops at tested code and the user commits manually.

**Placeholder scan:** none — every step shows the exact change or exact new code.

**Type consistency:** `Capability` type flows from `policy-cache.ts` → `delivery-summary.ts` (Task 1) → `delivery-health.ts` (Task 2) unchanged; `summarizeSpoolDelivery`/`summarizeSession` signatures match between their Task 1 definition and Task 2's call site.
