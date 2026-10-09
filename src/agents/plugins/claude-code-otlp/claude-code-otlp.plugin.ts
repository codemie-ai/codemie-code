
import { basename } from 'node:path';
import type {
  HookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
  UserPromptSubmitHookSpecificOutput,
} from '@anthropic-ai/claude-agent-sdk';
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { ConfigLoader } from '@/utils/config.js';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { type ClaudeForwardDecision, isClaudeCodeHookInput } from './claude-code-otlp.types.js';
import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';
import {
  collectMainTranscriptEvents,
  collectSubagentTranscriptEvents,
  subagentNeedsBackstop,
  type SubagentFile,
} from './transcript/orchestrator.js';
import { findSubagentFiles, readSubagentMeta } from './transcript/subagent-usage.js';
import { resolveClientVersion } from './client-version-cache.js';

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: 'agent.session.start',
  Stop: 'agent.session.stop',
  StopFailure: 'agent.turn.error',
  SessionEnd: 'agent.session.end',
  UserPromptSubmit: 'agent.prompt.submit',
  PreToolUse: 'agent.tool.start',
  PostToolUse: 'agent.tool.end',
  PostToolUseFailure: 'agent.tool.error',
  SubagentStart: 'agent.subagent.start',
  SubagentStop: 'agent.subagent.stop',
  PreCompact: 'agent.session.compact',
  Notification: 'agent.notification',
};

export class ClaudeCodeOtlpPlugin extends OtlpAgentAdapter<HookInput, UserPromptSubmitHookSpecificOutput> {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;

  protected extractHookContext(hookInput: HookInput): OtlpHookContext {
    return {
      cwd: hookInput.cwd,
      prompt: hookInput.hook_event_name === 'UserPromptSubmit' ? hookInput.prompt : undefined,
    };
  }

  protected parseHookInput(raw: string): HookInput | null {
    const parsed: unknown = JSON.parse(raw);
    return isClaudeCodeHookInput(parsed) ? parsed : null;
  }

  protected async isTracked(hookInput: HookInput): Promise<boolean> {
    return isProjectTracked(hookInput.cwd, await readAllowlistState());
  }

  /** Resolved once per call so every record in the batch shares one client-version lookup. */
  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {
      platform: 'claude-code',
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '',
      client_version: await resolveClientVersion(),
    };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['hook_event_name'] ?? '')] ?? 'agent.event';
  }

  protected async evaluate(hookInput: HookInput): Promise<ClaudeForwardDecision> {
    if (hookInput.hook_event_name === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(hookInput);
    }
    if (hookInput.hook_event_name === 'Stop') {
      return await this.onStopEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'PreCompact') {
      return await this.onPreCompactEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'StopFailure') {
      return await this.onStopFailureEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SessionEnd') {
      return await this.onSessionEndEvent(hookInput);
    }
    if (hookInput.hook_event_name === 'SubagentStop') {
      return await this.onSubagentStopEvent(hookInput);
    }

    return { decision: 'forward', payload: [hookInput] };
  }

  private async onStopEvent(hookInput: StopHookInput): Promise<ClaudeForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'Stop');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onPreCompactEvent(hookInput: PreCompactHookInput): Promise<ClaudeForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'PreCompact');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onStopFailureEvent(hookInput: StopFailureHookInput): Promise<ClaudeForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'StopFailure');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onSessionEndEvent(hookInput: SessionEndHookInput): Promise<ClaudeForwardDecision> {
    const { session_id: sessionId, transcript_path: transcriptPath } = hookInput;
    const derived = await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd');

    // Backstop: guarantee every subagent discovered for this session gets at least one
    // agent.subagent.usage event, even when its own SubagentStop hook never fired. Skipped for an
    // agent whose offset already covers the whole file — its own SubagentStop (or an earlier
    // backstop pass) already reported it and nothing was appended since, so re-running here would
    // only resend the same event as a duplicate.
    const subagentFiles = await findSubagentFiles(transcriptPath);
    for (const rawFile of subagentFiles) {
      // The sidecar carries no cwd/worktree of its own — the SessionEnd hook's cwd is the best
      // available stand-in (subagents share their parent session's cwd).
      const file: SubagentFile = { ...rawFile, cwd: hookInput.cwd };
      if (await subagentNeedsBackstop(sessionId, file)) {
        derived.push(...(await collectSubagentTranscriptEvents(sessionId, file)));
      }
    }

    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onSubagentStopEvent(hookInput: SubagentStopHookInput): Promise<ClaudeForwardDecision> {
    if (!hookInput.agent_type) {
      // Claude Code's own internal check-ins ("is it done yet?") fire SubagentStop with no
      // agent_type — not a real subagent, so nothing is derived or forwarded for it.
      return { decision: 'forward', payload: [] };
    }

    const agentTranscriptPath = hookInput.agent_transcript_path;
    if (!agentTranscriptPath) {
      return { decision: 'forward', payload: [hookInput] };
    }

    const meta = await readSubagentMeta(agentTranscriptPath);
    const subagentFile: SubagentFile = {
      agentId: hookInput.agent_id || basename(agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      filePath: agentTranscriptPath,
      // `tool_use_id` is not declared on the SDK's SubagentStopHookInput type; the hook payload
      // wins when it carries it anyway, else fall back to the `.meta.json` sidecar.
      toolUseId: readOptionalString(hookInput, 'tool_use_id') ?? meta.toolUseId,
      agentType: hookInput.agent_type,
      spawnDepth: meta.spawnDepth,
      description: meta.description,
      cwd: hookInput.cwd,
    };

    const derived = await collectSubagentTranscriptEvents(hookInput.session_id, subagentFile);
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async ensureProxyAuth(): Promise<AuthGateResult> {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);

    return await ensureCodeMieSsoAuth({
      provider: config.provider,
      ssoUrl: config.codeMieUrl || config.baseUrl,
    });
  }

  private async onUserPromptSubmit(hookInput: UserPromptSubmitHookInput): Promise<ClaudeForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      return {
        decision: 'forward',
        payload: [hookInput],
      }
    }

    return {
      decision: 'block',
      reason: [
        `CodeMie SSO authentication is invalid - you are blocked until you re-authenticate (${authResult.reason}).`,
        "A browser sign-in window has been opened automatically.",
        "Complete the sign-in, then re-send your prompt.",
      ].join("\n"),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        suppressOriginalPrompt: true,
      }
    }
  }
}

/**
 * Reads a string field not declared on the SDK's `HookInput` typings (e.g. `tool_use_id` on
 * `SubagentStop`), in case the raw hook payload carries it anyway.
 */
function readOptionalString(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
