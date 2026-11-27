# EPMCDME-15955 Implementation Plan: `codemie-opencode -s <id>` resumes a session

**Goal:** `-s` is forwarded to OpenCode for the `opencode` launcher only, and resume tracking recognises it.
**Spec:** `spec.md` in this task dir. Commit per task using the repository's existing convention.
**Test files:** vitest, real Commander parsing with a fake adapter (see `src/agents/core/__tests__/AgentCLI-silent-flag.test.ts`).

## Task 1: Forward `-s` for the `opencode` launcher

**Files:** `src/agents/core/AgentCLI.ts:67-75`, `src/agents/core/__tests__/AgentCLI-silent-flag.test.ts:149-164`

- [ ] Test-first: yes — `codemie-opencode -s ses_x` parsed through `AgentCLI` yields silent off and adapter args `['-s','ses_x']`; currently it yields silent on and `['ses_x']`.
- [ ] In the test file, move `opencode` out of the `describe.each(['claude','opencode'])` block (claude stays silent-on) into the forwarding group with `codex`/`gemini`. Keep a case that `--silent` on opencode still enables silent. Add a case that `opencode-acp -s chat` is still silent with args `['chat']`.
- [ ] Add `'opencode'` to the `agentsWithNativeShortS` list in `getSilentFlags()` (exact name match, so `opencode-acp` is unaffected). Update the JSDoc at `AgentCLI.ts:67-71` to list opencode (native `-s` = session) and to say `opencode-acp` keeps `-s` as silent.

## Task 2: Recognise `-s <id>` in opencode resume detection

**Files:** `src/agents/plugins/opencode/opencode.plugin.ts:625-629` (comment at ~627), `src/agents/core/__tests__/AgentCLI-resume.test.ts` (near 360-475)

- [ ] Test-first: yes — `extractNativeResumeId(['-s','ses_x'])` on the opencode plugin returns `ses_x`, and an `AgentCLI` run of opencode with `-s ses_x` sets `CODEMIE_RESUME_SESSION_ID=ses_x` like `--session ses_x`; currently both give no id. Also assert `--resume ses_x` is unchanged, and that `opencode-acp` with `-s x` is silent and sets no resume id (arch-review plan note).
- [ ] Change the `flagValue(args, ['--session'])` call to `['--session', '-s']`. Rewrite the comment at ~627: `-s` reaches this helper only for `opencode`; for `opencode-acp` (inherits this helper) `-s` is the wrapper's silent flag and never arrives. Leave `codemie-code.plugin.ts:520-524` untouched.
- [ ] Note for codex/gemini (also on the forward list): they have no resume helper using `-s`; the plan note's "per forward-list adapter" check applies to opencode only. State this in the test name or comment.

## Task 3: Real-plugin pass-through, Windows quoting and cwd assertions

**Files:** new `src/agents/plugins/__tests__/opencode-session-flag.test.ts`; assertions only unless a gap shows up. See `BaseAgentAdapter.ts:924-931` for the shell join and `:933-938` for the spawn call.

- [ ] Test-first: yes — with the real opencode plugin metadata, args `['-s','ses_x']` after `enrichArgs` and `transformFlags` still contain `-s ses_x` and no bare `ses_x`; fails if the plugin reorders or rewrites them.
- [ ] Add a unit case that the Windows `shell: true` argument join leaves a `ses_*` id unquoted and unchanged (extract or exercise the existing join logic; do not change its behaviour).
- [ ] Add a case that the spawn options carry no `cwd` override (cwd is spoofed, never `process.chdir`, in vitest).

## Task 4: Document the launcher split

**Files:** `docs/COMMANDS.md` (~379 and ~401)

- [ ] Test-first: no — docs only. State that `-s` is silent for all launchers except `codex`, `gemini` and `opencode`; that `codemie-opencode -s <session-id>` resumes an OpenCode session (`--silent` is the long form for silent); and that `codemie-code` behaviour is tracked in a separate ticket.

## Negative-constraint pass

- NG1 (binary untouched), NG2/NG5 (other launchers incl. `codemie-code`, `opencode-acp`): Tasks 1-2 touch only the `opencode` name; `opencode-acp` is covered by tests; `codemie-code` helper left as is.
- NG3 (`-m` unchanged): no task touches it.
- NG4 (`--resume` unchanged): asserted in Task 2.
- NG6 (bare `ses_x` without `-s`): no task handles it.
- No cwd handling added (Task 3 asserts none); no whole-suite or manual verification tasks (the spec's manual Windows resume is owned by later stages).
- Plan note honored: Task 2 (resume-helper test, acp silent test, comment).
