/**
 * Which Copilot surface a session ran on, and the analytics agent key that follows from it.
 *
 * Copilot CLI, the Copilot desktop app and VS Code's Copilot CLI agent all write to the SAME
 * `~/.copilot` store, so the path says nothing about the surface. The authoritative signal is
 * each session's `workspace.yaml` `client_name` — invariant to the working directory, unlike
 * the cwd heuristic the Python original falls back to (a Desktop session opened on a project
 * folder is indistinguishable from a CLI session by cwd alone).
 *
 * The `client_name` → agent-key mapping deliberately reuses
 * `resolveCopilotAgentKey()` so this scanner and the hook-based `copilot-cli-otlp` pipeline
 * agree on what counts as Desktop.
 */

import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import {
  FULL_SESSION_UUID,
  resolveCopilotAgentKey,
} from '@/agents/plugins/copilot-cli/copilot-cli.constants.js';
import { sessionStateRoot } from './copilot-local-paths.js';
import type { CopilotAgentKey } from './types.js';

/** `client_name` written by VS Code's Copilot CLI agent host. Stays on the `copilot-cli` key. */
const CLIENT_VSCODE_AGENT_HOST = 'vscode-agent-host';

/** Lines read from a `workspace.yaml` before giving up: `client_name` sits near the top. */
const MAX_WORKSPACE_YAML_LINES = 64;

/** Surface label plus the agent key analytics groups the row under. */
export interface CopilotSurface {
  agentName: CopilotAgentKey;
  surface: string;
}

/**
 * The surface of a session, from its `client_name` and the WSL distro it was read in.
 *
 * A home inside a WSL distro always yields a WSL label — a WSL session is never Desktop,
 * since the desktop app does not run there.
 */
export function resolveSurface(clientName: string | undefined, wslDistro?: string): CopilotSurface {
  const client = clientName?.trim().toLowerCase();
  if (wslDistro) {
    return client === CLIENT_VSCODE_AGENT_HOST
      ? { agentName: 'copilot-cli', surface: `VS Code (WSL:${wslDistro})` }
      : { agentName: 'copilot-cli', surface: `Copilot CLI (WSL:${wslDistro})` };
  }
  const agentName = resolveCopilotAgentKey(client) as CopilotAgentKey;
  if (agentName === 'copilot-desktop') {
    return { agentName, surface: 'Copilot Desktop' };
  }
  if (client === CLIENT_VSCODE_AGENT_HOST) {
    return { agentName: 'copilot-cli', surface: 'VS Code (Copilot CLI agent)' };
  }
  return { agentName: 'copilot-cli', surface: 'Copilot CLI' };
}

/**
 * `client_name` from `session-state/<id>/workspace.yaml`, or undefined when unreadable.
 *
 * Stops at the `client_name` line and never reads as far as `name`/`summary`, which are
 * prompt-derived and must not be pulled into an analytics scan. Never throws: a missing or
 * permission-guarded file yields undefined and the caller falls back to the plain CLI surface.
 */
export async function readClientName(home: string, sessionId: string, wslDistro?: string): Promise<string | undefined> {
  if (wslDistro || !FULL_SESSION_UUID.test(sessionId)) {
    return undefined;
  }
  const file = join(sessionStateRoot(home), sessionId, 'workspace.yaml');
  let stream;
  try {
    stream = createReadStream(file, { encoding: 'utf-8' });
  } catch {
    return undefined;
  }
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  let seen = 0;
  try {
    for await (const line of reader) {
      if (line.startsWith('client_name:')) {
        return line.slice('client_name:'.length).trim() || undefined;
      }
      if (++seen >= MAX_WORKSPACE_YAML_LINES) {
        break;
      }
    }
  } catch {
    return undefined;
  } finally {
    reader.close();
    stream.destroy();
  }
  return undefined;
}

/** `initiator` → the report's request category. Unknown initiators count as a plain agent turn. */
export const INITIATOR_CATEGORY: Record<string, string> = {
  user: 'chat/agent',
  agent: 'chat/tool-loop',
  'sub-agent': 'chat/sub-agent',
  compaction: 'feature/compaction',
};

export function categoryOf(initiator: unknown): string {
  return typeof initiator === 'string' ? (INITIATOR_CATEGORY[initiator] ?? 'chat/agent') : 'chat/agent';
}
