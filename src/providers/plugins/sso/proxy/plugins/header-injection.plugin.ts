/**
 * Header Injection Plugin
 * Priority: 20 (runs after auth)
 *
 * SOLID: Single responsibility = inject CodeMie headers
 * KISS: Straightforward header injection
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(execCb);
import { ProxyPlugin, PluginContext, ProxyInterceptor } from './types.js';
import { ProxyContext } from '../proxy-types.js';
import { ProviderRegistry } from '../../../../core/registry.js';
import { logger } from '../../../../../utils/logger.js';
import {
  getClaudeDesktopLocalSessionsRoot,
  getClaudeDesktopCodeSessionsRoot,
} from '../../../../../telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { walk } from '../../../../../telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import { extractRepository } from '../../../../../utils/paths.js';

export class HeaderInjectionPlugin implements ProxyPlugin {
  id = '@codemie/proxy-headers';
  name = 'Header Injection';
  version = '1.0.0';
  priority = 20;

  async createInterceptor(context: PluginContext): Promise<ProxyInterceptor> {
    return new HeaderInjectionInterceptor(context);
  }
}

class HeaderInjectionInterceptor implements ProxyInterceptor {
  name = 'header-injection';

  constructor(private context: PluginContext) {}

  async onRequest(context: ProxyContext): Promise<void> {
    // Request and session ID headers
    context.headers['X-CodeMie-Request-ID'] = context.requestId;
    context.headers['X-CodeMie-Session-ID'] = context.sessionId;

    // LiteLLM can use these headers for Responses API session affinity when
    // its router is configured with session-aware pre-call checks.
    if (this.context.config.clientType === 'codemie-codex') {
      context.headers['x-litellm-session-id'] = context.sessionId;
    }

    // Add CLI version header
    const cliVersion = this.context.config.version || '0.0.0';
    context.headers['X-CodeMie-CLI'] = `codemie-cli/${cliVersion}`;

    const config = this.context.config;

    // Check if provider requires integration header
    const provider = ProviderRegistry.getProvider(config.provider || '');
    const requiresIntegration = provider?.customProperties?.requiresIntegration === true;

    // Add integration header for providers that require it
    if (requiresIntegration && config.integrationId) {
      context.headers['X-CodeMie-Integration'] = config.integrationId;
    }

    // Add model header if configured (for all providers)
    if (config.model) {
      context.headers['X-CodeMie-CLI-Model'] = config.model;
    }

    // Add timeout header if configured (for all providers)
    if (config.timeout) {
      context.headers['X-CodeMie-CLI-Timeout'] = String(config.timeout);
    }

    // Add client type header
    if (config.clientType) {
      context.headers['X-CodeMie-Client'] = config.clientType;
    }

    // Per-request repository resolution for Desktop mode.
    // Claude Desktop sends x-claude-code-session-id = cliSessionId (plain UUID, no local_ prefix).
    // The shared map is keyed by agentSessionId = cliSessionId, so look up directly.
    //
    // Lookup chain for unknown session (runs in order, stops on first success):
    //   1. Process CWD lookup (Fix 4) — uses TCP remotePort → lsof → PID → CWD; works on first message
    //      before session file exists on disk. macOS only (~50ms).
    //   2. Session file scan (Fix 3) — targeted scan of Desktop session files for matching cliSessionId;
    //      succeeds from message 2 onward when file is on disk.
    //   3. Default — not cached; next request retries from step 1.
    if (config.sessionRepositoryMap) {
      const cliSessionId = context.headers['x-claude-code-session-id'];

      if (cliSessionId && !config.sessionRepositoryMap.has(cliSessionId)) {
        let workingDir: string | null = null;

        // Resolve the connecting PID once — shared by Fix 4 and Fix 4B to avoid running
        // lsof twice for the same remotePort on the same request.
        const connectingPid = context.remotePort
          ? await getPidForRemotePort(context.remotePort).catch(() => null)
          : null;

        // Fix 4: subprocess lookup — finds the claude process via its TCP connection.
        // Works for subprocess requests (x-claude-code-session-id present, process has --add-dir).
        if (connectingPid) {
          workingDir = await findWorkingDirViaProcess(connectingPid).catch(() => null);
          if (workingDir) {
            logger.debug('[header-injection] Resolved working dir via process lookup', {
              cliSessionId, remotePort: context.remotePort, workingDir,
            });
          }
        }

        // Fix 3: session file scan (works from message 2 onward when session file exists on disk)
        if (!workingDir) {
          workingDir = await findWorkingDirForSession(cliSessionId).catch(() => null);
          if (workingDir) {
            logger.debug('[header-injection] Resolved working dir via session file scan', {
              cliSessionId, workingDir,
            });
          }
        }

        // Fix 4B: process tree descent — for Desktop orchestrator requests whose connecting
        // process is the Desktop renderer (no --add-dir). Identified by ?beta=true in the URL.
        // Desktop spawns the claude subprocess before sending its orchestrator call, so the
        // subprocess is already in ps. Also covers second+ orchestrator via lastDesktopRepo.
        if (!workingDir && connectingPid && context.url?.includes('beta=true')) {
          workingDir = await findWorkingDirForDesktopDirectRequest(connectingPid).catch(() => null);
          if (workingDir) {
            logger.debug('[header-injection] Resolved working dir via process tree descent', {
              cliSessionId, remotePort: context.remotePort, workingDir,
            });
          }
        }

        if (workingDir) {
          const repository = (await readGitRemoteLocal(workingDir)) ?? extractRepository(workingDir);
          config.sessionRepositoryMap.set(cliSessionId, repository);
          config.lastDesktopRepo = { repo: repository, ts: Date.now() };
          const branch = await readGitBranchLocal(workingDir);
          if (branch) context.headers['X-CodeMie-Branch'] = branch;
          logger.debug('[header-injection] Resolved repository via targeted lookup', {
            cliSessionId, workingDir, repository, branch,
          });
        } else {
          // Last resort: reuse the most recently resolved Desktop repo. The 30 s TTL ensures
          // we only carry over the repo from the same user turn (subprocess + orchestrator
          // arrive within ~200 ms) and not from a stale prior session in a different folder.
          const last = config.lastDesktopRepo;
          if (last && Date.now() - last.ts < 30_000) {
            config.sessionRepositoryMap.set(cliSessionId, last.repo);
            logger.debug('[header-injection] Used cached last Desktop repo for orchestrator', {
              cliSessionId, lastRepo: last.repo,
            });
          }
        }
      }

      const resolvedRepository = cliSessionId
        ? (config.sessionRepositoryMap.get(cliSessionId) ?? config.repository ?? 'Default')
        : (config.repository ?? 'Default');

      context.headers['X-CodeMie-Repository'] = resolvedRepository;
    } else {
      // Non-Desktop mode: use static config values
      if (config.repository) {
        context.headers['X-CodeMie-Repository'] = config.repository;
      }
    }

    if (config.branch) {
      context.headers['X-CodeMie-Branch'] = config.branch;
    }
    if (config.project) {
      context.headers['X-CodeMie-Project'] = config.project;
    }

    logger.debug(`[${this.name}] Injected CodeMie headers`);
  }
}

async function findWorkingDirForSession(cliSessionId: string): Promise<string | null> {
  const roots = [
    getClaudeDesktopLocalSessionsRoot(),
    getClaudeDesktopCodeSessionsRoot(),
  ];

  for (const root of roots) {
    if (!existsSync(root)) continue;
    const files = await walk(root);
    for (const file of files) {
      try {
        const json = JSON.parse(await readFile(file, 'utf-8')) as Record<string, unknown>;
        if (json['cliSessionId'] !== cliSessionId) continue;
        const folders = json['userSelectedFolders'] as string[] | undefined;
        const workingDir =
          (json['originCwd'] as string | undefined)
          ?? (json['worktreePath'] as string | undefined)
          ?? folders?.[0]
          ?? (json['cwd'] as string | undefined);
        return workingDir ?? null;
      } catch { /* skip unreadable files */ }
    }
  }

  return null;
}

async function readGitRemoteLocal(dir: string): Promise<string | null> {
  try {
    const gitConfig = await readFile(join(dir, '.git', 'config'), 'utf-8');
    const match = gitConfig.match(/\[remote "origin"\][^[]*url\s*=\s*(.+)/);
    if (!match) return null;
    const repo = extractRepository(match[1].trim());
    return repo.endsWith('.git') ? repo.slice(0, -4) : repo;
  } catch {
    return null;
  }
}

// Reads .git/HEAD to get the current branch name. Not cached — branch can change
// within a session when user switches branches in the Desktop Code tab.
async function readGitBranchLocal(dir: string): Promise<string | null> {
  try {
    const head = (await readFile(join(dir, '.git', 'HEAD'), 'utf-8')).trim();
    const match = head.match(/^ref: refs\/heads\/(.+)$/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

// Returns the PID of the process that owns the TCP connection from remotePort.
// Shared by Fix 4 and Fix 4B to avoid running lsof twice per request.
// macOS only. Returns null on any failure.
async function getPidForRemotePort(remotePort: number): Promise<number | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execAsync(
      `lsof -n -P -i 4TCP@127.0.0.1:${remotePort} 2>/dev/null`,
      { timeout: 2000 }
    );
    const ownPid = process.pid;
    for (const line of stdout.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2 || parts[1] === 'PID') continue;
      const pid = parseInt(parts[1], 10);
      if (!pid || pid === ownPid) continue;
      if (line.includes(`127.0.0.1:${remotePort}->`)) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

// Resolves the working directory of the subprocess that owns the given PID.
// Reads --add-dir from the process command line (Desktop passes --add-dir <folder> when
// spawning claude). macOS only. Returns null on any failure.
async function findWorkingDirViaProcess(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o args=`, { timeout: 2000 });
    // Lazy match stops at the first subsequent -- flag, supporting paths with spaces.
    const match = stdout.match(/--add-dir\s+(.+?)(?=\s+--|$)/);
    const dir = match?.[1]?.trim();
    // Reject relative paths — Desktop renderer uses --add-dir for plugin loading (not absolute).
    if (!dir || !dir.startsWith('/')) return null;
    return dir;
  } catch {
    return null;
  }
}

// Resolves the working directory for a Desktop orchestrator request.
// Takes the already-resolved connectingPid (Desktop renderer) to avoid a second lsof call.
// Walks up from the renderer to the Claude app root, then BFS-descends to find a subprocess
// with --add-dir. macOS only. Returns null on any failure.
async function findWorkingDirForDesktopDirectRequest(connectingPid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;

  try {
    const { stdout } = await execAsync('ps -axww -o pid,ppid,args', { timeout: 2000 });

    // Build process map and children index in one pass
    const processes = new Map<number, { ppid: number; args: string }>();
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n').slice(1)) {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)/);
      if (!m) continue;
      const pid = parseInt(m[1], 10);
      const ppid = parseInt(m[2], 10);
      if (isNaN(pid) || isNaN(ppid)) continue;
      processes.set(pid, { ppid, args: m[3].trim() });
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid)!.push(pid);
    }

    // Walk up from Desktop renderer to find the Claude app root
    let claudeRootPid = connectingPid;
    let pid = connectingPid;
    for (let depth = 0; depth < 10; depth++) {
      const proc = processes.get(pid);
      if (!proc || proc.ppid <= 1) break;
      if (/Claude\.app/.test(proc.args)) claudeRootPid = pid;
      pid = proc.ppid;
    }

    // BFS down from Claude root to find the first subprocess with --add-dir
    const queue = [claudeRootPid];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const proc = processes.get(cur);
      if (proc?.args.includes('--add-dir')) {
        // Lazy match stops at the first subsequent -- flag, supporting paths with spaces.
        const m = proc.args.match(/--add-dir\s+(.+?)(?=\s+--|$)/);
        const dir = m?.[1]?.trim();
        // Reject relative paths — Desktop renderer uses --add-dir for plugin loading.
        if (dir?.startsWith('/')) return dir;
      }
      for (const child of (children.get(cur) ?? [])) {
        if (!visited.has(child)) queue.push(child);
      }
    }

    return null;
  } catch {
    return null;
  }
}

