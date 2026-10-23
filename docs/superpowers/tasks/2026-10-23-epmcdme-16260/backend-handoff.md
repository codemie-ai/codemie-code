# Backend handoff: percent-encoded attribution headers (EPMCDME-16260)

## Contract
The CLI ALWAYS percent-encodes the values of `X-CodeMie-Repository`, `X-CodeMie-Branch` and `X-CodeMie-Project`, per `/`-separated segment with `encodeURIComponent` (`/` is left as is). The backend must `decodeURIComponent` every value of these headers before storing or attributing, so the repository shows as `clients/репо-тест` in CLI Analytics. The same applies to the metrics upload and skills-metrics endpoints, which carry the same headers.

## Example
- Before: `X-CodeMie-Repository: clients/репо-тест` could not be sent (the CLI failed the request); `my repo` was sent raw.
- After: `X-CodeMie-Repository: clients/%D1%80%D0%B5%D0%BF%D0%BE-%D1%82%D0%B5%D1%81%D1%82` and `my%20repo`; `org/repo` is sent unchanged; a literal `%` is sent as `%25`. The backend stores the decoded text.

## Edge notes
- Old CLIs keep sending unencoded values, so the backend must handle both during the transition.
- An old CLI that sends a raw branch or repository containing a literal `%xx` (for example `100%25`) will have it decoded by the new backend. This is the cost of backend-first rollout; the fallback below only covers malformed escapes.
- Skill-event JSON body fields `repository`, `branch` and `project` are sent RAW (only the headers are encoded). The backend must not `decodeURIComponent` the body fields; the header, when present, takes precedence and is the only decoded source. If the backend decodes the body fields, a raw value such as `A%20B` is mis-decoded.
- Empty header values are sent as empty strings by the metrics upload; the backend treats an empty value as absent.
- Encoding expands a non-Latin character to 6 characters (3x per UTF-8 byte). Header size against intermediary limits is not measured.
- Decode must not fail on malformed escapes from older CLI versions (for example a raw `100%`): fall back to the raw value.

## Rollout order (hard prerequisite)
The backend decode MUST ship BEFORE this CLI fix. Otherwise existing repository, branch and project attribution breaks for users on old backends (encoded strings are stored). Mark the backend ticket as a release blocker for this change.

## Verification after deploy
Run `codemie-claude` in a folder like `~/qa/clients/репо-тест` and confirm CLI Analytics shows repository `clients/репо-тест`. Also confirm a repo with a space in the name shows decoded.

## Rollout gate
- The backend decode (`decodeURIComponent` for `X-CodeMie-Repository`, `X-CodeMie-Branch`, `X-CodeMie-Project`) must be agreed with the backend team and shipped BEFORE this CLI change is released or merged. This covers every receiving path: proxy, metrics upload, skill events and the OTLP spool forwarder (event-hooks, logs, metrics, traces).
- This is a wire change to `X-CodeMie-*` attribution headers, a CRITICAL change under the git-workflow rule. Security sign-off is required and must be recorded in the PR before merge.
