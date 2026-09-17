# Deferred from code review — 2026-08-25-profile-provider-decoupling (2026-08-25)

- **ConfigLoader exceeds the 500-line code-quality guideline** — `src/utils/config.ts` (1494 lines). Pre-existing: the file was already ~1497 lines before this diff (over the 500-line guideline in `code-quality.md`); this diff substantially rewrites its workspace-resolution logic (`resolveWorkspace`, `splitProfileAndWorkspace`, `saveProfile`, `initProjectConfig`) in place without extracting any of it, but does not materially grow the file, so the size violation itself predates this change.
