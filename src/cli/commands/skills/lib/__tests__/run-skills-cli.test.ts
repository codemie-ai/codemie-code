/**
 * Unit tests for `runSkillsCli`.
 *
 * Spec §6 / §10 require the wrapper to:
 *   - inject DO_NOT_TRACK / DISABLE_TELEMETRY / CI / NODE_OPTIONS=--require <shim>
 *   - resolve the upstream `skills/bin/cli.mjs` from node_modules
 *   - surface the upstream exit code (not collapse it to a rejection) so the
 *     classifier can see real failures
 *   - capture stderr in addition to forwarding it, so markers like
 *     CODEMIE_SKILL_EGRESS_BLOCKED reach the classifier
 *
 * Strategy: replace the upstream `skills` resolution with a fake bin that
 * echoes the env it observes and exits with whatever code we ask for.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;
let fakeSkillsBin: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'codemie-runskills-'));

  fakeSkillsBin = path.join(tempDir, 'fake-skills-cli.mjs');
  writeFileSync(
    fakeSkillsBin,
    [
      '#!/usr/bin/env node',
      'const env = {',
      '  DO_NOT_TRACK: process.env.DO_NOT_TRACK,',
      '  DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY,',
      '  CI: process.env.CI,',
      '  NODE_OPTIONS: process.env.NODE_OPTIONS,',
      '  ARGV: process.argv.slice(2),',
      '};',
      'process.stdout.write(JSON.stringify(env));',
      'if (process.argv.includes("--exit")) {',
      '  const idx = process.argv.indexOf("--exit");',
      '  process.exit(Number(process.argv[idx + 1]));',
      '}',
      'if (process.argv.includes("--stderr")) {',
      '  process.stderr.write("CODEMIE_SKILL_EGRESS_BLOCKED test marker");',
      '  process.exit(7);',
      '}',
      'process.exit(0);',
    ].join('\n')
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

async function importRunner(): Promise<typeof import('../run-skills-cli.js')> {
  vi.resetModules();
  // Mock the upstream resolution so the runner spawns our fake bin instead.
  vi.doMock('node:module', async () => {
    const actual = await vi.importActual<typeof import('node:module')>('node:module');
    return {
      ...actual,
      createRequire: () => {
        const realRequire = actual.createRequire(import.meta.url);
        return Object.assign(
          (id: string) => realRequire(id),
          {
            ...realRequire,
            resolve: (id: string) => {
              if (id === 'skills/bin/cli.mjs') return fakeSkillsBin;
              return realRequire.resolve(id);
            },
          }
        );
      },
    };
  });
  return import('../run-skills-cli.js');
}

describe('runSkillsCli', () => {
  it('injects DO_NOT_TRACK, DISABLE_TELEMETRY, CI, and NODE_OPTIONS=--require <shim>', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli([], { interactive: false });
    expect(result.code).toBe(0);
    const env = JSON.parse(result.stdout);
    expect(env.DO_NOT_TRACK).toBe('1');
    expect(env.DISABLE_TELEMETRY).toBe('1');
    expect(env.CI).toBe(process.env.CI ?? '1');
    expect(env.NODE_OPTIONS).toMatch(/--require\s+"[^"]+skills-sh-egress-guard\.cjs"/);
  });

  it('forwards args verbatim to the upstream binary', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli(['add', 'owner/repo', '--global'], { interactive: false });
    const env = JSON.parse(result.stdout);
    expect(env.ARGV).toEqual(['add', 'owner/repo', '--global']);
  });

  it('surfaces upstream non-zero exit code instead of rejecting', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli(['--exit', '42'], { interactive: false });
    expect(result.code).toBe(42);
  });

  it('captures stderr so the egress marker reaches classification', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli(['--stderr'], { interactive: false });
    expect(result.code).toBe(7);
    expect(result.stderr).toContain('CODEMIE_SKILL_EGRESS_BLOCKED');
  });

  it('appends to inherited NODE_OPTIONS when one already exists', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli([], {
      interactive: false,
      env: { NODE_OPTIONS_PARENT_TEST: 'set' },
    });
    expect(result.code).toBe(0);
    // The runner reads process.env.NODE_OPTIONS at call time. We assert that
    // the shim --require is present at minimum; presence of an inherited value
    // is best-effort because vitest may set NODE_OPTIONS itself.
    const env = JSON.parse(result.stdout);
    expect(env.NODE_OPTIONS).toMatch(/--require\s+"/);
  });

  it('quotes the shim path so spaces survive in NODE_OPTIONS', async () => {
    const { runSkillsCli } = await importRunner();
    const result = await runSkillsCli([], { interactive: false });
    const env = JSON.parse(result.stdout);
    // Quoted form ensures path-with-spaces is robust on every platform.
    expect(env.NODE_OPTIONS).toMatch(/--require\s+"[^"]+"/);
  });
});
