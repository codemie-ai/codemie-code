DONE
commit: 3cf247e0
test_command: npm run typecheck (docs-only task; no test command applicable)
changed: docs/COMMANDS.md, docs/ANALYTICS-REPORT.md, .ai-run/guides/integration/exposed-api.md
renames: none
reused: none
standards: Conventional Commits with ticket line + AI attribution — .ai-run/guides/standards/git-workflow.md; webhook signature masked with `<signature>` placeholder in all new examples — spec "Never print a real webhook signature in examples"
notes:
- docs/COMMANDS.md: added "### Scheduled delivery (`analytics sync`)" subsection at end of Analytics Commands, cross-linking to ANALYTICS-REPORT.md#scheduled-delivery-analytics-sync.
- docs/ANALYTICS-REPORT.md: fully replaced old "## Scheduled upload" section (sync/sync config/backfill, old `~/.codemie/analytics/sync/{config.json,markers/}` paths) with "## Scheduled delivery" covering install/status/run/uninstall, per-platform job table, log line format, collector takeover, state paths.
- .ai-run/guides/integration/exposed-api.md: this file documents src/index.ts's programmatic exports, not CLI commands, and had zero prior sync references — added a new "CLI entry: unattended scheduled runs" section documenting bin/codemie.js's `isScheduledSyncRun` detection contract (src/utils/scheduled-run.ts:20), since that's the piece of this feature that's an actual exposed CLI-entry contract.
- grep across docs/ (excluding docs/stories, docs/superpowers) for `sync config`, `analytics sync --from/--to/--last`, `analytics/sync/config`, `analytics/sync/markers`, `scheduled-upload` found no other hits — only match was an unrelated "Session sync configuration" string in docs/ARCHITECTURE-PROXY.md (different feature, left untouched).
- .ai-run/guides/security/security-practices.md already carries the correct exception wording/path (`~/.codemie/analytics-sync.json`) from an earlier task in this plan — out of my file scope, left as-is after confirming no `sync config`/old-path drift.
- Docs-only change: ran full `npm run typecheck` (0 exit) since the pre-commit hook runs it repo-wide regardless; pre-commit (lint-staged on 0 ts files, typecheck, gitleaks) passed clean, no `--no-verify`.
