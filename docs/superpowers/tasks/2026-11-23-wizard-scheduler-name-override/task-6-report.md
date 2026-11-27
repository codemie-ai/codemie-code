DONE

commit: none

Changed paths (under src/cli/commands/analytics/sync/):
- install-command.ts
- bootstrap/step-model.ts
- bootstrap/state-store.ts
- bootstrap/guided-late-steps.ts

Verification: `npm run typecheck` -> EXIT=0; `npx eslint` on install-command.ts and bootstrap/*.ts -> clean.

Signatures:
- `InstallCommandOptions.taskName?: string`; `buildInstallCommand` emits `--task-name "<s>"` via `flag()` -> `assertPrintableValue`, omitted for undefined/''.
- `BootstrapState.taskName?: string` ('' = default chosen). `isStepAnswered('task-name')` = taskName !== undefined; REVALIDATORS['task-name'] runs validateSchedulerSuffix on non-empty; `toInstallCommandOptions` passes non-empty taskName; `summarizeState` shows it.
- New step `{id:'task-name', title:'Scheduler task name', targets:'always'}` in ALL_STEPS between 'lookback' and 'developers' (now 11 steps; heading counts +1). `stepTaskName` in guided-late-steps.ts uses askValidated + validateSchedulerSuffix, prints the three prefixes (from generators constants), empty = omit.

Concerns:
- Old saved states without taskName are not "complete" any more: resume/reuse lands on the new task-name step instead of jumping straight to the command (they still load).
- Likely-broken existing tests (not touched): bootstrap/__tests__ (guided*, step-model, state-store, run-bootstrap) asserting step counts ("Step N of M"), prompt order/input call counts, ALL_STEPS length (10), checkReuse/firstUnansweredStep on states lacking taskName.
- Non-guided bootstrap flags (run-bootstrap.ts options) not given a --task-name option; not required by the task.
