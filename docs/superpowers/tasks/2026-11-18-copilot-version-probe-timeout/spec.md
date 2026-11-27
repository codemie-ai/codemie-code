# Bound the Copilot and base-class version probe - Spec

**Ticket**: EPMCDME-16976 (GitHub issue #539) · **Repo**: codemie-code only · **Size**: M (17/36)
Cite code by symbol; ticket line numbers are stale.

## Problem

`CopilotCliPlugin.getVersion` and `BaseAgentAdapter.getVersion` call `exec(cliCommand, ['--version'])` with no options. `exec` (`src/utils/exec.ts`) arms a timer only when `options.timeout` is set, spawns with stdio `'pipe'`, and never writes to or closes stdin. `codemie list` and `codemie update` await the probe, so one stuck child freezes the command (and, in `list`, every later agent).

Reported in #539 on macOS: the `copilot` on PATH is the old VS Code Copilot Chat shim (`/bin/sh` -> `copilotCLIShim.js`). With no real CLI it asks `Install GitHub Copilot CLI? [y/N]` via `readline.question` and waits on stdin forever.

Reproduced 2026-11-18 on Windows 11 / Node 24.12 with an emulated old shim (Jira comment of that date): a real fake `copilot.exe` that prints the prompt and calls `Console.In.ReadLine()`. On v0.15.0 (commit c8d7432f), `codemie list` printed the agent list up to the OpenWiki entry and stopped, with no output or error, still running after 60 s, and the fake `copilot.exe` alive as its child. This confirms the root cause: no timeout and an open stdin pipe in both `getVersion` methods. Limits of this reproduction: it is an emulation of the old shim. The real old shim (`globalStorage/github.copilot-chat/copilotCli/copilot`, `copilotCLIShim.js`), the reporter's macOS setup and Node 26 are untested. The trigger is environment-specific: it needs a `copilot` that prompts on stdin.

Not a trigger: the newer VS Code Rust shim (`copilot-shim\copilot.exe` v0.1.2.0) exits 127 at once and does not hang; `codemie list` took about 4 s with it.

Today `exec` on timeout sends one `child.kill()` (SIGTERM) and rejects. It does not escalate, close stdin, or destroy the pipes. A child that ignores SIGTERM and keeps stdout open therefore keeps the CLI's event loop alive after the command has printed (the AC6 failure).

## Approach

1. **Both probes pass the same bounded options**: a 5 s timeout plus the hardening below. The Copilot override does not call `super`, so each of the two call sites changes. A timeout rejection is already swallowed by the existing `catch` into `null` ("version unknown"), so no caller changes and nothing new is printed.
2. **Hardening lives in `exec()` as opt-in options, default off.** `ExecOptions` gains `closeStdin?: boolean` and `killGraceMs?: number`. With neither set, `exec` behaves byte-for-byte as today, so callers using 300000 ms timeouts, `interactive: true`, or no timeout are unchanged (NG4).
   - `closeStdin: true` spawns with stdin `'ignore'` (/dev/null, NUL on Windows) so prompts read EOF. Ignored when `interactive` is set.
   - `killGraceMs` (used with `timeout`): when the timer fires, reject once, send SIGTERM, then after the grace period send SIGKILL if the child has not closed. In both steps also destroy the child's stdout and stderr and call `child.unref()`, so a child that holds the pipes open cannot keep the CLI alive. The grace timer is not unref'd, so the CLI sends the SIGKILL before it exits. The wait added to exit is at most `killGraceMs`.
   - The promise settles exactly once. A later `close` or `error` does nothing.
3. **One shared constant** for the probe options (`timeout: 5000`, `closeStdin: true`, `killGraceMs: 500`), exported from `src/utils/exec.ts` and imported by both call sites from `utils/exec.js`. The Copilot plugin imports `exec` from `utils/processes.js`, which re-exports it from `exec.ts`; it keeps that import, and only the constant comes from `exec.js`. Tests mock `utils/processes.js` (it supplies `exec`) and do not mock `utils/exec.js`, so the constant stays real and the assertions on the options passed to `exec` are meaningful.

## Acceptance criteria

- AC1: With a `copilot` on PATH that never answers `--version`, `codemie list` finishes within the limit, shows Copilot as installed with no version, and lists every other agent. (story AC1)
- AC2: With the same command, `codemie update` finishes within the limit, skips Copilot, and still checks the other agents. (story AC2)
- AC3: An agent that uses `BaseAgentAdapter.getVersion` and does not answer is bounded the same way. (story AC3)
- AC4: If `--version` answers within the limit, the version is parsed and reported exactly as today. (story AC4)
- AC5: A timed-out probe prints no new error, stack trace or warning. The output equals today's output for an unknown version, including the "Could not check ... for updates" line. (story AC5)
- AC6: When the probe child ignores SIGTERM and never closes stdout, the CLI process exits within the limit plus a short margin (`killGraceMs` plus process teardown). The child is SIGKILLed and the pipes are released. (story AC6)
- AC7: The extra wait for one agent in `codemie list` is at most the limit. (story AC7)
- AC8: A probe child that prompts on stdin gets EOF immediately, so it exits instead of waiting. Both probes pass `closeStdin`.
- AC9: Every other `exec` caller is unchanged. Without the new options, `exec` spawns with the same stdio, sends the same single SIGTERM, and has the same rejection messages.

## Non-goals

- Verifying what the real VS Code Copilot Chat shim does beyond the emulated reproduction above. (story NG1)
- Making Copilot "installed" detection stricter (`commandExists`). (story NG2)
- Bounding the codex, gemini, claude and kimi probes, the doctor checks, `client-version-cache`, `mcp/index`, and `commandExists`. Follow-up in the PR description (owner to be named by the requester). (story NG3)
- A default timeout, or any default behaviour change, in `exec()`. (story NG4)
- Parallel agent checks in `codemie list`. (story NG5)
- Process-group kill (`detached` plus `kill(-pid)`). See open risks.
- A configurable timeout (env var or setting).

## Decisions

- 5 s timeout over another value: the most common probe limit in the repo (`BaseFrameworkAdapter`, `native-installer`). (story D1)
- A timeout is treated as "version unknown" with no new message, over a new warning, because every caller already handles `null`. (story D2)
- The base class is bounded as well as Copilot. (story D3)
- Codex, gemini, claude and kimi are left out; they are a follow-up. (story D5) — user
- A genuine but slow Copilot (cold start over 5 s) is reported as "version unknown". The 5 s was not measured against a real `copilot --version`. (story D4)
- A slow probe on a loaded Windows laptop (over 5 s) lets the launch gate proceed with an unknown version, accepted over lengthening the limit or adding a retry. — user, answers AR-1
- Close stdin on both probes (`closeStdin`) over timeout-only: a cheap second defence the issue reporter asked for, and the Windows reproduction suggested checking stdin handling. It lets a prompting shim exit on EOF without waiting for the timer, and it supports AC6. The cost is a small new opt-in `exec` option. Recommended and applied.
- Hardening is opt-in `exec` options over a probe-local spawn helper: AC6 needs `spawn` internals (SIGKILL, pipe destroy, unref) that only `exec` can reach, and a second spawn path would duplicate its Windows handling. Default-off keeps other callers unchanged.
- SIGKILL escalation after a 500 ms grace over a single SIGTERM: Windows `child.kill()` already terminates hard, but on POSIX a child can ignore SIGTERM.
- Process-group kill is not included over adding it: the `/bin/sh -> node` chain behaviour is an untested hypothesis, and `detached` changes terminal and signal semantics. Stdin EOF plus pipe destroy plus `unref` release the CLI even if a grandchild lingers.
- Shared exported constant over two inline literals: both probes must stay in step, and the repo's inline-literal convention would have meant two copies of three values.
- Tests mock `utils/processes.js` (`exec`), per `.ai-run/guides/testing/testing-patterns.md`, over mocking `utils/exec.js`. The `exec` tests themselves use real throwaway child processes.

## Tests (Vitest, in scope by explicit request)

- Copilot plugin (new file under `src/agents/plugins/copilot-cli/__tests__/`): `vi.mock('utils/processes.js')`. Asserts `exec` is called with the probe options; parsed version on success; `null` on rejection (a timeout error) and on a non-version output fallback as today.
- `BaseAgentAdapter.test.ts` (already mocks `processes.js`): same assertions for the base `getVersion`.
- New `src/utils/__tests__/exec.test.ts`, with small `node -e` children: the timeout rejects once; SIGKILL follows for a SIGTERM-ignoring child; a child that holds stdout open does not keep the test process alive; `closeStdin` gives a stdin-reading child EOF; no options means an unchanged result (AC9).

## Verification (Windows fake-.exe harness, built on the reproduction)

The prompt fake below is the same emulation that reproduced the hang on v0.15.0 (a `csc.exe`-built `copilot.exe` that prints the prompt and calls `Console.In.ReadLine()`), so it first confirms the hang on an unfixed build and then the fix. Point `CODEMIE_COPILOT_BIN` at each fake, or put its folder first on PATH (the value is read at module load, so set it before launching `codemie`):

1. **Prompt fake**: prints `Install GitHub Copilot CLI? [y/N]` and calls `ReadLine()`. Expected: `codemie list` finishes, with the probe done within the timeout (EOF makes it exit at once), where the unfixed build stalled after the OpenWiki entry. Copilot is shown with no version, the other agents are listed, and no leftover fake process remains. Also check stdin handling: the fake sees EOF, not an open pipe.
2. **Stubborn fake**: ignores termination requests, never closes stdout, never reads stdin. Expected: the `codemie` process exits within 5 s plus a short margin, and the fake is gone (killed). `codemie update` skips Copilot and checks the others.
3. **Fast fake**: prints `copilot 1.2.3` to `--version`. Expected: the version is shown as today.

The Windows emulation is an established reproduction of the root cause, not only a test harness. Still not verifiable here: macOS, the real old extension shim (`copilotCLIShim.js`), Node 26. Record them as unverified in the PR.

## Open risks

- The reproduction is an emulation of the old shim on Windows 11 / Node 24.12. The real old shim, the reporter's macOS setup and Node 26 are untested, and the trigger is environment-specific (a `copilot` that prompts on stdin).
- Accepted (AR-1, user): on a loaded Windows laptop a probe slower than 5 s makes the launch gate proceed with an unknown Copilot version.
- The macOS shim chain (`/bin/sh` -> node) is untested. If SIGKILL reaches only `sh`, a grandchild node may linger. The CLI still exits, because the pipes are destroyed and `unref`'d.
- Windows `.cmd` or `.ps1` shims under `shell:false` are unverified (technical analysis); the harness uses `.exe`.
- A 5 s limit may mark a slow genuine Copilot as unknown (D4).
- `list` probes serially, so N hung agents cost N times the limit. Only Copilot and the base class are bounded, and NG5 rules out parallelism.
- The sibling plugins `copilot-cli-otlp` and `copilot-chat-otlp` were not traced to see if they inherit `getVersion`. The planner must check.

## Revision history

Round 2: Problem now records the Windows emulated reproduction per the last Jira comment; AR-1 accepted by the user.
