import { createHash } from 'node:crypto';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { ConfigLoader } from '@/utils/config.js';
import { logger } from '@/utils/logger.js';
import {
  evaluateCopilotAnalyticsGate,
  type CopilotAnalyticsGateReason,
} from '@/agents/core/copilot-analytics-gate.js';
import { readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { COPILOT_CHAT_OTLP_AGENT_NAME } from './copilot-chat-otlp.constants.js';
import { type ChatBlockOutput, type ChatForwardDecision, type CopilotChatHookInput, isCopilotChatHookInput } from './copilot-chat-otlp.types.js';

const HOOK_EVENT_TYPE_MAP: Record<string, string> = {
  SessionStart: 'agent.session.start',
  UserPromptSubmit: 'agent.prompt.submit',
  PreToolUse: 'agent.tool.start',
  PostToolUse: 'agent.tool.end',
  Stop: 'agent.session.stop',
  SubagentStart: 'agent.subagent.start',
  SubagentStop: 'agent.subagent.stop',
  PreCompact: 'agent.session.compact',
};

/** Enforcement points: block the session/prompt, deny tools as defense in depth. */
const ENFORCED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse']);

/**
 * The user turned analytics off (or excluded this project, or the opt-out file is unreadable).
 * Nothing is collected, but a block here would stop their Copilot Chat session/prompts/tools — so
 * these stay silent; `codemie proxy analytics status` explains why nothing is collected.
 */
const ANALYTICS_OPT_OUT_REASONS: ReadonlySet<CopilotAnalyticsGateReason> = new Set<CopilotAnalyticsGateReason>([
  'preferences-corrupt',
  'analytics-disabled',
  'project-excluded',
]);

export class CopilotChatOtlpPlugin extends OtlpAgentAdapter<CopilotChatHookInput, ChatBlockOutput> {
  public readonly name = COPILOT_CHAT_OTLP_AGENT_NAME;

  protected parseHookInput(raw: string): CopilotChatHookInput | null {
    const parsed: unknown = JSON.parse(raw);
    return isCopilotChatHookInput(parsed) ? parsed : null;
  }

  protected extractHookContext(hookInput: CopilotChatHookInput): OtlpHookContext {
    return {
      cwd: typeof hookInput.cwd === 'string' ? hookInput.cwd : '',
      prompt: hookInput.hook_event_name === 'UserPromptSubmit' ? hookInput.prompt : undefined,
    };
  }

  protected async isTracked(hookInput: CopilotChatHookInput): Promise<boolean> {
    const decision = await evaluateCopilotAnalyticsGate(this.name, this.cwdOrUndefined(hookInput));
    return decision.tracked && this.hasRequiredIdentity(hookInput);
  }

  protected async onUntrackedHook(hookInput: CopilotChatHookInput): Promise<void> {
    if (!ENFORCED_EVENTS.has(hookInput.hook_event_name)) {
      return;
    }

    const decision = await evaluateCopilotAnalyticsGate(this.name, this.cwdOrUndefined(hookInput));
    if (!decision.tracked && ANALYTICS_OPT_OUT_REASONS.has(decision.reason)) {
      return;
    }

    const scope = await readCopilotConnectorScope(this.name);
    if (scope.kind === 'corrupt') {
      this.emitBlock(
        this.buildBlock(
          hookInput.hook_event_name,
          'connector scope configuration is corrupt; repair it and reconnect',
          false
        )
      );
      return;
    }
    if (!scope.value.enabled) {
      return;
    }
    if (!this.hasRequiredIdentity(hookInput)) {
      this.emitBlock(
        this.buildBlock(
          hookInput.hook_event_name,
          'required session identity or working directory is missing',
          false
        )
      );
    }
  }

  protected async resolveAgentFields(): Promise<Record<string, unknown>> {
    return {
      platform: 'copilot-chat',
      // The host version is not detected: left empty rather than guessed.
      client_version: '',
    };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['hook_event_name'] ?? '')] ?? 'agent.event';
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

  protected requiresSpoolAcceptance(input: CopilotChatHookInput): boolean {
    return ENFORCED_EVENTS.has(input.hook_event_name);
  }

  protected async evaluate(hookInput: CopilotChatHookInput): Promise<ChatForwardDecision> {
    if (!ENFORCED_EVENTS.has(hookInput.hook_event_name)) {
      return { decision: 'forward', payload: [hookInput] };
    }

    const scope = await readCopilotConnectorScope(this.name);
    if (scope.kind === 'corrupt') {
      return this.buildBlock(
        hookInput.hook_event_name,
        'connector scope configuration is corrupt; repair it and reconnect',
        false
      );
    }
    if (!scope.value.enabled) {
      return { decision: 'forward', payload: [] };
    }
    if (!this.hasRequiredIdentity(hookInput)) {
      return this.buildBlock(
        hookInput.hook_event_name,
        'required session identity or working directory is missing',
        false
      );
    }

    const authResult = await this.ensureProxyAuth();
    if (authResult.ok) {
      return { decision: 'forward', payload: [hookInput] };
    }

    return this.buildBlock(hookInput.hook_event_name, authResult.reason);
  }

  private cwdOrUndefined(input: CopilotChatHookInput): string | undefined {
    return typeof input.cwd === 'string' ? input.cwd : undefined;
  }

  private hasRequiredIdentity(input: CopilotChatHookInput): input is CopilotChatHookInput & {
    cwd: string;
    session_id: string;
  } {
    return (
      typeof input.cwd === 'string' &&
      input.cwd.length > 0 &&
      typeof input.session_id === 'string' &&
      isSafeSessionId(input.session_id)
    );
  }

  private buildBlock(
    eventName: CopilotChatHookInput['hook_event_name'],
    reason: string | undefined,
    authenticationFailure = true
  ): Extract<ChatForwardDecision, { decision: 'block' }> {
    const message = authenticationFailure
      ? [
          `CodeMie SSO authentication is invalid (${reason ?? 'unknown reason'}).`,
          'A browser sign-in window has been opened automatically.',
          'Complete the sign-in, then re-send your prompt.',
        ].join(' ')
      : `CodeMie cannot safely process this event (${reason ?? 'unknown reason'}). Fix the issue, then re-send your prompt.`;

    const hookSpecificOutput: ChatBlockOutput =
      eventName === 'PreToolUse'
        ? { permissionDecision: 'deny', permissionDecisionReason: message }
        : { continue: false, stopReason: message };

    return { decision: 'block', reason: message, hookSpecificOutput };
  }

  /** VS Code's hook output protocol is not Claude's `{decision,reason,hookSpecificOutput}` envelope. */
  protected emitBlock(decision: Extract<ChatForwardDecision, { decision: 'block' }>): void {
    console.log(JSON.stringify(decision.hookSpecificOutput));
  }

  /**
   * An internal failure (daemon start, forward) during an enforcement event must still produce
   * VS Code's block output — otherwise the hook exits with an uncaught error and the prompt
   * goes through unblocked. On any other event, log and swallow: a sync failure on
   * `Stop`/`PostToolUse`/etc. must not surface as a host-visible hook failure.
   */
  protected async onHookError(err: unknown, input: CopilotChatHookInput): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[${this.name}] hook processing failed: ${message}`);
    if (!ENFORCED_EVENTS.has(input.hook_event_name)) {
      return;
    }
    this.emitBlock(this.buildBlock(input.hook_event_name, 'an internal CodeMie error', false));
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
