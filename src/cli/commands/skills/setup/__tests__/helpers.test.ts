/**
 * Unit tests for skills setup helpers
 */

import { describe, it, expect, vi } from 'vitest';
import type { CodemieSkill } from '@/env/types.js';

vi.mock('@/utils/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock('@/cli/commands/skills/setup/generators/claude-skill-generator.js', () => ({
  registerClaudeSkill: vi.fn(),
  unregisterClaudeSkill: vi.fn(),
}));

vi.mock('@/cli/commands/skills/setup/generators/codex-skill-generator.js', () => ({
  registerCodexSkill: vi.fn(),
  unregisterCodexSkill: vi.fn(),
}));

vi.mock('@/cli/commands/skills/setup/generators/gemini-skill-generator.js', () => ({
  registerGeminiSkill: vi.fn(),
  unregisterGeminiSkill: vi.fn(),
}));

import { resolveMissingSkills } from '../helpers.js';
import { RegistrationItemNotFoundError } from '@/utils/errors.js';

describe('resolveMissingSkills', () => {
  const registered: CodemieSkill[] = [
    { id: 'stale-1', name: 'Stale One', slug: 'stale-one', description: '', registeredAt: '2026-01-01T00:00:00.000Z' },
    { id: 'stale-2', name: 'Stale Two', slug: 'stale-two', description: '', registeredAt: '2026-01-01T00:00:00.000Z' },
  ];

  it('returns an empty list when nothing is missing', () => {
    // Act
    const result = resolveMissingSkills([], registered);

    // Assert
    expect(result).toEqual([]);
  });

  it('returns the registered entries for missing registered ids, in missing order', () => {
    // Act
    const result = resolveMissingSkills(['stale-2', 'stale-1'], registered);

    // Assert
    expect(result).toEqual([registered[1], registered[0]]);
  });

  it('throws RegistrationItemNotFoundError naming a missing id that is not registered', () => {
    // Act & Assert
    expect(() => resolveMissingSkills(['new-id'], registered)).toThrow(RegistrationItemNotFoundError);
    expect(() => resolveMissingSkills(['new-id'], registered)).toThrow('new-id');
  });

  it('throws for an unregistered missing id even when a stale registered id precedes it', () => {
    // Act & Assert
    expect(() => resolveMissingSkills(['stale-1', 'new-id'], registered)).toThrow(RegistrationItemNotFoundError);
    expect(() => resolveMissingSkills(['stale-1', 'new-id'], registered)).toThrow('new-id');
  });
});
