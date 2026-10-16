# Deferred from code review — 2026-10-07-pr576-review-round4-fixes (2026-10-07)

- **checkAndInstallClaude has no test** — `src/cli/commands/setup.ts:787` — The first-run setup branch for an installed Claude changed its isNewer output and its timeout, and no test reaches checkAndInstallClaude. Pre-existing: the original task explicitly excludes adding a checkAndInstallClaude test from this round.
- **Kimi update routed through npm** — `src/cli/commands/update.ts` — updateAgent special-cases only Claude for the native installer, so a live-tracked Kimi update falls through to npm installGlobal. Pre-existing: the original task names "Kimi update via npm" as a pre-existing item deferred last round.
