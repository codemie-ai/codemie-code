/**
 * Connector that points the Codex desktop app (Codex inside the ChatGPT desktop
 * app) at the local CodeMie proxy by splicing a managed provider block into the
 * user's `~/.codex/config.toml`.
 *
 * CodeMie never installs, launches or patches the app — the shared config file
 * that the app and the Codex CLI both read is the whole integration seam.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { getCodemiePath } from '@/utils/paths.js';

/**
 * Resolve the config file the desktop app reads.
 *
 * Deliberately NOT `getCodexHomePath()` from the codex agent plugin. That helper
 * is used by code paths which redirect `CODEX_HOME` to a CodeMie-isolated home
 * for the CLI they spawn, and the desktop app never reads that home. A
 * `CODEX_HOME` visible here belongs to the user, and upstream documents the app
 * respecting it, so it is honoured.
 */
export function getCodexDesktopConfigPath(): string {
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  return join(codexHome, 'config.toml');
}

/** Where the connector records what it owns, mirroring the Claude Desktop precedent. */
export function getCodexDesktopStatePath(): string {
  return getCodemiePath('proxy', 'codex-desktop-state.json');
}

/** Install locations for the ChatGPT desktop app, which is what ships Codex. */
export function getCodexDesktopAppCandidates(): string[] {
  const home = homedir();
  if (process.platform === 'darwin') {
    return [
      '/Applications/ChatGPT.app',
      join(home, 'Applications', 'ChatGPT.app'),
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    return [
      join(localAppData, 'Programs', 'ChatGPT'),
      join(programFiles, 'ChatGPT'),
    ];
  }
  return [];
}

/** First candidate path that exists, or null. */
export function findCodexDesktopApp(
  candidates: string[] = getCodexDesktopAppCandidates()
): string | null {
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
