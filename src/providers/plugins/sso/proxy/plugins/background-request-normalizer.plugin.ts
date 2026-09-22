/**
 * Background Request Normalizer Plugin
 * Priority: 14 (alongside the other request normalizers, before RequestSanitizer at 15)
 *
 * Claude Code makes its own background/utility API calls — auto-title generation is the
 * first one we've caught (system prompt: "Generate a concise, sentence-case title...").
 * These always request the same model alias as the surrounding conversation
 * (`claude-sonnet-5-switchyard-claude-4-5-haiku-signal` — confirmed via a captured real
 * request body, EPMCDME-14083), which only *signals* a haiku preference to the upstream
 * Switchyard tier classifier rather than forcing it — the classifier still sometimes routes
 * these tiny calls to the expensive `capable`/sonnet tier. Measured impact: one real session
 * had a single title-gen call billed at $0.237 by LiteLLM, on par with that session's most
 * expensive genuine turn.
 *
 * We can't fix Switchyard's classifier (external service, not in this repo). What we can do
 * is stop deferring to it at all for requests we can positively identify as this kind of
 * cheap background work: rewrite `model` to a concrete haiku deployment before the request
 * ever reaches the classifier.
 *
 * BACKGROUND_REQUEST_RULES is deliberately a list, not a single check: title-gen is the only
 * one caught so far, but Claude Code has other small fire-and-forget calls (branch-name
 * generation shares the same underlying prompt in some CC versions, commit-message
 * suggestions, etc.) that will very likely turn out to have the same misrouting problem.
 * Adding a new one is just another entry — same `matches`/`resolveForcedModel` shape, no new
 * plumbing.
 *
 * The forced model is deliberately NOT a hardcoded literal: `claude.plugin.ts`'s beforeRun
 * hook already resolves each tier against the live CodeMie catalog for the active profile —
 * the same resolution a `/model` switch relies on — and merges it into `process.env` via
 * `Object.assign(process.env, env)` (BaseAgentAdapter.ts) before the `claude` child process
 * (and therefore any request through this proxy) ever starts. Reading `CODEMIE_HAIKU_MODEL`
 * lazily inside `onRequest`, rather than caching it at plugin construction, means it's always
 * read after that merge has happened, whatever the relative startup ordering of the proxy vs.
 * the beforeRun hook turns out to be.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';

interface BackgroundRequestRule {
  /** Short identifier for logging — not user-facing. */
  name: string;
  /** True when `body` (the parsed JSON request) is this kind of background request. */
  matches(body: Record<string, unknown>): boolean;
  /**
   * Model to force onto the request in place of whatever it originally asked for, resolved at
   * request time from whichever env var this deployment actually populated. Returns
   * `undefined` when no suitable tier is provisioned (e.g. the anthropic-subscription
   * provider, which skips CodeMie's catalog resolution entirely) — the caller leaves the
   * request untouched rather than forcing a model id that may not exist on this backend.
   */
  resolveForcedModel(): string | undefined;
}

/** Same fallback order claude.plugin.ts itself populates: generic CodeMie var, then the native Anthropic one. */
function resolveHaikuModel(): string | undefined {
  return process.env.CODEMIE_HAIKU_MODEL || process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL || undefined;
}

/** `body.system` is either a plain string or an array of `{type: 'text', text: string}` blocks. */
function systemPromptText(body: Record<string, unknown>): string {
  const system = body.system;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((block) => (block && typeof block === 'object' && 'text' in block ? String((block as { text: unknown }).text) : ''))
      .join('\n');
  }
  return '';
}

// Add new background-request rules here as they're identified — each is independent, so one
// rule matching never affects whether another does.
const BACKGROUND_REQUEST_RULES: readonly BackgroundRequestRule[] = [
  {
    name: 'claude-code-title-gen',
    matches: (body) => systemPromptText(body).includes('sentence-case title'),
    resolveForcedModel: resolveHaikuModel,
  },
];

// Same agent scope as claude-request-normalizer.plugin.ts: this system-prompt-based detection
// only ever matches traffic from Claude Code itself.
const ALLOWED_AGENTS = ['codemie-claude', 'codemie-copilot', 'claude-desktop'];

export class BackgroundRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-background-request-normalizer';
  name = 'Background Request Normalizer';
  version = '1.0.0';
  priority = 14; // Alongside the other request normalizers, before RequestSanitizer (15)

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_AGENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }
    return new BackgroundRequestNormalizerInterceptor();
  }
}

class BackgroundRequestNormalizerInterceptor implements ProxyInterceptor {
  name = 'background-request-normalizer';

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(context.requestBody.toString('utf-8'));
    } catch {
      return; // Not JSON, or a torn body — nothing this plugin can do.
    }

    const rule = BACKGROUND_REQUEST_RULES.find((r) => r.matches(body));
    if (!rule) return;

    const forcedModel = rule.resolveForcedModel();
    if (!forcedModel) {
      logger.debug(`[${this.name}] Matched rule "${rule.name}" but no target model is provisioned — leaving request untouched`);
      return;
    }

    const originalModel = body.model;
    body.model = forcedModel;

    context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
    context.headers['content-length'] = String(context.requestBody.length);

    logger.debug(
      `[${this.name}] Forced model for background request: ${rule.name} (${String(originalModel)} -> ${forcedModel})`
    );
  }
}
