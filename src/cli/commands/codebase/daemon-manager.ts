import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import net from 'node:net';
import { getCodemieHome, getDirname } from '../../../utils/paths.js';
import { spawnDetached } from '../../../utils/processes.js';
import { ToolExecutionError } from '../../../utils/errors.js';

export interface CodebaseUiState {
  pid: number;
  childPid?: number;
  port: number;
  url: string;
  startedAt: string;
}

const DEFAULT_CODEBASE_UI_PORT = 9749;
const DEFAULT_STATE_FILE = join(getCodemieHome(), 'codebase-memory-ui.json');

export async function readCodebaseUiState(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<CodebaseUiState | null> {
  try {
    const raw = await readFile(stateFile, 'utf-8');
    return JSON.parse(raw) as CodebaseUiState;
  } catch {
    return null;
  }
}

export async function writeCodebaseUiState(
  state: CodebaseUiState,
  stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  await mkdir(dirname(stateFile), { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, stateFile);
}

export async function clearCodebaseUiState(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
  try {
    await unlink(stateFile);
  } catch {
    // Already gone.
  }
}

export function isCodebaseUiProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', () => {
      resolve(false);
    });

    server.once('listening', () => {
      server.close(() => resolve(true));
    });

    server.listen(port, '127.0.0.1');
  });
}

export async function checkCodebaseUiStatus(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<{ running: boolean; state: CodebaseUiState | null }> {
  const state = await readCodebaseUiState(stateFile);
  if (!state) {
    return { running: false, state: null };
  }

  if (!isCodebaseUiProcessAlive(state.pid)) {
    await clearCodebaseUiState(stateFile);
    return { running: false, state: null };
  }

  return { running: true, state };
}

export interface SpawnCodebaseUiOptions {
  port?: number;
  stateFile?: string;
  readinessTimeoutMs?: number;
}

export async function spawnCodebaseUi(
  options: SpawnCodebaseUiOptions = {}
): Promise<CodebaseUiState> {
  const port = options.port ?? DEFAULT_CODEBASE_UI_PORT;
  const stateFile = options.stateFile ?? DEFAULT_STATE_FILE;
  const daemonBin = join(getDirname(import.meta.url), '../../../../bin/codebase-memory-ui-daemon.js');
  const pid = spawnDetached(
    process.execPath,
    [
      daemonBin,
      '--port',
      String(port),
      '--state-file',
      stateFile,
    ],
    { stdio: 'ignore' }
  );

  if (pid <= 0) {
    throw new ToolExecutionError(
      'codebase-memory-mcp',
      'Failed to start Codebase Memory graph UI process.'
    );
  }

  const timeoutMs = options.readinessTimeoutMs ?? 6000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
    const state = await readCodebaseUiState(stateFile);
    if (state && isCodebaseUiProcessAlive(state.pid)) {
      return state;
    }

    if (!isCodebaseUiProcessAlive(pid)) {
      await clearCodebaseUiState(stateFile);
      throw new ToolExecutionError(
        'codebase-memory-mcp',
        `Codebase Memory graph UI failed to start. Run \`codebase-memory-mcp --ui=true --port=${port}\` to inspect the upstream error.`
      );
    }
  }

  await clearCodebaseUiState(stateFile);
  throw new ToolExecutionError(
    'codebase-memory-mcp',
    `Codebase Memory graph UI did not become ready on port ${port} within 6 seconds.`
  );
}

export async function stopCodebaseUi(
  stateFile: string = DEFAULT_STATE_FILE
): Promise<void> {
  const state = await readCodebaseUiState(stateFile);
  if (!state) {
    return;
  }

  if (isCodebaseUiProcessAlive(state.pid)) {
    process.kill(state.pid, 'SIGTERM');
    for (let i = 0; i < 50; i++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      if (!isCodebaseUiProcessAlive(state.pid)) {
        await clearCodebaseUiState(stateFile);
        return;
      }
    }

    throw new ToolExecutionError(
      'codebase-memory-mcp',
      `Codebase Memory UI pid ${state.pid} did not stop within 5 seconds`
    );
  }

  await clearCodebaseUiState(stateFile);
}
