# QA Gate Report — epmcdme-13136-bedrock-qwen3-compaction

**Branch**: fix/EPMCDME-13136-bedrock-qwen3-compaction
**Runner**: npm
**Started**: 2026-06-24T00:00:00Z
**Status**: BLOCKED (pre-existing lint failures not introduced by this change)

## Gates

| Gate         | Status  | Command                        | Notes |
|--------------|---------|--------------------------------|-------|
| license-check | PASS   | `npm run license-check`        | Exits 0; no Apache-2.0 violations |
| lint          | FAIL   | `npm run lint`                 | **Pre-existing**: 65 errors in 5 files (compare-codex-conversations.mjs, statusline.mjs, postinstall.mjs, skills-sh-egress-guard.cjs, prepare-install-artifacts.mjs). Verified: identical failures exist on main without our changes. `sso.proxy.ts` has zero lint issues. |
| typecheck     | PASS   | `npm run typecheck`            | `tsc --noEmit` exits 0; no diagnostics |
| build         | PASS   | `npm run build`                | `tsc && tsc-alias && copy-plugin` all succeed; `dist/` rebuilt |
| unit          | PASS   | `npm run test:unit`            | 141 test files, 2118 passed / 1 skipped |
| integration   | PASS   | `npm run test:integration`     | All integration checks pass |
| secrets       | PASS   | `npm run validate:secrets`     | 0 leaks found (gitleaks) |
| commitlint    | PASS   | `npm run commitlint:last`      | 0 problems, 0 warnings; Conventional Commits format confirmed |
| ui            | SKIPPED | (n/a)                         | No UI surface changed (diff touches only `.ts`) |

## Failure detail

```
ESLint: 65 errors, 0 warnings in 5 files

compare-codex-conversations.mjs (32 issues) — no-undef (32)
src/agents/plugins/claude/plugin/statusline.mjs (14 issues) — no-undef (11), no-empty (2), no-constant-condition (1)
postinstall.mjs (9 issues) — no-undef (9)
skills-sh-egress-guard.cjs (7 issues) — no-undef (7)
prepare-install-artifacts.mjs (3 issues) — no-undef (3)
```

**Pre-existing confirmation**: `git stash && npm run lint` produces the identical 65 errors in the same 5 files on the base branch. Our change (`sso.proxy.ts`) was not among the failing files.

## Drift signal

no — `logBedrockUpstreamError(context: ProxyContext, statusCode: number)` matches the spec signature exactly; placement after `streamResponse` and before `onResponseComplete` matches the spec.
