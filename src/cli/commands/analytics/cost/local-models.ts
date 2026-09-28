/**
 * Local (self-hosted, free) model detection for report-time cost.
 *
 * A session launched against the `ollama` provider runs its model on the user's own
 * hardware, so there is no per-token bill: the report prices it at $0 and lists it as
 * local rather than unpriced. Ollama's hosted "cloud" models are the exception — they
 * are tagged `<name>:<size>-cloud` or `<name>:cloud` and are billed by Ollama, so they
 * stay unpriced. This `:tag` handling is deliberately kept out of the general price
 * resolver (price-resolution.ts), which only ever sees provider-agnostic model ids.
 */

const OLLAMA_PROVIDER = 'ollama';
const OLLAMA_CLOUD_TAG_PATTERN = /(?:-cloud|:cloud)$/i;

/** True when `model` is an Ollama cloud-hosted tag (`…-cloud` or `…:cloud`). */
export function isOllamaCloudTag(model: string): boolean {
  return OLLAMA_CLOUD_TAG_PATTERN.test(model);
}

/** True when `model`, served by `provider`, runs locally and therefore costs $0. */
export function isLocalModel(provider: string | undefined, model: string): boolean {
  return provider?.toLowerCase() === OLLAMA_PROVIDER && !isOllamaCloudTag(model);
}
