
import { basename } from 'node:path';
import type {
  HookInput,
  PreCompactHookInput,
  SessionEndHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStopHookInput,
  UserPromptSubmitHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { AgentAdapterType, OtlpAdapterDeps, OtlpAgentAdapter } from '@/agents/core/types.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { ForwardDecision, isClaudeCodeHookInput } from './claude-code-otlp.types.js';
import { forwardOtlpEventToSpool } from '../utils.js';
import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';
import {
  collectMainTranscriptEvents,
  collectSubagentTranscriptEvents,
  type SubagentFile,
} from './transcript/orchestrator.js';
import { findSubagentFiles } from './transcript/subagent-usage.js';
import { resolveClientVersion } from './client-version-cache.js';

export class ClaudeCodeOtlpPlugin implements OtlpAgentAdapter {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;
  public readonly type = AgentAdapterType.OTLP;

  public async processOtlpEvent(rawHookInput: string, { ensureOtlpProxy }: OtlpAdapterDeps): Promise<void> {
    const hookInput: unknown = JSON.parse(rawHookInput);
    if (!isClaudeCodeHookInput(hookInput)) {
      logger.debug('[Claude Code OTLP plugin] hook payload missing session_id/cwd/hook_event_name, ignoring');
      return;
    }

    // INVARIANT - do not weaken. An untracked project must produce NO hooks data
    // in the daemon spool, must not start the daemon, and must not run the SSO
    // check. The daemon has no allowlist of its own. Its completeness gate
    // (`otlp-spool/completeness-gate.ts`) only sends sessions that have hooks
    // data, and skips sessions that only have OTEL data. Forwarding a hook event
    // for an untracked project would make the session sendable and leak its
    // data to the backend.
    const isTracked = await isProjectTracked(hookInput.cwd, await readAllowlistState());
    if (!isTracked) {
      logger.debug('[Claude Code OTLP plugin] project not in analytics allowlist, ignoring hook event');
      return;
    }

    await ensureOtlpProxy(this.name);

    const evaluation = await this.evaluate(hookInput);
    if (evaluation.decision === 'block') {
      logger.error(`[Claude Code OTLP plugin] Blocking prompt: ${evaluation.reason}`);
      console.log(JSON.stringify(evaluation));
      return;
    }
    this.forwardToSpool(await this.withCommonFields(evaluation.payload));
  }

  /** Resolved once per call so every record in the batch shares one client-version lookup. */
  private async withCommonFields(records: Record<string, unknown>[]): Promise<Record<string, unknown>[]> {
    const common = {
      platform: 'claude-code',
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '',
      client_version: await resolveClientVersion(),
    };
    return records.map((record) => ({ ...record, ...common }));
  }

  private async evaluate(hookInput: HookInput): Promise<ForwardDecision> {
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

  private async onStopEvent(hookInput: StopHookInput): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'Stop');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onPreCompactEvent(hookInput: PreCompactHookInput): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'PreCompact');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onStopFailureEvent(hookInput: StopFailureHookInput): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(hookInput.session_id, hookInput.transcript_path, 'StopFailure');
    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onSessionEndEvent(hookInput: SessionEndHookInput): Promise<ForwardDecision> {
    const { session_id: sessionId, transcript_path: transcriptPath } = hookInput;
    const derived = await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd');

    // Backstop: guarantee every subagent discovered for this session gets at least one
    // agent.subagent.usage event, even when its own SubagentStop hook never fired.
    const subagentFiles = await findSubagentFiles(transcriptPath);
    for (const file of subagentFiles) {
      derived.push(...(await collectSubagentTranscriptEvents(sessionId, file)));
    }

    return { decision: 'forward', payload: [hookInput, ...derived] };
  }

  private async onSubagentStopEvent(hookInput: SubagentStopHookInput): Promise<ForwardDecision> {
    const agentTranscriptPath = hookInput.agent_transcript_path;
    if (!agentTranscriptPath) {
      return { decision: 'forward', payload: [hookInput] };
    }

    const subagentFile: SubagentFile = {
      agentId: hookInput.agent_id || basename(agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      filePath: agentTranscriptPath,
      // `tool_use_id` is not declared on the SDK's SubagentStopHookInput type; read it
      // defensively in case the raw hook payload carries it anyway.
      toolUseId: readOptionalString(hookInput, 'tool_use_id'),
      agentType: hookInput.agent_type,
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

  private forwardToSpool(events: Record<string, unknown>[]): void {
    // Intentionally not awaited: forwardOtlpEventToSpool is fire-and-forget.
    for (const event of events) {
      forwardOtlpEventToSpool(event, CLAUDE_CODE_OTLP_AGENT_NAME);
    }
  }

  private async onUserPromptSubmit(hookInput: UserPromptSubmitHookInput): Promise<ForwardDecision> {
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
