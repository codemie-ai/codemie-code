/**
 * Tests for the "why isn't this tracked and what do I run next" advice shown by `codemie proxy analytics`.
 * @group unit
 */
import { describe, expect, it } from 'vitest';

const CLAUDE = 'claude-code-otlp';
const CLI = 'copilot-cli-otlp';
const CHAT = 'copilot-chat-otlp';

describe('coverage and resume notes', () => {
  it('names, per connector, the channels the settings do not control', async () => {
    const { unaffectedChannels, coverageNote } = await import('../analytics-hints.js');
    expect(unaffectedChannels(CLAUDE)).toMatch(/daily analytics collector/);
    expect(unaffectedChannels(CLAUDE)).toMatch(/codemie claude/);
    expect(unaffectedChannels(CLI)).toMatch(/copilot-cli/);
    expect(unaffectedChannels(CHAT)).toBe('the daily analytics collector');
    expect(coverageNote(CLAUDE)).toMatch(/^Controls the hook pipeline only — not affected: .+\.$/);
  });

  it('warns about reporting on resume for Claude and Copilot CLI, not for Copilot Chat', async () => {
    const { resumeNote } = await import('../analytics-hints.js');
    expect(resumeNote(CLAUDE)).toMatch(/transcripts/);
    expect(resumeNote(CLI)).toMatch(/whole-session usage/);
    expect(resumeNote(CHAT)).toBeUndefined();
  });

  it('knows the hooks-not-installed reason for Claude only', async () => {
    const { adviceForReason } = await import('../analytics-hints.js');
    expect(adviceForReason(CLAUDE, 'hooks-not-installed', '/work/a')).toEqual({
      description: 'the Claude Code hooks are not installed',
      command: 'codemie proxy connect --claude-code-otlp',
    });
    expect(adviceForReason(CLI, 'hooks-not-installed', '/work/a')).toBeUndefined();
  });
});

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
      expect(advice?.action).toContain('codemie proxy connect --claude-code-otlp --scope project');
      expect(advice?.command).toBeUndefined();
    });

    it('disabled suggests enable without any connector flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'disabled', '/work/a')?.command).toBe('codemie proxy analytics enable');
    });

    it('project-excluded suggests include with the path', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/a')?.command).toBe('codemie proxy analytics include /work/a');
    });

    it('quotes a path that contains spaces', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/my project')?.command).toBe(
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
      expect(adviceForReason(id, 'analytics-disabled', '/work/a')?.command).toBe(`codemie proxy analytics enable ${flag}`);
    });

    it('project-excluded suggests include with the path and the flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'project-excluded', '/work/a')?.command).toBe(`codemie proxy analytics include /work/a ${flag}`);
    });

    it('scope-untracked points at connect --scope project for that connector', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-untracked', '/work/a');
      expect(advice?.description).toMatch(/Project scope/);
      expect(advice?.action).toContain(`codemie proxy connect ${flag} --scope project`);
    });

    it('scope-disabled says the connector is not connected and suggests connect', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-disabled', '/work/a');
      expect(advice?.description).toMatch(/not connected/);
      expect(advice?.command).toBe(`codemie proxy connect ${flag}`);
    });

    it('scope-corrupt does not suggest a reconnect that would be refused', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-corrupt', '/work/a');
      expect(advice?.description).toMatch(/corrupt/);
      expect(advice?.action).toMatch(/fix or delete/i);
    });

    it('preferences-corrupt is recognised', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'preferences-corrupt', '/work/a')?.description).toMatch(/corrupt/);
    });
  });
});
