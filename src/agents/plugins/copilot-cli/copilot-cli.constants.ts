/**
 * Shared Copilot CLI identifiers.
 *
 * These live apart from `copilot-cli.plugin.ts` so the session adapter can use them
 * without importing the plugin, which imports the adapter — a cycle.
 */

/** Internal agent key. Disambiguates the CLI from the VS Code / JetBrains extensions. */
export const COPILOT_CLI_AGENT_NAME = 'copilot-cli';

/** User-facing label shown in the analytics report and terminal output. */
export const COPILOT_CLI_DISPLAY_NAME = 'GitHub Copilot CLI';

/** Agent key for sessions created by the GitHub Copilot desktop app (same `session-state` store as the CLI). */
export const COPILOT_DESKTOP_AGENT_NAME = 'copilot-desktop';

/** `workspace.yaml` `client_name` written by the Copilot desktop app. */
const COPILOT_DESKTOP_CLIENT_NAME = 'vscode-agent-host';

/** Agent key for a session, derived from the host application recorded in its `workspace.yaml`. */
export function resolveCopilotAgentKey(clientName?: string): string {
  return clientName === COPILOT_DESKTOP_CLIENT_NAME ? COPILOT_DESKTOP_AGENT_NAME : COPILOT_CLI_AGENT_NAME;
}

// The Copilot desktop (Tauri) app prefixes the user's message with internal context blocks
// (<copilot_tauri_workspace>, <current_datetime>, ...); they must not surface as the session prompt/title.
// Only complete leading blocks are removed, so a user's own mention of these tags is kept.
const DESKTOP_WRAPPER_TAGS = ['copilot_tauri_workspace', 'current_datetime'];
const DESKTOP_PREAMBLE_RE = new RegExp(
  `^\\s*(?:<(${DESKTOP_WRAPPER_TAGS.join('|')})\\b[^>]*>[\\s\\S]*?<\\/\\1>\\s*)+`,
  'i'
);

/** Removes the desktop app's leading internal context blocks from a user prompt. */
export function stripDesktopPreamble(text: string): string {
  return text.replace(DESKTOP_PREAMBLE_RE, '').trim();
}

// For slash commands (/review, /security-review, /fleet, ...) Copilot swaps the typed command for an internal
// instruction ("The user has requested ... via the /review command. Use the task tool ...").
const SLASH_INSTRUCTION_RE = /^The user has (?:requested|invoked)\b[^\n]*?\bvia the (\/[\w-]+) command\b/i;

/** The user's own prompt: desktop preamble removed and Copilot's internal slash-command instruction replaced by the command. */
export function normalizeUserPrompt(text: string): string {
  const stripped = stripDesktopPreamble(text);
  const slash = SLASH_INSTRUCTION_RE.exec(stripped);
  return slash ? slash[1] : stripped;
}

/** Slash command (without the leading `/`) behind a user message, from Copilot's instruction or the typed text. */
export function extractSlashCommand(content?: string, transformedContent?: string): string | undefined {
  for (const candidate of [transformedContent, content]) {
    if (typeof candidate !== 'string') continue;
    const text = stripDesktopPreamble(candidate);
    const match = SLASH_INSTRUCTION_RE.exec(text) ?? /^(\/[\w-]+)(?=\s|$)/.exec(text);
    if (match) return match[1].slice(1);
  }
  return undefined;
}

/** User-facing short name used by install/uninstall surfaces. */
export const COPILOT_CLI_INSTALL_ALIAS = 'copilot';

/** Runtime client type used for managed Copilot sessions. */
export const COPILOT_CLI_CLIENT_TYPE = 'codemie-copilot';
