status: DONE_WITH_CONCERNS

commit: 30fe3a7a
changed: src/utils/analytics-obfuscation.ts, src/utils/__tests__/analytics-obfuscation.test.ts, src/utils/__tests__/fixtures/obfuscation-samples.json
test command: npx vitest run src/utils/__tests__/analytics-obfuscation.test.ts (45 passed); tsc and eslint clean.
RED was module-not-found; GREEN came on the first implementation run.

exports: ObfuscationMode, SanitizeOptions, OBFUSCATION_RULES_VERSION='1', OBFUSCATION_FAILURE_PLACEHOLDER='[REDACTED:FAILED]', DEFAULT_OBFUSCATION_MAX_INPUT=256K,
sanitizeText(text, mode, opts?) : string, sanitizeDeep<T>(value, mode, opts?) : T, trimBeforeOpenPlaceholder(text, limit) : string
reused: maskSecretsInLongText, maskSecretsDeep, TICKET_REF_RE (ticket-parser.ts has no imports, so graph stays light), logger.
Placeholders: EMAIL, IP (v4 and v6), CARD, IBAN (mod97), PHONE. Order: secrets, email, ticket protect, IBAN, card, IPv6, IPv4, phone, restore.
Cap measured (worst shape '1-' repeated): 256 KB ~150 ms, 1 MB ~640 ms, 5 MB ~3.3 s; cap 256 KB (recorded in code comment).

concerns:
- Off mode uses maskSecretsInLongText, identical to maskSecretsInText up to 64 KB; beyond that it scans to 8 MB rather than dropping the tail. Callers needing byte-identical legacy behaviour above 64 KB should say so.
- trimBeforeOpenPlaceholder also backs up when a cut lands inside a ticket ref (beyond the stated placeholder-only scope).
- 1.2.3.4 (no v prefix) is masked as IP; phone rule is heuristic (>=10 digits with non-dot separators, or + prefix with >=8).
- Card requires first digit 2-6 to avoid epoch timestamps.
- Emails are masked before ticket protection so ABC-123@corp.com is fully masked.
