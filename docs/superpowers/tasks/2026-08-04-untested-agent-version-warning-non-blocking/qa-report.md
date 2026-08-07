# QA Gate Report — EPMCDME-13734

**Branch**: EPMCDME-13734
**Runner**: npm
**Started**: 2026-08-04T00:00:00Z
**Status**: PASSED

## Gates

| Gate            | Source | Status  | Duration | Command                        | Notes |
|-----------------|--------|---------|----------|--------------------------------|-------|
| license-check   | guide  | SKIPPED | ~1s      | `npm run license-check`        | Environment issue: `EACCES: permission denied, mkdir '/Users/Evgenii_Kurdakov/.npm/_cacache/…'` while npx tried to install `license-checker`. Not a code problem. CI runs the same gate unconditionally against a clean cache — do not rely on this local skip. |
| lint            | guide  | PASS    | ~4s      | `npm run lint`                 | Zero warnings (ESLint 9.x, `--max-warnings=0`). |
| typecheck       | guide  | PASS    | ~3s      | `npm run typecheck`            | `tsc --noEmit` clean. |
| build           | guide  | PASS    | ~20s     | `npm run build`                | `tsc && tsc-alias && npm run copy-plugin` all succeeded. |
| unit            | guide  | PASS    | ~4s      | `npm run test:unit`            | 186 test files, 2660 passed, 1 skipped. |
| integration     | guide  | PASS    | ~29s     | `npm run test:integration`     | 29 files passed, 1 file skipped (pre-existing); 204 tests passed, 10 skipped. The agent-project tests were deliberately not run per the run instructions (require live Claude installation + integration credentials). |
| secrets         | guide  | SKIPPED | ~1s      | `npm run validate:secrets`     | Self-skipped: "No container engine found — skipping secrets detection (CODEMIE_SKIP_SECRETS_SCAN=1)". Enable locally by starting Docker/Podman/Apple Containers; CI runs the same scan unconditionally. |
| commitlint      | guide  | PASS    | ~1s      | `npm run commitlint:last`      | 0 problems, 0 warnings against HEAD~1..HEAD. |
| ui              | guide  | SKIPPED | —        | (n/a)                          | Reason: "no UI surface changed" — diff touches no `.tsx/.jsx/.css/.html/.vue/.svelte` files. |

## Failure detail

None.

## Skipped gates that CI will still run

- `license-check` (local: npm cache EACCES; CI runs it and is authoritative).
- `secrets` (local: no container engine; CI runs the same scan unconditionally).
- `agent-project` tests (deliberately not run in this run; agent integration suite requires live Claude installation and integration credentials).

The `PASSED` outcome here means "nothing local blocks this MR". CI still enforces the three items above; do not treat this report as CI-green.

## Drift signal

no
