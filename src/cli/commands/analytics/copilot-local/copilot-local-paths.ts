/**
 * Every platform-dependent location the Copilot local scanners read.
 *
 * This is the ONLY module in `copilot-local/` that looks at `process.platform` or at an
 * environment variable naming a directory. Each scanner takes its roots as arguments, so
 * adding or fixing a platform is a change here and nowhere else.
 *
 * Ported from the Windows-only scanner in `sl-ai-sdlc-cost-tracking`
 * (`src/parsers/vscode_paths.py`, `privacy_fs.env_dir`), whose roots were `%APPDATA%` /
 * `%LOCALAPPDATA%` only. The subtree BELOW each root is identical on every platform, so
 * only the root resolution differs.
 *
 * An absent path is never an error: discovery returns fewer roots and the caller reports
 * "source skipped" (the `env_dir(...) is None` behaviour of the Python original).
 */

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCopilotHome } from '@/agents/plugins/copilot-cli/copilot-cli.paths.js';

/** VS Code editions scanned by default; mirrors `scan.vscode_editions` in the Python config. */
export const DEFAULT_VSCODE_EDITIONS = ['Code', 'Code - Insiders'] as const;

/** Which of a VS Code user-data root's three chat-session locations a directory is. */
export type VsCodeLocationKind = 'workspaceStorage' | 'emptyWindow' | 'transferred';

/** One directory holding VS Code chat-session `.jsonl` files. */
export interface VsCodeLocation {
  /** Edition folder name, e.g. `Code - Insiders`. Not persisted — only {@link label} is. */
  edition: string;
  /** `stable` | `insiders` — the only edition detail allowed to leave this module. */
  label: string;
  kind: VsCodeLocationKind;
  /** Absolute path of the directory holding the session files. */
  path: string;
}

/** `stable` unless the edition folder name marks it as Insiders. */
export function editionLabel(edition: string): string {
  return edition.toLowerCase().includes('insiders') ? 'insiders' : 'stable';
}

/**
 * VS Code's per-edition user-data directory, or undefined on a platform/edition with none.
 *
 * Mirrors `getVsCodeProductDir` in `src/cli/commands/proxy/connectors/vscode.ts`, but returns
 * undefined instead of throwing: a scanner that finds no VS Code must degrade to zero rows,
 * never abort a report.
 */
export function vsCodeUserDataDir(edition: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', edition);
  }
  if (process.platform === 'win32') {
    return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), edition);
  }
  if (process.platform === 'linux') {
    return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), edition);
  }
  return undefined;
}

/** Subdirectories of a user-data root that are scan roots: `User` plus every `User/profiles/*`. */
function profileRoots(userDataDir: string): string[] {
  const userRoot = join(userDataDir, 'User');
  if (!existsSync(userRoot)) {
    return [];
  }
  // Whether a named profile nests its own workspaceStorage/globalStorage is unverified
  // (assumption A1 of the Python original), so BOTH the shared `User` root and every
  // per-profile root are scanned. Duplicate rows are deduped later by request id.
  const roots = [userRoot];
  try {
    for (const entry of readdirSync(join(userRoot, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) {
        roots.push(join(userRoot, 'profiles', entry.name));
      }
    }
  } catch {
    // No named profiles; the shared root is the only one.
  }
  return roots;
}

/**
 * Every existing directory holding VS Code chat sessions, across editions × profiles ×
 * the three location kinds.
 */
export function vsCodeChatLocations(
  editions: readonly string[] = DEFAULT_VSCODE_EDITIONS,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Explicit user-data roots, bypassing platform resolution. The seam that makes the scanner
   * runnable against a fixture on any OS — platform resolution is homedir-based on macOS, so
   * an env var alone cannot redirect it.
   */
  userDataDirs?: readonly string[]
): VsCodeLocation[] {
  const found: VsCodeLocation[] = [];
  const roots: ReadonlyArray<{ edition: string; dir: string | undefined }> = userDataDirs
    ? userDataDirs.map((dir) => ({ edition: dir, dir }))
    : editions.map((edition) => ({ edition, dir: vsCodeUserDataDir(edition, env) }));
  for (const { edition, dir: userData } of roots) {
    if (!userData || !existsSync(userData)) {
      continue;
    }
    const label = editionLabel(edition);
    for (const root of profileRoots(userData)) {
      // One chatSessions directory per workspace hash.
      const workspaceStorage = join(root, 'workspaceStorage');
      try {
        for (const entry of readdirSync(workspaceStorage, { withFileTypes: true })) {
          const dir = join(workspaceStorage, entry.name, 'chatSessions');
          if (entry.isDirectory() && existsSync(dir)) {
            found.push({ edition, label, kind: 'workspaceStorage', path: dir });
          }
        }
      } catch {
        // No workspaceStorage under this root.
      }
      // Window-less and transferred chats live under globalStorage instead.
      for (const [name, kind] of [
        ['emptyWindowChatSessions', 'emptyWindow'],
        ['transferredChatSessions', 'transferred'],
      ] as ReadonlyArray<[string, VsCodeLocationKind]>) {
        const dir = join(root, 'globalStorage', name);
        if (existsSync(dir)) {
          found.push({ edition, label, kind, path: dir });
        }
      }
    }
  }
  return found;
}

/** One Copilot home directory (`~/.copilot`-shaped) to scan, and the WSL distro it belongs to. */
export interface CopilotHomeRoot {
  path: string;
  /** Set only for a home read inside a WSL distro; drives the `(WSL:<distro>)` surface label. */
  wslDistro?: string;
}

/**
 * The local Copilot home, when it exists.
 *
 * Platform-neutral already: Copilot uses `~/.copilot` on every OS, and `COPILOT_HOME`
 * overrides it. Desktop and the CLI share this one store and are told apart by each
 * session's `workspace.yaml` `client_name`, not by path.
 */
export function localCopilotHome(env: NodeJS.ProcessEnv = process.env): CopilotHomeRoot | undefined {
  const home = getCopilotHome(env);
  return existsSync(home) ? { path: home } : undefined;
}

/** `session-store.db` inside a Copilot home. */
export function sessionStoreDb(home: string): string {
  return join(home, 'session-store.db');
}

/** The `session-state` directory inside a Copilot home (per-session `workspace.yaml`, `events.jsonl`). */
export function sessionStateRoot(home: string): string {
  return join(home, 'session-state');
}
