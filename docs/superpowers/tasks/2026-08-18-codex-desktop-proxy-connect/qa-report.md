# QA Gate Report — Codex Desktop Proxy Connect

**Date**: 2026-08-19
**Branch**: `feat/codex-desktop-proxy-connect`
**Result**: PASSED

| Gate | Result | Evidence |
|---|---|---|
| Lint (changed files) | **PASS** | `npx eslint` clean on all 10 changed source files |
| Lint (repo-wide) | **PRE-EXISTING FAIL** | `src/agents/plugins/claude/plugin/statusline.mjs`, 13 `no-undef` errors. Verified identical on `main` via a temporary worktree; introduced by PR #418, untouched by this branch |
| Typecheck | **PASS** | `tsc --noEmit`, no errors |
| Build | **PASS** | `npm run build` |
| Unit tests | **PASS** | 3187 tests across 215 files |
| Secrets | **PASS** | gitleaks, no leaks found (runs on every commit via pre-commit hook) |

## Functional verification (live, against the real gateway)

Not a browser surface, so `feature-verification` does not apply. Verified instead by driving the
real proxy daemon against the real CodeMie gateway, and by the user exercising the Codex desktop
app directly.

**Model-name resolution** — the app's picker emits undated names; CodeMie deployments are dated.
Every name observed in the user's failing session now resolves:

| Requested | Served by |
|---|---|
| `gpt-5.6-luna` | `gpt-5.6-luna-2026-07-09` |
| `gpt-5.6-sol` | `gpt-5.6-sol-2026-07-09` |
| `gpt-5.6-terra` | `gpt-5.6-terra-2026-07-09` |
| `gpt-5.5` | `gpt-5.5-2026-04-24` |
| `gpt-5.2` | `gpt-5-2-2025-12-11` |
| `gpt-5` | `gpt-5-2025-08-07` |
| unknown name | newest servable deployment, substitution logged |

**Empty tool descriptions** — verified against the built artifact: 3 repaired in a mixed payload,
real descriptions preserved, and JSON-schema property descriptions plus unrelated
`metadata.description` left untouched. Confirmed working in the app by the user.

**Config integrity after connect** — `~/.codex/config.toml` parses, `model_provider = "codemie"`,
and unrelated content survives: `personality = "pragmatic"` and all 22 `[projects.*]` entries.
`~/.codex/auth.json` never written.

## Notes

- The user confirmed both the Codex tab and ChatGPT Work mode work after the fixes.
- Two reproduction limits are recorded honestly in `spec.md` §12: the exact request shape behind
  the empty-description rejection could not be synthesized, and the real per-platform app-detection
  paths are not covered by tests.
