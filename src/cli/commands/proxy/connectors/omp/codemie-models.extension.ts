/**
 * oh-my-pi (omp) extension: registers the CodeMie catalog as two dynamic omp providers because
 * each provider binds one base URL, API and auth mode.
 *
 *   codemie         OpenAI wire (Chat Completions / Responses), `<base>/v1`, Bearer key
 *   codemie-claude  Anthropic Messages wire, `<base>`, `authHeader`
 *
 * Both rosters come from one `GET /v1/llm_models?include_all=true` through the local CodeMie proxy
 * daemon — the same catalog `codemie models list` prints — so `omp models refresh` always mirrors the
 * active CodeMie profile, with its cost, context window, output cap, and image input.
 *
 * Deployed by `codemie proxy connect --omp`: scripts/bundle-omp-extension.mjs bundles this file
 * into one self-contained ESM artifact that omp loads from `<agentDir>/extensions/`. It runs inside
 * omp, never inside the CodeMie CLI, so it only reads the daemon state file and must not depend on
 * CLI runtime state.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { LlmModel } from '@/providers/plugins/sso/sso.http-client.js';
import { ConfigurationError } from '@/utils/errors.js';
import { getCodemieHome } from '@/utils/paths.js';

import { buildOmpModelRoster, type OmpApi, type OmpModelRoster, type OmpModelRow } from './omp-models.js';

/** The slice of omp's `ExtensionAPI` this extension uses; omp passes the full API. */
interface OmpExtensionApi {
  registerProvider(name: string, config: {
    baseUrl: string;
    apiKey: string;
    api: OmpApi;
    authHeader?: boolean;
    fetchDynamicModels: (apiKey: string | undefined) => Promise<readonly OmpModelRow[]>;
  }): void;
}

interface DaemonConnection {
  url: string;
  gatewayKey: string;
}

// Mirrors `codemie proxy start` / `connect` defaults (DEFAULT_DAEMON_PORT, daemon-manager gatewayKey).
const DEFAULT_DAEMON_URL = 'http://127.0.0.1:4001';
const DEFAULT_GATEWAY_KEY = 'codemie-proxy';
// omp hard-caps a dynamic fetch at 15 s; failing first yields this extension's actionable error.
const CATALOG_TIMEOUT_MS = 10_000;
// openai and anthropic discovery run back to back; one catalog request serves both.
const ROSTER_REUSE_MS = 5_000;

function readDaemonConnection(): DaemonConnection {
  try {
    const state = JSON.parse(readFileSync(join(getCodemieHome(), 'proxy-daemon.json'), 'utf-8')) as Partial<DaemonConnection>;
    return {
      url: typeof state.url === 'string' && state.url ? state.url : DEFAULT_DAEMON_URL,
      gatewayKey: typeof state.gatewayKey === 'string' && state.gatewayKey ? state.gatewayKey : DEFAULT_GATEWAY_KEY,
    };
  } catch {
    return { url: DEFAULT_DAEMON_URL, gatewayKey: DEFAULT_GATEWAY_KEY };
  }
}

async function fetchRoster({ url, gatewayKey }: DaemonConnection): Promise<OmpModelRoster> {
  // Discovery uses the same connection snapshot as inference; a daemon port/key change needs an omp restart.
  const endpoint = new URL('/v1/llm_models?include_all=true', url);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${gatewayKey}` },
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ConfigurationError(
      `CodeMie proxy is not reachable at ${url} (${error instanceof Error ? error.message : String(error)}). ` +
      'Run `codemie proxy connect --omp` (or `codemie proxy start`).'
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new ConfigurationError('CodeMie SSO session expired or invalid. Run `codemie profile login`, then `omp models refresh`.');
  }
  if (!response.ok) {
    throw new ConfigurationError(`CodeMie model catalog request failed: HTTP ${response.status} from ${endpoint.toString()}`);
  }
  // An expired SSO session can surface as a 200 HTML login page instead of a 401.
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new ConfigurationError('CodeMie model catalog returned a non-JSON response. Run `codemie profile login`, then `omp models refresh`.');
  }

  const payload = (await response.json()) as unknown;
  if (!Array.isArray(payload)) {
    throw new ConfigurationError(`CodeMie model catalog returned an unexpected payload from ${endpoint.toString()}`);
  }
  return buildOmpModelRoster(payload as LlmModel[]);
}

export default function codemieModels(pi: OmpExtensionApi): void {
  const connection = readDaemonConnection();
  // Inference may go through another local hop (e.g. a caching proxy that forwards to the daemon);
  // the catalog is always read from the daemon itself.
  const baseUrl = (process.env.CODEMIE_OMP_BASE_URL?.trim() || connection.url).replace(/\/+$/, '');

  let shared: { startedAt: number; roster: Promise<OmpModelRoster> } | undefined;
  const loadRoster = (): Promise<OmpModelRoster> => {
    if (!shared || Date.now() - shared.startedAt > ROSTER_REUSE_MS) {
      shared = { startedAt: Date.now(), roster: fetchRoster(connection) };
    }
    return shared.roster;
  };

  pi.registerProvider('codemie', {
    baseUrl: `${baseUrl}/v1`,
    apiKey: connection.gatewayKey,
    api: 'openai-completions',
    fetchDynamicModels: async () => (await loadRoster()).openai,
  });
  pi.registerProvider('codemie-claude', {
    baseUrl,
    apiKey: connection.gatewayKey,
    api: 'anthropic-messages',
    authHeader: true,
    fetchDynamicModels: async () => (await loadRoster()).anthropic,
  });
}
