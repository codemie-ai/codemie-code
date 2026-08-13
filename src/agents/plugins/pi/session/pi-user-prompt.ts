/**
 * Extract the first real user prompt from Pi v3 session entries.
 *
 * A `/skill:<name>` invocation reaches the transcript as an ordinary user message whose text
 * begins with Pi's literal `<skill …>…</skill>` block, followed by the prompt the user actually
 * typed. Left in place that block becomes the session title in the report, so it is stripped
 * via {@link parseSkillWrapper} — the single source of truth for the wrapper shape.
 */

import { parseSkillWrapper } from './pi-named-invocations.js';

interface PiPromptEntry {
  type?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

/** Concatenated text of a Pi user message's content, skill wrapper stripped; undefined when empty. */
function piUserText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return parseSkillWrapper(content).rest.trim() || undefined;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    const block = part as { type?: string; text?: unknown };
    if (block.type !== 'text' || typeof block.text !== 'string') {
      continue;
    }
    const text = parseSkillWrapper(block.text).rest.trim();
    if (text) {
      texts.push(text);
    }
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * First user prompt in transcript order that still carries text once the skill wrapper is
 * stripped. A message that is nothing but a skill block contributes no prompt and is skipped.
 */
export function firstPiUserText(entries: readonly unknown[]): string | undefined {
  for (const raw of entries) {
    const entry = raw as PiPromptEntry;
    if (entry?.type !== 'message' || entry.message?.role !== 'user') {
      continue;
    }
    const text = piUserText(entry.message.content);
    if (text) {
      return text;
    }
  }
  return undefined;
}
