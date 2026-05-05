/**
 * Subprocess e2e tests for `codemie skills {add,update,remove,list}`.
 *
 * Exercises the real built CLI (`bin/codemie.js`) against a stub upstream
 * `skills` binary so we can prove end-to-end:
 *   - the auth gate fires before any skills.sh spawn for unauthenticated users
 *   - `runSkillsCli` injects `DO_NOT_TRACK`, `DISABLE_TELEMETRY`, `CI`,
 *     and `NODE_OPTIONS=--require <egress shim>` into the upstream env
 *   - argv mapping for each subcommand survives into the upstream invocation
 *   - upstream non-zero exit codes are propagated, not collapsed to 1
 *
 * The stub binary (`tests/helpers/fake-skills-cli.mjs`) writes a JSON
 * snapshot of its argv + observed env to a temp file the test reads back.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_BIN = path.join(REPO_ROOT, 'bin', 'codemie.js');

let workspace: string;
let stubBin: string;
let snapshotPath: string;

beforeAll(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'codemie-skills-e2e-'));
  stubBin = path.join(workspace, 'fake-skills-cli.mjs');
  snapshotPath = path.join(workspace, 'invocations.jsonl');

  // Stub upstream `skills` binary: append one JSON line per invocation
  // recording argv + relevant env, then exit with the code requested via
  // STUB_EXIT_CODE env. STUB_STDOUT / STUB_STDERR let tests inject output for
  // classification checks. We use env vars rather than CLI flags because
  // Commander rejects unknown flags before they reach the upstream spawn.
  writeFileSync(
    stubBin,
    [
      '#!/usr/bin/env node',
      'import { appendFileSync } from "node:fs";',
      'const argv = process.argv.slice(2);',
      'if (process.env.STUB_STDERR) process.stderr.write(process.env.STUB_STDERR);',
      'if (process.env.STUB_STDOUT) process.stdout.write(process.env.STUB_STDOUT);',
      `appendFileSync(${JSON.stringify(snapshotPath)}, JSON.stringify({`,
      '  argv,',
      '  env: {',
      '    DO_NOT_TRACK: process.env.DO_NOT_TRACK,',
      '    DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY,',
      '    CI: process.env.CI,',
      '    NODE_OPTIONS: process.env.NODE_OPTIONS,',
      '  },',
      '}) + "\\n");',
      'process.exit(Number(process.env.STUB_EXIT_CODE ?? 0));',
    ].join('\n')
  );
});

afterAll(() => {
  rmSync(workspace, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function runCLI(args: string[], extraEnv: Record<string, string> = {}): RunResult {
  // Truncate snapshot before each run so each test reads only its own data.
  writeFileSync(snapshotPath, '');

  const result = spawnSync(process.execPath, [CLI_BIN, 'skills', ...args], {
    cwd: workspace,
    env: {
      ...process.env,
      // Point the wrapper at our stub instead of node_modules/skills.
      CODEMIE_SKILLS_BIN_OVERRIDE: stubBin,
      // Disable interactive prompts so the test never hangs.
      CI: '1',
      NODE_ENV: 'test',
      VITEST: 'true',
      ...extraEnv,
    },
    encoding: 'utf-8',
    timeout: 30_000,
  });

  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function readInvocations(): Array<{ argv: string[]; env: Record<string, string | undefined> }> {
  if (!existsSync(snapshotPath)) return [];
  return readFileSync(snapshotPath, 'utf-8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe('codemie skills (subprocess e2e)', () => {
  it('shows help for `codemie skills` without spawning upstream', () => {
    const result = runCLI(['--help']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(/Install, manage, and discover skills/);
    expect(result.stdout).toMatch(/\badd\b/);
    expect(result.stdout).toMatch(/\bupdate\b/);
    expect(result.stdout).toMatch(/\bremove\b/);
    expect(result.stdout).toMatch(/\blist\b/);
    expect(result.stdout).toMatch(/\bfind\b/);
    // Help bypasses auth and never reaches the upstream binary.
    expect(readInvocations()).toHaveLength(0);
  });

  it('shows help for each subcommand', () => {
    for (const sub of ['add', 'update', 'remove', 'list', 'find']) {
      const result = runCLI([sub, '--help']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(new RegExp(sub));
    }
    expect(readInvocations()).toHaveLength(0);
  });

  it('blocks every subcommand on unauthenticated invocation (spec §7)', () => {
    // Point credentials lookup at a brand-new URL never logged in to so any
    // fallback global credentials in the user's keychain will not match.
    const isolatedEnv = {
      CODEMIE_HOME: path.join(workspace, 'isolated-home-' + Date.now()),
    };

    for (const sub of [
      ['add', 'owner/repo', '-y'],
      ['update', '-y'],
      ['remove', '-y'],
      ['list'],
    ]) {
      const result = runCLI(sub as string[], {
        ...isolatedEnv,
        // Force a base URL that is guaranteed to have no stored credentials.
        // The wrapper's auth check loads ConfigLoader which reads from
        // CODEMIE_HOME; an empty home means no codeMieUrl, which short-circuits
        // the auth gate to "not configured".
      });
      // Either "no CodeMie URL configured" or the canonical SSO message, both
      // exit with 1 and never spawn the upstream stub.
      expect(result.exitCode).toBe(1);
      expect(readInvocations()).toHaveLength(0);
    }
  });
});

// Subprocess tests that exercise the upstream-spawn path require the user to
// have an active CodeMie SSO session locally. We skip these on machines
// without one so CI does not fail; developers running locally will exercise
// them automatically.
const HAS_LOCAL_SSO = (() => {
  try {
    const probe = spawnSync(process.execPath, [CLI_BIN, 'skills', 'list', '--global'], {
      env: { ...process.env, CODEMIE_SKILLS_BIN_OVERRIDE: 'noexist' },
      encoding: 'utf-8',
      timeout: 10_000,
    });
    // If auth fails, the wrapper exits 1 before resolving the (missing) bin.
    // If auth succeeds, the wrapper attempts to resolve the bin and fails
    // with a different error path.
    return !/SSO authentication required|No CodeMie URL configured/i.test(
      probe.stderr ?? ''
    );
  } catch {
    return false;
  }
})();

describe.runIf(HAS_LOCAL_SSO)('codemie skills (authenticated upstream spawn)', () => {
  it('add: forwards source and explicit --agent to upstream argv', () => {
    const result = runCLI(['add', 'owner/repo', '-a', 'claude-code', '-y']);
    expect(result.exitCode).toBe(0);
    const [invocation] = readInvocations();
    expect(invocation.argv).toEqual(['add', 'owner/repo', '--yes', '--agent', 'claude-code']);
  });

  it('add: forwards --skill list to upstream argv', () => {
    const result = runCLI(['add', 'owner/repo', '--skill', 'foo', 'bar', '-a', 'claude-code', '-y']);
    expect(result.exitCode).toBe(0);
    const [invocation] = readInvocations();
    expect(invocation.argv).toContain('--skill');
    expect(invocation.argv).toContain('foo');
    expect(invocation.argv).toContain('bar');
  });

  it('add: injects DO_NOT_TRACK / DISABLE_TELEMETRY / CI / NODE_OPTIONS shim', () => {
    runCLI(['add', 'owner/repo', '-a', 'claude-code', '-y']);
    const [invocation] = readInvocations();
    expect(invocation.env.DO_NOT_TRACK).toBe('1');
    expect(invocation.env.DISABLE_TELEMETRY).toBe('1');
    expect(invocation.env.CI).toBe('1');
    expect(invocation.env.NODE_OPTIONS).toMatch(/--require\s+"[^"]+skills-sh-egress-guard\.cjs"/);
  });

  it('update: forwards positional skill names', () => {
    const result = runCLI(['update', 'foo', 'bar', '-y']);
    expect(result.exitCode).toBe(0);
    const [invocation] = readInvocations();
    expect(invocation.argv).toEqual(['update', '--yes', 'foo', 'bar']);
  });

  it('remove: forwards --skill / --agent / -y options', () => {
    const result = runCLI(['remove', '-s', 'foo', '-a', 'claude-code', '-y']);
    expect(result.exitCode).toBe(0);
    const [invocation] = readInvocations();
    expect(invocation.argv).toEqual(['remove', '--yes', '--skill', 'foo', '--agent', 'claude-code']);
  });

  it('list: forwards --json so upstream emits machine-readable output', () => {
    const result = runCLI(['list', '--json'], { STUB_STDOUT: '[{"skill":"foo"}]' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('[{"skill":"foo"}]');
    const [invocation] = readInvocations();
    expect(invocation.argv).toEqual(['list', '--json']);
  });

  it('propagates upstream non-zero exit codes (not collapsed to 1)', () => {
    const result = runCLI(['add', 'owner/repo', '-a', 'claude-code', '-y'], {
      STUB_EXIT_CODE: '7',
    });
    expect(result.exitCode).toBe(7);
  });

  it('classifies CODEMIE_SKILL_EGRESS_BLOCKED stderr as egress_blocked exit code', () => {
    // The stub writes the egress marker to stderr and exits with code 7.
    // The wrapper must preserve the upstream exit code (per the runSkillsCli
    // refactor that bypasses the project's `exec()` interactive-mode reject).
    const result = runCLI(['add', 'owner/repo', '-a', 'claude-code', '-y'], {
      STUB_EXIT_CODE: '7',
      STUB_STDERR: 'CODEMIE_SKILL_EGRESS_BLOCKED audit attempt',
    });
    expect(result.exitCode).toBe(7);
    expect(result.stderr).toContain('CODEMIE_SKILL_EGRESS_BLOCKED');
  });
});
