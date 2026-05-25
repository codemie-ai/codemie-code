/**
 * Spawns the upstream `skills` CLI as a child Node process with safe defaults:
 *
 * - Blocks upstream telemetry/audit egress to `add-skill.vercel.sh` via a
 *   `NODE_OPTIONS=--require <shim>` injection.
 * - Sets `DO_NOT_TRACK` / `DISABLE_TELEMETRY` / `CI` so the upstream
 *   `track()` env gate is closed.
 * - Inherits stdio so interactive prompts from `skills.sh` keep working.
 *
 * Resolution rules:
 *
 * - The skills bin is resolved from the project's `node_modules`
 *   (`skills/bin/cli.mjs`).
 * - The egress shim is resolved from this module's own directory; both the
 *   source layout (`<repo>/src/cli/commands/skills/lib`) and the dist layout
 *   (`<repo>/dist/cli/commands/skills/lib`) are supported by walking up to
 *   the package root and checking `dist/assets/...` first, then
 *   `assets/...` as a fallback for ts-node / dev runs.
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { ExecResult } from '@/utils/exec.js';
import { logger } from '@/utils/logger.js';
import { getDirname } from '@/utils/paths.js';
import { SKILLS_SH_TELEMETRY_MARKER } from './skills-sh-telemetry.js';

const SHIM_FILENAME = 'skills-sh-egress-guard.cjs';

export interface RunSkillsCliOptions {
  cwd?: string;
  /**
   * When false, output is captured (used for non-interactive CLI flows like
   * `list --json`). When true (default), stdio is inherited so the child can
   * prompt the user.
   */
  interactive?: boolean;
  /** Additional env to merge in (caller may override telemetry vars too). */
  env?: Record<string, string>;
  /** Maximum runtime before terminating the upstream CLI. */
  timeoutMs?: number;
}

/**
 * Spawn the upstream `skills` CLI directly (not via the project `exec()` helper)
 * because that helper rejects on non-zero exit when `interactive: true`. We need
 * to surface the real exit code so `classifySkillError()` can map upstream
 * failures to stable `error_code` values; rejection collapses everything to
 * `unknown`.
 *
 * Even in interactive mode, child stderr is captured (in addition to being
 * tee'd to the parent terminal) so that markers like
 * `CODEMIE_SKILL_EGRESS_BLOCKED` remain visible to the classifier.
 */
export async function runSkillsCli(
  args: string[],
  options: RunSkillsCliOptions = {}
): Promise<ExecResult> {
  const skillsBin = resolveSkillsBin();
  const shimPath = resolveShimPath();
  const interactive = options.interactive !== false;

  const baseEnv: Record<string, string> = {
    NODE_OPTIONS: buildNodeOptions(shimPath),
  };
  if (args[0] === 'add' || args[0] === 'remove' || args[0] === 'update') {
    // We temporarily reopen upstream's telemetry gate only after resolving
    // NODE_OPTIONS with the CodeMie egress guard shim. The shim captures the
    // selected-skill payload locally and blocks add-skill.vercel.sh, so the
    // request never leaves the machine.
    baseEnv.DO_NOT_TRACK = '';
    baseEnv.DISABLE_TELEMETRY = '';
    baseEnv.CODEMIE_CAPTURE_SKILLS_SH_INSTALL_TELEMETRY = '1';
    if (args[0] === 'update') {
      baseEnv.CODEMIE_CAPTURE_SKILLS_SH_UPDATE_STDOUT = '1';
    }
  } else {
    baseEnv.DO_NOT_TRACK = '1';
    baseEnv.DISABLE_TELEMETRY = '1';
  }
  // Force CI=1 only for non-interactive runs to suppress any prompts the
  // upstream might fire. Forcing it on interactive runs interferes with
  // Clack/inquirer prompt + spinner behavior; DO_NOT_TRACK / DISABLE_TELEMETRY
  // already cover the telemetry gate.
  if (!interactive) {
    baseEnv.CI = process.env.CI ?? '1';
  }

  const env = { ...process.env, ...baseEnv, ...options.env };
  const timeoutMs = options.timeoutMs;

  logger.debug('[skills] Spawning skills CLI', {
    bin: skillsBin,
    args,
    interactive,
    shimPath,
  });

  return new Promise<ExecResult>((resolve, reject) => {
    // Interactive runs inherit stdout so the child sees a real TTY: Clack's
    // multiselect renderer (used by skills.sh) computes visible rows from
    // process.stdout.rows, which is undefined when stdout is a pipe — turning
    // every prompt into an empty list. stderr stays piped so error markers
    // (e.g. CODEMIE_SKILL_EGRESS_BLOCKED) still reach classifySkillError().
    // Non-interactive callers (e.g. `list --json`) need captured stdout, so
    // both streams pipe in that mode.
    const stdio: ['inherit', 'inherit' | 'pipe', 'pipe'] = interactive
      ? ['inherit', 'inherit', 'pipe']
      : ['inherit', 'pipe', 'pipe'];
    const child = spawn(process.execPath, [skillsBin, ...args], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio,
      windowsHide: os.platform() === 'win32',
    });

    let stdout = '';
    let stderr = '';
    let interactiveStderrBuffer = '';
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }
      if (forceKillTimeout) {
        clearTimeout(forceKillTimeout);
        forceKillTimeout = undefined;
      }
    };

    const timeoutMessage = (): string => {
      const seconds = Math.ceil((timeoutMs ?? 0) / 1000);
      return `CODEMIE_SKILLS_TIMEOUT: skills CLI did not finish within ${seconds}s.`;
    };

    // stdout is null when inherited (interactive mode); only fires when piped.
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      stderr += text;
      if (interactive) {
        interactiveStderrBuffer += text;
        const lines = interactiveStderrBuffer.split(/\r?\n/);
        interactiveStderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith(`${SKILLS_SH_TELEMETRY_MARKER} `)) {
            process.stderr.write(`${line}\n`);
          }
        }
      }
    });

    child.on('error', (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Failed to spawn skills CLI: ${error.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (
        interactive &&
        interactiveStderrBuffer.length > 0 &&
        !interactiveStderrBuffer.startsWith(`${SKILLS_SH_TELEMETRY_MARKER} `)
      ) {
        process.stderr.write(interactiveStderrBuffer);
      }
      resolve({
        code: timedOut ? 124 : code ?? (signal ? 130 : 1),
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        signal,
      });
    });

    if (timeoutMs && timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        const message = timeoutMessage();
        stderr += stderr.length > 0 ? `\n${message}` : message;
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
          }
        }, 5000);
      }, timeoutMs);
    }
  });
}

function resolveSkillsBin(): string {
  // Test-only override: e2e tests point this at a stub bin so they exercise
  // the wrapper end-to-end without touching the network. Production code must
  // never set this — it is intentionally undocumented to users.
  const override = process.env.CODEMIE_SKILLS_BIN_OVERRIDE;
  if (override && existsSync(override)) {
    return override;
  }

  const requireFromHere = createRequire(import.meta.url);
  try {
    return requireFromHere.resolve('skills/bin/cli.mjs');
  } catch (error) {
    throw new Error(
      `Failed to resolve "skills" CLI binary. Run "npm install" in the codemie-code package. Underlying error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function resolveShimPath(): string {
  const here = getDirname(import.meta.url);
  // Walk up from <root>/src/cli/commands/skills/lib (or its dist twin) to <root>.
  // Five "../" hops cover both layouts.
  const projectRoot = path.resolve(here, '..', '..', '..', '..', '..');

  const candidates = [
    path.join(projectRoot, 'dist', 'assets', SHIM_FILENAME),
    path.join(projectRoot, 'assets', SHIM_FILENAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `Failed to locate skills.sh egress guard shim "${SHIM_FILENAME}". Looked in: ${candidates.join(', ')}`
  );
}

function buildNodeOptions(shimAbsPath: string): string {
  // Forward slashes work on all platforms (Node accepts them on Windows too)
  // and avoid backslash-handling edge cases in NODE_OPTIONS on Windows.
  const normalizedPath = shimAbsPath.replaceAll('\\', '/');
  const ours = `--require "${normalizedPath}"`;
  const inherited = process.env.NODE_OPTIONS;
  // Preserve user-supplied NODE_OPTIONS (e.g., --max-old-space-size) but
  // append our require so the shim runs first in child processes.
  return inherited ? `${inherited} ${ours}` : ours;
}
