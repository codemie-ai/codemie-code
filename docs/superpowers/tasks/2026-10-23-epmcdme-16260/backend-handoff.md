# Backend handoff: percent-encoded attribution headers (EPMCDME-16260)

## Contract
The CLI percent-encodes the values of `X-CodeMie-Repository` and `X-CodeMie-Branch` per `/`-separated segment with `encodeURIComponent` (`/` is left as is), but only a segment that contains a character outside printable ASCII (`0x20–0x7E`). Every other segment is sent unchanged. Lone surrogates become U+FFFD. The helper is not idempotent: an already-encoded non-ASCII input is encoded again.

The backend must `decodeURIComponent` every value of these two headers before storing or attributing, so the repository shows as `clients/репо-тест` in CLI Analytics.

`X-CodeMie-Project` is sent RAW and must NOT be decoded by the backend (for example `a@b.com` stays `a@b.com`). If the project is not a valid Latin-1 header value (`0x20–0x7E`, `0xA0–0xFF`) the CLI omits the header, so the backend falls back to the user's default project.

The metrics upload and skills-metrics endpoints carry the same headers. The OTLP spool forwarder (event-hooks, logs, metrics, traces) sends only `X-CodeMie-Project` (raw).

## Examples
| Sent value | On the wire |
|---|---|
| `clients/репо-тест` | `clients/%D1%80%D0%B5%D0%BF%D0%BE-%D1%82%D0%B5%D1%81%D1%82` |
| `репо%` | `%D1%80%D0%B5%D0%BF%D0%BE%25` |
| `my repo` | `my repo` (unchanged) |
| `org/repo` | `org/repo` (unchanged) |
| `fix/100%` | `fix/100%` (unchanged) |

Only a segment that contains non-ASCII and a literal `%` gets `%25`.

## Edge notes
- Old CLIs send unencoded values, so the backend must handle both during the transition.
- A literal `%xx` in an ASCII value (for example a branch `fix/100%25`) is sent unchanged by the new CLI too, so the new backend stores it decoded (`fix/100%`). This is not limited to old CLIs. It is rare and accepted.
- Latin-1 non-ASCII values (for example `café`, `0xA0–0xFF`) were accepted by Node before and are now encoded. A backend that does not decode yet stores `caf%C3%A9`.
- Skill-event JSON body fields `repository`, `branch` and `project` are sent RAW. The backend must not `decodeURIComponent` the body fields; the header, when present, takes precedence and is the only decoded source. If the backend decodes the body fields, a raw value such as `A%20B` is mis-decoded.
- Empty header values are sent as empty strings by the metrics upload; the backend treats an empty value as absent.
- Encoding expands a non-Latin character to 6 characters (3x per UTF-8 byte). Header size against intermediary limits is not measured.
- Decode must not fail on malformed escapes from older CLI versions (for example a raw `100%`): fall back to the raw value.

## Rollout order
Only values containing non-printable-ASCII characters change on the wire, so ASCII attribution is unaffected on a backend that does not decode yet. The backend decode should still ship before or with this CLI release, otherwise non-ASCII and Latin-1 non-ASCII repository and branch values are stored encoded.

## Verification after deploy
Run `codemie-claude` in a folder like `~/qa/clients/репо-тест` and confirm CLI Analytics shows repository `clients/репо-тест`. Also confirm a project name containing a space is still attributed correctly.

## Rollout gate
- Backend MR: https://gitbud.epam.com/epm-cdme/codemie/-/merge_requests/4621 (`decode_attribution_header`). It is approved; `/sanity` and the preview/prod deploy are pending.
- The backend decode covers `X-CodeMie-Repository` and `X-CodeMie-Branch` only, on the proxy, metrics upload and skill-event paths. The OTLP spool forwarder sends only Project, so it is not a Repository/Branch path.
- The backend must NOT decode `X-CodeMie-Project`.
- This is a wire change to `X-CodeMie-*` attribution headers, a CRITICAL change under the git-workflow rule. Security sign-off is required and must be recorded in the PR before merge.
