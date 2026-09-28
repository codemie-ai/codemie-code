
import { logger } from '@/utils/logger.js';
import { AgentAdapterType, OTLPAgentAdapter } from '@/agents/core/types.js';
import { CLAUDE_CODE_OTLP_AGENT_NAME } from './claude-code-otlp.constants.js';
import { ForwardDecision, toBaseClaudeCodeHookEvent } from './claude-code-otlp.types.js';
import { forwardOtlpEventToSpool } from '../utils.js';
import { ConfigLoader } from '@/utils/config.js';
import { ProviderRegistry } from '@/providers/index.js';
import { CodeMieSSO } from '@/providers/plugins/sso/sso.auth.js';

export class ClaudeCodeOtlpPlugin implements OTLPAgentAdapter {
  public readonly name = CLAUDE_CODE_OTLP_AGENT_NAME;
  public readonly type = AgentAdapterType.OTLP;

  public async processOtlpEvent(rawEvent: string): Promise<void> {
    const decision = await this.evaluate(rawEvent);
    if (decision.action === 'block') {
      logger.error(`[Claude Code OTLP plugin] Blocking prompt: ${decision.reason}`);
      console.log(JSON.stringify({
        decision: 'block',
        reason: decision.reason,
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          suppressOriginalPrompt: true,
        }
      }));
      return;
    }
    this.forwardToSpool(decision.payload);
  };

  private async evaluate(rawEvent: string): Promise<ForwardDecision>  {
    const event = toBaseClaudeCodeHookEvent(JSON.parse(rawEvent));

    if (event.hookEventName === 'UserPromptSubmit') {
      const isAuthValid = await this.ensureProxyAuth();

      if (!isAuthValid) {
        return {
          action: 'block',
          reason: [
            "CodeMie SSO authentication is invalid - you are blocked until you re-authenticate.",
            "A browser sign-in window has been opened automatically.",
            "Complete the sign-in, then re-send your prompt.",
          ].join("\n"),
        }
      }
    }

    return {
      action: 'forward',
      payload: rawEvent,
    }
  }

  private async ensureProxyAuth(): Promise<boolean> {
    const workingDir = process.cwd();
    const config = await ConfigLoader.load(workingDir);

    if (!config.provider || config.provider !== "ai-run-sso") {
      logger.error(`[Claude Code OTLP plugin] Only "ai-run-sso" auth provider is available.`);
      return false;
    }

    const { validateAuth } = ProviderRegistry.getSetupSteps(config.provider)!;
    const result = await validateAuth!(config);

    if (result.valid) {
      return true;
    }

    const ssoUrl = config.codeMieUrl || config.baseUrl;

    if (!ssoUrl) {
      logger.error(`[Claude Code OTLP plugin] SSO URL is missing.`);
      return false;
    }

    try {
      await new CodeMieSSO().authenticate({ codeMieUrl: ssoUrl, timeout: 120_000, quiet: true });
    } catch (error) {
      logger.error(`[Claude Code OTLP plugin] Failed to re-authenticate: ${(error as Error).message}`);
    }

    return false;
  }

  private forwardToSpool(rawEvent: string): void {
    // Intentionally not awaited: forwardOtlpEventToSpool is fire-and-forget.
    forwardOtlpEventToSpool(rawEvent, CLAUDE_CODE_OTLP_AGENT_NAME);
  }
}
