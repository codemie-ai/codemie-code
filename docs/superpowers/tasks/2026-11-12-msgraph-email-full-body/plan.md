# msgraph email --read full HTML body Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `msgraph.js emails --read ID` prints the whole stripped HTML body instead of truncating at 2000 chars (EPMCDME-16964).

**Architecture:** One-line removal of `.slice(0, 2000)` in the `args.read` branch. Regression test runs the script as a child process with a CommonJS `-r` preload that patches `https.request` (Graph goes through `httpsRequest`, line 70, not `fetch`) and a temp `HOME` holding a fake token cache.

**Tech Stack:** Node CommonJS script, Vitest (`cli` project, `tests/integration/`).

**Spec:** none; requirements inline (ticket EPMCDME-16964). Technical analysis: `technical-analysis.md` in this directory.

Commit per task using the repository's existing convention (Conventional Commits; ticket id EPMCDME-16964 in the body; no Co-Authored-By line; if a scope is rejected by commitlint use one already in git log). Stage by explicit path only; never stage `.codemie/codemie-cli.config.json`. Run only the new test file, with `HOME` and `CODEMIE_HOME` pointed at a fresh temp dir.

## Acceptance criteria

- An HTML email body longer than 2000 chars (e.g. 8500) is printed in full by `emails --read`.
- The text-body branch and the other `.slice` calls (Teams previews, list columns) are unchanged.
- SKILL.md is unchanged.

## Task 1: Regression test and fix

**Files:**
- Create: `tests/integration/msgraph-email-read.test.ts`
- Modify: `src/agents/plugins/claude/plugin/skills/msgraph/scripts/msgraph.js:617`

**Test-first:** yes — HTML body of 8500 chars returned by the stubbed Graph is printed in full; fails today because output is cut at 2000 chars.

- [ ] **Step 1: Write the failing test** in `tests/integration/msgraph-email-read.test.ts`, modelled on `tests/integration/hook-stdout.test.ts` (`spawn`, `mkdtempSync` temp dir, strip `NODE_ENV`/`VITEST` from env, ~20 s timeout). Setup per test: temp `HOME` containing `.ms_graph_token_cache.json` = `{"access_token":"fake","expires_at":<now+3600 epoch seconds>,"username":"x"}`; a preload file `stub.cjs` written to a separate temp dir that replaces `require('node:https').request` with a fake returning a Graph message JSON (`subject`, `from.emailAddress`, `receivedDateTime`, `isRead`, `body: {contentType:'html', content:'<p>' + 'a'.repeat(8500) + '</p>'}`). Read `msgraph.js` lines ~70-125 (`httpsRequest`/`graphGet`) first to match the response events/status the fake must emit. Run `node -r <stub.cjs> <msgraph.js> emails --read MSG1` with `env.HOME` and `env.CODEMIE_HOME` set to the temp dir. Assert exit code 0 and that stdout contains `'a'.repeat(8500)`.
- [ ] **Step 2: Run to verify RED:** `HOME=<fresh tmp> CODEMIE_HOME=<fresh tmp> npx vitest run --project cli tests/integration/msgraph-email-read.test.ts`. Expected: FAIL on the length assertion (not on a stub or auth error; if it fails for another reason, fix the harness first).
- [ ] **Step 3: Fix** `msgraph.js:617`: drop `.slice(0, 2000)` so the line is `console.log(body.contentType === 'text' ? body.content : stripHtml(body.content || ''));`. Touch nothing else in the file.
- [ ] **Step 4: Run to verify GREEN:** same command. Expected: PASS.
- [ ] **Step 5: Mutation check:** temporarily restore `.slice(0, 2000)`, rerun, confirm exactly this new test fails, then remove it again and rerun to confirm PASS.
- [ ] **Step 6: Commit** the two files by explicit path (e.g. `fix(skills): ...`).

## Negative-constraint pass

- "No SKILL.md change": no task touches SKILL.md.
- "Not fetch" (preload must patch `https.request`): honored in Task 1 Step 1.
- "Never run full npm test suite / real ~/.codemie": single-file run with temp HOME and CODEMIE_HOME in Steps 2, 4, 5.
- "No Co-Authored-By; don't stage local config": header and Step 6.
