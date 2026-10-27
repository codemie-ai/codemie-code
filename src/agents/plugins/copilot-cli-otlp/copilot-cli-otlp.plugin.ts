import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import { isCopilotProjectTracked, readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { getCopilotSessionStateRoot } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import { readCopilotEventsTolerant } from '@/agents/plugins/copilot-cli/copilot-cli.storage-utils.js';
import { extractCopilotUsage } from '@/agents/plugins/copilot-cli/copilot-cli.usage.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from './copilot-cli-otlp.constants.js';
import { type CliBlockOutput, type CliForwardDecision, type CopilotCliHookInput, isCopilotCliHookInput } from './copilot-cli-otlp.types.js';

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  sessionStart: 'agent.session.start',
  sessionEnd: 'agent.session.end',
  userPromptTransformed: 'agent.prompt.submit',
  preToolUse: 'agent.tool.start',
  postToolUse: 'agent.tool.end',
  postToolUseFailure: 'agent.tool.error',
  agentStop: 'agent.session.stop',
  subagentStart: 'agent.subagent.start',
  subagentStop: 'agent.subagent.stop',
  errorOccurred: 'agent.turn.error',
  preCompact: 'agent.session.compact',
  notification: 'agent.notification',
};

/** Enforcement points: replace the prompt, deny the tool. */
const ENFORCED_EVENTS = new Set(['userPromptTransformed', 'preToolUse']);

const FREE_TEXT_MAX_CHARS = 300;

export class CopilotCliOtlpPlugin extends OtlpAgentAdapter<CopilotCliHookInput, CliBlockOutput> {
  public readonly name = COPILOT_CLI_OTLP_AGENT_NAME;

  protected parseHookInput(raw: string): CopilotCliHookInput | null {
    const parsed: unknown = JSON.parse(raw);
    return isCopilotCliHookInput(parsed) ? parsed : null;
  }

  protected extractHookContext(input: CopilotCliHookInput): OtlpHookContext {
    return {
      cwd: input.cwd,
      prompt: input.codemieEventName === 'userPromptTransformed' ? input.prompt : undefined,
    };
  }

  protected async isTracked(input: CopilotCliHookInput): Promise<boolean> {
    // A managed `copilot-cli` launch sets CODEMIE_SESSION_ID for its own child
    // process; a native invocation of this hook file never carries it. Without this guard a
    // global COPILOT_HOME would make managed sessions double-counted by both pipelines.
    if (process.env.CODEMIE_SESSION_ID) {
      return false;
    }
    return isCopilotProjectTracked(input.cwd, await readCopilotConnectorScope(this.name));
  }

  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {
      platform: 'copilot-cli',
      // The host version is not detected: left empty rather than guessed.
      client_version: '',
    };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['codemieEventName'] ?? '')] ?? 'agent.event';
  }

  protected buildEventId(
    event: Record<string, unknown>,
    payload: Record<string, unknown>,
    timestamp: string
  ): string {
    const content = JSON.stringify({ ...payload, timestamp }) ?? 'null';
    const digest = createHash('sha256').update(content).digest('hex');
    return `${String(event['type'] ?? '')}:${String(event['session_id'] ?? '')}:${digest}`;
  }

  protected requiresSpoolAcceptance(input: CopilotCliHookInput): boolean {
    return ENFORCED_EVENTS.has(input.codemieEventName);
  }

  protected async evaluate(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    if (input.codemieEventName === 'userPromptTransformed') {
      return this.onEnforcedEvent(input, 'userPromptTransformed');
    }
    if (input.codemieEventName === 'preToolUse') {
      return this.onEnforcedEvent(input, 'preToolUse');
    }
    if (input.codemieEventName === 'sessionEnd') {
      return this.onSessionEnd(input);
    }
    return { decision: 'forward', payload: [this.normalizeEvent(input)] };
  }

  private async onEnforcedEvent(
    input: CopilotCliHookInput,
    eventName: 'userPromptTransformed' | 'preToolUse'
  ): Promise<CliForwardDecision> {
    const authResult = await this.ensureProxyAuth();
    if (authResult.ok) {
      return { decision: 'forward', payload: [this.normalizeEvent(input)] };
    }
    return this.buildBlock(eventName, authResult.reason);
  }

  private async onSessionEnd(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const event = this.normalizeEvent(input);
    this.attachUsage(event, input.sessionId);
    // No later hook retries a failed SessionEnd batch, so it gets one in-process resend
    // (mirrors Claude's SessionEnd handling).
    return { decision: 'forward', payload: [event], retryOnce: true };
  }

  /**
   * Reuses the managed plugin's `extractCopilotUsage` on the session's own `events.jsonl`.
   * This is a cumulative per-model session rollup, never per-request deltas — the field
   * names below are NOT a confirmed backend wire contract; they exist so the data is
   * captured and available once that contract is confirmed, not to claim it is already
   * consumed by any dashboard.
   */
  private attachUsage(event: Record<string, unknown>, sessionId: string): void {
    try {
      const eventsPath = join(getCopilotSessionStateRoot(), sessionId, 'events.jsonl');
      const events = readCopilotEventsTolerant(eventsPath);
      if (events.length === 0) {
        event.usage_unavailable_reason = 'session-state events.jsonl not found or empty';
        return;
      }
      const extract = extractCopilotUsage(events);
      if (extract.messages.length === 0) {
        event.usage_unavailable_reason = extract.unavailableReason ?? 'no usage data in transcript';
        return;
      }
      event.usage_models = extract.messages;
      event.usage_partial = extract.partial;
      if (extract.premiumRequests !== undefined) {
        event.usage_premium_requests = extract.premiumRequests;
      }
    } catch (error) {
      logger.debug(`[${this.name}] usage extraction failed: ${error instanceof Error ? error.message : String(error)}`);
      event.usage_unavailable_reason = 'usage extraction failed';
    }
  }

  /** Normalizes camelCase native fields to the base class's expected keys, before truncation. */
  private normalizeEvent(input: CopilotCliHookInput): Record<string, unknown> {
    const normalized: Record<string, unknown> = {
      session_id: input.sessionId,
      timestamp: new Date(input.timestamp).toISOString(),
      type: HOOK_EVENT_TYPE_MAP[input.codemieEventName] ?? 'agent.event',
    };

    if (input.source !== undefined) normalized.source = this.boundedFreeText(input.source);
    if (input.reason !== undefined) normalized.reason = this.boundedFreeText(input.reason);
    if (input.prompt !== undefined) normalized.prompt = input.prompt;
    if (input.toolName !== undefined) normalized.tool_name = this.boundedFreeText(input.toolName);
    if (input.toolCallId !== undefined) normalized.tool_use_id = this.boundedFreeText(input.toolCallId);
    if (input.toolArgs !== undefined) {
      normalized.tool_input = input.toolArgs;
    }
    if (input.toolResult?.textResultForLlm !== undefined) {
      normalized.tool_response = input.toolResult.textResultForLlm;
    }
    if (input.error !== undefined) {
      const err = input.error;
      if (typeof err === 'object' && err !== null) {
        const errRecord = err as Record<string, unknown>;
        if ('message' in errRecord) {
          normalized.error_message = this.boundedFreeText(errRecord.message);
        }
        // errorOccurred forwards error.name alongside error.message; never the stack.
        if (typeof errRecord.name === 'string') {
          normalized.error_type = this.boundedFreeText(errRecord.name);
        }
      } else {
        normalized.error_message = this.boundedFreeText(err);
      }
    }
    if (input.errorContext !== undefined) {
      normalized.error_context = this.boundedFreeText(input.errorContext);
    }
    if (input.recoverable !== undefined) normalized.recoverable = input.recoverable;
    if (input.agentName !== undefined) normalized.agent_name = this.boundedFreeText(input.agentName);
    if (input.agentId !== undefined) normalized.agent_id = this.boundedFreeText(input.agentId);
    if (input.agentType !== undefined) normalized.agent_type = this.boundedFreeText(input.agentType);
    if (input.trigger !== undefined) normalized.trigger = this.boundedFreeText(input.trigger);
    if (input.title !== undefined) {
      normalized.title = this.boundedFreeText(input.title);
    }
    if (input.notification_type !== undefined) {
      normalized.notification_type = this.boundedFreeText(input.notification_type);
    }
    if (input.message !== undefined) {
      normalized.message = this.boundedFreeText(input.message);
    }
    return normalized;
  }

  /** R11: free-text fields outside the base class's four truncated keys must still be bounded. */
  private boundedFreeText(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return text.slice(0, FREE_TEXT_MAX_CHARS);
  }

  private buildBlock(
    eventName: 'userPromptTransformed' | 'preToolUse',
    reason: string | undefined,
    authenticationFailure = true
  ): Extract<CliForwardDecision, { decision: 'block' }> {
    const logMessage = authenticationFailure
      ? `CodeMie SSO authentication is invalid (${reason ?? 'unknown reason'}).`
      : `CodeMie cannot safely process this event (${reason ?? 'unknown reason'}).`;

    const userMessage = authenticationFailure
      ? 'CodeMie sign-in required — complete the browser sign-in and resend your prompt.'
      : 'CodeMie hit an internal error and cannot process this event — check the CodeMie logs, then resend your prompt.';

    const hookSpecificOutput: CliBlockOutput =
      eventName === 'preToolUse'
        ? { permissionDecision: 'deny', permissionDecisionReason: userMessage }
        : {
            modifiedTransformedPrompt:
              `${authenticationFailure ? 'CodeMie sign-in required' : 'CodeMie internal error'}. Reply only with: "${userMessage}" Do not use any tools.`,
          };

    return { decision: 'block', reason: logMessage, hookSpecificOutput };
  }

  /** GitHub's CLI hook output protocol is not Claude's `{decision,reason,hookSpecificOutput}` envelope. */
  protected emitBlock(decision: Extract<CliForwardDecision, { decision: 'block' }>): void {
    console.log(JSON.stringify(decision.hookSpecificOutput));
  }

  /**
   * An internal failure during an enforcement event must still produce the replacement/deny
   * output — otherwise the hook exits with an uncaught error and, per GitHub's
   * fail-open timeout behavior, the prompt or tool call could go through unblocked. On any
   * other event, log and swallow: a sync failure on `postToolUse`/`notification`/etc. must not
   * surface as a host-visible hook failure.
   */
  protected async onHookError(err: unknown, input: CopilotCliHookInput): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[${this.name}] hook processing failed: ${message}`);
    if (!ENFORCED_EVENTS.has(input.codemieEventName)) {
      return;
    }
    this.emitBlock(this.buildBlock(input.codemieEventName as 'userPromptTransformed' | 'preToolUse', 'an internal CodeMie error', false));
  }

  private async ensureProxyAuth() {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);
    return ensureCodeMieSsoAuth({
      provider: config.provider,
      ssoUrl: config.codeMieUrl || config.baseUrl,
      baseUrl: config.baseUrl,
    });
  }
}
