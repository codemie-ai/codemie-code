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
// Command token: letter-led segments joined by `:` or `.`, so `/sdlc-factory:x` matches but `/v1.2` and `/1` do not.
const SLASH_INSTRUCTION_RE = /^The user has (?:requested|invoked)\b[^\n]*?\bvia the (\/[A-Za-z][\w-]*(?:[:.][A-Za-z][\w-]*)*) command\b/i;
const TYPED_SLASH_RE = /^(\/[A-Za-z][\w-]*(?:[:.][A-Za-z][\w-]*)*)(?=\s|$)/;

// /fleet is injected as "You are now in fleet mode. Dispatch sub-agents ..." with no "via the /x command" wording.
const FLEET_INSTRUCTION_RE = /^You are now in fleet mode\b/i;

// Copilot ends the fleet instruction with "User request: <typed text>"; its `content` is a display label ("Fleet deployed: ...").
const FLEET_REQUEST_RE = /\n\s*User request:\s*([\s\S]*?)\s*$/i;

// Fallback when only the label is available (the hook may not carry the transformed text).
const FLEET_LABEL_RE = /^Fleet deployed:\s*([\s\S]*?)\s*$/;

function fleetTitle(instruction: string): string {
  const request = (FLEET_REQUEST_RE.exec(instruction) ?? FLEET_LABEL_RE.exec(instruction))?.[1];
  return request ? `/fleet: ${request}` : '/fleet';
}

/**
 * The user's own prompt: desktop preamble removed and Copilot's internal slash-command instruction replaced by the command.
 * `transformed` is the instruction Copilot actually sent to the model, when the raw text is only a label.
 */
export function normalizeUserPrompt(text: string, transformed?: string): string {
  for (const candidate of [transformed, text]) {
    if (typeof candidate !== 'string') continue;
    const instruction = stripDesktopPreamble(candidate);
    if (FLEET_INSTRUCTION_RE.test(instruction) || FLEET_LABEL_RE.test(instruction)) return fleetTitle(instruction);
  }
  const stripped = stripDesktopPreamble(text);
  const slash = SLASH_INSTRUCTION_RE.exec(stripped);
  return slash ? slash[1] : stripped;
}

/** Slash command (without the leading `/`) behind a user message, from Copilot's instruction or the typed text. */
export function extractSlashCommand(content?: string, transformedContent?: string): string | undefined {
  for (const candidate of [transformedContent, content]) {
    if (typeof candidate !== 'string') continue;
    const text = stripDesktopPreamble(candidate);
    if (FLEET_INSTRUCTION_RE.test(text) || FLEET_LABEL_RE.test(text)) return 'fleet';
    const match = SLASH_INSTRUCTION_RE.exec(text) ?? TYPED_SLASH_RE.exec(text);
    if (match) return match[1].slice(1);
  }
  return undefined;
}

/** User-facing short name used by install/uninstall surfaces. */
export const COPILOT_CLI_INSTALL_ALIAS = 'copilot';

/** Runtime client type used for managed Copilot sessions. */
export const COPILOT_CLI_CLIENT_TYPE = 'codemie-copilot';
