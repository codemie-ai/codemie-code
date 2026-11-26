DONE
commit: 7d277ec8
files: src/agents/core/BaseAgentAdapter.ts, src/agents/core/types.ts, src/agents/core/__tests__/BaseAgentAdapter.path-shadow.test.ts, src/agents/plugins/claude/claude.plugin.ts, src/agents/plugins/kimi/kimi.plugin.ts, src/agents/plugins/codemie-code.plugin.ts
test_command: npx vitest run src/agents/core/__tests__/BaseAgentAdapter.path-shadow.test.ts (13 pass; BaseAgentAdapter.test + version-notice still pass)

Signatures:
- BaseAgentAdapter.checkPathShadow(opts: { resolvePrefix?: boolean } = {}): Promise<ShadowVerdict>  (also optional checkPathShadow? on AgentAdapter in types.ts)
- BaseAgentAdapter.getPathMatches(): Promise<string[] | null>  -- memoized per instance (private pathMatches promise), one getCommandMatches call under 5000 ms race; null = unanswered/timeout/no cliCommand, [] = nothing on PATH. Launch (T8) can use (await getPathMatches())?.[0].
Opt-out: AgentMetadata.pathShadowCheck?: false. Set on claude, kimi, codemie-code (cliCommand is a resolved binary path, installs via npm package but not a PATH shim). claude-acp has its own metadata object (no flag, eligible, npm install); codex-acp, pi (base npm installVersion), openwiki (no install override) are eligible.
Behavior: unknown when platform != win32 (process.platform read at call time), no cliCommand/npmPackage, opt-out, prefix unresolved (getCodemieNpmPrefix() only; npm spawned via getCodemieOrGlobalNpmPrefix only with resolvePrefix), lookup failed/timeout. Shim probe: fs.access on <managedDir>\<cmd>.cmd then <cmd>. Dir equality pre-resolved with isSamePathResolved into a Map used as the classifier's sync samePath.
Note: tests stub process.platform; the matches memo is not invalidated, so a checkPathShadow after an install in the same instance reuses stale matches (use a fresh adapter if needed).
