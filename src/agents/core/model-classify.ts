/**
 * Leaf module for the model-compatibility classification rule (EPMCDME-15641).
 * Has no registry import so agent plugins can depend on it without an import cycle.
 */

export type ModelCompat = 'compatible' | 'incompatible' | 'unverified';

export interface ModelClassifyContext {
  /** Catalog hint: the model is a router/alias (ModelInfo.metadata.isRouter). */
  isRouter?: boolean;
}

const ROUTER_NAME = /router/i;

// Definite vendor families. A router whose name carries one of these belongs to that family.
const VENDOR_FAMILIES: RegExp[] = [
  /claude/i,
  /gpt/i,
  /gemini/i,
  /kimi/i,
  /qwen/i,
  /deepseek/i,
  /llama/i,
  /mistral/i,
  /grok/i,
];

/**
 * Shared classification rule behind every per-agent `classifyModel` hook:
 * predicate match -> compatible; a router/alias with no definite family -> unverified;
 * anything else -> incompatible.
 */
export function classifyWithPredicate(
  isCompatible: (id: string) => boolean,
  id: string,
  ctx?: ModelClassifyContext
): ModelCompat {
  if (isCompatible(id)) return 'compatible';
  const isRouter = ctx?.isRouter === true || ROUTER_NAME.test(id);
  if (isRouter && !VENDOR_FAMILIES.some((p) => p.test(id))) return 'unverified';
  return 'incompatible';
}
