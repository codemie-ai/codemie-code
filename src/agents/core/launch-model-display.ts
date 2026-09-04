import { ProviderName } from '../../providers/core/types.js';

const SUBSCRIPTION_PER_SESSION = 'chosen per session by Claude Code / your Anthropic subscription';

/**
 * What the launch banner prints as the model. On the subscription profile the model
 * is either the explicit --model the user passed (CODEMIE_CLI_MODEL) or, absent that,
 * Claude Code's own per-session choice — never the blanked CODEMIE_MODEL, which would
 * otherwise render as 'unknown'. Other providers keep their existing behavior.
 */
export function resolveLaunchModelDisplay(
  provider: string | undefined,
  envModel: string | undefined,
  cliModel: string | undefined,
): string {
  if (provider === ProviderName.ANTHROPIC_SUBSCRIPTION) {
    return cliModel && cliModel.trim() !== '' ? cliModel : SUBSCRIPTION_PER_SESSION;
  }
  return envModel || 'unknown';
}
