# Design: API Key info + JSON output for `codemie proxy status`

**Ticket**: EPMCDME-14308

## Problem

`codemie proxy status` prints human-readable status lines only. It has no way to surface the API key used to authenticate against the local proxy, and no machine-readable output mode for scripting.

## Goals

- Add an "API Key" line to the existing human-readable output.
- Add a `--json` flag that emits the same information as valid JSON instead of the formatted lines.
- Preserve the existing human-readable output byte-for-byte when `--json` is not passed.

## Non-goals

- No change to how the gateway key is generated, stored, or defaulted (`daemon-manager.ts`'s existing `'codemie-proxy'` default is untouched).
- No change to `--deep` behavior or to any other `proxy` subcommand.

## Design

### Human-readable output

Add one new line, `  API Key: ${state.gatewayKey}`, placed after the `Port:` line and before the `Profile:` line:

```
Status:  running, healthy
  URL:     http://127.0.0.1:PORT
  Port:    PORT
  API Key: codemie-proxy
  Profile: default
  Client:  vscode-byok        (if state.clientType is set)
  Project: my-project         (if state.project is set)
  Uptime:  1m 3s
  Note:    last recorded issue — ...   (if applicable)
```

The `Status: stopped` branch (daemon not running) is unchanged — there is no API key to show when nothing is running.

### `--json` flag

New boolean option on the `status` subcommand: `.option('--json', 'emit status as JSON instead of formatted output')`, following the convention already used by `skills list`/`skills find`. The action handler branches near the top: when `options.json` is set, build a plain object and print it via a local JSON-printing call (`console.log(JSON.stringify(payload, null, 2))`, matching the `outputJson()` pattern from `sdk/utils/cli-utils.ts`); otherwise fall through to the existing (unchanged) human-readable branch.

**Stopped:**
```json
{ "status": "stopped" }
```

**Running:**
```json
{
  "status": "healthy" | "unhealthy",
  "apiKey": "codemie-proxy",
  "url": "http://127.0.0.1:PORT",
  "port": 1234,
  "profile": "default",
  "clientType": "vscode-byok",
  "project": "my-project",
  "uptimeSec": 63,
  "level": "shallow" | "deep",
  "reason": "...",
  "lastRecordedIssue": "..."
}
```

Field rules:
- `apiKey` is `state.gatewayKey` (the same value the human-readable branch prints; defaults to `'codemie-proxy'` unless the daemon was started with a custom `--gateway-key`).
- `clientType` and `project` are included only when `state.clientType` / `state.project` are set (omitted otherwise, matching the conditional lines in the human-readable branch).
- `level` mirrors `health.level` (`'shallow'` unless `--deep` was passed and succeeded).
- `reason` is present only when `status: "unhealthy"` (mirrors the `Reason:` line).
- `lastRecordedIssue` is present only in the edge case the human-readable branch already handles: a fresh health check now passes (`health.healthy === true`) but `state.health === 'unhealthy'` with a recorded `state.healthReason` (mirrors the `Note:` line).
- `uptimeSec` is the raw integer seconds (the human branch's `Nh Nm Ns` formatting is display-only and not needed in JSON).

### Testing

No test changes are required unless the user explicitly asks for tests (per AGENTS.md policy). If tests are requested later, extend `src/cli/commands/proxy/__tests__/index.test.ts`'s `describe('proxy status', ...)` block: one case for the new API Key line in the existing exact-string assertions, and new cases for `--json` in the running/stopped/unhealthy branches.

## Risks

- The existing test file asserts exact `console.log` strings for the human-readable branch; adding the API Key line will shift those assertions if tests are touched later. Out of scope for this change unless tests are requested.
- None of the JSON fields introduce new data — everything is already computed by the existing `checkStatus`/`checkProxyHealth` calls, so there is no new failure surface beyond the branch/serialization logic itself.
