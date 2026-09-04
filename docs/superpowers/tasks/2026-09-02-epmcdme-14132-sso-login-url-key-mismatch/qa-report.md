# QA Gate Report — epmcdme-14132-sso-login-url-key-mismatch

**Branch**: EPMCDME-14132
**Runner**: npm (guide-first, `.ai-run/guides/quality-gates.md`)
**Started**: 2026-09-02T12:30:00Z
**Status**: PASSED (with gates owed to CI — see Owed to CI)

## Gates

| Gate | Source | Status | Command | Notes |
|---|---|---|---|---|
| license headers | guide | PASS | `npm run license-check` | exit 0. Needed `npm_config_cache` override — `~/.npm/_cacache` is permission-broken on this machine. |
| lint | guide | PASS | `npm run lint` | ESLint 9, `--max-warnings=0`, zero output. |
| typecheck | guide | PASS | `npm run typecheck` | `tsc --noEmit`, no diagnostics. |
| build | guide | PASS | `npm run build` | `tsc && tsc-alias && copy-plugin`; plugin assets and pricing table copied. |
| unit tests | guide | PASS | `npm run test:unit` | 3956 tests / 265 files passed. |
| integration tests | guide | **SKIPPED** | `npm run test:integration` | Full suite not run locally: the `cli` vitest project hangs on subprocess/PTY specs on this machine (pre-existing environment issue, unrelated to this change). Ran a targeted subset instead — 6 files / 64 tests passed, covering every file touching SSO, proxy and credentials: `sso-credential-key-normalization` (7), `sso-per-url-credentials` (23), `sso-claude-plugin`, `proxy-header-contract`, `proxy-routing-guard`, `proxy-normalizer-body-contract`. Not run locally: `proxy-daemon-lifecycle`, `proxy-header-contract-extended`. |
| secrets scan | hook | **SKIPPED** | `npm run validate:secrets` | Self-skipped: `"No staged changes to scan"` — the working tree is clean because everything is committed. It did run for real at each commit via `.husky/pre-commit`: gitleaks reported `no leaks found` on both fix-up commits. To run it here deliberately, stage the diff first. |
| commitlint | hook | PASS | `npx commitlint --from origin/main --to HEAD` | 0 problems across all 4 commits. 1 warning: `footer-leading-blank` on the `Co-authored-by` trailer — a warning, not a failure. |
| ui | guide | SKIPPED | (none configured) | No UI surface changed — diff touches no path matching `ui_globs`. Green outcome. |
| CI gitleaks | ci | N/A | `gitleaks/gitleaks-action` | Runs unconditionally in CI (`ci.yml:96-110`); cannot be reproduced locally. |
| CI test (Windows) | ci | N/A | `npm run test:unit && npm run test:integration` on `windows-latest` | Cannot run from macOS. See Owed to CI. |

## Owed to CI

A `PASSED` outcome here means nothing local blocks this branch — not that CI will be green. Still owed:

1. **Full integration suite** (`npm run test:integration`) — skipped locally due to the subprocess/PTY hang. CI runs it on both Ubuntu and Windows.
2. **Secrets scan as a standalone gate** — self-skipped on a clean tree; CI's gitleaks job runs it unconditionally against the full checkout.
3. **`test-windows` job** (`ci.yml:191`, `runs-on: windows-latest`) — this is directly relevant to ticket **AC5**. The new credential-key regression tests will execute on Windows there, which exercises the changed key derivation and the keytar/Windows Credential Vault storage path on the target platform. It does **not** cover the manual `profile login` browser-SSO flow, so it narrows but does not close AC5.

## Failure detail

None. No gate failed.

## Drift signal

no — the implementation matches `spec.md`. The one deviation from the original plan (passing the unnormalized URL from `getStoredCredentials`, commit `847bef23`) arose from review finding CR-005 and is recorded in `code-review-check.json`; it changes how the spec's design is reached, not what it specifies.
