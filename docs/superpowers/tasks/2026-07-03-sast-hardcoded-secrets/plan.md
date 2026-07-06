# Plan — Fix SAST HardcodedNonCryptoSecret in Test Files

## Requirements

Fix four SAST `HardcodedNonCryptoSecret` findings in two test files. Tickets: EPMCDME-13309, EPMCDME-13310, EPMCDME-13311, EPMCDME-13312. The SAST scanner flags API-key-like field names paired with any non-empty string value. The fix replaces flagged values with alternatives that satisfy the type contract and preserve test intent without triggering the pattern.

## Tasks

### Task 1 — Fix AgentCLI-effort.test.ts (EPMCDME-13309, EPMCDME-13310)

Replace both `apiKey: 'test-key'` occurrences with `apiKey: ''`.

Neither test asserts on `apiKey`; an empty string satisfies the TypeScript type and eliminates the SAST signal.

Test-first: no — both tests already pass; this is a value substitution that preserves existing GREEN state.

**Files**: `src/agents/core/__tests__/AgentCLI-effort.test.ts`

### Task 2 — Fix moonshot-subscription.template.test.ts (EPMCDME-13311, EPMCDME-13312)

Replace `KIMI_MODEL_API_KEY: 'some-key'` with `KIMI_MODEL_API_KEY: 'placeholder'` in the two flagged test cases. Update the corresponding `.toBe('some-key')` assertions to `.toBe('placeholder')`.

The value must remain consistent between input and assertion (immutability test checks the original reference).

Test-first: no — existing tests stay GREEN; this is a value rename that preserves test semantics.

**Files**: `src/providers/plugins/moonshot-subscription/__tests__/moonshot-subscription.template.test.ts`
