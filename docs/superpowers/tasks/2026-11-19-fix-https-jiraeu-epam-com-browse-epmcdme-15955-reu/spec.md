# Spec: `codemie-opencode -s <session-id>` resumes an OpenCode session (EPMCDME-15955)

Source: `story.md` (approved, architecture review intent 2026-11-17), `technical-analysis.md`.

## Problem

`AgentCLI` registers `-s, --silent` for every launcher except `codex` and `gemini` (`src/agents/core/AgentCLI.ts:72-75`). For `codemie-opencode -s ses_X`, Commander consumes `-s` as the silent flag and the ID reaches the `opencode` binary as a bare positional, which OpenCode reads as a project directory (the reported "Failed to change directory" error comes from the OpenCode binary, not from this repo). The launcher's own `--resume <id>` already maps to `-s <id>` (`opencode.plugin.ts:232-237`) and works.

## Behavior

1. For the launcher named `opencode` only, `-s` is no longer registered as a short form of `--silent`. It is forwarded to OpenCode untouched together with its value, in original order, and the process cwd is not changed. (story AC1, AC2, AC5)
2. `--silent` (long form) still enables silent mode for `codemie-opencode`. (story AC6)
3. Every other launcher keeps `-s` as silent, including `opencode-acp` and `codemie-code`. (story AC7, NG2, NG5)
4. Resume tracking: the opencode plugin's `extractNativeResumeId` also recognises `-s <id>` (and `-s=<id>` is not required), so a run started with `-s ses_X` sets `CODEMIE_RESUME_SESSION_ID` and goes through the same ownership check as `--session ses_X` and `--resume ses_X`. (story AC3)
5. Runs without `-s`, with `--resume`, `--session`, `--continue`/`-c`, or `--task` behave exactly as before. (story AC4)
6. Docs: `docs/COMMANDS.md` (around lines 379 and 401) states which launchers treat `-s` as silent (all except `codex`, `gemini`, `opencode`), that for `codemie-opencode` `-s <session-id>` resumes a session, and that `codemie-code` behaviour is tracked in a separate ticket. (story AC8)
7. Update the comments at `opencode.plugin.ts:627` and the `AgentCLI.ts:67-71` JSDoc, which currently say `-s` never reaches opencode / list only codex and gemini. The `codemie-code.plugin.ts:520-524` helper is left as is.

## Implementation shape

Extend the existing name list in `getSilentFlags()` with `opencode` (existing mechanism, exact adapter-name match; `opencode-acp` is a different name and is not matched). Extend `extractNativeResumeId` in `opencode.plugin.ts:626-629` to look for `['--session', '-s']`. `flagValue` already handles the `<flag> <value>` form (`flag-transform.ts:128-141`). No new option, no cwd handling, no other plugin changed.

## Tests (required by story AC9; this run overrides the repo's tests-on-request rule)

- `AgentCLI-silent-flag.test.ts:149-164`: remove `opencode` from the `describe.each(['claude','opencode'])` block that expects `-s` = silent; add `opencode` to the forwarding group with `codex`/`gemini`; assert `-s ses_x` yields silent off and args `['-s','ses_x']`; keep `--silent` on opencode asserting silent on; keep claude `-s` asserting silent; add `opencode-acp` still silent.
- Through the real opencode plugin (not the fake adapter alone): the args after `enrichArgs`/`transformFlags` contain `-s ses_x` and no bare `ses_x`.
- Windows quoting: for the `shell: true` argument join at `BaseAgentAdapter.ts:924-931`, a `ses_*` id is neither quoted nor altered (unit-level, no real Windows needed).
- `AgentCLI-resume.test.ts` (near lines 360-475): `-s ses_x` populates `CODEMIE_RESUME_SESSION_ID` like `--session`; `--resume ses_x` unchanged.
- Cwd: assert the spawn call carries no `cwd` override (cwd is spoofed, not changed, in vitest).

## Acceptance criteria

See story AC1-AC9; this spec carries all of them (story AC1, AC2, AC3, AC4, AC5, AC6, AC7, AC8, AC9).

## Non-goals

- Changing the OpenCode binary or its treatment of a bare positional (story NG1).
- Launchers for other agents, including `codemie-code` (story NG2; see D5).
- `-m, --model` short flag (story NG3).
- New resume features or changes to `--resume` (story NG4).
- `codemie-opencode-acp` (story NG5).
- A bare session ID without `-s`, `codemie-opencode ses_x` (story NG6).

## Decisions

- D1: `opencode` joins the `-s` opt-out list over a metadata-driven flag or a new option, because the list is the existing exact-name mechanism. — proposed by PO, AR-2 (story D1)
- D2: `codemie-opencode` only; `codemie-opencode-acp` excluded (story D2).
- D3: No compatibility shim for callers using `-s` as silent on opencode; non-TTY is auto-silent and `--silent` remains (story D3).
- D4: Acceptance is "OpenCode receives exactly `-s <id>`" via tests plus one manual Windows resume before closing, because the binary cannot be run here (story D4).
- D5: `codemie-code` built-in agent is not changed here; separate ticket. — user
- D6: Extend `extractNativeResumeId` with `-s` over leaving `-s` undetected, so resume tracking matches `--session`.
- D7: Document the launcher split in `docs/COMMANDS.md` over a code-only change (story AC8).

## Open risks

- OpenCode binary and v2 behaviour on `-s <id>` is unverified here; one manual Windows resume is needed.
- `extractNativeResumeId` is inherited by `opencode-acp`; there `-s` still means silent so it never reaches the helper, but the comment should say so.
- Users who typed `codemie-opencode -s` interactively for silent mode now get it forwarded to OpenCode.
