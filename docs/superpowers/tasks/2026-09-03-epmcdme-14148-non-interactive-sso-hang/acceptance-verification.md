# EPMCDME-14148 — final acceptance verification

Full re-verification of all four acceptance criteria against the branch head, run end-to-end through `bin/codemie.js` exactly as the ticket's *Steps to Reproduce* describe.

**Result: 4 / 4 pass.**

## Why this re-run exists

The first pass at AC1 and AC2 was executed from a shell that CodeMie itself had launched, which exports `CODEMIE_PROVIDER=anthropic-subscription` and `CODEMIE_PROFILE_CONFIG`. `ConfigLoader` gives `process.env` precedence over both config files, so those runs resolved to the wrong provider — the same pollution that produced the four retracted claims in `ac4-investigation.md`. They happened to pass anyway (the message originates in `sdk-client.ts`, which is provider-agnostic), but a criterion verified under the wrong provider is not verified.

A second, subtler harness bug had to be fixed first: the shell here is **zsh**, which does not word-split an unquoted `$VAR`, so `env $FLAGS …` passed all 38 `-u` flags as a single argument and stripped nothing. Environment cleaning is therefore done inside Node, not in the shell.

## Conditions

Matching the ticket's preconditions:

- **No valid SSO session** — a throwaway `CODEMIE_HOME` per run, holding a copy of the config and **no credentials**. The real `~/.codemie` is never touched.
- **Non-interactive stdin** — `stdio: ['ignore', …]` for the AC1/AC2 runs.
- **Clean environment** — every `CODEMIE_*` except `CODEMIE_HOME` deleted from the child env, so provider resolution comes from config (`ai-run-sso`), not from the parent agent session.
- Interactive cases use `node-pty` (a real pty), never `script(1)` — see the methodological note in `ac4-investigation.md`.

## AC1 — "Non-TTY stdin skips interactive prompt"

| Check | Result |
|---|---|
| `Re-authenticate now?` absent from output | ✅ |
| Completes without hanging | ✅ 964 ms |
| **Control:** same command *with* a TTY does prompt | ✅ prompt at 604 ms |

The control is the part that matters. Without it, AC1 passes trivially whenever anything else terminates the run early — which is precisely how the earlier investigation fooled itself. With a TTY the prompt appears; without one it does not; the only difference is the TTY, so the `isNonInteractiveEnvironment()` guard is demonstrably what skips it.

Detection matcher is the exact inquirer question `Re-authenticate now?`. An earlier draft matched `/authentication required/i`, which also matches the legitimate error text `SSO authentication required` and produced a false "prompt appeared".

## AC2 — "CLI exits non-zero with clear remediation"

| Check | Result |
|---|---|
| Exit code non-zero | ✅ `1` |
| Message names `codemie setup` | ✅ |
| No stack trace (`^\s+at\s`) | ✅ |
| No leaked `ConfigurationError:` prefix | ✅ |
| No `Node.js v…` crash banner | ✅ |
| stdout free of the diagnostic | ✅ |

Emitted on stderr:

```
❌ SSO authentication required. Please run "codemie setup" with SSO provider first.
```

## AC3 — "Optional `--non-interactive` or `--ci` behavior is supported **or** documented"

| Check | Result |
|---|---|
| No flag registered in `src/cli/index.ts` | ✅ deliberate — EPMCDME-13953 recorded it out of scope |
| Absence documented in `AUTHENTICATION.md` | ✅ |
| Boundary documented (pty-allocating runners) | ✅ added by this MR |

Satisfied through the "or documented" limb. This MR strengthens it: the page previously claimed stdin-TTY detection was sufficient for CI, which overstated it — a `docker run -t` runner still reaches the prompt. That limitation is now stated explicitly, with JWT auth given as the unattended path.

## AC4 — "Killing during prompt does not produce readline lifecycle crash"

| Check | Result |
|---|---|
| Prompt genuinely reached before interrupting | ✅ 3/3 |
| `ERR_USE_AFTER_CLOSE` | ✅ none |

A broader sweep — 4 signal modes × 3 delays — is recorded in `ac4-investigation.md`: **12/12 reached the prompt, 0 crashes.**

The ticket hedges with "*can* crash", so this is a negative result on this build and platform (macOS, Node v24.19.0), not proof the failure is impossible everywhere. It is now a real negative result, with the precondition genuinely satisfied.

## Out of scope, worth its own ticket

**Ctrl-C at the prompt exits with code 0.** Conventionally an interrupt should exit non-zero (130). A script checking `$?` after the user interrupts would conclude the command succeeded. Unrelated to the four criteria; not fixed here.
