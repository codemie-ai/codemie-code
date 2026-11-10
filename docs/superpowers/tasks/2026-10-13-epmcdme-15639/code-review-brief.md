# Code review — 2026-10-13-epmcdme-15639 (2026-10-14)

**approve** · confidence: high · 10/10 prior findings resolved · 0 unresolved · 0 superseded
Coverage: targeted verifier ✓ (10/10 blocking findings graded)

## Finding status (vs. prior round's CR-001..CR-010)

- CR-001 resolved — `docs/CONFIGURATION.md:127` now carves out the Claude tier fields, matching `docs/COMMANDS.md`
- CR-002 resolved — `src/agents/plugins/claude/claude.plugin.ts:505` keeps the live active model, `[1m]`-suffix normalized on both sides
- CR-003 resolved — `src/agents/plugins/codex/codex-models.ts:528` appends the active model when missing from the filtered set
- CR-004 resolved — `src/agents/plugins/opencode/opencode-model-configs.ts:770` and `codex-models.ts:521` now log a fallback warning (AC22)
- CR-005 resolved — 5 new integration tests pin the real call sites (OpenCode `beforeRun`, Codex `setupProxy` x3, Pi `fetchAndBuildPiModels`, Claude `[1m]` keep-case, `models-switch-prompt` render)
- CR-006 resolved — `src/cli/commands/models.ts:148` wraps the tier-refresh in try/catch; tested with a network-failure case
- CR-007 resolved — `src/cli/commands/setup.ts:293` isolates per-model install failures, still saves the profile with the models that succeeded
- CR-008 resolved — `promptForModelsSelection` now delegates to extracted `promptForManualOrSearchModel`/`promptForActiveModel` helpers
- CR-009 resolved — `src/cli/commands/setup.ts:646,667` extends the `models` array with the custom/Ollama-searched id before re-rendering
- CR-010 resolved — `promptForActiveModel` (`setup.ts:545`) now defaults to the profile's actual active model when still checked

## Checked and clean

commit-format ✓ · security ✓ · code-quality ? unverified (carried forward partial — not re-audited this round, no standards agent dispatched on code-review.check)

No new findings — this is a targeted verifier for the prior round's findings only; see `code-review-check.local.json` for the full business/standards review carried forward.
