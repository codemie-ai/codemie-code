status: DONE_WITH_CONCERNS
commit: 6bdd2ba7

Changed paths (all named by task, plus the existing test file):
- src/providers/plugins/sso/proxy/plugins/otlp-json-masking.ts
- src/providers/plugins/sso/proxy/plugins/otlp.plugin.ts
- src/providers/plugins/sso/proxy/plugins/__tests__/otlp-json-masking.test.ts

Test command: npx vitest run src/providers/plugins/sso/proxy (71 files, 1271 tests pass); RED seen first (5 failed). tsc and eslint clean.

Signature changes:
- `maskOtlpJson(parsed: unknown, mode: ObfuscationMode, opts?: SanitizeOptions): unknown` (mode now required). Uses `sanitizeDeep` after `redactSensitiveAttributes`. In on mode, a per-string failure becomes the placeholder; if the whole walk collapses to a string it throws, so the caller drops the record.
- New `resolveSessionObfuscationMode(sessionId, deps?: {readStatus, resolveSettings}): Promise<ObfuscationMode>` in otlp-json-masking.ts. Task 7 protobuf route should call it with the session id found in the bytes, then pass mode to its walker.
- Call site: otlp.plugin.ts handleOtlpJson. Existing tests wrap maskOtlpJson with mode 'off' via a local helper.

Reused: sanitizeDeep, resolveAnalyticsSettings, readStatus, redactSensitiveAttributes, isSensitiveKey.

Concerns:
- SessionStatus holds only a project NAME, no directory, so the daemon cannot locate a project-layer config from the mapping. The resolver reads status (error => 'on') and resolves settings from homedir(), i.e. the global layer only. A project-only "on" is therefore not honoured on the proxy route. Fix needs the hook/stamp path to record the project cwd in the session status (outside this task's files).
- Status read failure or settings throw gives 'on' (protective).
