import { ProviderName } from '../../providers/core/types.js';

/**
 * A pin that would downgrade an already-installed newer binary is softened to a
 * warning that defaults to keeping what is installed — but only on the Anthropic
 * Subscription profile, whose model availability comes from the installed Claude
 * Code version. Proxied providers keep 'install' as the tested default (a newer,
 * unverified binary can break the CodeMie proxy). The minimum-version block is a
 * separate branch and is unaffected.
 */
export function newerVersionPromptDefault(provider: string | undefined): 'install' | 'continue' {
  return provider === ProviderName.ANTHROPIC_SUBSCRIPTION ? 'continue' : 'install';
}

/**
 * On an older-but-supported Claude Code, tell subscription users that newer models
 * may be unavailable on that version (the update to the verified version is already
 * offered by the prompt). Returns null for providers this story does not touch.
 */
export function olderSupportedModelNote(provider: string | undefined): string | null {
  if (provider !== ProviderName.ANTHROPIC_SUBSCRIPTION) return null;
  return 'Newer models may be unavailable on this version of Claude Code.';
}
