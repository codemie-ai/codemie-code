# Generic Resume Ownership Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move resume ownership validation out of shared Claude-specific CLI logic into an optional agent capability, while preserving slug-based resume IDs such as `codemie-claude --resume session-slug`.

**Architecture:** Add a new optional resume-ownership capability to the agent adapter contract in core types, let `AgentCLI` invoke it generically with fail-open behavior, and migrate Claude to implement the capability as the first adopter. Keep prompt/consent and conversation-sync suppression in `AgentCLI`, but make fallback messaging and audit payloads agent-aware instead of Claude-hardcoded.

**Tech Stack:** TypeScript, Node.js 20+, Commander.js, Vitest

## Global Constraints

- Follow the plugin-based 5-layer architecture: CLI coordinates prompts, plugin layer owns agent-specific resume semantics, core types define the shared contract.
- Do not add UUID validation for `--resume`; slug-like values such as `session-slug`, `epmcdme-12992`, and `abc-123` must remain valid.
- Agents without resume ownership support must remain unchanged (`fail-open`).
- Shared CLI code must not call Claude-specific ownership helpers directly.
- Shared CLI messaging must not hardcode `claude --resume`.
- Per repository policy, do not write or run tests unless explicitly requested by the user.

---

### Task 1: Add Generic Resume Ownership Contract And CLI Flow

**Files:**
- Modify: `src/agents/core/types.ts`
- Modify: `src/agents/core/AgentCLI.ts`

**Interfaces:**
- Consumes: existing `AgentAdapter` interface in `src/agents/core/types.ts`
- Produces:
  - `ResumeOwnershipInput`
  - `ResumeOwnershipResult`
  - `AgentAdapter.resolveResumeOwnership?(input: ResumeOwnershipInput): Promise<ResumeOwnershipResult>`
  - `AgentCLI` generic resume handling that uses adapter capability when present

- [ ] **Step 1: Add core resume ownership types to the agent contract**

Insert the new types near the `AgentAdapter` interface in `src/agents/core/types.ts`:

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

Extend `AgentAdapter` with the optional method:

```ts
  /**
   * Resolve whether a native resume target belongs to a CodeMie-managed session.
   * Agents that do not support ownership validation may omit this capability.
   */
  resolveResumeOwnership?(
    input: ResumeOwnershipInput,
  ): Promise<ResumeOwnershipResult>;
```

- [ ] **Step 2: Refactor the generic resume branch in `AgentCLI` to use the optional capability**

Replace the Claude-specific block in `src/agents/core/AgentCLI.ts` around the current `options.resume` handling with logic equivalent to:

```ts
      if (options.resume) {
        const resumeId = (options.resume as string).replace(/\p{Cc}/gu, '');
        const resolveResumeOwnership = this.adapter.resolveResumeOwnership?.bind(this.adapter);

        if (resolveResumeOwnership && resumeId) {
          let ownership: import('./types.js').ResumeOwnershipResult | undefined;

          try {
            ownership = await resolveResumeOwnership({
              resumeId,
              cwd: process.cwd(),
              env: process.env,
            });
          } catch (error) {
            logger.debug('[AgentCLI] Resume ownership resolver failed; proceeding without validation', {
              agent: this.adapter.name,
              resumeId,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          const isExternal = ownership?.supported === true && ownership.owned === false;

          if (isExternal) {
            const confirmed = await this.promptExternalResume(
              resumeId,
              ownership?.fallbackResumeCommand,
            );
            const { appendAuditEvent } = await import('./session/session-origin-audit.js');
            const auditData = {
              agent: this.adapter.name,
              resumeId,
              ...(ownership?.auditData ?? {}),
            };

            if (!confirmed) {
              appendAuditEvent('resume_blocked', auditData);
              process.exit(1);
            }

            Object.assign(providerEnv, buildResumeEnvOverride(true));
            process.env.CODEMIE_CONV_SYNC_DISABLED = '1';
            appendAuditEvent('resume_external_confirmed', auditData);
            logger.info(`[AgentCLI] External resume confirmed for agent ${this.adapter.name}; conversation sync suppressed`);
          }
        }
      }
```

- [ ] **Step 3: Make the external-resume prompt agent-aware instead of Claude-hardcoded**

Update `promptExternalResume` in `src/agents/core/AgentCLI.ts` to accept an optional fallback command:

```ts
  private async promptExternalResume(
    sessionId: string,
    fallbackResumeCommand?: string,
  ): Promise<boolean> {
    const fallbackLine = fallbackResumeCommand
      ? `Use '${fallbackResumeCommand}' to resume without CodeMie tracking.\n`
      : 'Resume without CodeMie tracking using the native agent CLI.\n';

    if (shouldBlockNonInteractiveResume()) {
      console.error(
        chalk.red(`\n✗ Session ${sessionId} was not created through CodeMie.\n`) +
        chalk.white('Non-interactive mode: resume blocked.\n') +
        chalk.white(fallbackLine)
      );
      return false;
    }

    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout });

    console.log(chalk.yellow(`\n⚠  Warning: Session ${sessionId} was not created through CodeMie.`));
    console.log(chalk.white('If you continue:'));
    console.log(chalk.white('  • Token usage and API metrics WILL be tracked via the CodeMie proxy.'));
    console.log(chalk.white('  • Conversation transcript will NOT be synced to your CodeMie account history.\n'));
    console.log(chalk.dim(fallbackResumeCommand
      ? `To resume without any CodeMie tracking, use: ${fallbackResumeCommand}\n`
      : 'To resume without any CodeMie tracking, use the native agent CLI.\n'));

    try {
      const answer = await new Promise<string>((resolve) => {
        rl.question(chalk.yellow('Continue with CodeMie? (y/N): '), resolve);
      });
      return answer.trim().toLowerCase() === 'y';
    } finally {
      rl.close();
    }
  }
```

- [ ] **Step 4: Verify the code still preserves slug-based IDs by construction**

Confirm the final `AgentCLI` resume logic still only does:

```ts
const resumeId = (options.resume as string).replace(/\p{Cc}/gu, '');
```

and does **not** add any UUID regex, parser, or `validate()` call. No additional code should reject values like:

```ts
'session-slug'
'epmcdme-12992'
'abc-123'
```

### Task 2: Implement Claude As The First Resume Ownership Provider

**Files:**
- Modify: `src/agents/plugins/claude/claude.plugin.ts`
- Reuse: `src/agents/core/session/session-ownership.ts`

**Interfaces:**
- Consumes:
  - `ResumeOwnershipInput`
  - `ResumeOwnershipResult`
  - `scanSessionsForClaudeId(claudeSessionId: string, sessionsDir?: string): boolean`
- Produces:
  - `ClaudePlugin.resolveResumeOwnership(input): Promise<ResumeOwnershipResult>`

- [ ] **Step 1: Import the new resume ownership types into the Claude plugin**

Update the Claude plugin type import to include the new interfaces:

```ts
import { AgentMetadata } from '../../core/types.js';
```

becomes:

```ts
import type {
  AgentMetadata,
  ResumeOwnershipInput,
  ResumeOwnershipResult,
} from '../../core/types.js';
```

Keep existing value imports intact.

- [ ] **Step 2: Add the Claude implementation of the optional adapter method**

Inside `export class ClaudePlugin extends BaseAgentAdapter`, add:

```ts
  async resolveResumeOwnership(
    input: ResumeOwnershipInput,
  ): Promise<ResumeOwnershipResult> {
    const { scanSessionsForClaudeId } = await import('../../core/session/session-ownership.js');
    const owned = scanSessionsForClaudeId(input.resumeId);

    return {
      supported: true,
      owned,
      fallbackResumeCommand: `claude --resume ${input.resumeId}`,
      auditData: {
        nativeAgent: 'claude',
        nativeResumeId: input.resumeId,
      },
    };
  }
```

This preserves slug support because `input.resumeId` is treated as an opaque string.

- [ ] **Step 3: Keep the shared CLI decoupled from the Claude helper**

Ensure the final codebase has:

- no `scanSessionsForClaudeId` import in `src/agents/core/AgentCLI.ts`
- the helper used only from Claude plugin code (or Claude-owned helper code)

The shared CLI should interact only with:

```ts
this.adapter.resolveResumeOwnership?.(...)
```

### Task 3: Make Shared Audit Payloads Generic And Update Tests

**Files:**
- Modify: `src/agents/core/session/session-origin-audit.ts`
- Modify: `src/agents/core/__tests__/AgentCLI-resume.test.ts`
- Modify: `src/agents/core/__tests__/session-origin-audit.test.ts`
- Optionally modify: `src/agents/plugins/__tests__/plugin-effort-resume.test.ts`

**Interfaces:**
- Consumes:
  - `appendAuditEvent(event: AuditEventName, data: Record<string, unknown>, logsDir?: string): void`
  - `buildResumeEnvOverride(isExternal: boolean): Record<string, string>`
  - `shouldBlockNonInteractiveResume(): boolean`
- Produces:
  - generic audit payload expectations using `resumeId` / `agent`
  - updated test coverage for slug-based resume IDs and fail-open adapter behavior

- [ ] **Step 1: Keep audit writer generic; stop encoding Claude-specific shared payload names in the plan**

No signature change is required in `src/agents/core/session/session-origin-audit.ts`, but the shared resume flow must now call it with generic payloads like:

```ts
appendAuditEvent('resume_blocked', {
  agent: this.adapter.name,
  resumeId,
  ...(ownership?.auditData ?? {}),
});
```

and:

```ts
appendAuditEvent('resume_external_confirmed', {
  agent: this.adapter.name,
  resumeId,
  ...(ownership?.auditData ?? {}),
});
```

- [ ] **Step 2: Expand `AgentCLI` unit tests to cover generic fail-open and slug support**

Replace or extend `src/agents/core/__tests__/AgentCLI-resume.test.ts` with focused pure-function / helper coverage:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildResumeEnvOverride, shouldBlockNonInteractiveResume } from '../AgentCLI.js';

describe('buildResumeEnvOverride', () => {
  it('returns CODEMIE_CONV_SYNC_DISABLED=1 for an external confirmed resume', () => {
    expect(buildResumeEnvOverride(true)).toEqual({ CODEMIE_CONV_SYNC_DISABLED: '1' });
  });

  it('returns empty object for a CodeMie-owned or unsupported resume', () => {
    expect(buildResumeEnvOverride(false)).toEqual({});
  });
});

describe('slug resume IDs', () => {
  it('preserves slug-like resume ids after control-char stripping', () => {
    const resumeId = 'session-slug'.replace(/\p{Cc}/gu, '');
    expect(resumeId).toBe('session-slug');
  });

  it('preserves ticket-like resume ids after control-char stripping', () => {
    const resumeId = 'epmcdme-12992'.replace(/\p{Cc}/gu, '');
    expect(resumeId).toBe('epmcdme-12992');
  });
});

describe('shouldBlockNonInteractiveResume', () => {
  let origNoPrompts: string | undefined;

  beforeEach(() => {
    origNoPrompts = process.env.CODEMIE_NO_PROMPTS;
  });

  afterEach(() => {
    if (origNoPrompts === undefined) delete process.env.CODEMIE_NO_PROMPTS;
    else process.env.CODEMIE_NO_PROMPTS = origNoPrompts;
  });

  it('returns true when CODEMIE_NO_PROMPTS=1', () => {
    process.env.CODEMIE_NO_PROMPTS = '1';
    expect(shouldBlockNonInteractiveResume()).toBe(true);
  });
});
```

Keep this task limited to tests explicitly tied to the new generic behavior; do not broaden scope.

- [ ] **Step 3: Update audit tests to assert generic shared payloads are accepted**

In `src/agents/core/__tests__/session-origin-audit.test.ts`, add a case like:

```ts
  it('writes generic resume audit payloads for any agent', () => {
    appendAuditEvent(
      'resume_blocked',
      { agent: 'claude', resumeId: 'session-slug', nativeResumeId: 'session-slug' },
      join(TMP, 'logs'),
    );

    const lines = readFileSync(auditFile, 'utf-8').trim().split('\n');
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe('resume_blocked');
    expect(parsed.data.agent).toBe('claude');
    expect(parsed.data.resumeId).toBe('session-slug');
  });
```

- [ ] **Step 4: Keep plugin resume mapping coverage aligned with slug support**

If needed, add one slug-oriented assertion to `src/agents/plugins/__tests__/plugin-effort-resume.test.ts` for Claude:

```ts
it('maps --resume <slug> to -r <slug>', () => {
  const args = ['-p', 'do the thing', '--resume', 'session-slug'];
  const result = transformFlags(args, ClaudePluginMetadata.flagMappings!, mockConfig);
  expect(result).toEqual(['-p', 'do the thing', '-r', 'session-slug']);
});
```

Only add this if current coverage does not already make slug support obvious enough.

## Self-Review

Spec coverage:
- Generic optional adapter capability: Task 1
- Fail-open behavior: Task 1
- Slug-based resume IDs: Tasks 1 and 3
- Claude-first implementation: Task 2
- Generic audit payloads and non-hardcoded messaging: Tasks 1 and 3

Placeholder scan:
- All changed files are named explicitly.
- All produced interfaces are named explicitly.
- No TODO/TBD placeholders remain.

Type consistency:
- `ResumeOwnershipInput`, `ResumeOwnershipResult`, and `resolveResumeOwnership()` are defined in Task 1 and consumed consistently in Tasks 1 and 2.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-generic-resume-ownership-validation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
