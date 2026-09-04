# EPMCDME-14148 — Reproduction Report

**Baseline:** `codemie-code` @ `1d5cc22b` (origin/main, v0.15.0), branch `EPMCDME-14148`, Node v24.19.0, macOS.
**Isolation:** every case ran with `CODEMIE_HOME` pointed at a throwaway directory. The real `~/.codemie` was never modified; its `credentials` store was verified intact afterwards.

## Verdict

The ticket describes two symptoms. Only one is still live.

| Ticket symptom | Status on main |
|---|---|
| "CLI hangs on a re-authentication prompt" (non-TTY) | **Already fixed** by `5b2de4b7` (PR #471) |
| "exits non-zero with an actionable message" | **Still broken** — exits 1 via an *unhandled exception + raw stack trace*, and the message drops the actionable remediation |
| `ERR_USE_AFTER_CLOSE` on kill | **Not reproduced** — 12/12 interrupts at a genuinely-reached prompt, zero crashes (`ac4-investigation.md`). Case D below was inconclusive and is superseded |
| `--non-interactive` / `--ci` flag | **Does not exist** as a flag, but its absence *is* documented (`docs/AUTHENTICATION.md:113`, added by PR #471) — corrected; an earlier draft of this table wrongly called it undocumented |

The residual defect is not a hang. It is that the non-interactive failure path terminates by letting a `ConfigurationError` escape to Node's default handler.

## Cases

### Case A — no config at all, stdin `< /dev/null`

```
CODEMIE_HOME=<empty-dir> codemie sdk assistants list < /dev/null
```

Exit code **1**, duration **0s** (no hang).

```
- Loading configuration...
✖ No valid SSO credentials found
file:///.../dist/utils/auth.js:65
    throw new ConfigurationError('Authentication expired. Please re-authenticate.');
          ^
ConfigurationError: Authentication expired. Please re-authenticate.
    at promptReauthentication (.../dist/utils/auth.js:65:11)
    at getAuthenticatedClient (.../dist/utils/auth.js:40:36)
    at async Command.<anonymous> (.../dist/cli/commands/sdk/assistants.js:24:24)
Node.js v24.19.0
```

### Case B — valid config present, no SSO credentials, stdin `< /dev/null`

Matches the ticket's stated precondition more closely (config exists, session does not). Exit code **1**, duration **1s**. Output **identical** to Case A, same stack trace, same line.

### Case C — attempted control: same command **with** a TTY (pty via `script`)

Exit code **142** after the 25 s alarm fired.

**This case was originally read as "blocks on the interactive re-auth prompt". That interpretation is wrong** — corrected after the AC4 investigation (see `ac4-investigation.md`):

- Re-running the identical `script` harness against the **fixed** build still hangs for 25 s, so the hang is not the defect this ticket fixes.
- A control (`script` wrapping a child that exits immediately) returns in **0 s**, so `script` does not hang unconditionally.
- The captured output stalls at `⠋ Loading configuration...` — *before* credentials are ever read — and contains a stray `^D`. The re-auth prompt is never reached.
- The same command under a real pty (node-pty) exits in **under 1 s** with the correct message.

Conclusion: the Case C hang is an artifact of the `script` harness (its stdin is an immediately-EOF pipe, which something downstream blocks on), not CLI behaviour. Case C is **not** valid evidence for or against the non-TTY guard.

The guard is still confirmed working — but by `auth-validation.test.ts` and by Cases A/B exiting in 0–1 s without prompting, not by Case C.

### Case D — AC4: kill during the prompt

Ran under a pty and sent `SIGINT` then `SIGTERM`. **No `ERR_USE_AFTER_CLOSE` and no readline lifecycle error** appeared across two attempts.

**Corrected:** an earlier draft described these signals as being sent "while parked on the prompt". That was an assumption, not an observation, and the later node-pty work disproved it — the process exits before any signal is delivered and the prompt is never reached. See `ac4-investigation.md`; the criterion was never exercised.

Incidental observation, **not** confirmed as a product bug: after the interrupt the `ora` spinner emitted a runaway stream of cursor-control escapes (`ESC[1A ESC[0K`), producing a 73 MB capture. This is most likely an artifact of `script` giving the child a pty with no usable `stdout.columns`, which breaks ora's line-clearing arithmetic. It should be re-checked in a real terminal before anyone treats it as a finding.

The ticket hedges with "**can** crash", so AC4 is plausibly intermittent or environment-specific. It is unproven here, not disproven.

## Root cause of the live defect

`src/utils/auth.ts`:

```
getAuthenticatedClient(config)                       // line 22
  └─ getCodemieClient()                              // line 44
       └─ throws ConfigurationError
          'SSO authentication required. Please run "codemie setup" with SSO provider first.'
  └─ catch (line 45): message matches 'SSO authentication required'
       └─ promptReauthentication(config)             // line 47
            └─ handleAuthValidationFailure(...)      // line 68
                 └─ isNonInteractiveEnvironment() === true
                    → prompt correctly skipped, returns false     ← PR #471 working
            └─ falls through to line 76
                 └─ throw new ConfigurationError('Authentication expired. Please re-authenticate.')
                                                                  ← UNCAUGHT
```

Two distinct problems on that last hop:

1. **The throw escapes the command's error handler.** *(Corrected after technical analysis — my first reading of this was wrong.)* `assistants.ts` **does** import and use `handleSdkError` in all six actions. The defect is **statement ordering**: `const client = await getSdkClient();` sits at line 65, *outside and above* the `try {` at line 68, so the try/catch only guards the post-auth API call. The auth throw sails past it to Node's default handler, which prints the raw stack and exits 1. `bin/codemie.js` installs no `uncaughtException` / `unhandledRejection` handler as a backstop. AC "exits non-zero with clear remediation" fails on *clear*, not on *non-zero*.

2. **The actionable text is discarded.** `getCodemieClient` produced the remediation the AC asks for — *"Please run `codemie setup` with SSO provider first"*. `promptReauthentication` throws a **new**, vaguer error at line 76 that overwrites it. The useful string is generated and then thrown away one frame later.

`handleAuthValidationFailure` and `isNonInteractiveEnvironment` are working exactly as designed; the gap is in what happens *after* they correctly decline to prompt.

## Blast radius

**Corrected after technical analysis.** My initial claim that `src/agents/core/AgentCLI.ts` and `src/cli/commands/profile/index.ts` were affected was **wrong** — those call `handleAuthValidationFailure` *directly*, not `getAuthenticatedClient`/`promptReauthentication`, and they already exit cleanly. The uncaught-throw path is narrower than this report first stated.

The actual blast radius is wider in a different direction: the same outside-the-try ordering repeats in **all 8 `src/cli/commands/sdk/*.ts` files, ~50 command actions**. A grep for `try {` within two lines above any `await getSdkClient()` returns zero matches.

There is, however, a **single choke point**: `getSdkClient()` at `src/cli/commands/sdk/utils/cli-utils.ts:15-18` is the sole bridge from all ~50 sdk actions into `src/utils/auth.ts`. Fixing there — plus preserving the message at `auth.ts:76` — follows the shared-gate precedent PR #471 set, instead of 50 mechanical edits.

Note that `handleSdkError`'s `else` branch **already** renders `ConfigurationError` cleanly. So wrapping alone removes the stack trace but still prints the vague message: **both halves must be fixed** to satisfy the AC.

## Acceptance criteria mapped to evidence

| AC | Verdict | Evidence |
|---|---|---|
| Non-TTY stdin skips interactive prompt | **Met already** | Cases A/B exit in 0–1 s without prompting, plus the `auth-validation.test.ts` guard tests. **Not** Case C, which this document retracts as a `script(1)` artifact |
| CLI exits non-zero with clear remediation | **Not met** | Case A/B: exit 1 but raw stack trace; message lacks `codemie setup` |
| `--non-interactive` / `--ci` supported or documented | **Partially met** | No such flag in `src/`, but the absence is documented at `docs/AUTHENTICATION.md:113`. The AC reads "supported **or** documented". Not a clean pass: the documented mechanism (`stdin` TTY only) has a blind spot for pty-allocating CI — now stated explicitly in that doc |
| Kill during prompt produces no readline crash | **Met** | Later verified properly: 12/12 runs reached the prompt under a real pty and none crashed. The earlier "never reached" reading was an artifact of `CODEMIE_*` env vars injected by the parent CodeMie session — see `ac4-investigation.md` |
