/**
 * Desktop repository attribution resolver.
 *
 * Owns every strategy that maps a Claude Desktop session to a repository and branch:
 * process introspection, Desktop session-file scanning and git metadata reads. Both the
 * proxy's header-injection interceptor and DesktopTelemetryRuntime resolve through this
 * single service, so attribution has one implementation and one cache instead of two
 * independently maintained paths.
 */

import { exec as execCb } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { walk } from '@/telemetry/clients/claude-desktop/claude-desktop.discovery.js';
import {
  getClaudeDesktopCodeSessionsRoot,
  getClaudeDesktopLocalSessionsRoot
} from '@/telemetry/clients/claude-desktop/claude-desktop.paths.js';
import { logger } from '@/utils/logger.js';
import { detectGitBranch, resolveRepositoryName } from '@/utils/processes.js';

const execAsync = promisify(execCb);

/** Window in which a freshly resolved repository may stand in for an unresolvable session. */
const FALLBACK_TTL_MS = 30_000;

const LOG = '[desktop-repo-resolver]';

/** Request-scoped inputs the resolver cannot derive on its own. */
export interface DesktopRequestHints {
  /** TCP source port of the connecting client, used to find the owning process. */
  remotePort?: number;
  /** Request URL — `beta=true` marks a Desktop orchestrator call. */
  url?: string;
}

export interface DesktopAttribution {
  /** Resolved repository, or null when the caller should apply its own default. */
  repository: string | null;
  /**
   * Branch for the session, replayed from cache on every request. Reporting it only once
   * would split a session's cost across a {repo, branch} and a {repo, ""} bucket.
   */
  branch: string | null;
  /** True for Cowork (chat mode) sessions, which must report as claude-desktop clients. */
  isCowork: boolean;
}

interface SessionRecord {
  repository: string;
  branch: string | null;
  isCowork: boolean;
  /** True while the repository is a guess that any authoritative resolution may replace. */
  tentative: boolean;
}

interface DesktopSessionResolution {
  repository: string;
  branch: string | null;
  isCodeIntegration: boolean;
  /**
   * False when the directory came from the process-tree descent, which finds *some* Claude
   * subprocess rather than one keyed to this session and can therefore latch onto an
   * unrelated project. Such a result is stored tentatively so a later authoritative lookup
   * can correct it.
   */
  confident: boolean;
}

interface SessionFileResolution {
  workingDir: string;
  isCodeIntegration: boolean;
}

export class DesktopRepositoryResolver {
  private readonly sessions = new Map<string, SessionRecord>();

  /**
   * Dedupes concurrent resolution of the same new session. A Desktop turn sends its
   * subprocess and orchestrator requests ~200 ms apart; without this both would run the
   * lsof/ps chain independently.
   */
  private readonly inFlight = new Map<string, Promise<DesktopSessionResolution | null>>();

  private lastResolved?: { repository: string; branch: string | null; ts: number };

  /** Repository recorded for a session, if any. */
  getRepository(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.repository;
  }

  /**
   * Resolves attribution for one proxied request, caching the outcome per session.
   *
   * Confirmed records are returned as-is. Tentative records (TTL-window guesses) are
   * retried on every request so the first real resolution can correct them — a session
   * opened seconds after another must not stay pinned to the previous repository.
   */
  async resolveForRequest(
    cliSessionId: string | undefined,
    hints: DesktopRequestHints
  ): Promise<DesktopAttribution> {
    if (!cliSessionId) {
      return { repository: null, branch: null, isCowork: false };
    }

    const known = this.sessions.get(cliSessionId);
    if (known && !known.tentative) {
      return { repository: known.repository, branch: known.branch, isCowork: known.isCowork };
    }

    const resolved = await this.resolveSession(cliSessionId, hints);
    if (resolved) {
      const isCowork = !resolved.isCodeIntegration;
      this.sessions.set(cliSessionId, {
        repository: resolved.repository,
        branch: resolved.branch,
        isCowork,
        tentative: !resolved.confident
      });
      this.lastResolved = {
        repository: resolved.repository,
        branch: resolved.branch,
        ts: Date.now()
      };
      return { repository: resolved.repository, branch: resolved.branch, isCowork };
    }

    if (known) {
      return { repository: known.repository, branch: known.branch, isCowork: known.isCowork };
    }

    const fallback = this.lastResolved;
    if (fallback && Date.now() - fallback.ts < FALLBACK_TTL_MS) {
      this.sessions.set(cliSessionId, {
        repository: fallback.repository,
        branch: fallback.branch,
        isCowork: false,
        tentative: true
      });
      logger.debug(`${LOG} Applied tentative attribution from last resolved Desktop repository`, {
        cliSessionId,
        repository: fallback.repository,
        branch: fallback.branch
      });
      return { repository: fallback.repository, branch: fallback.branch, isCowork: false };
    }

    return { repository: null, branch: null, isCowork: false };
  }

  /**
   * Publishes the repository DesktopTelemetryRuntime derived from a polled session file.
   *
   * A confirmed per-request resolution wins, because it reads the real process CWD rather
   * than the session file's recorded directory. A tentative record is only a guess, so the
   * poll result replaces it.
   */
  recordDiscoveredSession(agentSessionId: string, repository: string | undefined): void {
    // Desktop's own `local_<uuid>` ids never arrive as x-claude-code-session-id.
    if (agentSessionId.startsWith('local_')) {
      return;
    }

    const known = this.sessions.get(agentSessionId);
    if (known && !known.tentative) {
      return;
    }

    this.sessions.set(agentSessionId, {
      repository: repository || 'Cowork',
      branch: known?.branch ?? null,
      isCowork: known?.isCowork ?? false,
      tentative: false
    });
  }

  private async resolveSession(
    cliSessionId: string,
    hints: DesktopRequestHints
  ): Promise<DesktopSessionResolution | null> {
    const existing = this.inFlight.get(cliSessionId);
    if (existing) return existing;

    const resolution = this.resolveSessionUncached(cliSessionId, hints);
    this.inFlight.set(cliSessionId, resolution);
    try {
      return await resolution;
    } finally {
      this.inFlight.delete(cliSessionId);
    }
  }

  private async resolveSessionUncached(
    cliSessionId: string,
    hints: DesktopRequestHints
  ): Promise<DesktopSessionResolution | null> {
    let workingDir: string | null = null;

    // Resolved once and shared by the process-lookup and process-tree-descent steps so a
    // single request never runs lsof twice for the same port.
    const connectingPid = hints.remotePort
      ? await getPidForRemotePort(hints.remotePort).catch(() => null)
      : null;

    // Tracks whether this is a claude-code-sessions (Code tab) session. Cowork sessions run
    // without git hooks, so their deltas carry no branch; reporting them as Code integration
    // would split metrics into a {repo, branch} bucket separate from the {repo, ""} one.
    let isCodeIntegration = false;

    // Only the process-tree descent is a guess; the other two strategies key on this session.
    let confident = true;

    // Subprocess lookup — finds the claude process behind the TCP connection. A subprocess
    // carrying --add-dir may belong to the Code tab or to a Cowork session, so the session
    // root decides which.
    if (connectingPid) {
      workingDir = await findWorkingDirViaProcess(connectingPid).catch(() => null);
      if (workingDir) {
        const sessionRes = await findWorkingDirForSession(cliSessionId).catch(() => null);
        isCodeIntegration = sessionRes ? sessionRes.isCodeIntegration : true;
        logger.debug(`${LOG} Resolved working dir via process lookup`, {
          cliSessionId, remotePort: hints.remotePort, workingDir, isCodeIntegration
        });
      } else {
        logger.debug(`${LOG} Process lookup returned no workingDir`, {
          cliSessionId, connectingPid, remotePort: hints.remotePort
        });
      }
    } else {
      logger.debug(`${LOG} No connectingPid found`, {
        cliSessionId, remotePort: hints.remotePort
      });
    }

    // Session-file scan — succeeds from the second message onward, once Desktop has written
    // the session file to disk.
    if (!workingDir) {
      const resolved = await findWorkingDirForSession(cliSessionId).catch(() => null);
      if (resolved) {
        workingDir = resolved.workingDir;
        isCodeIntegration = resolved.isCodeIntegration;
        logger.debug(`${LOG} Resolved working dir via session file scan`, {
          cliSessionId, workingDir, isCodeIntegration
        });
      } else {
        logger.debug(`${LOG} Session file scan returned no workingDir`, { cliSessionId });
      }
    }

    // Process-tree descent — for orchestrator requests whose connecting process is the
    // Desktop renderer (no --add-dir), identified by beta=true. Desktop spawns the claude
    // subprocess before the orchestrator call, so it is already visible in ps.
    if (!workingDir && connectingPid && hints.url?.includes('beta=true')) {
      workingDir = await findWorkingDirForDesktopDirectRequest(connectingPid).catch(() => null);
      if (workingDir) {
        isCodeIntegration = true;
        confident = false;
        logger.debug(`${LOG} Resolved working dir via process tree descent`, {
          cliSessionId, remotePort: hints.remotePort, workingDir
        });
      } else {
        logger.debug(`${LOG} Process tree descent returned no workingDir`, {
          cliSessionId, connectingPid, remotePort: hints.remotePort
        });
      }
    }

    if (!workingDir) return null;

    const [repository, branch] = await Promise.all([
      resolveRepositoryName(workingDir),
      detectGitBranch(workingDir)
    ]);
    logger.debug(`${LOG} Resolved repository via targeted lookup`, {
      cliSessionId, workingDir, repository, branch, isCodeIntegration, confident
    });
    return { repository, branch: branch ?? null, isCodeIntegration, confident };
  }
}

async function findWorkingDirForSession(cliSessionId: string): Promise<SessionFileResolution | null> {
  const roots = [
    { path: getClaudeDesktopLocalSessionsRoot(), isCode: false },
    { path: getClaudeDesktopCodeSessionsRoot(), isCode: true }
  ];

  for (const { path: root, isCode } of roots) {
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
        if (!workingDir) return null;
        return { workingDir, isCodeIntegration: isCode };
      } catch { /* skip unreadable files */ }
    }
  }

  return null;
}

/**
 * PID owning the TCP connection from `remotePort`. Shared by the process-lookup and
 * process-tree-descent steps. macOS only; returns null on any failure.
 */
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

/**
 * Working directory of the subprocess owning `pid`, read from its --add-dir flag and
 * falling back to the OS-level cwd. macOS only; returns null on any failure.
 */
async function findWorkingDirViaProcess(pid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execAsync(`ps -p ${pid} -o args=`, { timeout: 2000 });
    // Lazy match stops at the first subsequent -- flag, supporting paths with spaces.
    const match = stdout.match(/--add-dir\s+(.+?)(?=\s+--|$)/);
    const dir = match?.[1]?.trim();
    // Reject relative paths — the Desktop renderer uses --add-dir for plugin loading.
    if (dir?.startsWith('/')) return dir;

    // Code tab subprocesses launch from the project directory but carry no --add-dir flag.
    // Reject launcher paths (home, Library, app bundles) so Cowork sessions with a
    // non-project cwd are not misattributed.
    const { stdout: lsofOut } = await execAsync(`lsof -a -d cwd -p ${pid} -Fn`, { timeout: 2000 });
    const cwd = lsofOut.split('\n').find(l => l.startsWith('n'))?.slice(1).trim();
    if (!isProjectCwd(cwd)) return null;
    return cwd!;
  } catch {
    return null;
  }
}

/**
 * Working directory for a Desktop orchestrator request. Walks up from the renderer to the
 * Claude app root, then descends to a subprocess that reveals a project directory.
 * macOS only; returns null on any failure.
 */
async function findWorkingDirForDesktopDirectRequest(connectingPid: number): Promise<string | null> {
  if (process.platform !== 'darwin') return null;

  try {
    const { stdout } = await execAsync('ps -axww -o pid,ppid,args', { timeout: 2000 });

    // Build the process map and the children index in one pass.
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

    // Walk up from the Desktop renderer to the Claude app root. The Claude.app test runs
    // before the ppid<=1 break so the main app process (PPID=1) is still considered.
    let claudeRootPid = connectingPid;
    let pid = connectingPid;
    for (let depth = 0; depth < 10; depth++) {
      const proc = processes.get(pid);
      if (!proc) break;
      if (/Claude\.app/.test(proc.args)) claudeRootPid = pid;
      if (proc.ppid <= 1) break;
      pid = proc.ppid;
    }

    // Descend from the Claude root: --add-dir (Cowork with a folder) or process cwd (Code tab).
    const queue = [claudeRootPid];
    const visited = new Set<number>();
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const proc = processes.get(cur);
      if (proc?.args.includes('--add-dir')) {
        const m = proc.args.match(/--add-dir\s+(.+?)(?=\s+--|$)/);
        const dir = m?.[1]?.trim();
        if (dir?.startsWith('/')) return dir;
      } else if (proc?.args.includes('--output-format stream-json')) {
        try {
          const { stdout: cwdOut } = await execAsync(`lsof -a -d cwd -p ${cur} -Fn`, { timeout: 1000 });
          const cwd = cwdOut.split('\n').find(l => l.startsWith('n'))?.slice(1).trim();
          logger.debug(`${LOG} Subprocess cwd candidate`, { pid: cur, cwd: cwd ?? null });
          if (isProjectCwd(cwd)) return cwd!;
        } catch (e) {
          logger.debug(`${LOG} Subprocess lsof failed`, { pid: cur, error: String(e) });
        }
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

/** Rejects launcher directories that would misattribute a session to a non-project path. */
function isProjectCwd(cwd: string | undefined): boolean {
  if (!cwd?.startsWith('/')) return false;
  const home = process.env.HOME ?? '';
  return cwd !== home && !cwd.includes('/Library/') && !cwd.includes('.app/Contents');
}
