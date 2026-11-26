# Code review — EPMCDME-17845 Copilot live funding (follow-up to #902)

- reviewed_head: 3229d0a1610cfd3403ad75367aeb02fab00d11fa
- base: d2b18221ffc5bc551672e4c78928d8af609be0b5 (branch vs base, 7 files, +133/-8, profile `balanced`)
- machine verdict: `code-review-final.json` (decision request-changes, confidence low: no spec, so acceptance lens n/a; 1 blocking, 2 advisory, 0 deferred)
- coverage: edge-case, standards ran; blind and verification-gap n/a (balanced profile); acceptance n/a (no spec)

## Findings and disposition

| id | finding | disposition |
|---|---|---|
| CR-001 (blocking, style) | ticket key in the subject of both commits (git-workflow: put it in the body) | **Not rewritten.** Local history that the repository squash-merges; the PR title (which becomes the squash commit) carries no key and the PR body links the ticket. Same disposition as #902. Reviewer may ask for a reword. |
| CR-002 (advisory) | launch-endpoint fallback is inherited by a nested native Copilot's hook | **Accepted.** A new funding claim still needs a fresh start whose id equals the pinned session, which a nested session does not have; a present `COPILOT_PROVIDER_BASE_URL` is never replaced. Same trust model as the Claude managed launch. |
| CR-003 (advisory) | pin id read from `process.env`, written to `spawnEnv` | **Accepted.** Both hold the same `CODEMIE_SESSION_ID` set by `run()`; the spawn-boundary test asserts the pin equals the spawn env's id. |

## Verification at the reviewed head

- `tsc` 0, `eslint` 0, vitest over `src/agents/core`, `copilot-cli`, `copilot-cli-otlp`: 1834 passed.
- Spawn-boundary regression through the real `run()`: pin and launch endpoint in the child env; `--resume`/`--continue`/`--session-id` clear the pin; a present BYOK endpoint, no launch copy and unmanaged all give no proof.
- Live managed `codemie-copilot -p` (built wrapper, isolated config, local test backend): 15/15, including persisted `project_origin`, spool `sendMode: evidence` and the exact profile/evidence for the same session.
- Live native `copilot -p` with direct BYOK to a local model route (no CodeMie proxy): 10/10; same session reached the consumer as `legacy`/unknown, `funding.unknown` only, `api_based` 0 sessions and `api_cost_usd` 0.
- Synthetic: fake model route, front server for model catalog and applications, JWT/credentials, backend auth and application-directory stubs. Not run live: Claude/Cowork, consent paths, explicit resume end to end, real gateway pricing/SSO.
