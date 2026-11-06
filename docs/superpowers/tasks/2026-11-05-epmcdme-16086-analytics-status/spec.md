# EPMCDME-16086 — Analytics delivery health in proxy status

## Problem

`codemie proxy status` reports `running, healthy` while CLI Analytics (OTLP spool) delivery is stopped. Daemon health and analytics delivery health must be reported separately, by both `proxy status` and `proxy analytics status`.

## Requirements

### 1. Delivery-health collector

One tool-agnostic module, used by both commands, that never throws. It reads the OTLP spool, the analytics auth marker and the daemon `/health` reply, and returns:

```ts
interface DeliveryHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  reason?: 'credentials_expired' | 'auth_rejected' | 'identity_mismatch' | 'send_failed';
  pendingBytes: number;
}
```

Unhealthy when any rule below applies. The first rule that matches sets `reason`:

1. `credentials_expired`: the daemon `/health` reply reports `analytics.credentials: 'stale'`.
2. `auth_rejected`: the analytics auth marker applies. The filtering is the same as the auth gate's (`sso.auth-gate.ts:51-96`): markers detected before the latest sign-in are dropped, and the marker is matched against the daemon's recorded profile and its URLs.
3. `identity_mismatch`: a session with pending data is held with `holds.session.reason === 'analytics_endpoint_mismatch'` (the daemon's analytics URL does not match the credentials' identity, `tick-processor.ts:136`). No other hold reason affects health.
4. `send_failed`: a stream has a live delivery-failure record, using the forwarder's liveness check (`liveDelivery`, `delivery-state.ts:18`).

When no rule applies and the `/health` reply has no usable `analytics.credentials` (an older daemon, no reply, or a malformed field), `status` is `unknown` instead of `healthy`.

`pendingBytes` is the sum of unsent bytes (size − cursor) across all spool streams.

Reason codes are stable identifiers, not display strings. Every label map keyed by reason is typed `Record<Reason, string>`, so adding a code without a label fails to compile.

### 2. Daemon `/health`

- The `/health` reply gains one additive field, `analytics: { credentials: 'ok' | 'stale' }`, taken from `areCredentialsStale()` (`auth-state.ts:18`). The endpoint stays unauthenticated and existing fields are unchanged. No on-disk files are added and `DaemonState` is unchanged.
- The awaiting-login listener (the daemon has no usable credentials) reports `analytics: { credentials: 'stale' }`.
- `checkProxyHealth` (`health-check.ts:60`) reads the reply body and exposes the field as an additive, optional member of `ProxyHealthResult`. It accepts the field only when the reply's `pid` matches the daemon state's `pid`.

### 3. `codemie proxy status`

- After the daemon block, a new line: `Analytics: healthy` (green), `Analytics: unhealthy (<short label>)` (yellow), or `Analytics: unknown (restart the proxy to enable all checks)` (dim), followed for `unknown` by `Run: codemie proxy restart`.
- When unhealthy, a tip line follows: `Run: codemie profile login` for `credentials_expired` and `auth_rejected`, `Run: codemie proxy restart` for `identity_mismatch`, and `Run: codemie proxy analytics status` for `send_failed`.
- `--json` adds `analytics: DeliveryHealth`, where `reason` is the code.
- The line and the JSON field appear only when an OTLP connector is enabled; otherwise both are omitted, whatever the spool holds.
- When the daemon is stopped, text and JSON stay exactly as they are today (`Status: stopped` / `{"status":"stopped"}`), with no analytics line.

### 4. `codemie proxy analytics status`

This applies to the default (Claude Code) and every connector flag — today `--claude-code-otlp`, `--copilot-cli-otlp` and `--copilot-chat-otlp`; connectors added later follow the same layout. The output uses the `proxy status` style: a headline label with a colored value (chalk green or yellow), then detail lines indented 2 spaces with aligned labels.

- **Delivery section** (first, identical for every connector, shown only when an OTLP connector is enabled, as in `proxy status`):
  - `Delivery: healthy`, `Delivery: unhealthy (<label>)` or `Delivery: unknown (restart the proxy to enable all checks)`.
  - `Pending: <size>` (for example `2.00 KB`), only when pending bytes are above 0.
  - `Run: codemie profile login` for the two credential reasons, and `Run: codemie proxy restart` for `identity_mismatch` and `unknown`.
  - When the daemon is running, the command calls `/health`. When the daemon is stopped, the section shows `Delivery: proxy not running` instead of a verdict.
- **Connector section**: the same data as today, in the new style. That is connected / hooks installed, scope, tracked projects, collection enabled or disabled, excluded projects, whether the current directory is tracked and why, and the corrupt-preferences error. At most one `Run: <command>` line holds the fix: `codemie proxy connect --<id>` when the connector is not connected, otherwise the existing not-tracked advice command (for example `codemie proxy analytics include "<path>"`). Advice that is not a single command (for example a corrupt preferences file) goes into the not-tracked reason instead. There is no `Hint:` line.
- The "Not affected by these settings: …" text is printed after the sections as a plain, dim sentence (no label, no indentation), for example: These settings do not affect the daily analytics collector or the session sync that `codemie claude` runs itself.
- `--json` keeps its existing shape and adds `delivery: DeliveryHealth` (`null` when the daemon is stopped or no connector is enabled). This is the same object that `proxy status --json` publishes as `analytics`.

## Acceptance criteria

### Delivery-health collector

- AC1: One collector serves both commands, with no per-connector delivery logic, and it never throws.
- AC2: Each of the four reasons is detected under its stated rule. When several apply, the stated precedence decides.
- AC3: `auth_rejected` ignores a marker detected before the latest sign-in, and a marker that does not match the daemon's recorded profile or URLs.
- AC4: `send_failed` ignores a delivery record that fails the forwarder's liveness check.
- AC5: An `analytics_endpoint_mismatch` session hold produces `identity_mismatch`. Every other hold reason leaves health unchanged.
- AC6: Adding a reason code without a label is a compile error.

### Daemon `/health`

- AC7: `/health` returns `analytics.credentials` (`ok` | `stale`), existing fields are unchanged, and the awaiting-login listener returns `stale`.
- AC8: `checkProxyHealth` exposes `analytics` only when the reply's pid matches the daemon state's pid and the field has the expected shape. The other consumers of `ProxyHealthResult` behave as before.

### `codemie proxy status`

- AC9: Prints the green, yellow or dim (`unknown`) `Analytics:` line, plus the tip for its reason, only when an OTLP connector is enabled.
- AC10: `--json` adds only `analytics: DeliveryHealth`, and all existing fields are unchanged.
- AC11: With the daemon stopped, text and JSON are byte-identical to today's.

### `codemie proxy analytics status`

- AC12: For every connector flag and the default, prints the Delivery section first, using the stated line conditions, when an OTLP connector is enabled; otherwise it prints only the connector section. With the daemon stopped, it prints `Delivery: proxy not running`.
- AC13: The connector section shows the same data as today in the new style, with at most one `Run:` line and no `Hint:` line, followed by the unlabeled dim sentence about unaffected channels.
- AC14: `--json` keeps its existing shape and adds `delivery` (`null` when the daemon is stopped or no connector is enabled).

## Non-goals

- Session-sync pipeline backlog (`~/.codemie/sessions`, managed launches).
- Last-successful-delivery time, and detecting a stall that leaves no failure record.
- Backlog trend (growing or draining).
- Per-tool backlog breakdown.
- Held or dropped detail lines.
- Any new on-disk state file.
