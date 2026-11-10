// Isolated environment for one live run. Everything the CLI could read or write (CODEMIE_HOME, HOME,
// USERPROFILE, APPDATA, the Claude config dir) points into a fresh temp root. The child env is built
// from a small allowlist of the parent env, so no CODEMIE_*, OTEL_*, ANTHROPIC_* or token variables leak in.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const SUITE_DIR = resolve(here, '..');
// LIVE_REPO_ROOT points the suite at another checkout (e.g. a clean build of origin/main used as the baseline).
export const REPO_ROOT = process.env.LIVE_REPO_ROOT ? resolve(process.env.LIVE_REPO_ROOT) : resolve(SUITE_DIR, '..', '..', '..');
export const DIST = join(REPO_ROOT, 'dist');
export const NO_KEYTAR_PRELOAD = pathToFileURL(join(here, 'no-keytar.mjs')).href;

// Variables the OS / Node need to run a child; nothing user-specific.
const PASS_THROUGH = ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'windir', 'COMSPEC', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'TERM', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS'];

/** Claude Code names a project dir after its cwd with every non-alphanumeric character turned into '-'. */
export function claudeProjectDirName(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export function createTestEnv({ prefix = 'otlp-live-', keep = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const codemieHome = join(root, 'codemie-home');
  const home = join(root, 'home');
  const claudeDir = join(home, '.claude'); // == CLAUDE_CONFIG_DIR
  const appData = join(root, 'appdata');
  const workRoot = join(root, 'work');
  for (const d of [codemieHome, claudeDir, appData, join(appData, 'Local'), workRoot]) mkdirSync(d, { recursive: true });

  const env = {};
  for (const k of PASS_THROUGH) if (process.env[k] !== undefined) env[k] = process.env[k];
  Object.assign(env, {
    CODEMIE_HOME: codemieHome,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: join(appData, 'Local'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    CLAUDE_CONFIG_DIR: claudeDir,
    NODE_OPTIONS: `--import=${NO_KEYTAR_PRELOAD}`,
    NO_COLOR: '1',
  });
  // Windows keeps %HOMEDRIVE%%HOMEPATH% as a second home; leave them unset so os.homedir() uses USERPROFILE.

  const te = {
    root, codemieHome, home, claudeDir, appData, workRoot, env,
    /** Child env with extras layered on top. */
    envWith: (extra = {}) => ({ ...env, ...extra }),
    /** A project (cwd) dir, not a git repo, and the Claude transcript dir that belongs to it. */
    project(name = 'project') {
      const cwd = join(workRoot, name);
      mkdirSync(cwd, { recursive: true });
      const transcriptDir = join(claudeDir, 'projects', claudeProjectDirName(cwd));
      mkdirSync(transcriptDir, { recursive: true });
      return { cwd, transcriptDir, transcriptPath: (sessionId) => join(transcriptDir, `${sessionId}.jsonl`) };
    },
    write(rel, content) {
      const p = join(root, rel);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, content);
      return p;
    },
    assertInside(p) {
      const r = resolve(p);
      if (!r.toLowerCase().startsWith(root.toLowerCase())) throw new Error(`safety: ${p} is outside the isolated root ${root}`);
      return r;
    },
    cleanup() {
      if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    },
  };
  return te;
}
