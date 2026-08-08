# FIX REPORT — round-7 session-attribution review

Source: `pi-session-attribution-review.md` (7 findings). All seven were verified against the code
and against upstream Pi at `~/TS/github/pi` @ `6fb2d766a`; every cited `file:line` was accurate and
every mechanism reproduced. Five are fixed. Two are deliberately declined and recorded in the design
doc instead.

## Fixed

### F1 (P1) — timing accepted a transcript with no proof of ownership

`src/agents/plugins/pi/pi.session.ts`

The single-survivor fallback ran for *every* ambiguous case, which contradicted the round-6 report's
own claim that "timing never accepts a transcript on its own". Two reachable paths:

- **Identity published, anchor absent.** Upstream is stricter than the review stated: `_persist`
  (`session-manager.ts:1015-1027`) writes nothing until the session holds an assistant message, and
  `newSession()` only computes the filename (`:947`). So *any* run that ended before its first reply
  leaves no anchor, `findAnchor` fails, and the run was treated as identity-less.
- **Anchor present, concurrent CodeMie run present.** A competing UUIDv4 root suppressed the
  adopt-all shortcut but then fell into the same fallback, where the other run's sole `/new` was the
  lone survivor and got adopted.

Timing is now gated on `!identityPublished`: a run that never named a session (`--continue`, bare
`--resume`) may still claim a lone in-window candidate, because a second writer would have touched a
file of its own. Once an identity *was* published, an unmatched transcript is someone else's by
elimination, so the run reports nothing. The missing-anchor case logs at debug so it is diagnosable
rather than silent.

### F2 (P1) — adopt-all trusted a directory it could not prove was private

`src/agents/plugins/pi/pi.session.ts`

The round-6 justification — "a bare `pi` cannot land here, CodeMie uses a project-local agent dir" —
does not hold when `sessionDir` is set in `<cwd>/.pi/settings.json`. That file is Pi's *project*
settings (`settings-manager.ts:201`, `sessionDir` declared `:131`, applied `:675`) and is read
independently of the agent dir, so bare `pi` and `codemie pi` share one directory. The foreign
transcript carries a UUIDv7 like any `/new` file, so `concurrentRuns` stayed empty and adopt-all
claimed it — uploading another process's prompts and tool output under the CodeMie session.

Adopt-all now additionally requires a directory no other Pi process can write to. CodeMie's per-cwd
default under `<cwd>/.pi/codemie/agent` qualifies; anything the operator named (`--session-dir`,
`PI_CODING_AGENT_SESSION_DIR`, or settings) does not. The signal is `isCustom`, already returned by
`resolvePiSessionDir` and now threaded through the discovery scope.

**Accepted cost:** a run using a named session directory no longer claims its own `/new`
transcripts. Silent loss is the right trade against uploading a stranger's transcript, and it only
applies to the configuration that made the directory ambiguous.

### F3 (P2, reported P1) — path-selected sessions were discovered under the wrong cwd

`src/agents/plugins/pi/pi.session.ts`

Confirmed upstream: `resolveSessionPath` treats an argument containing a separator or ending
`.jsonl` as a path (`main.ts:259-263`), `SessionManager.open` takes the cwd from the file's header
(`:1546`), and the runtime uses `sessionManager.getCwd()` (`main.ts:703`, `:844`). Discovery stayed
pinned to the wrapper's `process.cwd()` and `collectCandidates` rejects foreign-cwd headers, so
`codemie pi --session /other/repo/x.jsonl` produced zero metrics — and `findAnchor`'s path branch was
unreachable for the case it was written for.

New `resolveDiscoveryScope()` returns the directories to scan plus the cwd candidates must declare.
When the published identity is an existing transcript path it follows the file: scan its directory
under its header's cwd, plus the configured directory when one was named explicitly (Pi writes
`/new` there instead of beside the opened file). Regraded to P2 — silent loss, not misattribution.

### F4 (P2) — a globally-resolved `--session <id>` left no anchor

`src/agents/plugins/pi/pi.session.ts`

Confirmed: `main.ts:402-408` forks with no `sessionId`, so `forkFrom` mints a fresh UUIDv7 and
records `parentSession` as the source path (`session-manager.ts:1601-1617`). The published id
therefore never appears as a header id.

`findAnchor` gained a fourth tier: a candidate whose `parentSession` file name contains
`_<identity>`. Pi names transcripts `<timestamp>_<id>.jsonl`, so the underscore anchors the match at
the id boundary and descent from the named session becomes proof. This also removes a regression F1's
gating would otherwise have introduced — before the fix the global-fork run was rescued by the
single-survivor fallback that F1 closes.

### F6 (P2) — session-directory path forms diverged from Pi

`src/agents/plugins/pi/pi.paths.ts`

Pi's `normalizePath` (`utils/paths.ts:75-101`) rewrites Windows shell paths, expands `~`, then
converts `file://` URLs via `fileURLToPath`, and `getSessionDir()` applies it to the settings channel
too. `expandTildeAndResolve` handled only `~` and documented the rest as out of parity — but the
divergence is not benign: the CLI flag reaches Pi verbatim while the derived value drives discovery,
so `--session-dir file:///tmp/pi-sessions` had Pi writing to `/tmp/pi-sessions` while discovery
scanned `<cwd>/file:/tmp/pi-sessions`.

`expandTildeAndResolve` now applies the same three transforms in Pi's order, with a ported
`normalizeWindowsShellPath` and a fallback to plain resolution when `fileURLToPath` rejects the URL.

## Declined

### F5 (P3, reported P2) — session flags in value positions

Real: Pi's parser assigns `args[++i]` with no leading-`-` guard (`args.ts:95-96` and every other
value-taking branch; only `--print` and `--list-models` check), so `--system-prompt --continue` makes
`--continue` the prompt value while `hasSessionSelectionFlag` still sees it. Reachable through
CodeMie, since `allowUnknownOption()` puts both tokens into the operand list in order.

Not fixed. The remedy is a copy of Pi's value-taking flag table inside CodeMie, which rots silently
the next time Pi adds an option — a maintenance cost out of proportion to a pathological command
line whose consequence is degraded attribution rather than wrong data. Recorded in design §9.1 and
§12.

### F7 (P3, reported P2) — unkeyed processor state

The mechanism is stated correctly: `AgentRegistry` holds one static `PiPlugin` (`registry.ts:41`) and
`hook.ts:334` uses its adapter, so the activity-window bounds would leak across sessions. But no Pi
path processes two sessions in one process — `onSessionStart` returns early on the empty transcript
path, `onSessionEnd` fires once, and Pi has no reconciliation loop of the kind
`codex.reconciliation.ts:144-160` runs. The review also named only half the state: `seenEntryIds`
(same commit, same lifetime) has the identical property.

Not fixed: adding a reset for a caller that does not exist. Recorded in design §12 with the
conditions that would make it live.

## Verification

No test in the repo covers `PiSessionAdapter`, so a throwaway harness drove the real
`discoverSessions()` against fabricated session directories — seven scenarios, including two
regression guards (plain run keeps its `/new` history; identity-less `--continue` still claims a lone
candidate). At `HEAD` the two guards passed and five scenarios failed exactly as predicted: F1a and
F2 adopted a foreign transcript, F1b adopted the other run's `/new`, F3 and F4 returned nothing. All
seven pass after the fix. The harness was not added to the suite, per the project's tests-on-request
policy.

`npm run lint`, `npm run typecheck`, `npm run build` clean.
`npx vitest run tests/integration/metrics tests/integration/session` — 96/96 pass, unchanged.

## Residual

- An identity-less run (`--continue`, bare `--resume`) that produces nothing itself, concurrent with
  another run that produces exactly one transcript, still adopts that transcript. Closing it needs an
  identity the run never established. The window is strictly narrower than before, since timing no
  longer applies to identity-published runs or to anchor-plus-competitor cases.
- Runs sharing a named session directory claim only anchor and lineage, dropping their own `/new`
  transcripts (see F2).
- Pi still prints a yellow stderr warning on every plain run, because the injected `--session-id`
  never pre-exists. Inherent to the identity-anchor design.
