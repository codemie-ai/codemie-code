/**
 * Tests for the "why isn't this tracked and what do I run next" advice shown by `codemie proxy analytics`.
 * @group unit
 */
import { describe, expect, it } from 'vitest';

const CLAUDE = 'claude-code-otlp';
const CLI = 'copilot-cli-otlp';
const CHAT = 'copilot-chat-otlp';

describe('adviceForReason', () => {
  it('returns nothing for a tracked project and for reasons it does not know', async () => {
    const { adviceForReason } = await import('../analytics-hints.js');
    expect(adviceForReason(CLAUDE, 'tracked', '/work/a')).toBeUndefined();
    expect(adviceForReason(CLI, 'tracked', '/work/a')).toBeUndefined();
    expect(adviceForReason(CLAUDE, 'no-such-reason', '/work/a')).toBeUndefined();
    expect(adviceForReason('some-other-connector', 'disabled', '/work/a')).toBeUndefined();
  });

  describe('Claude Code (no connector flag in the suggested commands)', () => {
    it('not-in-allowlist points at connect --scope project, not at include', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(CLAUDE, 'not-in-allowlist', '/work/a');
      expect(advice?.description).toMatch(/Project-scope allowlist/);
      expect(advice?.nextStep).toContain('codemie proxy connect --claude-code-otlp --scope project');
      expect(advice?.nextStep).not.toContain('include');
    });

    it('disabled suggests enable without any connector flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'disabled', '/work/a')?.nextStep).toBe('codemie proxy analytics enable');
    });

    it('project-excluded suggests include with the path', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/a')?.nextStep).toBe('codemie proxy analytics include /work/a');
    });

    it('quotes a path that contains spaces', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/my project')?.nextStep).toBe(
        'codemie proxy analytics include "/work/my project"'
      );
    });

    it('preferences-corrupt explains how to recover', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'preferences-corrupt', '/work/a')?.description).toMatch(/corrupt/);
    });
  });

  describe.each([
    [CLI, '--copilot-cli-otlp'],
    [CHAT, '--copilot-chat-otlp'],
  ])('%s (suggested commands carry the connector flag)', (id, flag) => {
    it('analytics-disabled suggests enable with the flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'analytics-disabled', '/work/a')?.nextStep).toBe(`codemie proxy analytics enable ${flag}`);
    });

    it('project-excluded suggests include with the path and the flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'project-excluded', '/work/a')?.nextStep).toBe(`codemie proxy analytics include /work/a ${flag}`);
    });

    it('scope-untracked points at connect --scope project for that connector', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-untracked', '/work/a');
      expect(advice?.description).toMatch(/Project scope/);
      expect(advice?.nextStep).toContain(`codemie proxy connect ${flag} --scope project`);
    });

    it('scope-disabled says the connector is not connected and suggests connect', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-disabled', '/work/a');
      expect(advice?.description).toMatch(/not connected/);
      expect(advice?.nextStep).toBe(`codemie proxy connect ${flag}`);
    });

    it('scope-corrupt does not suggest a reconnect that would be refused', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-corrupt', '/work/a');
      expect(advice?.description).toMatch(/corrupt/);
      expect(advice?.nextStep).toMatch(/fix or delete/i);
    });

    it('preferences-corrupt is recognised', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'preferences-corrupt', '/work/a')?.description).toMatch(/corrupt/);
    });
  });
});
