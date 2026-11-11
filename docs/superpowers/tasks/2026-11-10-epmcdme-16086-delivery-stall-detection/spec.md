# Spec: EPMCDME-16086 follow-up — classification-unreachable delivery-health reason

## Problem

`codemie proxy status` / `codemie proxy analytics status` report `Delivery: healthy` for the
whole duration of an outage when a session has never completed classification (fresh
machine/profile/reinstall) and the analytics backend was unreachable from the very first
classification-policy probe. The shipped `send_failed` reason (`delivery-health.ts`,
`delivery-summary.ts`) only fires after a real POST gets an unacknowledged response; in this
scenario the forwarder fails closed in `evaluateSessionEvidence` before `send()` is ever reached
(`session-project.ts:97-115`, confirmed by `tick-processor.test.ts:620`), so no such record is ever
created and `pendingBytes` sits unmoving while nothing reports it.

## Approach

Add one new, additive `DeliveryReason` to `delivery-health.ts` — `classification_unreachable` —
fired when, for the single active namespace, a session is held `publication_contract_unavailable`
**or** `organization_encoding_unsupported` (`status.holds.session.reason`, already persisted)
**and** that namespace's policy-cache file (`policy-cache.ts`) has never recorded
`capability === 'evidence'`. Both hold reasons share the identical "backend never answered
usefully" precondition at the point they are set: `classifySession` (`classification.ts:74-116`)
runs before the contract-advertisement check (`tick-processor.ts:118-128`), so with
`state.policy === null` its organization gate (`organizationSendable`, `org-encoding.ts:49-51`)
produces `organization_encoding_unsupported` — before `publication_contract_unavailable` is ever
reached — for any organization name that needs header encoding (anything outside printable
ASCII/Latin-1; see `stamp.ts:58` / `routing.ts:151-164` for why every current session carries
`negotiate_publication: true` and so takes this path). This is the same never-answered-backend
precondition `publication_contract_unavailable` is set under for organizations whose name doesn't
need encoding. The two reasons disambiguate on the same guard: capability `'evidence'` means the
backend answered at least once — for `organization_encoding_unsupported` that is a reachable
backend genuinely unable to encode this org name (legitimate, not a stall); for
`publication_contract_unavailable` that is the reachable-but-old/paused-rollout case
(`tick-processor.ts:136-143`). Capability staying `'unknown'` means every classification-policy
probe since install has failed, timed out, or returned something unusable, for either reason —
the exact QA-reported silent stall.

`getPolicyState()` (pure cache-file read, no network call, no `refreshPolicy`) is called once per
`collectDeliveryHealth` invocation to get that capability, using the `NamespaceId` built from
`getStoredAnalyticsCredentials` + `forwarderIdentity` + `state.profile`. This is a CLI-invocation-
time lookup of the on-disk stored credential, independent of the daemon's own live in-memory
identity (`tick-processor.ts:217` resolves a different, live source each tick). If this lookup
cannot resolve a `NamespaceId` at all — `getStoredAnalyticsCredentials` finds nothing, or
`forwarderIdentity` returns `null` (`spool-io.ts:164-174,168`; `codemie-auth-helpers.ts:199-200,
269-275`) — `classification_unreachable` does not fire for any session, matching the existing
`forwarderIdentity` `null` → no identity → no namespace precedent already relied on elsewhere in
this codebase. A credential change (profile login, token refresh) shortly before the daemon's next
tick can leave this on-disk lookup briefly stale relative to the identity the daemon is actually
ticking under; there is no channel for the CLI status path to read the daemon's live identity to
detect or correct that, so this is accepted as a momentary false-negative window, never resolved by
guessing (see Decisions, Non-goals).

`summarizeSession`/`summarizeSpoolDelivery` (`delivery-summary.ts`) gain a new boolean,
`classificationUnreachable`, computed the same way `mismatchHeld`/`sendFailed` are (OR'd across all
sessions, for either qualifying hold reason), taking the resolved capability as an input rather
than re-resolving it per session. `collectDeliveryHealth`'s existing precedence chain gets this
reason appended last — after `credentials_expired` → `auth_rejected` → `identity_mismatch` →
`send_failed` — since it is the weakest-evidence signal (no failed send attempt exists at all) and
must never mask a stronger one.

No change to `evaluateSessionEvidence`, `tick-processor.ts`'s write path, `policy-cache.ts`'s
`refreshPolicy`, or any `status.holds`/`status.delivery` write. Everything added is a read-only
consumer of state that already exists.

## Decisions

- Reuse `policy-cache.ts`'s existing read-only `getPolicyState` over `refreshPolicy`, to keep the
  new code strictly read-only and never trigger a network probe from a status command.
- Resolve the single active `NamespaceId` once per `collectDeliveryHealth` call, via the same
  credential-lookup helpers (`getStoredAnalyticsCredentials` + `forwarderIdentity` + `state.profile`)
  the file already uses for the auth marker, over re-deriving it per session — the daemon serves
  exactly one identity/namespace at a time.
- When this lookup cannot resolve a `NamespaceId` at all, `classification_unreachable` does not
  fire for any session, over firing on a best-effort/fallback identity — matching the existing
  precedent that `forwarderIdentity` returning `null` means no identity, no namespace, no reason.
  A false negative here is acceptable; a false positive is not.
- Accept a bounded, momentary false-negative window (up to roughly one `OTLP_SEND_INTERVAL_MINUTES`
  tick, default 2 minutes) immediately after a credential change, over attempting to detect or
  correct a stale/mismatched identity read from disk against the daemon's live in-memory
  identity — no channel exists for the CLI status path to read that live identity, and guessing at
  a correction risks the false positive this task must avoid.
- Flag both `publication_contract_unavailable` and `organization_encoding_unsupported` combined
  with non-`'evidence'` capability, over flagging `publication_contract_unavailable` alone, after
  re-checking the earlier exclusion's premise against `classifySession`'s actual order
  (`tick-processor.ts:118-128`, `org-encoding.ts:49-51`): a never-answered backend
  (`state.policy === null`) also produces `organization_encoding_unsupported` — before the
  contract-advertisement check is ever reached — for any organization whose name needs header
  encoding. That is the identical unreachable-backend precondition, not "never ambiguous" as first
  assumed; the same capability guard disambiguates both reasons the same way.
- Exclude `publication_stopped` from the new reason entirely, over reading the stop-marker's own
  `reason` field to try to tell a consent-revoked stop apart from an expired-stall absorption — that
  third signal is outside the two (`status.holds.session.since`, policy-cache `capability`) the task
  licenses reusing; left as a documented residual risk instead of guessed.
- Flag immediately on the qualifying hold, no minimum dwell/debounce window, matching the existing
  `send_failed`/`identity_mismatch` precedent of flagging on first occurrence.
- Treat the pre-existing `send_failed` false positive on backend-configured 503 "hold"-disposition
  reasons (`project_analytics_not_enabled`, `personal_storage_unsupported`, `destination_unsupported`,
  `publication_contract_unavailable` as `destination_hold`) as a flagged-but-not-fixed separate issue,
  per the task's own recommendation — not conflated with this task's scope.
- New reason placed last in `collectDeliveryHealth`'s precedence chain, after `send_failed`, since it
  is the weakest-evidence signal and must not mask a stronger existing one.
- Proceed with this design despite its proximity to the reverted `not_delivered`/`undeliveredSince`
  design, rather than hold off or narrow further — user confirmed, same problem space but a
  different shape (no new persisted field, reuses only the two named existing fields, narrows via
  explicit non-goals below). — user

## Acceptance Criteria

1. A session held `publication_contract_unavailable` **or** `organization_encoding_unsupported`
   whose namespace's policy-cache capability has never recorded `'evidence'` →
   `codemie proxy status` / `proxy analytics status` report `Delivery: unhealthy` with reason
   `classification_unreachable`, distinct from `send_failed`'s label/remedy.
2. The same two hold reasons with capability `'evidence'` (reachable-but-old backend / operator
   rollout pause, or a reachable backend that genuinely cannot encode this org name) → `Delivery`
   stays whatever it would otherwise be (healthy/unknown) — no false positive.
3. When the active profile's `NamespaceId` cannot be resolved (`getStoredAnalyticsCredentials` +
   `forwarderIdentity` find no identity for the stored, on-disk credentials) →
   `classification_unreachable` never fires for any session, regardless of hold state — treated as
   insufficient evidence, matching the existing `forwarderIdentity` `null` precedent.
4. No change to `evaluateSessionEvidence`, any `tick-processor.ts` write, `policy-cache.ts`'s
   `refreshPolicy`, or any `status.holds`/`status.delivery` write — verified by inspection/tests
   touching only `delivery-health.ts`, `delivery-summary.ts`, and a new read-only call into
   `policy-cache.ts`'s `getPolicyState`.
5. `classification_unreachable` only applies when none of `credentials_expired`, `auth_rejected`,
   `identity_mismatch`, `send_failed` already apply.
6. `DELIVERY_REASONS` gets an exhaustive new entry (label + optional remedy) for
   `classification_unreachable`; the `Record<DeliveryReason, ...>` typing keeps this
   compile-time-enforced.
7. `delivery-health.test.ts` / `delivery-summary.test.ts` gain coverage for: the stalled case under
   each of the two hold reasons (AC1), the reachable-but-old-backend/genuinely-unsupported-encoding
   non-flag case for each (AC2), and the no-resolvable-identity non-flag case (AC3).

## Non-goals

- Fixing the pre-existing `send_failed` false positive on backend-configured 503 "hold" reasons
  (`project_analytics_not_enabled`, `personal_storage_unsupported`, `destination_unsupported`,
  `publication_contract_unavailable` recorded as `destination_hold`) — flagged as a known, separate,
  already-shipped issue; recommend a follow-up ticket.
- Detecting the stall that `publication_stopped` absorbs after a `publication_contract_unavailable`
  hold reaches the 24h retention bound (`tick-processor.ts:146-150`) and self-converts to a stop
  marker — left undetected; see Open Risks.
- A last-successful-delivery timestamp or any stall-duration UI — carried over non-goal from the
  original EPMCDME-16086 spec.
- Any change to the forwarder's send/retry/hold decisions or the hot write path
  (`spool-io.ts`/`session-status.ts` write side) for any OTLP connector.
- A minimum dwell/debounce window before reporting the new reason.
- Detecting or correcting a stale/mismatched identity in the new check's on-disk credential lookup
  relative to the daemon's live in-memory identity. A momentary false-negative immediately after a
  profile login or credential refresh (bounded to roughly one tick interval, default
  `OTLP_SEND_INTERVAL_MINUTES` = 2 minutes) is accepted as a known limitation; the check is designed
  to never fire on a mismatched/stale identity's policy-cache state (no false positive is
  acceptable), only to possibly under-report briefly in that narrow window.

## Open Risks

- `publication_stopped` can still silently absorb a genuinely stalled `publication_contract_unavailable`
  hold after 24h; this change does not close that path. A session that stalls, then ages past
  retention, reports `classification_unreachable` for ~24h and then goes silent again under
  `publication_stopped`.
- The pre-existing `send_failed` false positive on backend-configured 503 holds remains unfixed and
  continues to undermine trust in that reason.
- Round-3's revert rationale for the earlier `not_delivered`/`undeliveredSince` design is
  unrecoverable from this repo; the user confirmed proceeding with this differently-shaped design
  regardless.
