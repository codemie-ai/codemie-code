DONE

Commit: 64f0bc91 fix(cli): EPMCDME-16969 warn about PATH shadow on agent launch (T8)

Changed paths:
- src/agents/core/AgentCLI.ts
- src/agents/core/BaseAgentAdapter.ts
- src/agents/core/__tests__/AgentCLI.path-shadow.test.ts (new)
- src/agents/core/__tests__/BaseAgentAdapter.test.ts

Test command:
npx vitest run src/agents/core/__tests__/BaseAgentAdapter.test.ts src/agents/core/__tests__/BaseAgentAdapter.path-shadow.test.ts src/agents/core/__tests__/AgentCLI.path-shadow.test.ts src/agents/core/__tests__/BaseAgentAdapter.signals.test.ts src/agents/core/__tests__/BaseAgentAdapter.version-notice.test.ts
Result: 5 files, 113 tests passed. tsc --noEmit and eslint clean. RED was seen first for both new test groups.
