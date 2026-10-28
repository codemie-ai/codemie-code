DONE
commit: none (artifact not committed)
paths:
docs/superpowers/tasks/2026-10-28-epmcdme-16441-split-by-project/pr-note.md
test_command: none (docs artifact); check: `git status --short` shows the task dir untracked, `git diff --cached --stat` is empty

Notes:
- The note is 41 lines. It ends with the required "Generated with Claude Code" line. A grep for local paths and 8-hex hashes found nothing, and it names no people.
- Facts checked against the branch diff of forwarder.ts, spool-io.ts, session-status.ts and session-project.ts:
  - `groupHookRecords` groups by the lowercased top-level `codemie_project_name`.
  - Unnamed events go to the bound project.
  - A sealed (filtered) batch stays one group.
  - Groups that cannot travel as a header are dropped and counted.
  - The cursor advances only after every group returns `ok`, and the batch stops at the first non-ok result.
  - `isSendAllowed` admits any sendable project for unsealed hooks only.
  - The drop-warning key is `session:project(lowercased):reason`, and the log carries `project`.
  - `BACKEND_DROP_REASONS` is exported.
  - The `status.project ??= projectConflict[0]` guess is removed.
  - Names are read at the top level only.
- The note covers the spec's acceptance criterion 13, and it says the earlier PR-body claims about pinning and rewriting are replaced.
- The "Rollout" section says to restart the daemon after upgrade. This follows from the task brief, not from code I read.
- The working tree also holds other untracked and modified files that belong to other tasks. I did not touch them.
