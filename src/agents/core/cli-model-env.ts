/**
 * Publish the explicitly-requested CLI model for this launch as CODEMIE_CLI_MODEL,
 * the signal the anthropic-subscription provider passes through to Claude Code.
 *
 * Always clears any pre-existing value first (e.g. one exported in the user's shell)
 * so the var reflects ONLY what the user passed on THIS launch — never a stale value.
 * With no explicit model the var is left unset, so a no---model launch runs on Claude
 * Code's own default.
 */
export function applyCliModelEnv(model: unknown): void {
  delete process.env.CODEMIE_CLI_MODEL;
  if (typeof model === 'string' && model.trim() !== '') {
    process.env.CODEMIE_CLI_MODEL = model.trim();
  }
}
