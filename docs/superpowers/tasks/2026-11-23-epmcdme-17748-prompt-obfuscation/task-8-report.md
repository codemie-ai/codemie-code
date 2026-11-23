status: DONE_WITH_CONCERNS

commit: f20e7661
changed paths: src/utils/__tests__/analytics-obfuscation-imports.test.ts (new)
test command: npx vitest run src/utils/__tests__/analytics-obfuscation-imports.test.ts src/utils/__tests__/analytics-obfuscation.test.ts -> EXIT=0, 48 passed; tsc and eslint clean
migrated call sites: none. A scan of non-test src/ found no leftover imports of maskSecretsInText/maskSecretsDeep/maskSecretsInLongText outside the facade (only comment mentions in otlp-json-masking.ts), so RED could not be observed; the detector is covered by a multi-line import unit case.
allowlist: utils/analytics-obfuscation.ts (facade), utils/security.ts (defines two functions), utils/long-text-masking.ts (defines the third)
standards: ES modules, .js extensions, no any, no console.log
concerns: no RED run possible (nothing to migrate); guard matches import/export clauses only.
