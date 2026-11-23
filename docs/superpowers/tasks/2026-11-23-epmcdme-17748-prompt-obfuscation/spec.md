# CLI Analytics Prompt Obfuscation and Multi-Tracker Attribution — Spec

Ticket: EPMCDME-17748. Repository: codemie-code. Size: XL (27/36); delivered in one run at the user's request.

## Problem

The CLI masks secrets in analytics unconditionally, but not PII, and not on every route. The `--claude-otlp` protobuf path is forwarded unmasked (`src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts`, `handleOtlpBinary`). The local `codemie analytics` report keeps the full first prompt as `title` unless `--redact` is passed (`cli/commands/analytics/report/redact.ts:39`). Ticket attribution recognises only Jira keys (`agents/core/ticket-parser.ts:14`).

## Approach

1. One new leaf module (beside `src/utils/security.ts`, no heavy imports, to keep the proxy daemon graph small) is the only entry for masking analytics text: `sanitizeText(text, mode)` and `sanitizeDeep(value, mode, opts)`. It composes the three existing secret-masking variants (`otlp-field-limits.ts:49`, `utils/security.ts:235,244`, `utils/long-text-masking.ts:72`) with the PII rules, so size behaviour is uniform.
   - PII rules: email, phone, IPv4, IPv6, payment card (Luhn-checked), IBAN. Each match becomes a typed placeholder such as `[REDACTED:EMAIL]`.
   - Output is pure and idempotent. An optional `rules_version` stamp is set on obfuscated events so mixed rule sets in spool or backend can be told apart.
   - Rules are linear-time and anchored. Each call has an input cap; a field over the cap becomes the failure placeholder. The cap is chosen by measuring a 1 MB and a 5 MB body in the daemon.
   - Ticket references come from the exported ticket regex in `ticket-parser.ts` (one rule, two users). They are protected before the PII rules and restored after.
2. `resolveAnalyticsSettings(cwd)` returns `obfuscation` and `ticketTracker`. Obfuscation is on if either the global or the project layer is on; a project can only turn it on. Default is off. The mode is resolved once per event at the edge and passed down.
   - Project source per route: hook collectors use the hook context cwd; the proxy daemon uses the existing session-to-project mapping (`session-project.ts`), never anything in the request body; `analytics sync` and the report use the command cwd.
   - No mapping or project found: the protective value (on if any known layer was on).
   - The result is cached and re-read when the config file mtime changes. An unreadable config keeps the prior value, or resolves to on if any layer was on; it never silently resolves to off.
   - `ticketTracker` uses the same resolver and config because it is chosen in the same setup step; `.claude/analytics.local.json` is not reused because it holds session state, not user settings. `ticketTracker`, being a plain value, resolves project over global.
3. The analytics setup step offers obfuscation on/off and `ticketTracker` (jira, azure-devops, github, gitlab), each global or current-project.
4. Mask sites call the facade: `maskAndBoundFields` (covers `OtlpAgentAdapter` collectors and cowork, including cowork branch fields), `boundedFreeText` in copilot-cli-otlp, `maskOtlpJson`, the protobuf path, `report/redact.ts` and the report `title`, and `analytics sync` payloads. `--redact` stays the stronger mode; obfuscation applies to `title` otherwise. With obfuscation off, secret masking is unchanged.
5. Protobuf: a minimal generic length-delimited walker, no new dependency. It rewrites only string `AnyValue` leaves and copies every other and unknown field byte-for-byte, recomputing parent lengths. A string that fails becomes the failure placeholder and the rest of the body is sent. A body with nothing to obfuscate is forwarded byte-identical. The re-encoded size is checked before `appendSpool` against the forwarder's 5 MiB range and entry limits (`otlp-reader.ts:31,198-205`, `forwarder.ts:453-492`); if the limit cannot be met the body is dropped and a content-free counter is incremented.
6. Ticket parsing gains `AB#123`, `org/repo#123` and bare `#123`. Priority in `story-resolver.ts:133` is unchanged. Bare `#123` counts only when the resolved tracker is github or gitlab. The 200/300 cut backs off to before an unfinished `[REDACTED:`.
7. A canonical sample set (JSON fixture: input, expected output, limit variants, cut-in-placeholder cases, rules version) is the cross-repo contract the backend copies.

## Acceptance Criteria

- AC1: With obfuscation on or off selectable in analytics setup, saved globally or per project, the default is off. (story AC1)
- AC2: A project-scoped "on" with global "off" obfuscates only that project's prompts, on hook routes, the proxy daemon routes (via the session mapping), the report and `analytics sync`. A project "off" never overrides a global "on". (story AC2)
- AC3: With obfuscation on, emails, phones, IPv4/IPv6, card numbers, IBANs and secrets become typed placeholders on every route: hook collectors, proxy, `--claude-otlp` JSON and protobuf, the local report and `analytics sync`. Other text stays readable. (story AC3)
- AC4: Ticket references (`PROJ-123`, `AB#123`, `#123`, `org/repo#123`) survive obfuscation unchanged. For every hook collector, ticket fields come from the raw prompt before obfuscation and truncation; a test per collector is a gate. (story AC4)
- AC5: `AB#123`, GitHub/GitLab `#123` and `org/repo#123` are attributed with the existing priority (explicit, marker, branch, mention), with obfuscation on or off. (story AC5)
- AC6: A bare `#123` that is not a ticket reference (heading, `#fff`, list number) is attributed only when `ticketTracker` is github or gitlab, or when the `AB#` or `org/repo#` form is used. (story AC6)
- AC7: With obfuscation off, output equals today's, apart from the new attribution in AC5. (story AC7)
- AC8: If obfuscating a field fails or exceeds the input cap, that field is sent as a failure placeholder (never raw), metrics are still sent on every route including protobuf, and the failure is logged locally without content. The record is dropped only if the placeholder step also fails or, for protobuf, the 5 MiB limit cannot be met. (story AC8)
- AC9: `1.2.3`, `v1.2.3.4`, `ABC-1234` and `#42` are unchanged. A dotted four-part number without a `v` prefix is masked as an IP. (story AC9)
- AC10: The canonical sample set (including cuts at the 200/300 limits, cuts inside a placeholder, and already-obfuscated text) matches byte-for-byte, and a second pass changes nothing. (story AC10)
- AC11: `ticketTracker` is selectable in analytics setup, stored globally or per project, and defaults to unset. When unset, bare `#123` is never attributed. There is no inference from the git remote. (story AC6)
- AC12: Protobuf: a body with nothing to obfuscate is forwarded byte-identical; unknown fields survive; a re-encoded body passes the forwarder's range proof; a test near 5 MiB exists.
- AC13: Each PII rule has a worst-case input test with a time ceiling.
- AC14: No non-test file outside the new module imports `maskSecrets*` for analytics text.
- AC15: An unreadable config never resolves to off when any layer was on.

## Non-goals

- NG1: Backend obfuscation, the customer setting and backend storage. (story NG1)
- NG2: Whole-prompt redaction modes, and detecting names or addresses that need language understanding. (story NG2)
- NG3: Reading the backend customer setting from the CLI. (story NG3)
- NG4: Changing secret masking when obfuscation is off. (story NG4)
- Inferring the tracker from the git remote host.
- Retroactively obfuscating data already stored, synced or already spooled; records spooled before a toggle forward as they were.

## Decisions

- Obfuscation is opt-in, off by default, over always-on PII masking: it answers whether the PII layer is mandatory. D1
- Obfuscation is on if either global or project layer is on, over project overriding global both ways: it answers which setting wins — user, answers AR-2
- The proxy daemon finds the project through the existing session-to-project mapping, with the protective value when none exists, over a connector stamp or global-only: it answers where the daemon learns the project — user, answers AR-2
- A new leaf module with one facade over extending `security.ts`: it keeps the proxy daemon import graph small and removes per-site wiring.
- Ticket references are protected, then restored, using the one regex exported from `ticket-parser.ts`, over excluding them in each PII regex.
- A failed field becomes a failure placeholder over dropping the whole record: it answers fail-closed behaviour. D6
- On protobuf, only failing strings become the placeholder and the rest, with metrics, is sent, over dropping the whole body — user, answers AR-1
- The protobuf path uses a generic byte-faithful walker over a protobuf dependency: it avoids a new dependency.
- A four-part dotted number is an IP unless `v`-prefixed. D10
- Ticket fields are derived from the raw prompt before obfuscation and truncation. D11
- Bare `#123` counts only with an explicit tracker setting of github or gitlab, over inferring from the git remote — user
- `ticketTracker` is stored in the same setup step and the same global/per-project config as obfuscation, over a separate config location — user
- Per-call input cap over unbounded scanning: it answers how the shared daemon's event loop is protected.

## Risks

- The "GitHub collector" in the original request is ambiguous. AC3's every-route scope covers the Copilot collectors and the `analytics sync` git target.
- The raw-prompt order is verified only for Claude Code (`claude-code-otlp.plugin.ts:707`); AC4 gates the others.
- Rule parity with the backend relies only on the sample set.
- Unverified: whether the forwarder's range proof accepts changed length prefixes (AC12 tests it), and event-loop cost at 1 MB and 5 MB (sets the cap).
