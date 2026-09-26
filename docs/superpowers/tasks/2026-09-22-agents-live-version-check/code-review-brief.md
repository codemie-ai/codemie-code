# Code review — 2026-09-22-agents-live-version-check (2026-09-22)

**approve** · confidence: high · 0 blocking · 7/7 prior findings resolved
Coverage: targeted verifier ✓ (7/7 blocking findings graded)

## Checked and clean

All 7 prior blocking findings verified resolved against current source:

- CR-001 (Cache refresh ignores versionChecks toggle) — resolved: both `doctor --refresh-versions` and `update --force-refresh` now gate on `isVersionChecksEnabled()` before touching the cache.
- CR-002 (Setup version-check race drops notice) — resolved: `CLAUDE_VERSION_CHECK_TIMEOUT_MS = FETCH_TIMEOUT_MS + 2000` gives the outer race margin over the inner lookup's own timeout.
- CR-003 (Newer-version copy inverted) — resolved: `isNewer` branch now reads "ahead of the recommended vX" instead of "a newer version is available".
- CR-004 (Force-refresh wipes entire shared cache) — resolved: `clearVersionCache()` calls removed from `update.ts`; `forceRefresh` now threads through to a per-package scoped `getCachedLatestVersion(pkg, { forceRefresh })`.
- CR-005 (Claude up-to-date copy deleted, not reworded) — resolved: `isLiveTrackedAgent`-specific "already up to date — no newer version available" message, applied uniformly across all five allowlisted agents.
- CR-006 (Concurrent cache writes race) — resolved: `enqueueCacheWrite()` serializes writes and re-reads the cache inside the queue instead of a stale pre-fetch snapshot.
- CR-007 (extractVersion silently accepts prerelease tags) — resolved: `src/utils/version-utils.ts` itself is untouched (not in `changed_files`), but the only live-lookup call site (`version-resolution.ts`) now guards with `PRERELEASE_SUFFIX_PATTERN` and falls back before `extractVersion()` ever sees a prerelease string.

No new findings raised — this round verifies only prior ids per its targeted-verifier scope.
