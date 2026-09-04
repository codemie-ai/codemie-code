# AC4 — `ERR_USE_AFTER_CLOSE` on kill: investigation result

**Acceptance criterion:** "Killing during prompt does not produce readline lifecycle crash."

**Verdict: exercised and passing.** 12 of 12 runs reached the interactive re-auth prompt and were then interrupted; none produced `ERR_USE_AFTER_CLOSE` or any readline lifecycle error.

This supersedes two earlier verdicts in this document ("cannot reproduce", then "precondition not constructible"). Both were wrong, and both were wrong for the same reason: the test environment, not the product. See *Why the earlier attempts failed*.

## Result

Harness: `node-pty` (a real pty, so `stdin.isTTY === true`), isolated `CODEMIE_HOME` per run holding only a copy of the config — **no credentials**, which is what makes `validateAuth` fail and the prompt appear. Interrupt delivered once `Re-authenticate now?` is actually on screen.

| Mode | delay after prompt | `ERR_USE_AFTER_CLOSE` | exit |
|---|---|---|---|
| Ctrl-C (`\x03`) | 0 / 300 / 1500 ms | none | code 0, no signal |
| `SIGINT` | 0 / 300 / 1500 ms | none | code 0, signal 2 |
| `SIGTERM` | 0 / 300 / 1500 ms | none | code 0, signal 15 |
| `SIGHUP` | 0 / 300 / 1500 ms | none | code 0, signal 1 |

**Prompt reached: 12/12. Readline crashes: 0.**

The ticket hedges with "*can* crash", so this is evidence of non-reproduction on this build and platform (macOS, Node v24.19.0) — not proof the failure mode is impossible everywhere. But it is now a real negative result, obtained with the criterion's precondition genuinely satisfied, rather than an absence of testing.

### Incidental finding, not AC4

**Ctrl-C at the prompt exits with code 0.** Conventionally an interrupt at a prompt should exit non-zero (130 by convention). A script that runs `codemie sdk …`, has the user hit Ctrl-C at the re-auth prompt, and checks `$?` would conclude the command succeeded. Out of scope here; worth its own ticket.

## Why the earlier attempts failed

Every earlier run in this investigation was executed from a shell that **CodeMie itself had launched** (`CODEMIE_AGENT=claude`, `CODEMIE_CLIENT_TYPE=codemie-claude`). That parent session exports provider settings into the environment:

```
CODEMIE_PROVIDER=anthropic-subscription
CODEMIE_AUTH_METHOD=manual
CODEMIE_PROFILE_CONFIG={"name":"default","provider":"anthropic-subscription",…}
```

`ConfigLoader` gives `process.env` precedence over both the global and the project-local config file (`utils/config.ts`), so **every probe ran as `anthropic-subscription`, never as `ai-run-sso`** — regardless of which config file was planted in the isolated `CODEMIE_HOME`.

The `anthropic-subscription` provider has no `validateAuth` and no `promptForReauth`. So `promptReauthentication` hit its final `throw` immediately, and the run terminated long before any prompt could appear. Traced directly:

| | polluted env | env cleaned |
|---|---|---|
| `config.provider` | `anthropic-subscription` | `ai-run-sso` |
| `setupSteps.validateAuth` | `undefined` | `function` |
| `setupSteps.promptForReauth` | `undefined` | `function` |
| `validateAuth(config)` | not called | `{valid: false, error: 'No SSO credentials found for …'}` |
| `isNonInteractiveEnvironment()` | — | `false` |
| Reaches `promptForReauth`? | **no** | **yes** |

Clearing every `CODEMIE_*` variable except `CODEMIE_HOME` before spawning is what fixed it.

**Consequence for the superseded recipe.** A previous draft proposed planting credentials whose `apiUrl` points at a closed port so `validateAuth` would fail deterministically. That was never needed: **absent** credentials already produce `{valid: false}` via the `No SSO credentials found` branch, which is enough to reach the prompt. The recipe was solving a problem that did not exist, because the real blocker was environmental.

## Retracted claims

Four, kept on record so nobody re-derives them. All four were **environment or harness artifacts misread as product behaviour** — the recurring failure mode of this investigation.

1. **"73 MB ora escape-sequence flood."** Not real. 1 470 bytes under a real pty. Only appears under `script(1)`, which yields a pty with no usable `stdout.columns`, breaking ora's line-clearing arithmetic.
2. **"Case C proves a TTY hang on the prompt."** Not the prompt. The same `script` invocation still hangs 25 s against the *fixed* build, while `script` around an immediately-exiting child returns in 0 s. The capture stalls at `⠋ Loading configuration...`, before credentials are read, with a stray `^D` — an immediately-EOF stdin forwarded into the pty.
3. **"The spinner suppression in this MR mitigates AC4."** False. Suppression is gated on the environment being non-interactive, so it cannot fire in a scenario that requires a TTY. This was the sole justification offered for shipping without AC4 and did not survive inspection.
4. **"The re-auth prompt is unreachable from `codemie sdk …`."** False, and the most misleading of the four, because it questioned the ticket's premise on the strength of a polluted environment. The prompt is reachable, reliably — 12/12.

**Methodological notes for the next person:**

- Use `node-pty` (already a dependency, wrapped by `tests/helpers/pty-session.ts`) for anything TTY-dependent. `script(1)` injects its own stdin and terminal geometry and produced two of the four artifacts above.
- When testing CLI behaviour from inside a CodeMie-launched agent session, **strip `CODEMIE_*` from the child environment**. `CODEMIE_HOME` isolates configuration files but not the environment variables that outrank them.

## Recommendation

AC4 can be marked **verified** on this build, citing the table above, rather than deferred.

Two follow-ups, neither blocking this MR:

1. **Ctrl-C at a prompt exits 0** (see above) — its own ticket.
2. If the reporter can still reproduce `ERR_USE_AFTER_CLOSE`, the missing variable is platform or Node version, not the scenario — this investigation now covers the scenario. Ask for OS, Node version, and the exact command.
