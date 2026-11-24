DONE
commit: 5e9ef66e
test_command: npx vitest run src/cli/commands/analytics/sync/bootstrap/__tests__/guided.test.ts
paths:
- src/cli/commands/analytics/sync/bootstrap/steps.ts (new)
- src/cli/commands/analytics/sync/bootstrap/guided.ts (replaces Task 6 placeholder)
- src/cli/commands/analytics/sync/bootstrap/__tests__/guided.test.ts (new, 15 tests)
renames: none. BootstrapPrompter not redefined; re-exported from guided.ts via `export type { BootstrapPrompter }` sourced from types.ts.
reused:
- types.ts BootstrapDeps/BootstrapPrompter/BootstrapOptions (not redefined)
- links.ts cleanPaste/parseChannelLink/parseFolderUrl/validateSiteUrl/validateFolderPath/BootstrapInputError
- timezones.ts DEFAULT_TIME_ZONE/resolveTimeZone
- flow-package.ts resolveFlowTemplateDir/writeFlowPackage/FLOW_PACKAGE_FILENAME
- state-store.ts loadBootstrapState/saveBootstrapState/checkReuse/summarizeState
- redact.ts errorMessage (for the resolveFlowTemplateDir failure message)
standards: TDD (RED observed: 14/15 failing against the Task 6 placeholder before implementation; GREEN after); ES modules + .js extensions; no `any`; explicit return types on exports; no console.log (deps.err/out only); project error class (BootstrapInputError) used for retry control flow. Source: AGENTS.md conventions, .ai-run/guides not separately reloaded (task scope was narrow and task-7-brief.md/spec.md were sufficiently binding).
concerns:
- Design choice: start logic's "already imported?" question (no saved webhook) is unconditional/binary (full restart at step 1 vs jump to step 5), matching the collector's literal wizard.js structure and spec.md's "Without reuse, ask..." wording tied to the if/else on webhookUrl presence. It is NOT based on firstUnansweredStep/checkReuse — those are used only in the webhookUrl-present "reuse" branch, per the brief's own `checkReuse().resumeAt` wording and state-store.ts's design (checkReuse can only return resumeAt > 4 when webhookUrl is present). A restart at step 1 still prefills step 1's channel-link input and step 3's time-zone input with the prior saved values; step 2 (folder) has no raw address to prefill (only the derived site/path are saved) so it always starts fresh on a restart — documented in step2Folder's doc comment.
- runStepsFiveThroughEight(deps, state, save, fromStep) is the named placeholder Task 8 replaces; signature carries everything (state, save, target step) so Task 8 should not need to change the call site in runGuided.
- Full bootstrap test suite (6 files, 79 tests) still green; tsc --noEmit and eslint on the 3 changed/added files are clean.
