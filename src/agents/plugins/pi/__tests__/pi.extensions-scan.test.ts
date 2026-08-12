import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiPluginMetadata } from '../pi.plugin.js';
import { getExtensionsScanSummary } from '@/utils/extensions-scan.js';
import { redirectHomeDir } from './home-redirect.js';

/**
 * Pi's resource directories are named differently from the scanner's defaults, and a
 * wrong mapping fails silently — every count comes back zero and the lifecycle metric
 * looks like a user with no skills rather than a broken scan. These tests build a real
 * Pi layout on disk and assert the declared mapping actually finds it.
 */
function writeFile(path: string, content = ''): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('pi extensions scan', () => {
  let root: string;
  let cwd: string;
  let home: string;
  let restoreHome: () => void;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pi-ext-scan-'));
    cwd = join(root, 'project');
    home = join(root, 'home');
    // So '~/.pi/agent' resolves under the fixture rather than the real user profile.
    restoreHome = redirectHomeDir(home);

    // User scope: ~/.pi/agent/{skills,prompts,extensions}
    writeFile(join(home, '.pi/agent/skills/brave-search/SKILL.md'), '# Brave');
    writeFile(join(home, '.pi/agent/skills/pdf/SKILL.md'), '# PDF');
    writeFile(join(home, '.pi/agent/prompts/review.md'), '# Review');
    writeFile(join(home, '.pi/agent/extensions/usage-bar.js'), '');

    // Project scope: <cwd>/.pi/{skills,prompts,extensions}
    writeFile(join(cwd, '.pi/skills/deploy/SKILL.md'), '# Deploy');
    writeFile(join(cwd, '.pi/prompts/ship.md'), '# Ship');
    writeFile(join(cwd, '.pi/prompts/rollback.md'), '# Rollback');
    writeFile(join(cwd, '.pi/extensions/tracker.ts'), '');
  });

  afterEach(() => {
    restoreHome();
    rmSync(root, { recursive: true, force: true });
  });

  const scan = () => getExtensionsScanSummary(PiPluginMetadata.extensionsConfig, cwd);

  it('counts Pi prompt templates as commands and Pi extensions as hooks', async () => {
    const summary = await scan();

    expect(summary.global.commands).toBe(1);
    expect(summary.project.commands).toBe(2);
    expect(summary.global.hooks).toBe(1);
    expect(summary.project.hooks).toBe(1);
  });

  it('counts each skill directory once, naming it after the directory', async () => {
    const summary = await scan();

    expect(summary.global.skills).toBe(2);
    expect(summary.project.skills).toBe(1);
    expect(summary.globalNames.skills).toEqual(['brave-search', 'pdf']);
    expect(summary.projectNames.skills).toEqual(['deploy']);
  });

  it('holds agents and rules at zero even when such directories exist', async () => {
    // Pi has no agents or rules concept. If the empty-array override were dropped, the
    // scanner's defaults would start reporting whatever happens to sit in these dirs.
    writeFile(join(home, '.pi/agent/agents/stray.md'), '# Stray');
    writeFile(join(cwd, '.pi/rules/house-style.md'), '# Style');

    const summary = await scan();

    expect(summary.global.agents).toBe(0);
    expect(summary.project.agents).toBe(0);
    expect(summary.global.rules).toBe(0);
    expect(summary.project.rules).toBe(0);
  });

  it("does not count CodeMie's own metrics extension as a user hook", async () => {
    // beforeRun materializes this into the agent dir CodeMie redirects Pi to. It is
    // our plumbing, not a resource the user authored.
    writeFile(join(cwd, '.pi/codemie/agent/extensions/index.js'), '');
    writeFile(join(cwd, '.pi/codemie/agent/extensions/package.json'), '{}');

    const summary = await scan();

    expect(summary.project.hooks).toBe(1);
    expect(summary.projectNames.hooks).toEqual(['tracker.ts']);
  });

  it('reports zeros rather than throwing when nothing is installed', async () => {
    const summary = await getExtensionsScanSummary(
      PiPluginMetadata.extensionsConfig,
      join(root, 'empty')
    );

    expect(summary.project.skills).toBe(0);
    expect(summary.project.commands).toBe(0);
    expect(summary.project.hooks).toBe(0);
  });
});
