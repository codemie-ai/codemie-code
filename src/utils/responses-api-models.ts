/**
 * Which CodeMie deployments must be called through the OpenAI Responses API.
 *
 * The /v1/llm_models endpoint does not expose a "mode" field, so we maintain
 * an explicit list of model-name patterns that require OpenAI Responses API
 * (POST /v1/responses) instead of Chat Completions (POST /v1/chat/completions).
 *
 * Naming conventions observed in CodeMie deployments:
 *   Responses API  →  gpt-5-2-*, gpt-5.2-*, gpt-5.x-codex-*, gpt-5-x-codex-*,
 *                     gpt-5.4-*, gpt-5-4-*, gpt-5.5-*, gpt-5-5-*, gpt-5.6-*, gpt-5-6-*,
 *                     gpt-6-*, gpt-6.* (e.g. gpt-6-luna, gpt-6.1-sol, openai.gpt-6-luna, bare openai.gpt-6)
 *   Chat Completions → gpt-4*, gpt-5-<year>-*, o1/o3/o4*, gemini-*, claude-*, …
 *
 * Update this list whenever new Responses-API-only models are deployed.
 *
 * Dependency-free on purpose: the omp extension bundle (connectors/omp) inlines it.
 */

const RESPONSES_API_MODEL_PATTERNS: RegExp[] = [
  /^gpt-5-2-/,        // gpt-5-2-2025-12-11 (and future gpt-5-2-YYYY-* variants)
  /^gpt-5\.2-/,       // gpt-5.2-chat
  /^gpt-5-1-codex/,   // gpt-5-1-codex-2025-11-13
  /^gpt-5\.1-codex/,  // gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.1-codex-max
  /^gpt-5-3-codex/,   // hyphenated variant of gpt-5.3-codex
  /^gpt-5\.3-codex/,  // gpt-5.3-codex-2026-02-24
  /^gpt-5\.4-/,       // gpt-5.4-* — Azure requires /v1/responses for tools + reasoning_effort
  /^gpt-5-4-/,        // hyphenated variant of gpt-5.4-*
  /^gpt-5\.5-/,       // gpt-5.5-2026-04-24 — same Azure restriction as gpt-5.4
  /^gpt-5-5-/,        // hyphenated variant of gpt-5.5-*
  /gpt-5[.-]6/,       // gpt-5.6-* (e.g. openai.gpt-5.6-luna) — same Azure restriction (tools + reasoning_effort)
  /gpt-6(?!\d)/,      // gpt-6-* / gpt-6.* (e.g. gpt-6-luna, gpt-6.1-sol, openai.gpt-6-luna, chatgpt-6.1-sol) — Responses API for built-in tools; (?!\d) keeps gpt-60-style ids out while staying ready for 6.2+
];

export function isResponsesApiModel(id: string): boolean {
  return RESPONSES_API_MODEL_PATTERNS.some(p => p.test(id));
}
