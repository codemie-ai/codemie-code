/**
 * CodeMie providers — an oh-my-pi extension.
 *
 * `codemie omp` must route oh-my-pi's model traffic through CodeMie (the local proxy for SSO
 * profiles, LiteLLM, Ollama, ...) without touching the user's own `~/.omp` configuration. So
 * instead of writing `models.yml`, the wrapper writes this run's provider/model list to a JSON
 * file and passes its path in `CODEMIE_OMP_PROVIDERS`; this extension reads it and calls
 * `pi.registerProvider` for each provider, which is what makes `--model <provider>/<id>` resolve.
 *
 * ## Invariants
 *
 * Any extension load failure can end the user's session (oh-my-pi shares Pi's loader), and the
 * factory is re-bound to every subagent session, so:
 *
 *   1. Imports are node builtins only.
 *   2. The whole factory body is wrapped in try/catch, and so is every provider's registration —
 *      one malformed provider costs that provider, not the others and never the session.
 *   3. Input is untrusted: the JSON is parsed defensively and only whitelisted fields reach
 *      `registerProvider`. No env var, a missing/unreadable/invalid file, or an empty list
 *      registers nothing.
 *   4. Nothing is logged: the file holds the run's base URL and key.
 *
 * @see src/agents/plugins/omp/omp.extension.ts — writes the JSON file and materializes this asset
 */

import { readFileSync } from 'node:fs';

const MODEL_FIELDS = ['id', 'name', 'api', 'reasoning', 'input', 'contextWindow', 'maxTokens', 'cost'];

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The model entry reduced to the fields oh-my-pi's `registerProvider` accepts. */
function toModel(entry) {
  if (!isRecord(entry) || typeof entry.id !== 'string' || !entry.id) return null;
  const model = {};
  for (const field of MODEL_FIELDS) {
    if (entry[field] !== undefined) model[field] = entry[field];
  }
  return model;
}

function toProvider(provider) {
  if (!isRecord(provider) || typeof provider.baseUrl !== 'string' || typeof provider.api !== 'string') {
    return null;
  }
  const models = Array.isArray(provider.models) ? provider.models.map(toModel).filter(Boolean) : [];
  if (models.length === 0) return null;
  return {
    baseUrl: provider.baseUrl,
    apiKey: typeof provider.apiKey === 'string' ? provider.apiKey : 'proxy-handled',
    api: provider.api,
    ...(provider.authHeader === true && { authHeader: true }),
    models,
  };
}

export default function codemieProviders(pi) {
  try {
    const configPath = process.env.CODEMIE_OMP_PROVIDERS;
    if (!configPath) return;

    let providers;
    try {
      providers = JSON.parse(readFileSync(configPath, 'utf-8')).providers;
    } catch {
      return;
    }
    if (!isRecord(providers)) return;

    for (const [name, provider] of Object.entries(providers)) {
      try {
        const config = toProvider(provider);
        if (config) pi.registerProvider(name, config);
      } catch {
        // one bad provider must not cost the others
      }
    }
  } catch {
    // never propagate: a throw here would take the user's session with it
  }
}
