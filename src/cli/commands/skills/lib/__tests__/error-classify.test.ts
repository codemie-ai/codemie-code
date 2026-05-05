/**
 * Unit tests for the error classifier.
 *
 * Spec §8.6 lists the codes the wrapper must produce. We verify each branch
 * fires for stable upstream wording, and that novel wording falls back to
 * `unknown` rather than guessing.
 */

import { describe, expect, it } from 'vitest';
import { classifySkillError } from '../error-classify.js';

describe('classifySkillError', () => {
  it('returns "interrupted" for SIGINT signal', () => {
    expect(
      classifySkillError({ result: { code: 130, stdout: '', stderr: '', signal: 'SIGINT' } })
    ).toBe('interrupted');
  });

  it('returns "interrupted" for exit code 130 even without signal', () => {
    expect(
      classifySkillError({ result: { code: 130, stdout: '', stderr: '', signal: null } })
    ).toBe('interrupted');
  });

  it('returns "interrupted" for SIGTERM', () => {
    expect(
      classifySkillError({ result: { code: 143, stdout: '', stderr: '', signal: 'SIGTERM' } })
    ).toBe('interrupted');
  });

  it('detects egress block from CODEMIE_SKILL_EGRESS_BLOCKED marker', () => {
    expect(
      classifySkillError({
        result: {
          code: 1,
          stdout: '',
          stderr: 'Error: Request to add-skill.vercel.sh blocked by codemie skills wrapper (CODEMIE_SKILL_EGRESS_BLOCKED)',
          signal: null,
        },
      })
    ).toBe('egress_blocked');
  });

  it('detects egress block from add-skill.vercel.sh hostname mention alone', () => {
    expect(
      classifySkillError({
        result: {
          code: 1,
          stdout: '',
          stderr: 'fetch failed for add-skill.vercel.sh',
          signal: null,
        },
      })
    ).toBe('egress_blocked');
  });

  it('detects skill_not_found from stable upstream wording', () => {
    for (const message of ['skill not found', 'No such skill', 'Could not find skill: foo']) {
      expect(
        classifySkillError({
          result: { code: 1, stdout: '', stderr: message, signal: null },
        })
      ).toBe('skill_not_found');
    }
  });

  it('detects git_fetch_failed for git clone / fetch / network errors', () => {
    for (const message of [
      'git clone failed',
      'fatal: unable to access https://github.com/x/y',
      'could not resolve host github.com',
      'remote: not found',
    ]) {
      expect(
        classifySkillError({
          result: { code: 1, stdout: '', stderr: message, signal: null },
        })
      ).toBe('git_fetch_failed');
    }
  });

  it('returns unknown for novel error wording', () => {
    expect(
      classifySkillError({
        result: { code: 1, stdout: '', stderr: 'whatever new wording', signal: null },
      })
    ).toBe('unknown');
  });

  it('reads the haystack from the error message when no result is provided', () => {
    expect(
      classifySkillError({ error: new Error('CODEMIE_SKILL_EGRESS_BLOCKED while POSTing audit') })
    ).toBe('egress_blocked');
  });

  it('priority: egress beats not_found beats git_fetch', () => {
    // If multiple markers are present, egress should win because it represents
    // the most specific, unambiguous block reason.
    const stderr = 'add-skill.vercel.sh skill not found git clone failed';
    expect(
      classifySkillError({ result: { code: 1, stdout: '', stderr, signal: null } })
    ).toBe('egress_blocked');
  });

  it('treats string error input as message text', () => {
    expect(classifySkillError({ error: 'add-skill.vercel.sh request blocked' })).toBe(
      'egress_blocked'
    );
  });
});
