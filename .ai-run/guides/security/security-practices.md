# Security Practices

**Project**: @codemieai/code · **Stack**: TypeScript (ESM, target ES2022, module NodeNext) commander CLI · **Scope**: secret masking in logs, credential storage and X-CodeMie attribution headers; logger level semantics live in `.ai-run/guides/development/development-practices.md`

## Secrets

### Rules
- R1. Keep secrets out of the logger message string and out of longer strings passed as args; mask free text with `maskSecretsInText()` first (`writeToLogFile` sanitizes args only, and `sanitizeLogArgs` masks a string arg only when the whole string matches a key-shaped pattern). Evidence: `src/utils/security.ts::sanitizeLogArgs`
- R2. Wrap credential-bearing args to `logger.debug` in `sanitizeLogArgs()` yourself (its console copy prints the raw args to stderr; only the file copy is sanitized). Evidence: `src/utils/logger.ts::Logger.debug`
- R3. Persist SSO/JWT credentials through `CredentialStore` with the profile's base URL (keychain when keytar loads, else an AES-encrypted file per URL key under the CodeMie home). Evidence: `src/utils/security.ts::CredentialStore.storeSSOCredentials`

## Transport and headers

### Rules
- R4. Encode `X-CodeMie-Repository`/`X-CodeMie-Branch` values with `encodeAttributionHeader()` and send `X-CodeMie-Project` only when `rawProjectHeader()` accepts it (the backend does not decode the project header; the three current writers all follow this). Evidence: `src/utils/header-value.ts::encodeAttributionHeader`
- R5. Model-request attribution headers come only from `buildAttributionHeaders` in header-injection.plugin.ts; `MetricsApiClient` (/v1/metrics) and `skills-metrics.ts` `postOne` are the named exceptions; do not add another writer. Allowed exceptions: src/providers/plugins/sso/session/processors/metrics/metrics-api-client.ts, src/cli/commands/skills/lib/skills-metrics.ts. Evidence: `src/providers/plugins/sso/proxy/plugins/header-injection.plugin.ts::buildAttributionHeaders`
