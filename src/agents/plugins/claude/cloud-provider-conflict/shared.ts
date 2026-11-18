/**
 * Small pieces the resolver, prompt, switcher and gate of the cloud-provider settings conflict share.
 */
import type { ConflictLayer, ConflictScope } from './resolver.js';

/** VS Code setting whose `{ name, value }` entries the Claude Code extension passes to Claude as process env. */
export const VSCODE_ENV_KEY = 'claudeCode.environmentVariables';

/** Claude Code's own settings files. One that is malformed is skipped with a warning, as Claude Code skips it. */
export const CLAUDE_SETTINGS_FILE_SCOPES: readonly ConflictScope[] = ['user', 'project', 'project-local', 'managed'];

/** The Claude Code settings files a switch may rewrite: every settings file except managed policy. */
export const EDITABLE_CLAUDE_SETTINGS_SCOPES: readonly ConflictScope[] = ['user', 'project', 'project-local'];

/** A layer set by IT (Claude Code or Claude Desktop managed policy), which is never switched here. */
export function isManagedScope(layer: Pick<ConflictLayer, 'scope'>): boolean {
  return layer.scope === 'managed' || layer.scope === 'desktop-managed';
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Default output of the prompt and the switch report: one line on stdout. */
export function printLine(line: string): void {
  console.log(line);
}
