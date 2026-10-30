import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { OtlpAgentAdapter, type OtlpHookContext } from '@/agents/core/OtlpAgentAdapter.js';
import { isSafeSessionId } from '@/agents/core/session-id.js';
import { ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { describeLogin, type DetachedLoginOutcome } from '@/providers/plugins/sso/sso.detached-login.js';
import { ConfigLoader } from '@/utils/config.js';
import { maskSecretsInText } from '@/utils/security.js';
import { logger } from '@/utils/logger.js';
import { detectGitBranch } from '@/utils/processes.js';
import { isCopilotProjectTracked, readCopilotConnectorScope } from '@/agents/core/copilot-connector-scope.js';
import { getCopilotSessionStateRoot } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';
import type { CopilotSessionStartData } from '@/agents/plugins/copilot-cli/copilot-cli-event-types.js';
import { extractSlashCommand, normalizeUserPrompt, resolveCopilotAgentKey } from '@/agents/plugins/copilot-cli/copilot-cli.constants.js';
import { readWorkspaceManifest } from '@/agents/plugins/copilot-cli/copilot-cli.workspace.js';
import { COPILOT_CLI_OTLP_AGENT_NAME } from './copilot-cli-otlp.constants.js';
import { buildStopPass, type StopPass } from './copilot-cli-otlp.stop-pass.js';
import { TOOL_STATE_BUDGET_MS, readSessionState, resolveRootSessionId, sweepStaleStateFiles, updateSessionState } from './copilot-cli-otlp.state.js';
import { recordOpenStarts, resolveEndToolUseId } from './copilot-cli-otlp.tool-correlation.js';
import { buildToolEvent, extractEndCall, extractStartCalls } from './copilot-cli-otlp.tool-payload.js';
import { type CliBlockOutput, type CliForwardDecision, type CopilotCliHookInput, isCopilotCliHookInput } from './copilot-cli-otlp.types.js';

const HEAD_READ_BYTES = 64 * 1024;

/** `session.start` data from a bounded head-read of a session's `events.jsonl`. */
function readSessionStart(eventsPath: string): CopilotSessionStartData | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(eventsPath, 'r');
    const buffer = Buffer.alloc(HEAD_READ_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_READ_BYTES, 0);
    for (const line of buffer.subarray(0, read).toString('utf-8').split('\n')) {
      try {
        const event = JSON.parse(line) as { type?: string; data?: CopilotSessionStartData };
        if (event.type === 'session.start') return event.data;
      } catch {
        // Partial or non-JSON line.
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

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

/** The user's own prompt text: the desktop app's internal preamble removed; undefined when nothing remains. */
function userPrompt(prompt: string | undefined): string | undefined {
  if (typeof prompt !== 'string') return undefined;
  const text = normalizeUserPrompt(prompt);
  return text.length > 0 ? text : undefined;
}

export class CopilotCliOtlpPlugin extends OtlpAgentAdapter<CopilotCliHookInput, CliBlockOutput> {
  public readonly name = COPILOT_CLI_OTLP_AGENT_NAME;

  protected parseHookInput(raw: string): CopilotCliHookInput | null {
    const parsed: unknown = JSON.parse(raw);
    if (!isCopilotCliHookInput(parsed)) return null;
    // A sub-agent's hooks carry its own id as sessionId; attribute them to the root session.
    const rootId = resolveRootSessionId(parsed.sessionId);
    if (rootId !== parsed.sessionId) {
      parsed.agentId ??= parsed.sessionId;
      parsed.sessionId = rootId;
    }
    return parsed;
  }

  protected extractHookContext(input: CopilotCliHookInput): OtlpHookContext {
    return {
      cwd: input.cwd,
      prompt: input.codemieEventName === 'userPromptTransformed' ? userPrompt(input.prompt) : undefined,
    };
  }

  protected async isTracked(input: CopilotCliHookInput): Promise<boolean> {
    // The connector scope applies to managed and native sessions alike; both are labelled
    // through `entrypoint` and counted once, by Copilot's own session id.
    return isCopilotProjectTracked(input.cwd, await readCopilotConnectorScope(this.name));
  }

  protected async resolveAgentFields(input: CopilotCliHookInput): Promise<Record<string, unknown>> {
    const sessionDir = join(getCopilotSessionStateRoot(), input.sessionId);
    const manifest = readWorkspaceManifest(sessionDir);
    const fields: Record<string, unknown> = {
      // Not emitted until the manifest exists, so one session is never split across harness values.
      ...(manifest && { platform: resolveCopilotAgentKey(manifest.clientName) }),
      // A native `copilot` started inside a managed shell inherits CODEMIE_SESSION_ID but has its own session id.
      entrypoint: process.env.CODEMIE_SESSION_ID && process.env.CODEMIE_SESSION_ID === input.sessionId ? 'managed' : 'native',
      client_version: '',
    };
    const session = await this.resolveSessionHeader(input);
    fields.client_version = session.clientVersion;
    Object.assign(fields, session.gitFallback);
    return fields;
  }

  /** Version and git fallback from the head of `events.jsonl`, cached per session. */
  private async resolveSessionHeader(
    input: CopilotCliHookInput
  ): Promise<{ clientVersion: string; gitFallback: Record<string, string> }> {
    const cached = readSessionState(input.sessionId);
    if (cached.clientVersion) {
      return { clientVersion: cached.clientVersion, gitFallback: cached.gitFallback ?? {} };
    }
    const start = readSessionStart(join(getCopilotSessionStateRoot(), input.sessionId, 'events.jsonl'));
    if (!start?.copilotVersion) {
      return { clientVersion: '', gitFallback: {} };
    }
    const gitFallback: Record<string, string> = {};
    if (!(await detectGitBranch(input.cwd))) {
      if (start.context?.branch) gitFallback.git_branch = start.context.branch;
      if (start.context?.repository) gitFallback.repo_remote = start.context.repository;
    }
    await updateSessionState(input.sessionId, { clientVersion: start.copilotVersion, gitFallback });
    return { clientVersion: start.copilotVersion, gitFallback };
  }

  protected resolveEventType(event: Record<string, unknown>): string {
    return HOOK_EVENT_TYPE_MAP[String(event['codemieEventName'] ?? '')] ?? 'agent.event';
  }

  protected buildEventId(
    event: Record<string, unknown>,
    payload: Record<string, unknown>,
    timestamp: string
  ): string {
    // Usage and summary rows carry a stable id shared with the daemon's final pass.
    if (typeof payload['event_id'] === 'string' && payload['event_id'].length > 0) {
      return payload['event_id'];
    }
    const content = JSON.stringify({ ...payload, timestamp }) ?? 'null';
    const digest = createHash('sha256').update(content).digest('hex');
    return `${String(event['type'] ?? '')}:${String(event['session_id'] ?? '')}:${digest}`;
  }

  protected requiresSpoolAcceptance(input: CopilotCliHookInput): boolean {
    return ENFORCED_EVENTS.has(input.codemieEventName);
  }

  protected async evaluate(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const handler = this.handlers[input.codemieEventName];
    if (handler) {
      return handler(input);
    }
    return { decision: 'forward', payload: [this.normalizeEvent(input)] };
  }

  private readonly handlers: Partial<Record<string, (input: CopilotCliHookInput) => Promise<CliForwardDecision>>> = {
    userPromptTransformed: (input) => this.onPrompt(input),
    preToolUse: (input) => this.onToolStart(input),
    postToolUse: (input) => this.onToolEnd(input),
    postToolUseFailure: (input) => this.onToolEnd(input),
    agentStop: (input) => this.onAgentStop(input),
    subagentStart: (input) => this.onSubagentStart(input),
    sessionStart: (input) => this.onSessionStart(input),
    sessionEnd: (input) => this.onSessionEnd(input),
  };

  private async onPrompt(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const authResult = await this.ensureProxyAuth();
    if (authResult.ok) {
      return { decision: 'forward', payload: [this.normalizeEvent(input)] };
    }
    return this.buildBlock('userPromptTransformed', authResult.reason, true, authResult.loginOutcome);
  }

  /** Auth once for the whole batch; a denial denies every call and records nothing. */
  private async onToolStart(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const authResult = await this.ensureProxyAuth();
    if (!authResult.ok) {
      return this.buildBlock('preToolUse', authResult.reason, true, authResult.loginOutcome);
    }
    const calls = extractStartCalls(input);
    const base = this.normalizeEvent(input);
    return {
      decision: 'forward',
      payload: calls.map((call) => buildToolEvent(base, call.toolName, call.toolArgs, { toolUseId: call.toolUseId })),
      finalize: async (accepted: boolean) => {
        if (accepted) await recordOpenStarts(input.sessionId, calls);
      },
    };
  }

  private async onToolEnd(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const end = extractEndCall(input);
    const toolUseId = await resolveEndToolUseId(input.sessionId, end.toolName, end.toolArgs);
    const event = buildToolEvent(this.normalizeEvent(input), end.toolName, end.toolArgs, { toolUseId, end });
    return { decision: 'forward', payload: [event] };
  }

  /** Records which session a sub-agent belongs to, before its own hooks start arriving under its id. */
  private async onSubagentStart(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const subagentId = input.agentId;
    if (subagentId && isSafeSessionId(subagentId) && subagentId !== input.sessionId) {
      const stored = await updateSessionState(subagentId, { parentSessionId: input.sessionId }, TOOL_STATE_BUDGET_MS);
      if (!stored) logger.debug(`[${this.name}] failed to record sub-agent parent session`);
    }
    return { decision: 'forward', payload: [this.normalizeEvent(input)] };
  }

  private async onSessionStart(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    sweepStaleStateFiles();
    return { decision: 'forward', payload: [this.normalizeEvent(input)] };
  }

  /** Claude's `Stop`: usage and an incremental summary, so a killed session keeps what it produced. */
  private async onAgentStop(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const base = this.normalizeEvent(input);
    // A sub-agent stop fires mid-turn; advancing the usage cursor here would split the main turn's slices.
    if (input.agentId) {
      return { decision: 'forward', payload: [base] };
    }
    let pass: StopPass | null = null;
    try {
      pass = buildStopPass(input.sessionId, input.transcriptPath);
    } catch (error) {
      logger.debug(`[${this.name}] agentStop usage pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!pass) {
      return { decision: 'forward', payload: [base] };
    }
    const committed = pass;
    return {
      decision: 'forward',
      payload: [base, ...committed.events],
      finalize: async (accepted: boolean) => {
        if (accepted) await committed.commit();
      },
    };
  }

  private async onSessionEnd(input: CopilotCliHookInput): Promise<CliForwardDecision> {
    const stateRoot = getCopilotSessionStateRoot();
    if (!(await updateSessionState(input.sessionId, { sessionStateRoot: stateRoot }, 1_000))) {
      logger.debug('[copilot-cli-otlp] failed to record session-state root');
    }
    // No later hook retries a failed SessionEnd batch, so it gets one in-process resend.
    // Usage is added by the daemon after `session.shutdown`, which Copilot writes after this hook exits.
    return { decision: 'forward', payload: [this.normalizeEvent(input)], retryOnce: true };
  }

  /** Normalizes camelCase native fields to the base class's expected keys, before truncation. */
  private normalizeEvent(input: CopilotCliHookInput): Record<string, unknown> {
    const normalized: Record<string, unknown> = {
      session_id: input.sessionId,
      timestamp: new Date(input.timestamp ?? Date.now()).toISOString(),
      type: HOOK_EVENT_TYPE_MAP[input.codemieEventName] ?? 'agent.event',
    };

    if (input.source !== undefined) normalized.source = this.boundedFreeText(input.source);
    if (input.reason !== undefined) normalized.reason = this.boundedFreeText(input.reason);
    const prompt = userPrompt(input.prompt);
    if (prompt !== undefined) normalized.prompt = prompt;
    if (input.codemieEventName === 'userPromptTransformed') {
      const command = extractSlashCommand(input.prompt, input.transformedPrompt);
      if (command !== undefined) normalized.command_name = command;
    }
    if (input.stopReason !== undefined) normalized.stop_reason = this.boundedFreeText(input.stopReason);
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

  /**
   * R11: free-text fields outside the base class's four truncated keys must still be bounded.
   * Masked before the cut: the base class only sees the already-cut text, where a secret
   * straddling the limit would be left as a fragment too short to recognise.
   */
  private boundedFreeText(value: unknown): string {
    const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
    return maskSecretsInText(text).slice(0, FREE_TEXT_MAX_CHARS);
  }

  private buildBlock(
    eventName: 'userPromptTransformed' | 'preToolUse',
    reason: string | undefined,
    authenticationFailure = true,
    loginOutcome?: DetachedLoginOutcome
  ): Extract<CliForwardDecision, { decision: 'block' }> {
    const logMessage = authenticationFailure
      ? `CodeMie SSO authentication is invalid (${reason ?? 'unknown reason'}).`
      : `CodeMie cannot safely process this event (${reason ?? 'unknown reason'}).`;

    const userMessage = authenticationFailure
      ? describeLogin(loginOutcome).replace(/\n/g, ' ')
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
