status: DONE
commit: 956f3155
changed: report/redact.ts (new obfuscatePayload), analytics/index.ts, sync/report-builder.ts (new optional obfuscation option, default from resolveAnalyticsSettings(process.cwd())), tests: report/__tests__/redact-obfuscation.test.ts (new), sync/__tests__/report-builder.test.ts
test: npx vitest run src/cli/commands/analytics -> 55 files, 1076 passed; tsc and eslint clean
signature changes: BuildSyncReportOptions gains optional obfuscation; no renames
reused: sanitizeText, resolveAnalyticsSettings
concerns: git target has no separate payload path; it uploads buildSyncReport bytes, so the obfuscation there covers git and webhook. Only session titles are masked (the only free text in the payload). --redact stays stronger (blank title).
