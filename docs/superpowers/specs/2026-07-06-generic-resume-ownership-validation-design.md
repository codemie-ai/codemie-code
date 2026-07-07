# Design: Generic Resume Ownership Validation

**Review context:** PR #403 CR-001  
**Date:** 2026-07-06  
**Status:** Draft for review  
**Complexity:** Medium

## Problem

The current resume ownership validation lives in `src/agents/core/AgentCLI.ts` but calls a Claude-specific lookup helper. That creates two problems:

1. Shared CLI code assumes Claude ownership semantics for every agent.
2. Agents that support `--resume` but do not use Claude-style session identifiers can be misclassified as external.
3. User-facing guidance in the shared CLI is hardcoded to `claude --resume <id>`.

The fix must be generic, keep slug-based resume IDs valid, and avoid breaking agents that do not implement ownership validation.

## Goals

1. Make resume ownership validation an optional agent capability, not a shared Claude assumption.
2. Preserve support for non-UUID resume IDs such as `session-slug`.
3. Keep the existing external-resume warning / consent / conversation-sync suppression flow for agents that explicitly support ownership validation.
4. Leave agents without ownership validation unchanged (`fail-open`).
5. Make fallback guidance and audit metadata agent-aware.

## Non-Goals

1. Defining ownership validation for every agent in this change.
2. Changing native agent resume semantics beyond validation and messaging.
3. Introducing a new registry or provider layer for resume validation.
4. Requiring UUID-format resume IDs.

## Chosen Approach

Add a new optional plugin method on the agent adapter contract:

- `resolveResumeOwnership(...)` is implemented by agents that can determine whether a resume target belongs to a CodeMie-managed session.
- `AgentCLI` calls that method only when the current adapter implements it.
- If the method is absent, `AgentCLI` proceeds normally with no warning or block.

This keeps ownership logic in the plugin layer, which matches the repository architecture:

- CLI layer coordinates prompts and user interaction.
- Plugin layer owns agent-specific resume semantics.
- Core types define the shared interface only.

## Rejected Alternatives

### 1. Metadata-only configuration

Rejected because ownership validation is behavioral, not declarative. Agents may need filesystem lookups, custom session formats, or future remote checks.

### 2. Separate validator registry

Rejected because it adds a new routing mechanism for a narrow capability that naturally belongs on the active adapter.

### 3. Keep Claude logic in `AgentCLI` with agent-name guards

Rejected because it preserves the wrong responsibility boundary and invites more agent-specific branching in shared CLI code.

## Proposed Interface

Add two new core types:

```ts
export interface ResumeOwnershipInput {
  resumeId: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface ResumeOwnershipResult {
  supported: boolean;
  owned?: boolean;
  fallbackResumeCommand?: string;
  auditData?: Record<string, unknown>;
}
```

Extend the agent adapter contract with an optional method:

```ts
resolveResumeOwnership?(
  input: ResumeOwnershipInput,
): Promise<ResumeOwnershipResult>;
```

### Semantics

- Method absent: agent does not participate in ownership validation.
- `supported: false`: agent explicitly declines validation; `AgentCLI` proceeds normally.
- `supported: true, owned: true`: proceed normally.
- `supported: true, owned: false`: show external-resume warning flow.

`fallbackResumeCommand` is optional but should be supplied by agents that implement validation so the CLI can display correct non-CodeMie guidance without hardcoding `claude`.

## Resume ID Rules

`--resume` values must remain format-agnostic.

Allowed examples:

- `session-slug`
- `epmcdme-12992`
- `abc-123`
- UUID-like native session ids

The CLI may sanitize control characters for safe display/logging, but it must not reject a resume ID simply because it is not a UUID.

The only invalid cases are:

1. missing `--resume` value
2. empty value after normalization

## AgentCLI Flow

When `--resume <id>` is present in `handleRun()`:

1. Normalize the value for display/logging by stripping control characters only.
2. Do not validate UUID shape.
3. Detect whether `this.adapter.resolveResumeOwnership` exists.
4. If the method does not exist, continue normally.
5. If it exists, call it with `{ resumeId, cwd: process.cwd(), env: process.env }`.
6. Interpret result:
   - unsupported => continue normally
   - owned => continue normally
   - external => run the existing warning / confirm / non-interactive-block flow
7. If the user confirms external resume:
   - inject `CODEMIE_CONV_SYNC_DISABLED=1` into subprocess env
   - set `process.env.CODEMIE_CONV_SYNC_DISABLED=1` for same-process consumers
   - write audit event using generic audit payload
8. If the user declines or non-interactive mode blocks:
   - write audit event using generic audit payload
   - exit with the existing blocked behavior

## Claude Plugin Behavior

Claude becomes the first implementation of the new capability.

Its resolver should:

1. Accept slug-based and UUID-like resume IDs equally.
2. Reuse the current ownership lookup helper over `~/.codemie/sessions/*.json`.
3. Return:
   - `supported: true`
   - `owned: true/false`
   - `fallbackResumeCommand: "claude --resume <id>"`
   - `auditData` containing Claude-specific identifiers if useful

The current helper name `scanSessionsForClaudeId()` can stay temporarily if that minimizes churn, but the shared CLI must no longer reference it directly.

## Audit Logging Changes

Shared audit events should no longer force Claude-specific field names in shared flow.

Recommended shape:

```jsonl
{"ts":"<ISO>","event":"resume_blocked","data":{"agent":"claude","resumeId":"session-slug"}}
{"ts":"<ISO>","event":"resume_external_confirmed","data":{"agent":"claude","resumeId":"session-slug"}}
```

Agent-specific extra fields may be merged through `auditData`.

This keeps the audit schema usable for non-Claude agents later.

## Error Handling

1. Resolver throws:
   - log debug/warn context
   - treat as unsupported and continue normally (`fail-open`)
2. Resolver returns malformed data:
   - treat as unsupported and continue normally
3. Non-interactive mode:
   - if external resume is detected for a supported agent, block as today
4. Missing fallback command:
   - use a generic message without an explicit native command example

## Files Expected To Change

| File | Change |
|------|--------|
| `src/agents/core/types.ts` | Add resume ownership input/result types and optional adapter method |
| `src/agents/core/AgentCLI.ts` | Replace Claude-specific validation with generic capability detection and result handling |
| `src/agents/core/BaseAgentAdapter.ts` | No-op support only if needed for typing or shared helpers |
| `src/agents/plugins/claude/claude.plugin.ts` and/or Claude session helper files | Implement `resolveResumeOwnership()` |
| `src/agents/core/session/session-origin-audit.ts` | Make shared audit payload generic enough for non-Claude agents |
| `src/agents/core/__tests__/AgentCLI-resume.test.ts` | Cover generic CLI behavior and slug-based IDs |
| `src/agents/plugins/__tests__/plugin-effort-resume.test.ts` or plugin-specific tests | Verify resume slug handling remains intact |

## Acceptance Criteria

1. `AgentCLI` contains no direct Claude-specific ownership lookup.
2. `codemie-claude --resume session-slug` remains valid and does not fail UUID validation.
3. Claude external resume still triggers warning / consent / sync suppression.
4. Agents without `resolveResumeOwnership()` continue current resume behavior unchanged.
5. Shared CLI messages no longer hardcode `claude --resume`.
6. Audit payload emitted from shared resume flow is generic enough for multi-agent use.

## Rollout Notes

This change should introduce the generic contract and migrate Claude first. Other agents can opt in later without additional `AgentCLI` branching.
