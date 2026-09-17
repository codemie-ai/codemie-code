# Code review (check round) — 2026-09-17-philips-tenant-model-catalog (2026-09-17)

**approve** · confidence: high · 7 resolved · 0 unresolved · 0 superseded
Coverage: targeted verifier ✓ (7/7 blocking findings graded)

## Resolved

- `src/cli/commands/proxy/connectors/model-name-resolver.ts:12` — [config] release-date pattern now strips concatenated 8-digit dates too — CR-001
- `src/cli/commands/proxy/connectors/model-name-resolver.ts:58` — [config] pickMostRecent ranks by non-vertex/date/lexicographic precedence, not raw string sort — CR-002
- `src/cli/commands/proxy/connectors/tenant-catalog.ts:24` — [other] fetchTenantModelCatalog decomposed into named helpers, under the 50-line standard — CR-003
- `src/cli/commands/proxy/connectors/tenant-catalog.ts:35` — [infra] catalog fetch now has an AbortController-backed timeout — CR-004
- `src/cli/commands/proxy/connectors/tenant-catalog.ts:68` — [infra] data-wrapped branch now shares the id/base_name/deployment_name fallback chain — CR-005
- `src/cli/commands/proxy/connectors/vscode-claude-code.ts:178` — [config] JSONC writer now detects and applies the file's real indentation/eol — CR-006
- `tests/integration/vscode-byok.test.ts:13` — [infra] both integration test files updated to the renamed exports and gatewayKey-required signature — CR-007

## Checked and clean

business_review (12 pass · 1 partial, carried forward) · standards_review: commit-format ✓ · code-quality (partial, carried forward) · security n/a (carried forward)

Note: this round's prior_verdict (CR-001–CR-007) uses a different numbering than the 10-finding code-review-final.json on disk, which also lists two items outside this round's scope (a desktop.ts diagnostic-log gap, a malformed-proxyUrl TypeError) not verified here.
