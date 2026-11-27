/**
 * Claude statusline — managed-session badge, end to end (EPMCDME-16966)
 *
 * The unit tests inject the `managed` flag and the env into `buildStatusLine` / `isManagedSession`,
 * so nothing there exercises the wiring in `main()` (`managed: isManagedSession()` on the real
 * `process.env`) or the deployed artifact. This runs the built bundle — the exact file
 * `codemie install statusline` copies to ~/.claude — as a subprocess the way Claude Code does:
 * session JSON on stdin, rendered line on stdout.
 *
 * Needs `npm run build` first (the `ci` script builds before running this project).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUNDLE = join(REPO_ROOT, 'dist', 'agents', 'plugins', 'claude', 'plugin', 'statusline.bundle.mjs');
const RUN_TIMEOUT_MS = 20_000;
const BADGE = '[⏺ CodeMie]';

// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('statusline bundle — managed-session badge', () => {
  let sandbox: string;
  let workDir: string;
  let sessionJson: string;

  beforeAll(() => {
    if (!existsSync(BUNDLE)) {
      throw new Error(`Missing ${BUNDLE} — run \`npm run build\` before this test.`);
    }
    // A throwaway HOME / CODEMIE_HOME with no config means no budget lookup, so the run never
    // touches the network or the developer's real profile. workDir is deliberately not a git repo.
    sandbox = mkdtempSync(join(tmpdir(), 'codemie-statusline-'));
    workDir = join(sandbox, 'my-project');
    mkdirSync(workDir, { recursive: true });
    sessionJson = JSON.stringify({
      workspace: { current_dir: workDir },
      model: { id: 'claude-sonnet-4-5', display_name: 'Sonnet 4.5' },
      cost: { total_cost_usd: 1.5, total_duration_ms: 65_000 },
    });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** Runs the bundle with the given stdin; CODEMIE_SESSION_ID is present only if passed in extraEnv. */
  function render(stdin: string, extraEnv: Record<string, string> = {}): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: sandbox,
      USERPROFILE: sandbox,
      CODEMIE_HOME: join(sandbox, '.codemie'),
    };
    delete env.CODEMIE_SESSION_ID;
    Object.assign(env, extraEnv);

    return new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [BUNDLE], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`statusline bundle did not finish within ${RUN_TIMEOUT_MS}ms`));
      }, RUN_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', () => { clearTimeout(timer); resolvePromise(stdout); });
      child.stdin.end(stdin);
    });
  }

  it('renders the badge first when CODEMIE_SESSION_ID is set', async () => {
    const line = stripAnsi(await render(sessionJson, { CODEMIE_SESSION_ID: 'session-123' }));

    // The badge leads, then the project segment from the stdin JSON: proves main() passes the
    // real env through to buildStatusLine.
    expect(line.startsWith(`${BADGE} | [my-project]`)).toBe(true);
    expect(line).toContain('$1.5000');
  });

  it('renders no badge when CODEMIE_SESSION_ID is absent (plain claude session)', async () => {
    const raw = await render(sessionJson);

    // Nothing CodeMie-branded leaks into a plain session, and the project segment stays first.
    expect(raw).not.toContain('CodeMie');
    expect(raw).not.toContain('⏺');
    expect(stripAnsi(raw)).toMatch(/^\[my-project\]/);
    expect(stripAnsi(raw)).toContain('$1.5000');
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   '],
  ])('renders no badge when CODEMIE_SESSION_ID is %s', async (_label, value) => {
    const raw = await render(sessionJson, { CODEMIE_SESSION_ID: value });

    // An inherited-but-blank variable must not mark a plain session as managed.
    expect(raw).not.toContain('CodeMie');
    expect(stripAnsi(raw)).toMatch(/^\[my-project\]/);
  });

  it('still renders the badge when stdin is not valid JSON', async () => {
    const line = stripAnsi(await render('not json', { CODEMIE_SESSION_ID: 'session-123' }));

    // main() falls back to empty session info; the badge comes from the env, not from stdin.
    expect(line.startsWith(BADGE)).toBe(true);
    expect(line).not.toContain('my-project');
  });
});
