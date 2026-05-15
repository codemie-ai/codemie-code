import { describe, it, expect } from 'vitest';
import { SkillSlugFormatMigration } from '../005-skill-slug-format.migration.js';
import type { MultiProviderConfig, CodemieSkill } from '../../env/types.js';

const migration = new SkillSlugFormatMigration();
const computeSlug = (skill: any, scope: 'global' | 'local'): string =>
  (migration as any).computeNewSlug(skill, scope);
const migrateSkillSlugs = (config: any, scope: 'global' | 'local', dir = '/nonexistent') =>
  (migration as any).migrateSkillSlugs(config, scope, dir);

function baseConfig(skills: CodemieSkill[] = []): MultiProviderConfig {
  return { version: 2, activeProfile: 'default', codemieSkills: skills, codemieAssistants: [], profiles: {} };
}

function makeSkill(id: string, name: string, project?: string, slug?: string): CodemieSkill {
  return {
    id,
    name,
    slug: slug ?? name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    description: '',
    project,
    registeredAt: '2026-01-01T00:00:00.000Z',
  } as CodemieSkill;
}

// ---------------------------------------------------------------------------
// computeNewSlug
// ---------------------------------------------------------------------------
describe('SkillSlugFormatMigration — computeNewSlug', () => {
  it('appends scope suffix when no project', () => {
    const skill = makeSkill('1', 'commit-notes');
    expect(computeSlug(skill, 'global')).toBe('commit-notes-global');
    expect(computeSlug(skill, 'local')).toBe('commit-notes-local');
  });

  it('appends project and scope suffix', () => {
    const skill = makeSkill('1', 'commit-notes', 'my-project');
    expect(computeSlug(skill, 'global')).toBe('commit-notes-my-project-global');
  });

  it('sanitizes special chars in name', () => {
    const skill = makeSkill('1', 'PR Summary!');
    expect(computeSlug(skill, 'global')).toBe('pr-summary-global');
  });

  it('sanitizes special chars in project (email address)', () => {
    const skill = makeSkill('1', 'commit-notes', 'mykola@epam.com');
    expect(computeSlug(skill, 'global')).toBe('commit-notes-mykola-epam-com-global');
  });

  it('falls back to id when name produces empty string', () => {
    const skill = { ...makeSkill('abc-123', '!!!'), id: 'abc-123' };
    expect(computeSlug(skill, 'global')).toBe('abc-123-global');
  });

  it('strips leading/trailing hyphens from project suffix', () => {
    const skill = makeSkill('1', 'my-skill', '-frontend-');
    expect(computeSlug(skill, 'global')).toBe('my-skill-frontend-global');
  });
});

// ---------------------------------------------------------------------------
// migrateSkillSlugs
// ---------------------------------------------------------------------------
describe('SkillSlugFormatMigration — migrateSkillSlugs', () => {
  it('returns unchanged config when codemieSkills is empty', async () => {
    const config = baseConfig([]);
    const { config: result, changed } = await migrateSkillSlugs(config, 'global');
    expect(changed).toBe(false);
    expect(result).toBe(config);
  });

  it('returns unchanged when all slugs already match new format', async () => {
    const skill = makeSkill('1', 'commit-notes', 'proj', 'commit-notes-proj-global');
    const config = baseConfig([skill]);
    const { config: result, changed } = await migrateSkillSlugs(config, 'global');
    expect(changed).toBe(false);
    expect(result.codemieSkills![0].slug).toBe('commit-notes-proj-global');
  });

  it('updates slug when old format detected (dir does not exist — safe fallback)', async () => {
    const skill = makeSkill('1', 'commit-notes', 'proj', 'commit-notes');
    const config = baseConfig([skill]);
    const { config: result, changed } = await migrateSkillSlugs(config, 'global');
    expect(changed).toBe(true);
    expect(result.codemieSkills![0].slug).toBe('commit-notes-proj-global');
  });

  it('returns new config object — does not mutate original', async () => {
    const skill = makeSkill('1', 'commit-notes', undefined, 'commit-notes');
    const config = baseConfig([skill]);
    const { config: result } = await migrateSkillSlugs(config, 'global');
    expect(result).not.toBe(config);
    expect(config.codemieSkills![0].slug).toBe('commit-notes');
  });

  it('handles mixed skills — updates only those with old slugs', async () => {
    const old = makeSkill('1', 'pr-summary', 'proj', 'pr-summary');
    const current = makeSkill('2', 'commit-notes', 'proj', 'commit-notes-proj-global');
    const config = baseConfig([old, current]);
    const { config: result, changed } = await migrateSkillSlugs(config, 'global');
    expect(changed).toBe(true);
    expect(result.codemieSkills![0].slug).toBe('pr-summary-proj-global');
    expect(result.codemieSkills![1].slug).toBe('commit-notes-proj-global');
  });

  it('preserves other skill fields during slug update', async () => {
    const skill = makeSkill('id-1', 'commit-notes', 'proj', 'commit-notes');
    const config = baseConfig([skill]);
    const { config: result } = await migrateSkillSlugs(config, 'local');
    const updated = result.codemieSkills![0];
    expect(updated.id).toBe('id-1');
    expect(updated.name).toBe('commit-notes');
    expect(updated.project).toBe('proj');
    expect(updated.registeredAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('preserves top-level config fields other than codemieSkills', async () => {
    const skill = makeSkill('1', 'commit-notes', undefined, 'commit-notes');
    const config = baseConfig([skill]);
    const { config: result } = await migrateSkillSlugs(config, 'global');
    expect(result.activeProfile).toBe('default');
    expect(result.version).toBe(2);
    expect(result.codemieAssistants).toEqual([]);
  });
});
