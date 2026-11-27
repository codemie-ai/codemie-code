# EPMCDME-16959 Sounds audio player detection Implementation Plan

**Goal:** `checkAudioPlayer()` must detect installed players on Debian/WSL by using `commandExists()` instead of `exec('command', ['-v', ...])`.

**Conventions:** Work on current branch, no new branches. Commit per task using the repository's existing convention (commitlint `<type>(<scope>): <subject>`, scope `agents`; ticket only in footer `Refs: EPMCDME-16959`; body ends with "Generated with AI" and "Co-Authored-By: codemie-ai <codemie.ai@gmail.com>"; no `--no-verify`; no push, no PR). English only.

**Negative constraints:** negative-constraints pass: (1) scope is audio player detection only -> Task 1 touches only `checkAudioPlayer` and its import; other `exec('command', ...)` uses: none found in non-test src. (2) macOS afplay behavior unchanged -> afplay stays first in the list; covered by Task 1 test. (3) Do not rewrite the existing test -> Task 1 only adds cases. (4) No whole-suite gate tasks (owned by the calling flow).

### Task 1: Delegate player detection to commandExists

**Files:**
- Modify: `src/agents/plugins/claude/sounds-installer.ts:10` (drop the `exec` import, it has no other use in the file; add `import {commandExists} from '../../../utils/processes.js';`)
- Modify: `src/agents/plugins/claude/sounds-installer.ts:25-38` (loop body)
- Modify: `src/agents/plugins/claude/__tests__/sounds-installer.test.ts` (extend only)

Test-first: yes — existing failing test "should find an installed player when `command` has no binary (Linux/WSL-Debian)" (red: expected null to be 'success').

- [ ] Step 1: Confirm the existing test is red.
- [ ] Step 2: In the loop, replace the `await exec(...)` try/catch with `if (await commandExists(player)) { logger.debug('Audio player found', {...}); return player; }`, and log `'Audio player not available'` (player, feature) otherwise. `commandExists` never throws and returns a boolean, so success must be decided by the boolean, not by "did not throw". Keep the final "No audio players found" debug and `return null` unchanged. Keep the `error` field out of the debug call (no error is caught anymore).
- [ ] Step 3: Extend the test file with two cases inside the existing `describe`, reusing its mocks: (a) all `commandExists` calls resolve false -> `installSounds()` resolves `null`; (b) `commandExists` true for every name -> result is `'success'` and the first call was with `'afplay'` (`commandExistsMock.mock.calls[0][0]`), proving macOS preference order.
- [ ] Step 4: Mock sufficiency is verified: after detection, `installSounds` only calls `mkdir` (mocked), `getCodemiePath` (mocked), `ora` (mocked) and `console.log` (spied), so no additional fs mocks are needed. The `exec` mock in the test file may stay (harmless, with the module no longer importing it).
- [ ] Step 5: Run `npx vitest run src/agents/plugins/claude/__tests__/` (the whole claude plugin test directory, including `sounds-installer.test.ts`) and confirm green; run `npm run lint` to confirm no unused-import warning.
- [ ] Step 6: Commit (include the previously untracked test file): `fix(agents): ...` subject describing player detection via commandExists, per the conventions above.
