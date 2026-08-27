/**
 * SkillDiscovery / SkillManager edge cases.
 *
 * These regression tests pin the discovery contract of `SkillDiscovery`
 * (src/skills/core/SkillDiscovery.ts) and the `SkillManager` facade over it,
 * for behaviors not already exercised by src/skills/**\/__tests__ or the
 * SkillSync suite: single-root discovery, empty/invalid inputs, cross-scope
 * dedup priority, and the in-memory discovery cache (cache hit, clearCache,
 * forceReload, per-option cache-key isolation).
 *
 * ISOLATION / SAFETY
 * ------------------
 * Discovery reads three real roots: cwd/.codemie/skills (project),
 * CODEMIE_HOME/skills (global), and resolved plugins. Every test points
 * CODEMIE_HOME and the working dir at throwaway temp dirs (mkdtemp), restoring
 * CODEMIE_HOME afterwards, so the developer's real ~/.codemie is never read or
 * written and plugin resolution is scoped to the empty temp home. All seed
 * skills carry a unique '-edge9k' suffix and every assertion targets skills by
 * that suffix, so any skills that leak in from globally-installed plugins are
 * tolerated and never asserted against. No network, no external binaries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillDiscovery } from '../core/SkillDiscovery.js';
import { SkillManager } from '../core/SkillManager.js';

const SUF = '-edge9k';

let home: string;
let proj: string;
let originalCodemieHome: string | undefined;

/** Seed a valid SKILL.md under `<base>/<sub>/<name>`. */
function seedSkill(base: string, sub: string, name: string, descTag = ''): string {
  const dir = join(base, sub, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Edge-case probe skill ${name}${descTag}\n---\n# ${name}\nbody\n`,
    'utf-8',
  );
  return dir;
}

/** Only skills seeded by these tests (ignore any real plugin skills). */
function onlyOurs(skills: Array<{ metadata: { name: string } }>): Array<{ metadata: { name: string } }> {
  return skills.filter((s) => s.metadata.name.endsWith(SUF));
}

beforeEach(() => {
  originalCodemieHome = process.env.CODEMIE_HOME;
  home = mkdtempSync(join(tmpdir(), 'skilldisc-home-'));
  proj = mkdtempSync(join(tmpdir(), 'skilldisc-proj-'));
  // Point the global skills root + plugin settings at an empty temp home.
  process.env.CODEMIE_HOME = home;
});

afterEach(() => {
  if (originalCodemieHome !== undefined) process.env.CODEMIE_HOME = originalCodemieHome;
  else delete process.env.CODEMIE_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
  // Discovery is stateless per-instance; the manager singleton is reset where used.
  SkillManager.resetInstance();
});

describe('SkillDiscovery — discovery roots & filtering edges', () => {
  it('discovers a skill with valid frontmatter from the project root', async () => {
    seedSkill(proj, '.codemie/skills', `alpha${SUF}`);

    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });

    const found = skills.find((s) => s.metadata.name === `alpha${SUF}`);
    expect(found).toBeDefined();
    expect(found!.source).toBe('project');
    // project base priority is 1000 (+ metadata priority default 0)
    expect(found!.computedPriority).toBe(1000);
    expect(found!.filePath).toContain(`alpha${SUF}`);
    expect(found!.content).toContain('body');
  });

  it('discovers a global-only skill from CODEMIE_HOME/skills with the lowest base priority', async () => {
    seedSkill(home, 'skills', `globonly${SUF}`);

    // Project dir has no .codemie/skills at all — global still resolves.
    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });

    const found = skills.find((s) => s.metadata.name === `globonly${SUF}`);
    expect(found).toBeDefined();
    expect(found!.source).toBe('global');
    expect(found!.computedPriority).toBe(100);
  });

  it('yields nothing for a directory that contains no SKILL.md', async () => {
    // An empty sub-directory under the project skills root.
    mkdirSync(join(proj, '.codemie', 'skills', `emptydir${SUF}`), { recursive: true });

    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });

    expect(onlyOurs(skills)).toHaveLength(0);
  });

  it('returns an empty result (no throw) when no skill roots exist at all', async () => {
    // Neither project nor global skills dir is created.
    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });
    expect(onlyOurs(skills)).toHaveLength(0);
  });

  it('skips a SKILL.md whose frontmatter is missing the required name (does not throw)', async () => {
    const badDir = join(proj, '.codemie', 'skills', `bad${SUF}`);
    mkdirSync(badDir, { recursive: true });
    // No `name:` key — fails SkillMetadataSchema validation.
    writeFileSync(join(badDir, 'SKILL.md'), `---\ndescription: missing name key\n---\n# bad\nbody\n`, 'utf-8');
    // A sibling valid skill proves discovery continues past the bad one.
    seedSkill(proj, '.codemie/skills', `good${SUF}`);

    const discovery = new SkillDiscovery();
    const skills = await discovery.discoverSkills({ cwd: proj });

    expect(skills.some((s) => s.metadata.name === `good${SUF}`)).toBe(true);
    expect(onlyOurs(skills).map((s) => s.metadata.name)).not.toContain(`bad${SUF}`);
    // The bad file is silently filtered — exactly one of our skills survives.
    expect(onlyOurs(skills)).toHaveLength(1);
  });

  it('skips a SKILL.md with no frontmatter delimiter without throwing', async () => {
    const noFm = join(proj, '.codemie', 'skills', `nofm${SUF}`);
    mkdirSync(noFm, { recursive: true });
    writeFileSync(join(noFm, 'SKILL.md'), `# just a heading\nno frontmatter here\n`, 'utf-8');

    // Must resolve, not reject.
    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });
    expect(onlyOurs(skills)).toHaveLength(0);
  });
});

describe('SkillDiscovery — dedup by name across scopes (priority)', () => {
  it('keeps the higher-priority project skill over a same-named global skill', async () => {
    const name = `dup${SUF}`;
    seedSkill(proj, '.codemie/skills', name, ' PROJECT');
    seedSkill(home, 'skills', name, ' GLOBAL');

    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });

    const matches = skills.filter((s) => s.metadata.name === name);
    // Deduplicated to a single entry.
    expect(matches).toHaveLength(1);
    const winner = matches[0];
    expect(winner.source).toBe('project');
    expect(winner.computedPriority).toBe(1000);
    expect(winner.metadata.description).toContain('PROJECT');
  });

  it('sorts results by computed priority descending (project before global)', async () => {
    seedSkill(proj, '.codemie/skills', `hi${SUF}`);
    seedSkill(home, 'skills', `lo${SUF}`);

    const skills = await new SkillDiscovery().discoverSkills({ cwd: proj });
    const ours = onlyOurs(skills) as Array<{ metadata: { name: string }; computedPriority: number }>;

    const hiIdx = ours.findIndex((s) => s.metadata.name === `hi${SUF}`);
    const loIdx = ours.findIndex((s) => s.metadata.name === `lo${SUF}`);
    expect(hiIdx).toBeGreaterThanOrEqual(0);
    expect(loIdx).toBeGreaterThanOrEqual(0);
    // Higher-priority (project) comes first.
    expect(hiIdx).toBeLessThan(loIdx);
    expect(ours[hiIdx].computedPriority).toBeGreaterThan(ours[loIdx].computedPriority);
  });
});

describe('SkillDiscovery — cache / reload behavior', () => {
  it('caches by option key: a second call returns the same array reference', async () => {
    seedSkill(proj, '.codemie/skills', `cache${SUF}`);
    const discovery = new SkillDiscovery();

    const first = await discovery.discoverSkills({ cwd: proj });
    const second = await discovery.discoverSkills({ cwd: proj });

    expect(second).toBe(first); // exact same cached reference
    expect(discovery.getCacheStats().size).toBe(1);
  });

  it('clearCache empties the cache and forces fresh discovery on the next call', async () => {
    seedSkill(proj, '.codemie/skills', `reload${SUF}`);
    const discovery = new SkillDiscovery();

    const first = await discovery.discoverSkills({ cwd: proj });
    expect(discovery.getCacheStats().size).toBe(1);

    discovery.clearCache();
    expect(discovery.getCacheStats().size).toBe(0);
    expect(discovery.getCacheStats().keys).toEqual([]);

    const afterClear = await discovery.discoverSkills({ cwd: proj });
    expect(afterClear).not.toBe(first); // freshly discovered array
    // Content still equivalent for our seed.
    expect(afterClear.some((s) => s.metadata.name === `reload${SUF}`)).toBe(true);
  });

  it('picks up a newly-added skill only after a reload, not from a stale cache', async () => {
    seedSkill(proj, '.codemie/skills', `first${SUF}`);
    const discovery = new SkillDiscovery();

    const before = await discovery.discoverSkills({ cwd: proj });
    expect(before.some((s) => s.metadata.name === `first${SUF}`)).toBe(true);
    expect(before.some((s) => s.metadata.name === `second${SUF}`)).toBe(false);

    // Add a new skill on disk — cached call must NOT see it.
    seedSkill(proj, '.codemie/skills', `second${SUF}`);
    const cached = await discovery.discoverSkills({ cwd: proj });
    expect(cached.some((s) => s.metadata.name === `second${SUF}`)).toBe(false);

    // forceReload re-discovers and now sees it.
    const reloaded = await discovery.discoverSkills({ cwd: proj, forceReload: true });
    expect(reloaded.some((s) => s.metadata.name === `second${SUF}`)).toBe(true);
  });

  it('isolates cache entries per distinct option set (cwd / mode / agentName)', async () => {
    seedSkill(proj, '.codemie/skills', `keys${SUF}`);
    const discovery = new SkillDiscovery();

    await discovery.discoverSkills({ cwd: proj });
    await discovery.discoverSkills({ cwd: proj, agentName: 'codemie-code' });
    await discovery.discoverSkills({ cwd: proj, mode: 'dev' });

    const stats = discovery.getCacheStats();
    expect(stats.size).toBe(3);
    // Cache key format is `${cwd}::${mode}::${agentName}`.
    expect(stats.keys).toContain(`${proj}::::`);
    expect(stats.keys).toContain(`${proj}::::codemie-code`);
    expect(stats.keys).toContain(`${proj}::dev::`);
  });
});

describe('SkillManager — facade edges over discovery', () => {
  it('getSkillByName returns the seeded skill and undefined for an unknown name', async () => {
    seedSkill(proj, '.codemie/skills', `mgr${SUF}`);
    const mgr = SkillManager.getInstance();

    const found = await mgr.getSkillByName(`mgr${SUF}`, { cwd: proj });
    expect(found).toBeDefined();
    expect(found!.source).toBe('project');

    const missing = await mgr.getSkillByName(`does-not-exist${SUF}`, { cwd: proj });
    expect(missing).toBeUndefined();
  });

  it('validateAll returns the valid skill and no invalid entries when frontmatter is well-formed', async () => {
    seedSkill(proj, '.codemie/skills', `valid${SUF}`);
    const mgr = SkillManager.getInstance();

    const { valid, invalid } = await mgr.validateAll({ cwd: proj });

    expect(valid.some((s) => s.metadata.name === `valid${SUF}`)).toBe(true);
    // Invalid skills are silently filtered by discovery, so none are reported here.
    expect(invalid).toEqual([]);
  });

  it('reload() clears the underlying discovery cache', async () => {
    seedSkill(proj, '.codemie/skills', `mgrreload${SUF}`);
    const mgr = SkillManager.getInstance();

    await mgr.listSkills({ cwd: proj });
    expect(mgr.getCacheStats().size).toBe(1);

    mgr.reload();
    expect(mgr.getCacheStats().size).toBe(0);
  });
});
