/**
 * Identity attributes whose plain string value is not obfuscated as PII (Claude Code's `user.email` names the
 * session owner). Matched on the exact attribute name; secret patterns are still masked in them. Shared by the OTLP
 * JSON and protobuf maskers; extend here if another identity attribute needs it.
 */
export const PII_EXEMPT_KEYS: ReadonlySet<string> = new Set(['user.email']);
