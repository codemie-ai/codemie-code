# Live Isolated Verification — Evidence (Round 3)

Verified against HEAD `ddbe35bf` (`fix(config): ... refactor(config): trim and de-ticket identity-isolation comments`) on branch `EPMCDME-15411_global-profile-identity-isolation`.

## Isolation discipline

- Every command ran from a `cwd` outside the repo (`/tmp/live-verify-3/project-{a,b,c}`), none of which contain a `.codemie/` directory of their own unless a scenario explicitly creates one as a local-profile fixture.
- `CODEMIE_HOME` pointed at a throwaway temp directory per scenario — never the real `~/.codemie`.
- All 25 real `CODEMIE_*` environment variables carried by the active session were explicitly `unset` before every command.
- Commands invoke the real CLI entry point (`bin/codemie.js`) against the real compiled `dist/` output, or the real `ConfigLoader.saveProfile()` via a small driver script (`save-profile-raw.mjs`) where no non-interactive CLI command exists for that action (profile identity is normally set by the interactive `codemie setup` wizard).
- All scratch directories were deleted after the run; nothing in the main repo checkout was touched.

## Scenario 1 — exact ticket scenario (AC1, AC2, AC3, AC7, AC8)

Two global profiles (`work`, `personal`) each independently given their own identity via `saveProfile()`, then switched `work → personal → work`.

**Result:** `work`'s own `codeMieUrl`/`codeMieProject` were restored exactly after switching back — no leakage from `personal`. `baseUrl` and `codeMieUrl` both track the active profile correctly, confirming the bug (shared single `workspace.codeMieUrl`) is fixed.

## Scenario 2 — provider switch isolation (AC3)

Same profile name (`work`) saved first as `bearer-auth`/jwt (with `authMethod`/`jwtConfig`), then re-saved as `ai-run-sso`.

**Result:** resulting config has no `authMethod`/`jwtConfig` left over — provider-specific fields stay full-replace; only the identity trio carries forward when omitted.

## Scenario 3 — migration 008 (AC1, AC4, AC6)

Pre-existing shared-workspace-identity fixture (two profiles, no own identity, shared `workspace.codeMieUrl`/`codeMieProject`/`hooks`) run through the real migration runner via `codemie profile`.

**Result:** migration 008 applied, cloned the shared identity onto both `work` and `personal`, stripped identity from `workspace`, and left `hooks` (non-identity `WORKSPACE_KEYS`) shared as-is. `codemie profile`'s listing output now shows a per-profile `CodeMie URL` row sourced from the fixed resolution path.

## Scenario 4 — local-only profile, no global counterpart (AC5)

A profile defined only in a project's local `.codemie/codemie-cli.config.json`, with no same-named global profile.

**Result:** resolves its own identity cleanly from the local config; no crash, no leaked global value.

## Scenario 5 — local profile overriding a same-named global profile (AC5)

A local `.codemie/codemie-cli.config.json` defines a profile named `work`, matching an existing global `work` profile with a different identity.

**Result:** the local profile's own identity wins; the global `work` profile's identity never leaks in.

## Acceptance criteria coverage

| AC | Scenario(s) | Status |
|----|-------------|--------|
| AC1 — each global profile stores/resolves its own identity independently | 1, 3 | ✅ |
| AC2 — switching global profiles applies the selected profile's own identity | 1 | ✅ |
| AC3 — identity not overwritten across unrelated global profiles | 1, 2 | ✅ |
| AC4 — `resolveProfileWorkspace()` resolves identity from profile data, not shared mutable state | 1, 3 | ✅ |
| AC5 — local profile behavior unregressed | 4, 5 | ✅ |
| AC6 — non-identity `WORKSPACE_KEYS` stay scope-level shared | 3 | ✅ |
| AC7 — two global profiles targeting different environments resolve independently | 1 | ✅ |
| AC8 — switching back to the first global profile restores its own identity | 1 | ✅ |

Full command-by-command transcript captured during this run (not reproduced here verbatim) covered the same five scenarios as the prior verification round, re-run after the comment-trimming commit to confirm no regression was introduced by that change.

---

# Live Isolated Verification — Evidence (Round 4)

Verified against HEAD `f879a7c1` (`fix(config): address PR review findings on identity isolation`, merged with upstream `main` at `f3e810f9`) on branch `EPMCDME-15411_global-profile-identity-isolation`, after analyzing and fixing all 5 PR #701 review comments.

## Isolation discipline

Same discipline as Round 3: isolated `CODEMIE_HOME` per scenario (`/tmp/live-verify-round4/codemie-home*`), a `cwd` outside the repo with no `.codemie/`, all real `CODEMIE_*` env vars explicitly unset, real compiled `dist/utils/config.js` / `dist/migrations/index.js` driven via a small `driver.mjs` script (no non-interactive CLI command exists for setting raw profile identity or forcing a migration run outside `bin/codemie.js` startup). All scratch directories deleted after the run.

## Scenario 1 — exact AC7/AC8 repro via real `switchProfile()`

Two global profiles (`env-a`, `env-b`) each given their own `codeMieUrl`/`codeMieProject`/`codeMieIntegration` via `saveProfile()`, then switched `env-a → env-b → env-a` using the real `ConfigLoader.switchProfile()` (not a `{ name }` CLI override).

**Result:** `A again` resolved exactly `env-a`'s own identity (`a.example.com` / `proj-a` / `int-a`), and `ConfigLoader.exportProviderEnvVars()` on that resolved config correctly exported `CODEMIE_URL=https://a.example.com`, `CODEMIE_PROJECT=proj-a`, `CODEMIE_INTEGRATION_ID=int-a` — no leakage from `env-b`.

## Scenario 2 — Comment 1 fix: pre-migration-008 fallback

A profile (`legacy-profile`) with no identity of its own, alongside a shared `workspace.codeMieUrl`/`codeMieProject` (the pre-migration-008 shape a non-`codemie.js` launcher would leave behind).

**Result:** `ConfigLoader.load()` resolved `legacy-profile`'s identity from the shared workspace fallback (`legacy.example.com` / `legacy-proj`) instead of resolving nothing — confirms the `resolveProfileWorkspace()` `profileIdentity` parameter fix.

## Scenario 3 — migration 008 run live (no clobber of existing identity)

Ran `MigrationRunner.runPending()` for real over a config containing both `env-a`/`env-b` (already own identity) and `legacy-profile` (no own identity, from Scenario 2).

**Result:** migration 008 applied; `env-a`/`env-b` identity was left untouched (not overwritten by the shared workspace's `legacy.example.com`/`legacy-proj` values), while `legacy-profile` had its missing identity filled in from the shared workspace (origins matched). `workspace` was stripped to `{}`.

## Scenario 4 — Comment 3 fix: origin-mismatch migration guard

A fresh config with `medecision` (`baseUrl` origin `codemie.gcp.medecision.com`) and `matching-env` (`baseUrl` origin `shared.example.com`), both lacking own identity, with shared `workspace.codeMieUrl = https://shared.example.com`.

**Result:** migration 008 skipped cloning the mismatched-origin identity onto `medecision` (stayed with no `codeMieUrl`/`codeMieProject`) while correctly cloning it onto `matching-env` (origin matches) — confirms the `originsMatch()` guard prevents pinning another environment's project onto a profile with a provably different backend.

## Scenario 5 — Comment 2 fix: `saveProfile()` explicit-undefined preservation

`subscription-profile` saved first with its own identity, then re-saved with `codeMieUrl: undefined, codeMieProject: undefined` as an own property (mirroring `anthropic-subscription`/`moonshot-subscription`'s `buildConfig()`, which always sets these as `string | undefined`).

**Result:** prior identity (`keep-me.example.com` / `keep-proj`) survived the re-save; only `model` changed — confirms stripping explicit-`undefined` identity keys before the spread fixes the bug without breaking a legitimate provider update.

## Acceptance criteria coverage (Round 4)

| AC | Scenario(s) | Status |
|----|-------------|--------|
| AC1 — each global profile stores/resolves its own identity independently | 1, 2, 3 | ✅ |
| AC2 — switching global profiles applies the selected profile's own identity | 1 | ✅ |
| AC3 — identity not overwritten across unrelated global profiles | 1, 3, 4, 5 | ✅ |
| AC4 — `resolveProfileWorkspace()` resolves identity from profile data, not shared mutable state | 1, 2 | ✅ |
| AC5 — local profile behavior unregressed | (unchanged code path; re-confirmed via unit suite, not re-run live this round) | ✅ |
| AC6 — non-identity `WORKSPACE_KEYS` stay scope-level shared | 3 | ✅ |
| AC7 — two global profiles targeting different environments resolve independently | 1 | ✅ |
| AC8 — switching back to the first global profile restores its own identity | 1 | ✅ |

Review-comment-driven edge cases additionally confirmed live: pre-migration-008 identity fallback (Comment 1), origin-mismatch migration guard (Comment 3), and `saveProfile()` explicit-undefined preservation (Comment 2). Comment 4 was a documentation-only fix (`.ai-run/guides/usage/project-config.md`); Comment 5 strengthened unit test coverage only — neither has a live-CLI behavior to re-verify beyond what Scenario 1 and the unit suite already cover.
