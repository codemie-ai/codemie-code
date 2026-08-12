# CodeMie run ledger — Pi extension

`index.js` is copied verbatim into `<piAgentDir>/extensions/codemie-metrics/` before every
`codemie pi` run and loaded by Pi's own extension discovery. It records which transcript files the
run produced so `onSessionEnd` can read a fact instead of inferring one.

## Why this exists

Pi names its transcripts itself, writes them lazily, and can produce several per run (`/new`,
`/fork`, `--session` into another project). Working out afterwards which files belong to the run you
just launched is guesswork — a concurrent `pi` in the same directory produces files that are
indistinguishable by id, mtime, or `parentSession` lineage. Eight review rounds of increasingly
careful heuristics kept yielding the same class of defect, and the failure mode is not lost metrics
but **uploading a stranger's prompts and tool output under this user's session**.

Inside Pi the question is not hard: `ctx.sessionManager.getSessionFile()` is the transcript being
written. This extension appends that, plus every session transition, to a ledger.

## Layout — why a directory and not a single file

Pi's discovery accepts `extensions/*.js` and `extensions/*/index.js` (upstream
`core/extensions/loader.ts:597-599`, `:610-638`). A bare `.js` file would inherit its module system
from the nearest `package.json` on the *user's* disk, where a CommonJS context would make
`export default` a syntax error. Shipping a directory lets `package.json` declare
`{"type":"module"}` next to the code, so Pi's jiti loader and CodeMie's pre-flight `import()`
self-test resolve it identically. `.mjs` would sidestep this too but is rejected by
`isExtensionFile`.

## The hard constraint

**Any extension load failure makes Pi call `process.exit(1)`** — bad import, factory throw,
non-function export — in every mode (upstream `main.ts:893-899`). A mistake here kills the user's
coding session, which is much worse than collecting nothing. Hence, in `index.js`:

- node builtins only; nothing from `@earendil-works/*`, not even `import type`
- the whole factory body, and every handler body, wrapped in `try/catch`
- never subscribes to `tool_call` (a throwing `tool_call` handler *blocks the tool*)
- handlers return `undefined`, so the `input` handler cannot alter what the user typed
- synchronous appends, each individually guarded
- only parsed command *names* are recorded — never prompt or argument text

`pi.extension.ts` additionally runs a pre-flight `import()` of the materialized copy and deletes it
if it does not export a function, so a corrupted asset degrades to "no metrics" rather than "no
session".

## Ledger format

`~/.codemie/sessions/<CODEMIE_SESSION_ID>_pi-run.jsonl`, append-only, one JSON object per line. The
path arrives as `CODEMIE_PI_LEDGER`, so this file holds no assumptions about CodeMie's layout — no
env var, no subscriptions.

| `t` | Fields |
|---|---|
| `boot` | `pid` |
| `session` | `reason`, `file`, `piSessionId`, `cwd`, `prevFile`, `mode` |
| `cmd` | `kind` (`skill`\|`prompt`), `name` |
| `shutdown` | `reason`, `file`, `target`, `piSessionId`, `cwd`, `mode` |

`cwd` is `sessionManager.getCwd()` — the *transcript's* cwd, which is what `--session <path>` runs
under, not the directory the wrapper was launched from.

`file` may name a path Pi has not written yet: `_persist` only flushes once the session holds an
assistant message. Consumers must filter on existence.

## Disabling

`CODEMIE_PI_EXTENSION_DISABLED=1` — the extension registers nothing, and `ensurePiCodeMieExtension`
removes the materialized copy.
