# Code review — 2026-08-25-profile-provider-decoupling (2026-08-25)

**approve** · confidence: high · 0 blocking · 6 resolved · 0 unresolved
Coverage: blind ✓ · edge-case ✓ · acceptance — n/a (check round) · verification-gap — n/a (check round)  (2/2 lenses ran)

## Finding status

- CR-001 resolved — `statusline.mjs` now reads `codeMieUrl` from `config.workspace` and `userEmail` from the top-level field; regression test added
- CR-002 resolved — `types.test.ts` literal split into a `ProviderProfile` object and a separate `WorkspaceConfig` object
- CR-003 resolved — `migrate()` guards on `hasWorkspaceFields` before writing `workspace`, mirroring `saveProfile`/`initProjectConfig`; test added citing CR-003
- CR-004 resolved — decision recorded: `applyProjectOnly` retained by design (prevents cross-profile credential leakage); `spec.md`'s AC revised to match, consistent with the unchanged code
- CR-005 resolved — `resolveWorkspace`/`removeUndefined` now guard against an explicit `workspace: null`
- CR-006 resolved — `workspaceSource` computed dynamically (`project`/`global`); the previously-pinned wrong-label test replaced with two correct per-scope tests

## New findings

None. The confirmation pass returned 3 blind + 3 edge-case candidates (hand-edited null/malformed `workspace` values, a benign double-read race in `--show-sources` labeling); all were checked against current source and dismissed — either already handled (`resolveWorkspace`'s global branch uses `??`, covering null) or below the new-finding bar (not security/public-API/data-loss/build-runtime-correctness).

See `code-review-check.json` for full detail.
