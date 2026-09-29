/**
 * DesktopRepositoryResolver process-lookup attribution tests
 * @group unit
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promisify } from 'node:util';

const LOCAL_ROOT = '/desktop/local-agent-mode-sessions';
const CODE_ROOT = '/desktop/claude-code-sessions';
const COWORK_OUTPUTS =
  '/Users/test/Library/Application Support/Claude-3p/local-agent-mode-sessions/abc/000/a1e0220c/outputs';
const REMOTE_PORT = 55_555;
const PID = 4242;
const CLAUDE_APP_PID = 100;
const CODE_TAB_PID = 500;

/** What the fake `ps`/`lsof` report for the process behind the proxied connection. */
let processArgs: string;
let processCwd: string;
/** Desktop session files keyed by path, as the session-file scan reads them. */
let sessionFiles: Record<string, Record<string, unknown>>;

function runCommand(command: string): string {
  if (command.startsWith('lsof -n -P -i')) {
    return `claude ${PID} test 20u IPv4 0x0 0t0 TCP 127.0.0.1:${REMOTE_PORT}->127.0.0.1:4001 (ESTABLISHED)\n`;
  }
  if (command.startsWith(`ps -p ${PID} -o args=`)) return `${processArgs}\n`;
  if (command.startsWith(`lsof -a -d cwd -p ${PID}`)) return `p${PID}\nfcwd\nn${processCwd}\n`;
  // Process tree for the descent strategy: Claude.app with the connecting process and an
  // unrelated Code tab subprocess running in another project.
  if (command.startsWith('ps -axww')) {
    return [
      '  PID  PPID ARGS',
      `  ${CLAUDE_APP_PID}     1 /Applications/Claude.app/Contents/MacOS/Claude`,
      `  ${PID}   ${CLAUDE_APP_PID} ${processArgs}`,
      `  ${CODE_TAB_PID}   ${CLAUDE_APP_PID} /Applications/Claude.app/Contents/Resources/claude --output-format stream-json`,
    ].join('\n');
  }
  if (command.startsWith(`lsof -a -d cwd -p ${CODE_TAB_PID}`)) {
    return `p${CODE_TAB_PID}\nfcwd\nn/Users/test/WebstormProjects/codemie-sdk\n`;
  }
  throw new Error(`unexpected command: ${command}`);
}

vi.mock('node:child_process', () => {
  const exec = vi.fn();
  // The resolver uses promisify(exec); expose the same { stdout, stderr } shape as Node's.
  Object.defineProperty(exec, promisify.custom, {
    value: async (command: string) => ({ stdout: runCommand(command), stderr: '' })
  });
  return { exec };
});

vi.mock('node:fs', () => ({
  existsSync: vi.fn().mockReturnValue(true)
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(async (path: string) => JSON.stringify(sessionFiles[path]))
}));

vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.discovery.js', () => ({
  walk: vi.fn(async (root: string) => Object.keys(sessionFiles).filter(path => path.startsWith(root)))
}));

vi.mock('@/telemetry/clients/claude-desktop/claude-desktop.paths.js', () => ({
  getClaudeDesktopLocalSessionsRoot: () => LOCAL_ROOT,
  getClaudeDesktopCodeSessionsRoot: () => CODE_ROOT
}));

vi.mock('@/utils/processes.js', async () => {
  const { extractRepository } = await vi.importActual<typeof import('@/utils/paths.js')>('@/utils/paths.js');
  return {
    // No git remote in these fixtures: the path-derived name is what gets reported.
    resolveRepositoryName: vi.fn(async (workingDirectory: string) => extractRepository(workingDirectory)),
    detectGitBranch: vi.fn().mockResolvedValue(undefined)
  };
});

import { DesktopRepositoryResolver } from '../DesktopRepositoryResolver.js';

const originalPlatform = process.platform;

describe('DesktopRepositoryResolver', () => {
  beforeEach(() => {
    // Process introspection is macOS-only; pin the platform so the test runs on any CI OS.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    processArgs = '/Applications/Claude.app/Contents/Resources/claude --output-format stream-json';
    processCwd = '/Users/test/projects/app';
    sessionFiles = {};
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  describe('Cowork session without a folder', () => {
    beforeEach(() => {
      sessionFiles[`${LOCAL_ROOT}/local_cowork.json`] = {
        cliSessionId: 'cowork-session',
        userSelectedFolders: [],
        cwd: COWORK_OUTPUTS
      };
    });

    it('attributes to Cowork when the sandbox process runs in /private/var/empty', async () => {
      processCwd = '/private/var/empty';

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('cowork-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages'
      });

      expect(attribution).toEqual({ repository: 'Cowork', branch: null, isCowork: true });
    });

    it('ignores a system path passed through --add-dir', async () => {
      processArgs = '/Applications/Claude.app/Contents/Resources/claude --add-dir /private/var/empty --verbose';
      processCwd = '/private/var/empty';

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('cowork-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages'
      });

      expect(attribution.repository).toBe('Cowork');
    });

    it('attributes the first message to Cowork before Desktop writes the session file', async () => {
      processCwd = '/private/var/empty';
      sessionFiles = {};

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('cowork-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages?beta=true'
      });

      // Not the unrelated Code tab project the process-tree descent would find.
      expect(attribution).toEqual({ repository: 'Cowork', branch: null, isCowork: true });
    });

    it('confirms Cowork from the session file on the next message', async () => {
      processCwd = '/private/var/empty';
      const coworkSession = sessionFiles[`${LOCAL_ROOT}/local_cowork.json`];
      sessionFiles = {};
      const resolver = new DesktopRepositoryResolver();
      const hints = { remotePort: REMOTE_PORT, url: '/v1/messages?beta=true' };
      await resolver.resolveForRequest('cowork-session', hints);

      sessionFiles[`${LOCAL_ROOT}/local_cowork.json`] = coworkSession;
      const attribution = await resolver.resolveForRequest('cowork-session', hints);

      expect(attribution).toEqual({ repository: 'Cowork', branch: null, isCowork: true });
    });

    it.each(['/var/empty', '/tmp', '/usr/local/bin', '/'])('never reports %s as a repository', async (cwd) => {
      processCwd = cwd;

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('cowork-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages'
      });

      expect(attribution.repository).toBe('Cowork');
    });
  });

  describe('project sessions', () => {
    it('keeps attributing a Code tab session to its project cwd', async () => {
      sessionFiles[`${CODE_ROOT}/local_code.json`] = {
        cliSessionId: 'code-session',
        cwd: '/Users/test/projects/app'
      };

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('code-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages'
      });

      expect(attribution).toEqual({ repository: 'projects/app', branch: null, isCowork: false });
    });

    it('keeps attributing a Cowork session to the folder passed through --add-dir', async () => {
      processArgs = '/Applications/Claude.app/Contents/Resources/claude --add-dir /Users/test/Desktop/test-project --verbose';
      sessionFiles[`${LOCAL_ROOT}/local_folder.json`] = {
        cliSessionId: 'folder-session',
        userSelectedFolders: ['/Users/test/Desktop/test-project']
      };

      const attribution = await new DesktopRepositoryResolver().resolveForRequest('folder-session', {
        remotePort: REMOTE_PORT,
        url: '/v1/messages'
      });

      expect(attribution).toEqual({ repository: 'Desktop/test-project', branch: null, isCowork: true });
    });
  });
});
