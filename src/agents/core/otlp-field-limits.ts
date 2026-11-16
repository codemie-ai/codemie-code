import { maskSecretsDeep } from '@/utils/security.js';

/**
 * The masking and length rules every forwarded OTLP hook event follows. A leaf module on purpose: the proxy
 * daemon's producers apply the same rules, and importing them from the adapter base class would pull the whole
 * adapter into the daemon's module graph.
 */

export const MAX_PROMPT_CHARS = 200;
export const MAX_TOOL_FIELD_CHARS = 300;

/** Free-text fields cut after masking, each to its own limit. */
export const TEXT_FIELD_LIMITS: Readonly<Record<string, number>> = {
  prompt: MAX_PROMPT_CHARS,
  tool_input: MAX_TOOL_FIELD_CHARS,
  tool_response: MAX_TOOL_FIELD_CHARS,
  error: MAX_TOOL_FIELD_CHARS,
  description: MAX_TOOL_FIELD_CHARS,
};

/** Top-level identifier fields that are never free text; masking must not touch them. */
export const UNMASKED_FIELD_KEYS: ReadonlySet<string> = new Set([
  'session_id', 'type', 'timestamp', 'file_path', 'skill_name', 'subagent_type', 'fork_agent_id',
  'hook_event_name', 'tool_name', 'tool_use_id', 'agent_id', 'agent_type', 'agent_name',
  'notification_type', 'error_type',
]);

export function boundedText(value: unknown, maxChars: number): string {
  if (value === undefined || value === null) {
    return '';
  }
  let text: string;
  if (typeof value === 'string') {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  const cut = text.slice(0, maxChars);
  // A cut inside a surrogate pair would leave a lone high surrogate, which strict UTF-8 consumers reject.
  return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** Masks secrets in every field, then cuts the free-text fields to their limits (mask first, so a secret straddling a cut is never half-shown). */
export function maskAndBoundFields(fields: Record<string, unknown>): Record<string, unknown> {
  const limited = maskSecretsDeep(fields, UNMASKED_FIELD_KEYS) as Record<string, unknown>;
  for (const [field, maxChars] of Object.entries(TEXT_FIELD_LIMITS)) {
    if (Object.prototype.hasOwnProperty.call(limited, field)) {
      limited[field] = boundedText(limited[field], maxChars);
    }
  }
  return limited;
}
