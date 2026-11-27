import { autoPromptSource, type PromptSource } from '@/agents/core/prompt-grammar.js';

export { AUTO_PROMPT_SOURCES, autoPromptSource, type PromptSource } from '@/agents/core/prompt-grammar.js';

/**
 * Context blocks Claude Code adds to the typed text: the IDE extensions' open file and selection,
 * and system reminders. The whole block goes, its content included. Non-greedy and anchored on the
 * matching closing tag, so text between two blocks is kept; an unterminated block is left as is.
 */
const INJECTED_CONTEXT_BLOCK = /<(ide_opened_file|ide_selection|system-reminder)(?:[ \t][^<>]*)?>[\s\S]*?<\/\1>/g;

/** The source of a `UserPromptSubmit` prompt; an auto prompt keeps its text, only flagged. */
export function resolvePromptSource(prompt: string): PromptSource {
  return autoPromptSource(prompt) ?? 'user';
}

/**
 * Removes the context blocks Claude Code adds to a prompt (IDE open file and selection, system
 * reminders) and keeps what the user typed. Text without a block is returned unchanged; otherwise
 * the result is trimmed at both ends and inner whitespace is left as is.
 */
export function stripInjectedContext(text: string): string {
  const stripped = text.replace(INJECTED_CONTEXT_BLOCK, '');
  return stripped === text ? text : stripped.trim();
}
