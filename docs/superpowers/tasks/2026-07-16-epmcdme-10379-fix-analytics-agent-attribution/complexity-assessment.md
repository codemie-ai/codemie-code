# Complexity Assessment

**Task**: Fix codemie analytics to correctly attribute sessions to wrapper agent names  
**Total**: 19 / 36 — **Size: M**  
**Routing**: `superpowers:brainstorming`  
**Generated**: 2026-07-16

## Dimension Scores

| Dimension | Score | Label | Key Reason |
|---|---|---|---|
| Component Scope | 4 | L | `BaseAgentAdapter` is the shared base class for all 7 agents — core shared utility; red flag applied |
| Requirements Clarity | 3 | M | Core requirements clear; gaps remain (registry aliasing approach undecided, backend API coordination unconfirmed, `codemie_cli` underscore variant has no codebase source) |
| Technical Risk | 4 | L | `AgentRegistry.getAgent(CODEMIE_AGENT)` is called at 3 sites in `hook.ts`; a naive env var change silently breaks session processing; backend API payload impact may require server coordination |
| File Change Estimate | 3 | M | 5–7 files across 3+ directories (`BaseAgentAdapter.ts`, `codex-agent.ts`, `types.ts`, possibly `hook.ts`, plus test updates) |
| Dependencies | 2 | S | No new packages; minor env var derivation change only |
| Affected Layers | 3 | M | Agent-Plugin layer + Analytics/Service layer + Session-Types; no DB schema, no external integration |

## Red Flags Applied

- Component Scope bumped from M (3) to L (4): `BaseAgentAdapter.ts` is a core shared utility and the change affects all 7 agent types flowing through it.

## Key Risks

1. **`AgentRegistry.getAgent(CODEMIE_AGENT)` dependency** — naive env var change silently breaks session processing at 3 call sites in `hook.ts`. Fix: derive wrapper name separately at the `CODEMIE_AGENT` assignment site while keeping `metadata.name` unchanged.
2. **Backend API payload change** — `sendSessionStartMetrics`/`sendSessionEndMetrics` pass `agentName` to the CodeMie API; changing the value changes API payloads. May require coordination with the server-side team.
3. **Backward compatibility** — existing session files on disk use short names. The analytics filter must treat `claude` and `codemie-claude` as the same family bidirectionally.
4. **`codemie_cli` legacy underscore variant** — no obvious codebase source; requires explicit special-case handling in the filter function.

## Split Recommendation

None — proceed as a single task.
