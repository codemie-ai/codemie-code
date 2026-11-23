status: DONE_WITH_CONCERNS
commit: 034ca8f5
changed: src/providers/plugins/sso/proxy/plugins/otlp-protobuf-obfuscate.ts (new), __tests__/otlp-protobuf-obfuscate.test.ts (new), otlp.plugin.ts (handleOtlpBinary)
test: npx vitest run src/providers/plugins/sso/proxy (72 files, 1282 pass); tsc and eslint clean; RED seen first (module missing)
signature: obfuscateOtlpProtobuf(body, mode, signal: OtlpSignal): Buffer | null -- a third arg 'signal' was added because the OTLP field numbers differ per signal. Also exports protobufObfuscationDropCount().
reused: sanitizeText, resolveSessionObfuscationMode, MAX_SNAPSHOT_BYTES/OtlpSignal/proveRange (tests)
standards: ESM, .js imports, @/ alias, logger, no any.
concerns:
- Off mode keeps protobuf byte-identical (walker only runs when mode is on), per "with obfuscation off, secret masking is unchanged".
- Values of session.id/session_id/codemie_project_name attributes are never rewritten (forwarder proof depends on them).
- Malformed body in on mode, or re-encoded body over 5 MiB, is dropped with a content-free warn + counter.
- Only the 5 MiB range limit is checked; forwarder.ts:453-492 per-window limits are the same cap. No handler-level test added for handleOtlpBinary.
