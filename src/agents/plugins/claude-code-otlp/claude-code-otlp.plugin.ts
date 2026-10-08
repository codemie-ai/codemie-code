
import { AuthGateResult, ensureCodeMieSsoAuth } from '@/providers/plugins/sso/sso.auth-gate.js';
import { logger } from '@/utils/logger.js';
import { ConfigLoader } from '@/utils/config.js';
import { AgentAdapterType, OtlpAdapterDeps, OtlpAgentAdapter } from '@/agents/core/types.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { ForwardDecision, toBaseClaudeCodeHookEvent } from './claude-code-otlp.types.js';
import { forwardOtlpEventToSpool } from '../utils.js';
import { isProjectTracked, readAllowlistState } from './claude-code-otlp.allowlist.js';

export class ClaudeCodeOtlpPlugin implements OtlpAgentAdapter {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;
  public readonly type = AgentAdapterType.OTLP;

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

    const evaluation = await this.evaluate(event.hookEventName, rawEvent);
    if (evaluation.decision === 'block') {
      logger.error(`[Claude Code OTLP plugin] Blocking prompt: ${evaluation.reason}`);
      console.log(JSON.stringify(evaluation));
      return;
    }
    this.forwardToSpool(evaluation.payload);
  }

  private async evaluate(hookEventName: string, rawEvent: string): Promise<ForwardDecision> {
    if (hookEventName === 'UserPromptSubmit') {
      return await this.onUserPromptSubmit(rawEvent);
    }

    return {
      decision: 'forward',
      payload: rawEvent,
    };
  }

  private async ensureProxyAuth(): Promise<AuthGateResult> {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);

    return await ensureCodeMieSsoAuth({
      provider: config.provider,
      ssoUrl: config.codeMieUrl || config.baseUrl,
    });
  }

  private forwardToSpool(rawEvent: string): void {
    // Intentionally not awaited: forwardOtlpEventToSpool is fire-and-forget.
    forwardOtlpEventToSpool(rawEvent, CLAUDE_CODE_OTLP_AGENT_NAME);
  }

  private async onUserPromptSubmit(rawEvent: string): Promise<ForwardDecision> {
    const authResult = await this.ensureProxyAuth();

    if (authResult.ok) {
      return {
        decision: 'forward',
        payload: rawEvent,
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
