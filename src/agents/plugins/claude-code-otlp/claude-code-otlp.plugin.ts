
import { basename } from 'node:path';
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { AgentAdapterType, OtlpAdapterDeps, OtlpAgentAdapter } from '@/agents/core/types.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { BaseClaudeCodeHookEvent, ForwardDecision, toBaseClaudeCodeHookEvent } from './claude-code-otlp.types.js';
import { forwardOtlpEventToSpool } from '../utils.js';
import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';
import {
  collectMainTranscriptEvents,
  collectSubagentTranscriptEvents,
  type SubagentFile,
} from './transcript/orchestrator.js';
import { findSubagentFiles } from './transcript/subagent-usage.js';
import { exec } from '@/utils/exec.js';

export class ClaudeCodeOtlpPlugin implements OtlpAgentAdapter {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;
  public readonly type = AgentAdapterType.OTLP;

  /** Cached across calls so a high-frequency hook (e.g. PostToolUse) doesn't spawn a subprocess per call. */
  private clientVersion: string | undefined;
  private readonly platform = 'claude-code';

  public async processOtlpEvent(rawEvent: string, { ensureOtlpProxy }: OtlpAdapterDeps): Promise<void> {
    const event = toBaseClaudeCodeHookEvent(JSON.parse(rawEvent));

    // INVARIANT - do not weaken. An untracked project must produce NO hooks data
    // in the daemon spool, must not start the daemon, and must not run the SSO
    // check. The daemon has no allowlist of its own. Its completeness gate
    // (`otlp-spool/completeness-gate.ts`) only sends sessions that have hooks
    // data, and skips sessions that only have OTEL data. Forwarding a hook event
    // for an untracked project would make the session sendable and leak its
    // data to the backend.
    const isTracked = await isProjectTracked(event.cwd, await readAllowlistState());
    if (!isTracked) {
      logger.debug('[Claude Code OTLP plugin] project not in analytics allowlist, ignoring hook event');
      return;
    }

    await ensureOtlpProxy(this.name);

    const evaluation = await this.evaluate(rawEvent);
    if (evaluation.decision === 'block') {
      logger.error(`[Claude Code OTLP plugin] Blocking prompt: ${evaluation.reason}`);
      console.log(JSON.stringify(evaluation));
      return;
    }
    this.forwardToSpool(evaluation.payload);
  }

  private async evaluate(rawEvent: string): Promise<ForwardDecision> {
    const event = toBaseClaudeCodeHookEvent(JSON.parse(rawEvent));

    if (!event.sessionId) {
      return { decision: 'forward', payload: [rawEvent] };
    }

    if (event.hookEventName === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(rawEvent);
    }
    if (event.hookEventName === 'Stop') {
      return await this.onStopEvent(rawEvent, event);
    }
    if (event.hookEventName === 'PreCompact') {
      return await this.onPreCompactEvent(rawEvent, event);
    }
    if (event.hookEventName === 'StopFailure') {
      return await this.onStopFailureEvent(rawEvent, event);
    }
    if (event.hookEventName === 'SessionEnd') {
      return await this.onSessionEndEvent(rawEvent, event);
    }
    if (event.hookEventName === 'SubagentStop') {
      return await this.onSubagentStopEvent(rawEvent, event);
    }

    return { decision: 'forward', payload: [rawEvent] };
  }

  private async onStopEvent(rawEvent: string, event: BaseClaudeCodeHookEvent): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(event.sessionId, event.transcriptPath, 'Stop');
    return { decision: 'forward', payload: [rawEvent, ...derived] };
  }

  private async onPreCompactEvent(rawEvent: string, event: BaseClaudeCodeHookEvent): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(event.sessionId, event.transcriptPath, 'PreCompact');
    return { decision: 'forward', payload: [rawEvent, ...derived] };
  }

  private async onStopFailureEvent(rawEvent: string, event: BaseClaudeCodeHookEvent): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(event.sessionId, event.transcriptPath, 'StopFailure');
    return { decision: 'forward', payload: [rawEvent, ...derived] };
  }

  private async onSessionEndEvent(rawEvent: string, event: BaseClaudeCodeHookEvent): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(event.sessionId, event.transcriptPath, 'SessionEnd');

    // Backstop: guarantee every subagent discovered for this session gets at least one
    // agent.subagent.usage event, even when its own SubagentStop hook never fired.
    const subagentFiles = await findSubagentFiles(event.transcriptPath);
    for (const file of subagentFiles) {
      derived.push(...(await collectSubagentTranscriptEvents(event.sessionId, file)));
    }

    return { decision: 'forward', payload: [rawEvent, ...derived] };
  }

  private async onSubagentStopEvent(rawEvent: string, event: BaseClaudeCodeHookEvent): Promise<ForwardDecision> {
    if (!event.agentTranscriptPath) {
      return { decision: 'forward', payload: [rawEvent] };
    }

    const subagentFile: SubagentFile = {
      agentId: event.agentId ?? basename(event.agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      filePath: event.agentTranscriptPath,
      toolUseId: event.toolUseId,
      agentType: event.agentType,
    };

    const derived = await collectSubagentTranscriptEvents(event.sessionId, subagentFile);
    return { decision: 'forward', payload: [rawEvent, ...derived] };
  }

  private async ensureProxyAuth(): Promise<AuthGateResult> {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);

    return await ensureCodeMieSsoAuth({
      provider: config.provider,
      ssoUrl: config.codeMieUrl || config.baseUrl,
    });
  }

  private forwardToSpool(rawEvents: string[]): void {
    // Intentionally not awaited: forwardOtlpEventToSpool is fire-and-forget.
    for (const rawEvent of rawEvents) {
      forwardOtlpEventToSpool(rawEvent, CLAUDE_CODE_OTLP_AGENT_NAME);
    }
  }

  public async prepareAnalyticsFields(
    hookEvent: Record<string, unknown>
  ): Promise<Record<string, unknown>> {
    const fields: Record<string, unknown> = {
      platform: this.platform,
      entrypoint: process.env.CLAUDE_CODE_ENTRYPOINT ?? '',
      client_version: await this.getClientVersion(),
    };

    const agentId = readOptionalString(hookEvent, 'agent_id');
    if (agentId !== undefined) {
      fields.agent_id = agentId;
    }
    const agentType = readOptionalString(hookEvent, 'agent_type');
    if (agentType !== undefined) {
      fields.agent_type = agentType;
    }

    return fields;
  }

  private async getClientVersion(): Promise<string> {
    if (this.clientVersion === undefined) {
      this.clientVersion = await this.resolveClientVersion();
    }
    return this.clientVersion;
  }

  private async resolveClientVersion(): Promise<string> {
    try {
      const result = await exec('claude', ['--version']);
      const trimmed = result.stdout.trim();
      const versionMatch = trimmed.match(/^(\d+\.\d+\.\d+)/);
      return versionMatch ? versionMatch[1] : trimmed;
    } catch {
      return '';
    }
  }

  private async onUserPromptSubmit(rawEvent: string): Promise<ForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      return {
        decision: 'forward',
        payload: [rawEvent],
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

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}
