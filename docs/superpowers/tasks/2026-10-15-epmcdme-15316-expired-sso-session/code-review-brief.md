# Code review — 2026-10-15-epmcdme-15316-expired-sso-session (2026-10-15)

**request-changes** · confidence: low · 2 blocking · 1 deferred · 5 filtered as noise
Coverage: blind ✓ · edge-case ✓ · verification-gap ✗ failed · acceptance — n/a (no spec)  (2/3 applicable lenses ran)

The verification-gap lens's declared output file does not exist on disk, so that lens's coverage is unverified for this round — treat edge-case/consequence coverage as incomplete alongside blind and edge-case's own findings.

## Look here first

- `src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts:59` — [auth] expiry check has no clock-skew tolerance against the IdP-issued `expiresAt`; a slow local clock lets the original `<synthetic>`-turn bug recur in the gap window — CR-001
- `src/providers/plugins/sso/proxy/plugins/sso-session-expiry.plugin.ts:62` — [auth] no try/catch around `readBody`/`markAnalyticsAuthInvalid`/`startDetachedSsoLogin`; a rejection silently falls back to the pre-fix raw-302 behavior with only a generic hook-error log — CR-002

## Also flagged

(none)

## Checked and clean

commit-format ✓ · code-quality ✓ · security ✓ (na, no documented checklist) · 1 deferred → code-review-deferred.md
