# EPMCDME-16849 CLI connect flow: local handoff

Branch `EPMCDME-16849_cli-connect-flow`, baseline `916710fbeb309fcaf07fb412c2e08b9711eb1755`. Local commits only; nothing pushed, no MR, no merge, no Jira write.

## Revision-bound review record
- Reviewed code head: `60252f5561f7dab48cccbe0bf1021d5d1b7742ef` (`code-review.local.reviewed-head`). The fix-up delta over `4c783b4d` was verified by an independent reviewer against the frozen diff (sha256 `4cd8a8e8…3b3220`) plus `publication-review.test.ts` (sha256 `d04db7a4…09ca7c`); the committed delta matches both. Later commits on the branch add planning/handoff documents only.
- `code-review.check`: approved for local completion. IR-001 (consent reconnect incarnation) and IR-002 (stop-marker monotonicity) closed by independent final-delta verification.
- Actual complexity: L 25/36 (initial XL 27). Scored from file paths and diffstat. The Jira score/comment was NOT written (recorded `skipped`); owed at publication.

## QA (Stage 7), kept as recorded
- license-check, lint, typecheck, build: exit 0 at `60252f55`.
- Scoped unit run (4 changed directories): exit 1, 3 failed / 2519 passed / 2 skipped. `gate-run.json` status stays `BLOCKED`; it is not converted into a pass.
  - `codex-desktop.test.ts` "returns null when no candidate path exists": reproduced on exact baseline `916710fb` (single test, exit 1, same installed-package path received): accepted as an unrelated baseline exception.
  - Two 30 s timeouts (`claude-code-otlp.transitions`, `connect-wiring`): passed 29/29 on an isolated rerun; load-related, not baselined.
- `validate:secrets` scanned nothing in the QA run (no staged changes). Full suite, E2E harness and PG14/17 were not rerun after the fix-up.
- Prior real E2E (PG17, 45/45) predates the IR-001/IR-002 fix; the fix is covered by unit tests, the reviewer regressions and the live run below.

## Live manual validation (scoped, accepted)
Source: `evidence/live/manual-result.md`, `logs/manual-final-check.txt` (20 hook captures, all exit 0), `logs/manual-final-sessions.json`. Live Claude Code through the worktree `codemie-claude` launcher on `--profile claude-personal`, real local daemon, backend router/ingestor and PG17; synthetic CodeMie auth and application directory.
- Old session: started in `work`, in-session `cd` to `other` (PostToolUse cwd=other). The user saw exactly one pause notice; Claude kept answering; marker `stop=true reason=folder_changed`; stored rows did not grow afterwards (project `work-proj/linked_folder`).
- `/clear`: a distinct new session with `source=clear` started in `work`, received answers, published (16 rows under `work-proj/linked_folder`), no second notice; final SessionEnd captured.
- Interactive `cd` then `/clear` boundary: the new session's cwd was the launch folder `work`.
- Notice visibility: shown to the user once. Model-context separation: the verbatim-text probe answered `NONE`; the notice is stored as `hook_success`/`hook_system_message` attachments, with 0 occurrences in user/assistant messages. **Boundary:** this supports separation but is not proof of the complete outbound model request, which was not inspected.
- Fixture limitation: the interactive auxiliary CodeMie auth opened the stub's `/v1/auth/login/...` route (404); the user cancelled with Escape and validation continued. Production authentication was not verified and no product auth change is included.

## Still required / accepted limitations
- Formal security sign-off by a responsible reviewer before merge, with the `X-CodeMie-*` header attribution called out as CRITICAL in the MR description (CR-008).
- Commit subjects carry the ticket key; cleanup at publication/squash, no history rewrite now (CR-016).
- Not verified: auth variants U5/U6; real backend authentication/application directory (stubbed); the 200-discard response is synthetic; model-request header stripping is unit-tested only; the unbaselined timeouts; the global CLI was self-updated to 0.16.5 during E2E development (previous version unknown), and one early live-setup call used the global `codemie` against the scratch home only.
- Not done: push, MR, merge, Jira write (score and PBI comment).
