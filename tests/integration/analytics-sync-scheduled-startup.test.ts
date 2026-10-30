/**
 * Startup gating for the unattended `analytics sync run --scheduled` job.
 *
 * Spawns bin/codemie.js (built dist) in a fresh, isolated CODEMIE_HOME — every migration is
 * pending there — and checks that the scheduled invocation runs them silently while a manual
 * `analytics sync run` still prints the migration banner. The update check and the what's-new
 * notice are already off under NODE_ENV=test / a non-TTY stdout, so the migration banner is
 * the observable part of the gate here.
 *
 * Both runs have no sync settings, so they reach `runSync` and stop at `fail setup` without
 * any network call.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { createCLIRunner } from '../helpers/index.js';

const cli = createCLIRunner();
const MIGRATION_BANNER = /Running \d+ migration\(s\)/;

describe('analytics sync run startup gating', () => {
  const homes: string[] = [];

  afterAll(() => {
    for (const home of homes) {
      rmSync(home, { recursive: true, force: true });
    }
  });

  function runInFreshHome(command: string): string {
    const home = mkdtempSync(join(tmpdir(), 'codemie-sync-startup-'));
    homes.push(home);
    const result = cli.runSilent(command, {
      env: { ...process.env, CODEMIE_HOME: home },
      stdio: 'pipe',
    });
    return `${result.output}\n${result.error ?? ''}`;
  }

  it('runs pending migrations silently for the scheduled job', () => {
    const output = runInFreshHome('analytics sync run --scheduled');

    expect(output).toContain('fail setup');
    expect(output).not.toMatch(MIGRATION_BANNER);
  });

  it('still shows the migration banner for a manual run', () => {
    const output = runInFreshHome('analytics sync run');

    expect(output).toContain('fail setup');
    expect(output).toMatch(MIGRATION_BANNER);
  });
});
