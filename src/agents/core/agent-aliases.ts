/**
 * User-facing aliases for agent-management and launcher commands.
 *
 * Internal registry identities remain canonical (for example `copilot-cli`) while
 * selected user-facing commands are shortened for ergonomics.
 */

const MANAGED_AGENT_ALIASES: Record<string, string> = {
  copilot: 'copilot-cli',
};

const USER_FACING_AGENT_NAMES: Record<string, string> = {
  'copilot-cli': 'copilot',
};

const LAUNCHER_COMMANDS: Record<string, string> = {
  'copilot-cli': 'codemie-copilot',
};

/** Resolve a user-facing agent alias to the canonical registry key. */
export function resolveAgentAlias(name: string | undefined): string | undefined {
  if (!name) return name;
  return MANAGED_AGENT_ALIASES[name] ?? name;
}

/** Preferred short name for install/uninstall/list/help surfaces. */
export function getUserFacingAgentName(name: string): string {
  return USER_FACING_AGENT_NAMES[name] ?? name;
}

/** Preferred launcher command for the agent. */
export function getAgentLauncherCommand(name: string): string {
  if (name.startsWith('codemie-')) {
    return name;
  }
  return LAUNCHER_COMMANDS[name] ?? `codemie-${name}`;
}

/** Convenience for install-command hints. */
export function getAgentInstallCommand(name: string): string {
  return `codemie install ${getUserFacingAgentName(name)}`;
}

/** Convenience for uninstall-command hints. */
export function getAgentUninstallCommand(name: string): string {
  return `codemie uninstall ${getUserFacingAgentName(name)}`;
}
