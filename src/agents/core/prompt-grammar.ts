/**
 * Shared prompt grammar (EPMCDME-17748): how a raw prompt names a slash command and which prompts
 * the tool wrote itself. Daemon-safe leaf: no imports, no I/O.
 */

/** Who wrote a prompt: the user, or the tool itself (background task, agent message). */
export type PromptSource = 'user' | 'task_notification' | 'agent_message';

/** Opening sentence Claude Code writes into the first prompt after a context reset. Reduction-only marker. */
export const SESSION_CONTINUATION_PREFIX = 'This session is being continued from a previous conversation';

/** Starts of an auto prompt: the tool injects it when a background task finishes or a message arrives. */
export const AUTO_PROMPT_SOURCES: ReadonlyArray<readonly [prefix: string, source: PromptSource]> = [
  ['<task-notification>', 'task_notification'],
  ['<agent-message', 'agent_message'],
];

/**
 * Markers reduction recognizes: the auto prompts above plus the session-continuation sentence.
 * Kept apart from AUTO_PROMPT_SOURCES so `prompt_source` and session signals are unchanged with reduction off.
 */
export const REDUCTION_AUTO_MARKERS: readonly string[] = [
  ...AUTO_PROMPT_SOURCES.map(([prefix]) => prefix),
  SESSION_CONTINUATION_PREFIX,
];

/** The leading marker of an auto prompt for reduction (its fixed prefix), `undefined` for a prompt the user wrote. */
export function autoPromptMarker(text: string): string | undefined {
  const start = text.trimStart();
  return REDUCTION_AUTO_MARKERS.find((prefix) => start.startsWith(prefix));
}

/** The source of an auto prompt, `undefined` for a prompt the user wrote. */
export function autoPromptSource(text: string): PromptSource | undefined {
  const start = text.trimStart();
  return AUTO_PROMPT_SOURCES.find(([prefix]) => start.startsWith(prefix))?.[1];
}

/** Slash command the prompt starts with. */
export interface CommandFields {
  /** Command name without the leading slash, '' when the prompt is not a slash command. */
  command_name: string;
}

export const COMMAND_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;

/**
 * Parses the leading slash command of a prompt (`/simplify foo` -> `simplify`,
 * `/sdlc-factory:sdlc-standard x` -> `sdlc-factory:sdlc-standard`). Syntactic heuristic only:
 * it does not check that the command exists, and arguments are never reported. A pasted path
 * (`/Users/foo`), a URL or a bare `/` yield ''. Claude Code delivers the raw typed text to
 * `UserPromptSubmit`; built-in commands such as `/model` never reach it. The authoritative
 * event for skill-backed commands stays `agent.skill.dispatch`.
 */
export function resolveCommandFields(prompt: string): CommandFields {
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith('/')) {
    return { command_name: '' };
  }
  const token = trimmed.slice(1).split(/\s/, 1)[0] ?? '';
  return { command_name: COMMAND_TOKEN_RE.test(token) ? token : '' };
}

// The Copilot desktop (Tauri) app prefixes the user's message with internal context blocks
// (<copilot_tauri_workspace>, <copilot_artifacts>, <current_datetime>, ...); they must not surface as the session
// prompt/title. Every `copilot_*` tag is treated as a wrapper so new desktop-app blocks need no code change.
// The app also appends blocks after the user's text (<system_notification> session-rename reminder,
// <app_user_message_source_json>), which must not leak into the stored prompt either.
// Only complete blocks at the very start/end are removed, so a user's own mention of these tags is kept.
const DESKTOP_WRAPPER_TAGS = 'copilot_[a-z0-9_]+|current_datetime|branch_rename_request';
const DESKTOP_TRAILER_TAGS = 'system_notification|app_[a-z0-9_]+';
const DESKTOP_PREAMBLE_RE = new RegExp(
  `^\\s*(?:<(${DESKTOP_WRAPPER_TAGS})\\b[^>]*>[\\s\\S]*?<\\/\\1>\\s*)+`,
  'i'
);
// A trailing block may not contain another opening of its own tag, so a mid-text mention cannot swallow the user's text.
const DESKTOP_TRAILER_RE = new RegExp(
  `(?:<(${DESKTOP_TRAILER_TAGS})\\b[^>]*>(?:(?!<\\1\\b)[\\s\\S])*?<\\/\\1>\\s*)+$`,
  'i'
);

/** Removes the desktop app's leading and trailing internal context blocks from a user prompt. */
export function stripDesktopWrappers(text: string): string {
  return text.replace(DESKTOP_PREAMBLE_RE, '').replace(DESKTOP_TRAILER_RE, '').trim();
}

// For slash commands (/review, /security-review, /fleet, ...) Copilot swaps the typed command for an internal
// instruction ("The user has requested ... via the /review command. Use the task tool ...").
// Command token: letter-led segments joined by `:` or `.`, so `/sdlc-factory:x` matches but `/v1.2` and `/1` do not.
export const SLASH_INSTRUCTION_RE = /^The user has (?:requested|invoked)\b[^\n]*?\bvia the (\/[A-Za-z][\w-]*(?:[:.][A-Za-z][\w-]*)*) command\b/i;
const TYPED_SLASH_RE = /^(\/[A-Za-z][\w-]*(?:[:.][A-Za-z][\w-]*)*)(?=\s|$)/;

const KNOWN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  'agent', 'allow-all', 'clear', 'compact', 'context', 'cwd', 'delegate', 'diff', 'exit', 'feedback', 'fleet', 'help', 'init',
  'login', 'logout', 'mcp', 'model', 'new', 'plan', 'quit', 'rename', 'research', 'resume', 'review', 'security-review', 'session', 'share',
  'skills', 'terminal-setup', 'theme', 'usage', 'user',
]);

// /fleet is injected as "You are now in fleet mode. Dispatch sub-agents ..." with no "via the /x command" wording.
export const FLEET_INSTRUCTION_RE = /^You are now in fleet mode\b/i;

// Fallback when only the label is available (the hook may not carry the transformed text).
export const FLEET_LABEL_RE = /^Fleet deployed:\s*([\s\S]*?)\s*$/;

/** Slash command (without the leading `/`) behind a user message, from Copilot's instruction or the typed text. */
export function extractSlashCommand(content?: string, transformedContent?: string): string | undefined {
  const strippedContent = typeof content === 'string' ? stripDesktopWrappers(content) : undefined;
  const strippedTransformed = typeof transformedContent === 'string' ? stripDesktopWrappers(transformedContent) : undefined;
  // A typed token is a command only when Copilot actually rewrote the message into one of its own
  // instructions (compared after preamble stripping, so a preamble added only on one side doesn't count),
  // it is namespaced, or it is a known built-in; otherwise it is a path such as /tmp is full.
  const rewritten =
    strippedTransformed !== undefined &&
    strippedContent !== undefined &&
    strippedTransformed !== strippedContent &&
    (FLEET_INSTRUCTION_RE.test(strippedTransformed) ||
      FLEET_LABEL_RE.test(strippedTransformed) ||
      SLASH_INSTRUCTION_RE.test(strippedTransformed));

  for (const text of [strippedTransformed, strippedContent]) {
    if (text === undefined) continue;
    if (FLEET_INSTRUCTION_RE.test(text) || FLEET_LABEL_RE.test(text)) return 'fleet';
    const instruction = SLASH_INSTRUCTION_RE.exec(text);
    if (instruction) return instruction[1].slice(1);
    const typed = TYPED_SLASH_RE.exec(text)?.[1];
    if (!typed) continue;
    if (rewritten || typed.includes(':') || KNOWN_SLASH_COMMANDS.has(typed.slice(1).toLowerCase())) return typed.slice(1);
  }
  return undefined;
}

