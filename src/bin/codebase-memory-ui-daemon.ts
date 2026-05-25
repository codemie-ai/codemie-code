/**
 * Codebase Memory UI Daemon Entry Point
 *
 * Keeps codebase-memory-mcp running with stdin open so its embedded graph UI
 * remains available after the CLI command exits.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

interface CodebaseUiState {
  pid: number;
  childPid?: number;
  port: number;
  url: string;
  startedAt: string;
}

const { values } = parseArgs({
  options: {
    port: { type: 'string' },
    'state-file': { type: 'string' },
  },
  strict: false,
});

const stateFile = values['state-file'] as string | undefined;
if (!stateFile) {
  process.stderr.write('[codebase-memory-ui-daemon] --state-file is required\n');
  process.exit(1);
}

const portArg = values.port as string | undefined;
const port = portArg ? Number.parseInt(portArg, 10) : 9749;
if (!Number.isFinite(port) || port <= 0) {
  process.stderr.write(`[codebase-memory-ui-daemon] Invalid --port value: ${portArg}\n`);
  process.exit(1);
}

const url = `http://localhost:${port}`;
let child: ChildProcess | undefined;

function waitForHttpReady(targetUrl: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(targetUrl, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', (error) => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(error);
          return;
        }
        setTimeout(check, 100);
      });

      request.setTimeout(1000, () => {
        request.destroy();
      });
    };

    check();
  });
}

function initializeMcpSession(processToInitialize: ChildProcess): void {
  const stdin = processToInitialize.stdin;
  if (!stdin?.writable) {
    return;
  }

  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'codemie-codebase-ui-daemon',
        version: '0.1.0',
      },
    },
  })}\n`);
  stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  })}\n`);
}

async function writeStateAtomic(state: CodebaseUiState): Promise<void> {
  const tmp = `${stateFile}.tmp`;
  await mkdir(dirname(stateFile!), { recursive: true });
  await writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await rename(tmp, stateFile!);
}

async function cleanup(): Promise<void> {
  if (child && !child.killed) {
    child.kill('SIGTERM');
  }
  try {
    await unlink(stateFile!);
  } catch {
    // Already gone.
  }
}

process.on('SIGTERM', async () => {
  await cleanup();
  process.exit(0);
});

process.on('SIGINT', async () => {
  await cleanup();
  process.exit(0);
});

try {
  child = spawn('codebase-memory-mcp', [`--ui=true`, `--port=${port}`], {
    stdio: ['pipe', 'ignore', 'ignore'],
  });

  const mcpProcess = child;
  initializeMcpSession(mcpProcess);

  const earlyExit = new Promise<never>((_, reject) => {
    mcpProcess.once('exit', (code, signal) => {
      reject(new Error(`codebase-memory-mcp exited before UI was ready (code=${code ?? 'null'}, signal=${signal ?? 'null'})`));
    });
    mcpProcess.once('error', reject);
  });

  await Promise.race([
    waitForHttpReady(url, 5000),
    earlyExit,
  ]);

  await writeStateAtomic({
    pid: process.pid,
    childPid: mcpProcess.pid,
    port,
    url,
    startedAt: new Date().toISOString(),
  });

  mcpProcess.once('exit', async () => {
    try {
      await unlink(stateFile!);
    } catch {
      // Already gone.
    }
    process.exit(0);
  });
} catch (error) {
  await cleanup();
  process.stderr.write(`[codebase-memory-ui-daemon] Failed to start: ${(error as Error).message}\n`);
  process.exit(1);
}
