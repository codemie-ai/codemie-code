import { describe, expect, it } from 'vitest';
import {
  isClaudeServableDeployment,
  rankDeploymentsByRecency,
  resolveClaudeDeployment,
} from '../claude-model-resolver.js';

describe('resolveClaudeDeployment', () => {
  it.each([
    // [description, requested, available, expectedModel, expectedKind]
    ['exact match', 'claude-sonnet-4-6', ['claude-sonnet-4-6'], 'claude-sonnet-4-6', 'exact'],
    ['family-first request, version-first tenant (the bug this module exists to fix)',
      'claude-opus-5', ['claude-5-opus'], 'claude-5-opus', 'resolved'],
    ['version-first request, family-first tenant', 'claude-haiku-4-5', ['claude-4-5-haiku'], 'claude-4-5-haiku', 'resolved'],
    ['dated family-first tenant (EPAM)', 'claude-opus-4-5', ['claude-opus-4-5-20251101'], 'claude-opus-4-5-20251101', 'resolved'],
    ['single-number family against a dated tenant id (concatenated date)',
      'claude-opus-5', ['claude-opus-5-20260101'], 'claude-opus-5-20260101', 'resolved'],
    ['no match at all', 'glm-5', ['claude-sonnet-4-6'], 'glm-5', 'unresolved'],
    ['github-copilot-claude-* never matches a Claude family',
      'claude-sonnet-4-6', ['github-copilot-claude-sonnet-4-5'], 'claude-sonnet-4-6', 'unresolved'],
    ['prefers the non-vertex, most recently dated match among same-identity candidates',
      'claude-opus-4-6', ['claude-opus-4-6-vertex', 'claude-opus-4-6-2026-01-05'], 'claude-opus-4-6-2026-01-05', 'resolved'],
  ] as const)('%s', (_desc, requested, available, expectedModel, expectedKind) => {
    const resolution = resolveClaudeDeployment(requested, [...available]);
    expect(resolution.model).toBe(expectedModel);
    expect(resolution.kind).toBe(expectedKind);
  });
});

describe('isClaudeServableDeployment', () => {
  it('accepts claude-* deployments', () => {
    expect(isClaudeServableDeployment('claude-5-opus')).toBe(true);
  });

  it('rejects github-copilot-claude-* deployments', () => {
    expect(isClaudeServableDeployment('github-copilot-claude-sonnet-4-5')).toBe(false);
  });

  it('rejects non-Claude deployments', () => {
    expect(isClaudeServableDeployment('gpt-5.6-luna')).toBe(false);
  });
});

describe('rankDeploymentsByRecency', () => {
  it('ranks a non-vertex, more recently dated id ahead of an older or vertex one', () => {
    expect(rankDeploymentsByRecency([
      'claude-opus-4-6-vertex',
      'claude-opus-4-6-20260101',
      'claude-opus-4-6-20260315',
    ])).toEqual([
      'claude-opus-4-6-20260315',
      'claude-opus-4-6-20260101',
      'claude-opus-4-6-vertex',
    ]);
  });
});
