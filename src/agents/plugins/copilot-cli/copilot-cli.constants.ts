/**
 * Shared Copilot CLI identifiers.
 *
 * These live apart from `copilot-cli.plugin.ts` so the session adapter can use them
 * without importing the plugin, which imports the adapter — a cycle.
 */

import { SESSION_UUID_PATTERN } from '../../core/session/next-record-start.js';
import {
  FLEET_INSTRUCTION_RE,
  FLEET_LABEL_RE,
  SLASH_INSTRUCTION_RE,
  extractSlashCommand,
  stripDesktopWrappers,
} from '../../core/prompt-grammar.js';

export { extractSlashCommand, stripDesktopWrappers };

/** Internal agent key. Disambiguates the CLI from the VS Code / JetBrains extensions. */
export const COPILOT_CLI_AGENT_NAME = 'copilot-cli';

/** User-facing label shown in the analytics report and terminal output. */
export const COPILOT_CLI_DISPLAY_NAME = 'GitHub Copilot CLI';

/** Agent key for sessions created by the GitHub Copilot desktop app (same `session-state` store as the CLI). */
export const COPILOT_DESKTOP_AGENT_NAME = 'copilot-desktop';

/**
 * `workspace.yaml` `client_name` written by the GitHub Copilot desktop app. The CLI writes `github/cli`
 * and VS Code Chat's Copilot CLI agent `vscode-agent-host`; both stay `copilot-cli`.
 */
const COPILOT_DESKTOP_CLIENT_NAME = 'github/autopilot';

/** Agent key for a session, derived from the host application recorded in its `workspace.yaml`. */
export function resolveCopilotAgentKey(clientName?: string): string {
  return clientName === COPILOT_DESKTOP_CLIENT_NAME ? COPILOT_DESKTOP_AGENT_NAME : COPILOT_CLI_AGENT_NAME;
}

// Copilot ends the fleet instruction with "User request: <typed text>"; its `content` is a display label ("Fleet deployed: ...").
const FLEET_REQUEST_RE = /\n\s*User request:\s*([\s\S]*?)\s*$/i;

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
    const instruction = stripDesktopWrappers(candidate);
    if (FLEET_INSTRUCTION_RE.test(instruction) || FLEET_LABEL_RE.test(instruction)) return fleetTitle(instruction);
  }
  const stripped = stripDesktopWrappers(text);
  const slash = SLASH_INSTRUCTION_RE.exec(stripped);
  return slash ? slash[1] : stripped;
}

/** A `user.message` Copilot injected for a sub-agent: its `data.source` is `agent-<session id>`; the user's own prompts carry none. */
export function isSubagentPrompt(data: unknown): boolean {
  const source = typeof data === 'object' && data !== null ? (data as { source?: unknown }).source : undefined;
  return typeof source === 'string' && source.startsWith('agent-');
}

/** User-facing short name used by install/uninstall surfaces. */
export const COPILOT_CLI_INSTALL_ALIAS = 'copilot';

/** Runtime client type used for managed Copilot sessions. */
export const COPILOT_CLI_CLIENT_TYPE = 'codemie-copilot';

/** A full Copilot session UUID, case-insensitive — it names the `session-state/<uuid>/` directory. */
export const FULL_SESSION_UUID = new RegExp(`^${SESSION_UUID_PATTERN}$`, 'i');
/** Set by the managed launcher when it pins Copilot's own session id via `--session-id`. */
export const PINNED_NATIVE_SESSION_ENV = 'CODEMIE_COPILOT_NATIVE_SESSION_ID';
/** The endpoint the launcher handed Copilot; read by hooks only when Copilot strips COPILOT_PROVIDER_BASE_URL from them. */
export const LAUNCH_PROVIDER_BASE_URL_ENV = 'CODEMIE_COPILOT_LAUNCH_BASE_URL';
