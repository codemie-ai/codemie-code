/**
 * SkillSync — coverage for `SkillSync.syncToClaude()`, which copies CodeMie-managed
 * skill directories into `.claude/skills/`, tracks an incremental manifest, and (with
 * --clean) rm -rf's orphaned skills. It runs automatically on every Claude SessionStart
 * and from `codemie proxy start`, yet had NO test at any tier — the highest-blast-radius
 * untested filesystem operation in the repo (a bad --clean deletes real skill dirs).
 *
 * ISOLATION / SAFETY
 * ------------------
 * Discovery roots are cwd/.codemie/skills (project), CODEMIE_HOME/skills (global) and
 * plugins. We point CODEMIE_HOME and the working dir at one throwaway temp per test, so
 * neither the developer's ~/.codemie skills nor their real .claude/skills is ever read or
 * written. A uniquely-named seed skill is used, and every assertion targets THAT skill by
 * name — so any skills discovered from globally-installed plugins are tolerated, never
 * asserted against, and only ever land in (and are cleaned from) the temp dir.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillSync } from '../SkillSync.js';

const SKILL = 'sync-selftest-skill';
const MANIFEST = '.codemie-sync.json';

let root: string;
let originalCodemieHome: string | undefined;

function seedSkill(dir: string): string {
  const skillDir = join(dir, '.codemie', 'skills', SKILL);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${SKILL}\ndescription: Self-test skill for SkillSync coverage. Use only in tests.\n---\n# ${SKILL}\nbody\n`,
    'utf-8',
  );
  // A reference file to prove whole-directory copy, not just SKILL.md.
  writeFileSync(join(skillDir, 'reference.md'), 'reference content', 'utf-8');
  return skillDir;
}

beforeEach(() => {
  originalCodemieHome = process.env.CODEMIE_HOME;
  root = mkdtempSync(join(tmpdir(), 'codemie-skillsync-'));
  // Empties the global skills root + plugin settings so discovery is scoped to our seed.
  process.env.CODEMIE_HOME = root;
});

afterEach(() => {
  if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
  else delete process.env.CODEMIE_HOME;
  rmSync(root, { recursive: true, force: true });
});

describe('SkillSync.syncToClaude', () => {
  it('copies a whole skill directory into .claude/skills/ and writes a manifest', async () => {
    seedSkill(root);

    const result = await new SkillSync().syncToClaude({ cwd: root });

    expect(result.synced).toContain(SKILL);
    const target = join(root, '.claude', 'skills', SKILL);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(target, 'reference.md'))).toBe(true);

    const manifest = JSON.parse(readFileSync(join(root, '.claude', 'skills', MANIFEST), 'utf-8'));
    expect(manifest.skills[SKILL]).toBeDefined();
    expect(manifest.skills[SKILL].sourcePath).toContain(SKILL);
  });

  it('skips an unchanged skill on the second sync (incremental via mtime manifest)', async () => {
    seedSkill(root);

    const first = await new SkillSync().syncToClaude({ cwd: root });
    expect(first.synced).toContain(SKILL);

    const second = await new SkillSync().syncToClaude({ cwd: root });
    expect(second.skipped).toContain(SKILL);
    expect(second.synced).not.toContain(SKILL);
  });

  it('re-syncs when the source SKILL.md mtime changes', async () => {
    const skillDir = seedSkill(root);
    await new SkillSync().syncToClaude({ cwd: root });

    // Bump the source mtime one hour forward → manifest mtime no longer matches.
    const future = new Date(Date.now() + 3_600_000);
    utimesSync(join(skillDir, 'SKILL.md'), future, future);

    const result = await new SkillSync().syncToClaude({ cwd: root });
    expect(result.synced).toContain(SKILL);
  });

  it('with clean:true removes a skill that is no longer discovered (orphan)', async () => {
    // A second skill keeps discovery non-empty: syncToClaude early-returns (and so
    // never runs the clean pass) when ZERO skills are discovered, so an orphan is
    // only reaped while at least one live skill remains.
    seedSkill(root);
    const keeper = 'sync-selftest-keeper';
    const keeperDir = join(root, '.codemie', 'skills', keeper);
    mkdirSync(keeperDir, { recursive: true });
    writeFileSync(
      join(keeperDir, 'SKILL.md'),
      `---\nname: ${keeper}\ndescription: Keeper skill so discovery stays non-empty. Tests only.\n---\n# ${keeper}\n`,
      'utf-8',
    );

    await new SkillSync().syncToClaude({ cwd: root });
    const target = join(root, '.claude', 'skills', SKILL);
    expect(existsSync(target)).toBe(true);

    // Remove only the first skill's source, then sync with clean → its target dir
    // must be rm -rf'd while the keeper survives.
    rmSync(join(root, '.codemie', 'skills', SKILL), { recursive: true, force: true });
    const result = await new SkillSync().syncToClaude({ cwd: root, clean: true });

    expect(result.removed).toContain(SKILL);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(join(root, '.claude', 'skills', keeper))).toBe(true);
  });

  it('dryRun reports the skill but writes nothing to disk', async () => {
    seedSkill(root);

    const result = await new SkillSync().syncToClaude({ cwd: root, dryRun: true });

    expect(result.synced).toContain(SKILL);
    // No target dir and no manifest were created.
    expect(existsSync(join(root, '.claude', 'skills', SKILL))).toBe(false);
    expect(existsSync(join(root, '.claude', 'skills', MANIFEST))).toBe(false);
  });
});
