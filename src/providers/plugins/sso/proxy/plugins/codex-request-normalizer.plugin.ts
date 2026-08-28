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
import {
  isCodexServableDeployment,
  rankDeploymentsByRecency,
  resolveCodexDeployment,
} from './codex-model-resolver.js';

const ALLOWED_CLIENTS = ['codex-desktop'];

/** Re-list deployments occasionally so a long-lived daemon picks up new models. */
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000;

/** How long to wait before retrying after a failed or empty listing. */
const MODEL_RETRY_BACKOFF_MS = 60 * 1000;

/**
 * Repair empty `description` fields on tool definitions, in place.
 *
 * Azure — which backs CodeMie deployments through LiteLLM — rejects a tool whose
 * `description` is an empty string ("Expected a string with minimum length 1"),
 * while direct OpenAI accepts it. The Codex desktop app and the MCP servers it
 * loads do emit empty descriptions, so a turn that works against OpenAI fails
 * here. The client cannot be fixed from our side, so the proxy repairs it.
 *
 * Scoped deliberately to arrays literally named `tools`: a JSON-schema property
 * description is legitimately allowed to be empty and is not what Azure rejects,
 * so rewriting one would silently alter the tool's schema.
 *
 * An empty description carries no information the model does not already have
 * from the tool's name, so the name is the least-lossy replacement. The key is
 * dropped when there is no usable name, which the gateway also accepts.
 *
 * Returns the number of descriptions repaired.
 */
/**
 * Depth ceiling for the walk. Request bodies are client-controlled — Codex
 * accumulates conversation history plus nested MCP tool schemas — so an
 * unbounded walk risks a RangeError escaping into the proxy pipeline. Real
 * bodies nest far shallower than this.
 */
const MAX_WALK_DEPTH = 64;

export function repairEmptyToolDescriptions(node: unknown): number {
  return walk(node, 0, new WeakSet<object>());
}

function repairToolEntry(tool: unknown): boolean {
  if (tool === null || typeof tool !== 'object' || Array.isArray(tool)) return false;

  const toolRecord = tool as Record<string, unknown>;
  if (typeof toolRecord.description !== 'string') return false;
  if (toolRecord.description.trim() !== '') return false;

  const name = typeof toolRecord.name === 'string' ? toolRecord.name.trim() : '';
  if (name !== '') {
    toolRecord.description = name;
  } else {
    delete toolRecord.description;
  }
  return true;
}

function walk(node: unknown, depth: number, seen: WeakSet<object>): number {
  if (depth > MAX_WALK_DEPTH) return 0;
  if (node === null || typeof node !== 'object') return 0;

  // Guard against cycles. The function is exported and takes `unknown`, so it
  // cannot assume its input came from JSON.parse.
  if (seen.has(node)) return 0;
  seen.add(node);

  if (Array.isArray(node)) {
    return node.reduce<number>((count, item) => count + walk(item, depth + 1, seen), 0);
  }

  let repaired = 0;
  const record = node as Record<string, unknown>;

  for (const [key, value] of Object.entries(record)) {
    if (key === 'tools' && Array.isArray(value)) {
      for (const tool of value) {
        if (repairToolEntry(tool)) repaired++;
      }
    }
    // Recurse regardless: a `tools` array can sit at any depth, and the entries
    // of one may themselves nest further structures.
    repaired += walk(value, depth + 1, seen);
  }

  return repaired;
}

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
  private lastAttemptAt = 0;
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

    const repairedDescriptions = repairEmptyToolDescriptions(body);
    if (repairedDescriptions > 0) {
      logger.debug(
        `[${this.name}] Replaced ${repairedDescriptions} empty tool description(s) rejected by upstream`
      );
    }

    if (typeof body.model !== 'string' || body.model === '') {
      if (repairedDescriptions > 0) this.writeBody(context, body);
      return;
    }

    await this.ensureModelsLoaded();
    if (this.availableModels.length === 0) {
      // Never block a turn on an unavailable model list; the gateway's own
      // error is more useful than a guess.
      if (repairedDescriptions > 0) this.writeBody(context, body);
      return;
    }

    const resolution = resolveCodexDeployment(
      body.model,
      this.availableModels,
      this.resolveFallbackModel()
    );

    if (resolution.kind === 'exact' || resolution.kind === 'unresolved') {
      if (repairedDescriptions > 0) this.writeBody(context, body);
      return;
    }

    if (resolution.kind === 'substituted') {
      logger.info(
        `[${this.name}] CodeMie has no deployment for "${resolution.requested}"; ` +
        `using pinned model "${resolution.model}" instead`
      );
    } else {
      logger.debug(`[${this.name}] Resolved "${body.model}" to deployment "${resolution.model}"`);
    }

    body.model = resolution.model;
    this.writeBody(context, body);
  }

  /** Serialize the mutated body back onto the request, keeping content-length honest. */
  private writeBody(context: ProxyContext, body: Record<string, unknown>): void {
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
    if (pinned) {
      // The pinned value may be the profile's undated picker name; resolve it to
      // its dated deployment the same way an in-flight request is resolved.
      const resolution = resolveCodexDeployment(pinned, this.availableModels, undefined);
      if (resolution.kind === 'exact' || resolution.kind === 'resolved') return resolution.model;
    }
    return rankDeploymentsByRecency(this.availableModels)[0];
  }

  /**
   * Load the deployment list once, then refresh it on a TTL. Concurrent requests
   * share a single in-flight fetch so a burst of turns does not fan out into a
   * burst of list calls.
   */
  private async ensureModelsLoaded(): Promise<void> {
    const now = Date.now();
    const fresh = this.availableModels.length > 0 && now - this.loadedAt < MODEL_CACHE_TTL_MS;
    if (fresh) return;

    // Negative cache: without this, expired credentials or a 5xx gateway turn
    // every single request into a fresh listing call, because a failed load
    // leaves availableModels empty and so never looks "fresh".
    const backingOff = this.lastAttemptAt !== 0
      && now - this.lastAttemptAt < MODEL_RETRY_BACKOFF_MS;
    if (backingOff) return;

    if (this.inFlight) return this.inFlight;

    this.inFlight = this.loadModels().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async loadModels(): Promise<void> {
    this.lastAttemptAt = Date.now();

    const credentials = this.context.credentials;
    if (!credentials) {
      logger.debug(`[${this.name}] No credentials available; model names pass through unchanged`);
      return;
    }

    try {
      const apiUrl = credentials.apiUrl || this.context.config.targetApiUrl;
      const models = 'cookies' in credentials
        ? await fetchCodeMieLlmModels(apiUrl, credentials.cookies)
        : await fetchCodeMieLlmModels(apiUrl, credentials.token);

      this.availableModels = models
        .filter((model) => model.enabled !== false)
        .map((model) => model.deployment_name || model.base_name)
        .filter((name): name is string => Boolean(name))
        // Only Codex-servable deployments may be resolved to or substituted.
        .filter(isCodexServableDeployment);
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
