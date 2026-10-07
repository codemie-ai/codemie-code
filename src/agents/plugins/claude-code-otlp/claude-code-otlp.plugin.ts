
import { basename } from 'node:path';
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { AgentAdapterType, OtlpAdapterDeps, OtlpAgentAdapter } from '@/agents/core/types.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { ForwardDecision } from './claude-code-otlp.types.js';
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

  public async processOtlpEvent(rawEvent: string, { ensureOtlpProxy }: OtlpAdapterDeps): Promise<void> {
    const event = JSON.parse(rawEvent) as Record<string, unknown>;

    // INVARIANT - do not weaken. An untracked project must produce NO hooks data
    // in the daemon spool, must not start the daemon, and must not run the SSO
    // check. The daemon has no allowlist of its own. Its completeness gate
    // (`otlp-spool/completeness-gate.ts`) only sends sessions that have hooks
    // data, and skips sessions that only have OTEL data. Forwarding a hook event
    // for an untracked project would make the session sendable and leak its
    // data to the backend.
    const isTracked = await isProjectTracked(readString(event, 'cwd'), await readAllowlistState());
    if (!isTracked) {
      logger.debug('[Claude Code OTLP plugin] project not in analytics allowlist, ignoring hook event');
      return;
    }

    await ensureOtlpProxy(this.name);

    const evaluation = await this.evaluate(event);
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

  private async evaluate(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const sessionId = readString(parsed, 'session_id');
    if (!sessionId) {
      return { decision: 'forward', payload: [parsed] };
    }

    const hookEventName = readString(parsed, 'hook_event_name');
    if (hookEventName === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(parsed);
    }
    if (hookEventName === 'Stop') {
      return await this.onStopEvent(parsed);
    }
    if (hookEventName === 'PreCompact') {
      return await this.onPreCompactEvent(parsed);
    }
    if (hookEventName === 'StopFailure') {
      return await this.onStopFailureEvent(parsed);
    }
    if (hookEventName === 'SessionEnd') {
      return await this.onSessionEndEvent(parsed);
    }
    if (hookEventName === 'SubagentStop') {
      return await this.onSubagentStopEvent(parsed);
    }

    return { decision: 'forward', payload: [parsed] };
  }

  private async onStopEvent(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(
      readString(parsed, 'session_id'),
      readString(parsed, 'transcript_path'),
      'Stop'
    );
    return { decision: 'forward', payload: [parsed, ...derived] };
  }

  private async onPreCompactEvent(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(
      readString(parsed, 'session_id'),
      readString(parsed, 'transcript_path'),
      'PreCompact'
    );
    return { decision: 'forward', payload: [parsed, ...derived] };
  }

  private async onStopFailureEvent(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const derived = await collectMainTranscriptEvents(
      readString(parsed, 'session_id'),
      readString(parsed, 'transcript_path'),
      'StopFailure'
    );
    return { decision: 'forward', payload: [parsed, ...derived] };
  }

  private async onSessionEndEvent(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const sessionId = readString(parsed, 'session_id');
    const transcriptPath = readString(parsed, 'transcript_path');
    const derived = await collectMainTranscriptEvents(sessionId, transcriptPath, 'SessionEnd');

    // Backstop: guarantee every subagent discovered for this session gets at least one
    // agent.subagent.usage event, even when its own SubagentStop hook never fired.
    const subagentFiles = await findSubagentFiles(transcriptPath);
    for (const file of subagentFiles) {
      derived.push(...(await collectSubagentTranscriptEvents(sessionId, file)));
    }

    return { decision: 'forward', payload: [parsed, ...derived] };
  }

  private async onSubagentStopEvent(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const agentTranscriptPath = readOptionalString(parsed, 'agent_transcript_path');
    if (!agentTranscriptPath) {
      return { decision: 'forward', payload: [parsed] };
    }

    const subagentFile: SubagentFile = {
      agentId:
        readOptionalString(parsed, 'agent_id') ??
        basename(agentTranscriptPath).replace(/^agent-/, '').replace(/\.jsonl$/, ''),
      filePath: agentTranscriptPath,
      toolUseId: readOptionalString(parsed, 'tool_use_id'),
      agentType: readOptionalString(parsed, 'agent_type'),
    };

    const derived = await collectSubagentTranscriptEvents(readString(parsed, 'session_id'), subagentFile);
    return { decision: 'forward', payload: [parsed, ...derived] };
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

  private async onUserPromptSubmit(parsed: Record<string, unknown>): Promise<ForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      return {
        decision: 'forward',
        payload: [parsed],
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

function readString(record: Record<string, unknown>, key: string): string {
  return readOptionalString(record, key) ?? '';
}
