/**
 * Codex Request Normalizer Plugin
 * Priority: 14 (runs before generic request sanitization, alongside the other
 * per-client normalizers)
 *
 * The Codex desktop app owns the `model` key in `~/.codex/config.toml`: it
 * writes its model-picker selection back to that file, overwriting whatever
 * `codemie proxy connect --codex-desktop` pinned. The names its picker offers
 * come from the app's own bundled catalog and are undated (`gpt-5.6-luna`,
 * `gpt-5.5`), while CodeMie deployments carry a release date
 * (`gpt-5.6-luna-2026-07-09`). The gateway rejects the undated form with
 * "Invalid model name", and the app then cascades through further catalog
 * entries that fail the same way.
 *
 * This plugin maps the requested name onto a deployment the gateway actually
 * has, so the picker works instead of failing.
 */

import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { logger } from '../../../../../utils/logger.js';
import { fetchCodeMieLlmModels } from '../../sso.http-client.js';
import { rankDeploymentsByRecency, resolveCodexDeployment } from './codex-model-resolver.js';

const ALLOWED_CLIENTS = ['codex-desktop'];

/** Re-list deployments occasionally so a long-lived daemon picks up new models. */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

export class CodexRequestNormalizerPlugin implements ProxyPlugin {
  id = '@codemie/proxy-codex-request-normalizer';
  name = 'Codex Request Normalizer';
  version = '1.0.0';
  priority = 14;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    const clientType = context.config.clientType;
    if (!clientType || !ALLOWED_CLIENTS.includes(clientType)) {
      throw new Error(`Plugin disabled for agent: ${clientType}`);
    }

    return new CodexRequestNormalizerInterceptor(context);
  }
}

class CodexRequestNormalizerInterceptor implements ProxyInterceptor {
  name = 'codex-request-normalizer';

  private availableModels: string[] = [];
  private loadedAt = 0;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly context: PluginContext) {}

  /** Test seam — lets the suite supply a deployment list without a network call. */
  setAvailableModelsForTest(models: string[]): void {
    this.availableModels = models;
    this.loadedAt = Date.now();
  }

  async onRequest(context: ProxyContext): Promise<void> {
    if (!context.requestBody || !context.headers['content-type']?.includes('application/json')) {
      return;
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(context.requestBody.toString('utf-8'));
    } catch {
      // Not JSON — pass through unchanged.
      return;
    }

    if (typeof body.model !== 'string' || body.model === '') return;

    await this.ensureModelsLoaded();
    if (this.availableModels.length === 0) {
      // Never block a turn on an unavailable model list; the gateway's own
      // error is more useful than a guess.
      return;
    }

    const resolution = resolveCodexDeployment(
      body.model,
      this.availableModels,
      this.resolveFallbackModel()
    );

    if (resolution.kind === 'exact' || resolution.kind === 'unresolved') return;

    if (resolution.kind === 'substituted') {
      logger.info(
        `[${this.name}] CodeMie has no deployment for "${resolution.requested}"; ` +
        `using pinned model "${resolution.model}" instead`
      );
    } else {
      logger.debug(`[${this.name}] Resolved "${body.model}" to deployment "${resolution.model}"`);
    }

    body.model = resolution.model;
    context.requestBody = Buffer.from(JSON.stringify(body), 'utf-8');
    context.headers['content-length'] = String(context.requestBody.length);
  }

  /**
   * The model to substitute when CodeMie carries nothing matching the request.
   *
   * `config.model` is normally absent here: the daemon is spawned before the
   * connector resolves a model, because discovery itself goes through this
   * proxy. So the fallback cannot depend on a pinned value — it defaults to the
   * newest available deployment, which is what `connect` would have pinned.
   */
  private resolveFallbackModel(): string | undefined {
    const pinned = this.context.config.model;
    if (pinned && this.availableModels.includes(pinned)) return pinned;
    return rankDeploymentsByRecency(this.availableModels)[0];
  }

  /**
   * Load the deployment list once, then refresh it on a TTL. Concurrent requests
   * share a single in-flight fetch so a burst of turns does not fan out into a
   * burst of list calls.
   */
  private async ensureModelsLoaded(): Promise<void> {
    const fresh = this.availableModels.length > 0
      && Date.now() - this.loadedAt < MODEL_CACHE_TTL_MS;
    if (fresh) return;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.loadModels().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async loadModels(): Promise<void> {
    const credentials = this.context.credentials;
    if (!credentials) return;

    try {
      const apiUrl = credentials.apiUrl || this.context.config.targetApiUrl;
      const models = 'cookies' in credentials
        ? await fetchCodeMieLlmModels(apiUrl, credentials.cookies)
        : await fetchCodeMieLlmModels(apiUrl, credentials.token);

      this.availableModels = models
        .filter((model) => model.enabled !== false)
        .map((model) => model.deployment_name || model.base_name)
        .filter((name): name is string => Boolean(name));
      this.loadedAt = Date.now();

      logger.debug(`[${this.name}] Loaded ${this.availableModels.length} deployments for model resolution`);
    } catch (error) {
      // A failed list must not fail the request.
      logger.debug(
        `[${this.name}] Could not list deployments; passing model names through: ` +
        `${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
