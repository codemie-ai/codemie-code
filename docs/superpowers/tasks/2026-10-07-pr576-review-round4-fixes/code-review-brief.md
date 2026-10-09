# Code review — 2026-10-07-pr576-review-round4-fixes (2026-10-07)

**request-changes** · confidence: high · 8 blocking · 2 deferred · 16 filtered as noise
Coverage: blind ✓ · edge-case ✓ · verification-gap ✓ · acceptance ✓  (4/4 lenses ran)

## Look here first

- `src/cli/commands/install.ts:180` — [other: backwards compatibility] `--supported` on a lagging mirror prompts "Reinstall with the latest release?" but installs the minimum, which can downgrade the agent — CR-003
- `src/cli/commands/install.ts:130` — [other: lagging mirror] plain `install claude/codex` installs the below-minimum `latest` that the launch gate then refuses — CR-002
- `src/cli/commands/setup.ts:787` — [other: version gate] setup shows a green "installed" line for a Claude version below the minimum — CR-005
- `src/utils/npm-registry.ts:117` — [security] an invalid npm proxy setting silently sends the lookup direct, bypassing the configured proxy — CR-007
- `docs/superpowers/tasks/2026-09-22-agents-live-version-check/spec.md` — [other: spec] spec §2 does not describe the install-the-minimum path — CR-001

## Also flagged

- `src/utils/npm-registry.ts` — [infra] the user's .npmrc `cafile`/`ca`/`strict-ssl` settings are ignored, so lookups fail behind TLS-intercepting proxies — CR-008
- `src/cli/commands/install.ts:213` — [other: copy] `install opencode|pi --supported` blames disabled checks or npm, and no test covers it — CR-004
- `src/cli/commands/update.ts:63` — [other: tests] no test for a failed built-in agent lookup now reported as LOOKUP_FAILED — CR-006

## Checked and clean

commit-format ✓ · code-quality ✓ · security ✓ · 2 deferred → code-review-deferred.md
