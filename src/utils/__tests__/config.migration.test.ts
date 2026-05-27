import { describe, it, expect } from 'vitest';
import { SkillsAssistantsTopLevelMigration } from '../../migrations/004-skills-assistants-top-level.migration.js';
import type { MultiProviderConfig, CodemieSkill, CodemieAssistant } from '../../env/types.js';

const migration = new SkillsAssistantsTopLevelMigration();
const migrate = (config: any): MultiProviderConfig => migration.migrate(config);

function baseConfig(profiles: Record<string, any> = {}): any {
  return { version: 2, activeProfile: 'default', profiles };
}

function makeSkill(id: string, registeredAt: string, slug = id): CodemieSkill {
  return { id, name: `Skill ${id}`, slug, description: '', registeredAt } as CodemieSkill;
}

function makeAssistant(id: string, registeredAt: string, mode = 'agent'): CodemieAssistant {
  return { id, name: `Asst ${id}`, slug: id, registrationMode: mode, registeredAt } as CodemieAssistant;
}

// ---------------------------------------------------------------------------
// Guard — already new format
// ---------------------------------------------------------------------------
describe('migrateSkillsAndAssistants — guard (already new format)', () => {
  it('runs partial migration when only codemieSkills is present — adds missing codemieAssistants, preserves existing skills', () => {
    const skill = makeSkill('s1', '2026-01-01');
    const config = { ...baseConfig(), codemieSkills: [skill] };
    const result = migrate(config);
    expect(result).not.toBe(config);
    expect(result.codemieAssistants).toEqual([]);
    expect(result.codemieSkills).toEqual([skill]);
  });

  it('runs partial migration when only codemieAssistants is present — adds missing codemieSkills, preserves existing assistants', () => {
    const asst = makeAssistant('a1', '2026-01-01');
    const config = { ...baseConfig(), codemieAssistants: [asst] };
    const result = migrate(config);
    expect(result).not.toBe(config);
    expect(result.codemieSkills).toEqual([]);
    expect(result.codemieAssistants).toEqual([asst]);
  });

  it('returns unchanged when both fields are present — does not touch profiles', () => {
    const profileWithLegacy = { provider: 'openai', codemieSkills: [makeSkill('s1', '2026-01-01')] };
    const config = {
      ...baseConfig({ default: profileWithLegacy }),
      codemieSkills: [],
      codemieAssistants: [],
    };
    const result = migrate(config);
    expect(result).toBe(config);
    expect((result.profiles.default as any).codemieSkills).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Migration from old format
// ---------------------------------------------------------------------------
describe('migrateSkillsAndAssistants — migration from old format', () => {
  it('moves skills from a single profile to top-level and removes them from profile', () => {
    const skill = makeSkill('s1', '2026-01-01');
    const config = baseConfig({ default: { provider: 'openai', codemieSkills: [skill] } });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieSkills![0]).toEqual(skill);
    expect((result.profiles.default as any).codemieSkills).toBeUndefined();
  });

  it('moves assistants from a single profile to top-level and removes them from profile', () => {
    const asst = makeAssistant('a1', '2026-01-01');
    const config = baseConfig({ default: { provider: 'openai', codemieAssistants: [asst] } });

    const result = migrate(config);

    expect(result.codemieAssistants).toHaveLength(1);
    expect(result.codemieAssistants![0]).toEqual(asst);
    expect((result.profiles.default as any).codemieAssistants).toBeUndefined();
  });

  it('moves both skills and assistants simultaneously', () => {
    const skill = makeSkill('s1', '2026-01-01');
    const asst = makeAssistant('a1', '2026-01-01');
    const config = baseConfig({
      default: { codemieSkills: [skill], codemieAssistants: [asst] },
    });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieAssistants).toHaveLength(1);
    expect((result.profiles.default as any).codemieSkills).toBeUndefined();
    expect((result.profiles.default as any).codemieAssistants).toBeUndefined();
  });

  it('merges unique skills from multiple profiles', () => {
    const s1 = makeSkill('s1', '2026-01-01');
    const s2 = makeSkill('s2', '2026-02-01');
    const config = baseConfig({
      work: { codemieSkills: [s1] },
      personal: { codemieSkills: [s2] },
    });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(2);
    const ids = result.codemieSkills!.map(s => s.id);
    expect(ids).toContain('s1');
    expect(ids).toContain('s2');
  });

  it('produces empty arrays for profiles with no skills or assistants', () => {
    const config = baseConfig({ default: { provider: 'openai' } });

    const result = migrate(config);

    expect(result.codemieSkills).toEqual([]);
    expect(result.codemieAssistants).toEqual([]);
  });

  it('produces empty arrays when profiles is empty', () => {
    const config = baseConfig({});

    const result = migrate(config);

    expect(result.codemieSkills).toEqual([]);
    expect(result.codemieAssistants).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Deduplication — same id in multiple profiles
// ---------------------------------------------------------------------------
describe('migrateSkillsAndAssistants — deduplication', () => {
  it('keeps newer registeredAt when same skill id exists in two profiles', () => {
    const old = makeSkill('s1', '2026-01-01');
    const newer = { ...makeSkill('s1', '2026-03-01'), slug: 's1-updated' };
    const config = baseConfig({
      work: { codemieSkills: [old] },
      personal: { codemieSkills: [newer] },
    });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieSkills![0].registeredAt).toBe('2026-03-01');
    expect(result.codemieSkills![0].slug).toBe('s1-updated');
  });

  it('keeps the profile-order-first when registeredAt is older in second profile', () => {
    const newer = makeSkill('s1', '2026-03-01');
    const old = makeSkill('s1', '2026-01-01');
    const config = baseConfig({
      work: { codemieSkills: [newer] },
      personal: { codemieSkills: [old] },
    });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieSkills![0].registeredAt).toBe('2026-03-01');
  });

  it('keeps the first encountered when registeredAt is identical in both profiles', () => {
    const a = { ...makeSkill('s1', '2026-01-01'), slug: 'first' };
    const b = { ...makeSkill('s1', '2026-01-01'), slug: 'second' };
    const config = baseConfig({
      work: { codemieSkills: [a] },
      personal: { codemieSkills: [b] },
    });

    const result = migrate(config);

    expect(result.codemieSkills).toHaveLength(1);
    expect(result.codemieSkills![0].slug).toBe('first');
  });

  it('picks the assistant with newer registeredAt even when registrationMode differs', () => {
    const old = makeAssistant('a1', '2026-01-01', 'agent');
    const newer = makeAssistant('a1', '2026-03-01', 'skill');
    const config = baseConfig({
      work: { codemieAssistants: [old] },
      personal: { codemieAssistants: [newer] },
    });

    const result = migrate(config);

    expect(result.codemieAssistants).toHaveLength(1);
    expect(result.codemieAssistants![0].registeredAt).toBe('2026-03-01');
    expect(result.codemieAssistants![0].registrationMode).toBe('skill');
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe('migrateSkillsAndAssistants — edge cases', () => {
  it('handles empty arrays in profile without error', () => {
    const config = baseConfig({ default: { codemieSkills: [], codemieAssistants: [] } });

    const result = migrate(config);

    expect(result.codemieSkills).toEqual([]);
    expect(result.codemieAssistants).toEqual([]);
  });

  it('handles profile with codemieSkills: undefined without error', () => {
    const config = baseConfig({ default: { codemieSkills: undefined } });

    expect(() => migrate(config)).not.toThrow();
    expect(migrate(config).codemieSkills).toEqual([]);
  });

  it('removes codemieSkills and codemieAssistants keys from profiles after migration', () => {
    const config = baseConfig({
      work: {
        codemieSkills: [makeSkill('s1', '2026-01-01')],
        codemieAssistants: [makeAssistant('a1', '2026-01-01')],
      },
    });

    const result = migrate(config);

    expect('codemieSkills' in result.profiles.work).toBe(false);
    expect('codemieAssistants' in result.profiles.work).toBe(false);
  });

  it('does not mutate original profile objects — returns new profiles map', () => {
    const profileObj = { codemieSkills: [makeSkill('s1', '2026-01-01')] };
    const config = baseConfig({ default: profileObj });

    const result = migrate(config);

    expect(result).not.toBe(config);
    expect(result.profiles).not.toBe(config.profiles);
    expect((profileObj as any).codemieSkills).toBeDefined();
    expect((result.profiles.default as any).codemieSkills).toBeUndefined();
  });

  it('preserves other profile fields after migration', () => {
    const config = baseConfig({
      default: {
        provider: 'bedrock',
        model: 'claude-sonnet-4-6',
        codemieSkills: [makeSkill('s1', '2026-01-01')],
      },
    });

    const result = migrate(config);

    expect((result.profiles.default as any).provider).toBe('bedrock');
    expect((result.profiles.default as any).model).toBe('claude-sonnet-4-6');
  });

  it('preserves non-skills fields of the top-level config', () => {
    const config = { ...baseConfig({ default: {} }), activeProfile: 'default', version: 2 as const };

    const result = migrate(config);

    expect(result.version).toBe(2);
    expect(result.activeProfile).toBe('default');
  });
});
