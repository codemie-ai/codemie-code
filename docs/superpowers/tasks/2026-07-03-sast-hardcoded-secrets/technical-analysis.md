# Technical Analysis — SAST HardcodedNonCryptoSecret Fix

## Task

Fix four SAST `HardcodedNonCryptoSecret` findings in test files:
- EPMCDME-13309, EPMCDME-13310: `src/agents/core/__tests__/AgentCLI-effort.test.ts`
- EPMCDME-13311, EPMCDME-13312: `src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts`

## Codebase Findings

### AgentCLI-effort.test.ts

**Purpose**: Tests `ConfigLoader.exportProviderEnvVars` focusing on `CODEMIE_REASONING_EFFORT` env var emission.

**Flagged lines**: `apiKey: 'test-key'` appears in two `it` blocks (lines 9 and 20).

**Key observation**: Neither test asserts on the `apiKey` value. It is a required structural field on the config object but is irrelevant to both test assertions. An empty string `''` satisfies the TypeScript type contract without triggering the SAST pattern-match.

### moonshot-subscription.template.test.ts

**Purpose**: Tests `MoonshotSubscriptionTemplate` — env var export, Kimi hook injection, stripping/non-mutation of `KIMI_MODEL_API_KEY`.

**Flagged lines**: `KIMI_MODEL_API_KEY: 'some-key'` in two test cases.

**Key observation**: Two tests (`strips Kimi model env vars…` and `returns env unchanged…`) use `'some-key'` both as input and in the immutability/identity assertion (`.toBe('some-key')`). The value itself is arbitrary — what matters is that it is present before the hook runs and either stripped or passed through unchanged. Renaming to `'placeholder'` preserves test intent without matching key-like SAST patterns.

Three other `KIMI_MODEL_API_KEY: 'key'` occurrences in later test cases were not flagged and are left untouched.

## Risk Indicators

1. Changes are confined to test files only — no production code is touched.
2. No test assertions rely on the semantic meaning of `'test-key'` or `'some-key'`; they only check presence/absence or identity.
3. The `ConfigLoader.exportProviderEnvVars` signature accepts `apiKey: string` — empty string is a valid value.
4. The `MoonshotSubscriptionTemplate` strips `KIMI_MODEL_API_KEY` regardless of value when agent is `kimi`.
