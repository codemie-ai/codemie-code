/**
 * Tests for the "why isn't this tracked and what do I run next" advice shown by `codemie proxy analytics`.
 * @group unit
 */
import { BACKEND_REMEDIES } from '../doctor/backend-plan.js';
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
    expect(coverageNote(CLI)).toMatch(/^Controls the hook pipeline only — not affected: .+\.$/);
    expect(coverageNote(CHAT)).toBe('Controls the hook pipeline only — not affected: the daily analytics collector.');
    expect(coverageNote('some-other-connector')).toMatch(/^Controls the hook pipeline only — not affected: .+\.$/);
  });

  it('Claude disable covers Claude Desktop chats; exclude says they are not affected', async () => {
    const { unaffectedChannels, coverageNote } = await import('../analytics-hints.js');
    expect(coverageNote(CLAUDE, 'disable')).toMatch(/^Controls Claude Code hooks, Cowork and Claude Desktop chats \(metrics and conversation sync\) — not affected: .+\.$/);
    expect(coverageNote(CLAUDE, 'disable')).not.toContain('hook pipeline only');
    expect(coverageNote(CLAUDE)).toBe(coverageNote(CLAUDE, 'disable'));
    expect(unaffectedChannels(CLAUDE, 'disable')).not.toContain('Claude Desktop');
    expect(coverageNote(CLAUDE, 'exclude')).toMatch(/^Controls the hook pipeline and Cowork only — not affected: Claude Desktop chats \(exclusions are not applied to them\), .+\.$/);
    expect(unaffectedChannels(CLAUDE, 'exclude')).toMatch(/^Claude Desktop chats \(exclusions are not applied to them\), the daily analytics collector/);
  });

  it('the backend warns about reporting on resume for Claude and Copilot CLI, not for Copilot Chat', () => {
    expect(BACKEND_REMEDIES.resumeNote(CLAUDE)).toBe(
      'Usage already written to session transcripts while collection was off may be reported now that it is back on.'
    );
    expect(BACKEND_REMEDIES.resumeNote(CLI)).toBe(
      'A Copilot CLI session that was running while collection was off reports its whole-session usage when it ends.'
    );
    expect(BACKEND_REMEDIES.resumeNote(CHAT)).toBeUndefined();
  });

  it.each([CLAUDE, CLI, CHAT])('the local mode says on resume, for %s, that an excluded session stays out', async (id) => {
    const { LOCAL_REMEDIES } = await import('../../shared/analytics-collection/local-doctor.js');
    expect(LOCAL_REMEDIES.resumeNote(id)).toBe(
      'A session that fired an event while collection was off stays out; sessions started from now on are gathered.'
    );
  });

  it('knows the hooks-not-installed reason for Claude only', async () => {
    const { adviceForReason } = await import('../analytics-hints.js');
    expect(adviceForReason(CLAUDE, 'hooks-not-installed', '/work/a', BACKEND_REMEDIES)).toEqual({
      description: 'the Claude Code hooks are not installed',
      command: 'codemie proxy connect --claude-otlp',
    });
    expect(adviceForReason(CLI, 'hooks-not-installed', '/work/a', BACKEND_REMEDIES)).toBeUndefined();
  });
});

describe('adviceForReason', () => {
  it('returns nothing for a tracked project and for reasons it does not know', async () => {
    const { adviceForReason } = await import('../analytics-hints.js');
    expect(adviceForReason(CLAUDE, 'tracked', '/work/a', BACKEND_REMEDIES)).toBeUndefined();
    expect(adviceForReason(CLI, 'tracked', '/work/a', BACKEND_REMEDIES)).toBeUndefined();
    expect(adviceForReason(CLAUDE, 'no-such-reason', '/work/a', BACKEND_REMEDIES)).toBeUndefined();
    expect(adviceForReason('some-other-connector', 'disabled', '/work/a', BACKEND_REMEDIES)).toBeUndefined();
  });

  describe('Claude Code (suggested analytics commands carry --claude-otlp)', () => {
    it('not-in-allowlist points at connect --scope project, not at include', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(CLAUDE, 'not-in-allowlist', '/work/a', BACKEND_REMEDIES);
      expect(advice?.description).toMatch(/Project-scope allowlist/);
      expect(advice?.action).toContain('codemie proxy connect --claude-otlp --scope project');
      expect(advice?.command).toBeUndefined();
    });

    it('disabled suggests enable for Claude alone: --claude-otlp, never the flagless fan-out over every connector', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'disabled', '/work/a', BACKEND_REMEDIES)?.command).toBe('codemie proxy analytics enable --claude-otlp');
    });

    it('project-excluded suggests include with the path, for Claude alone', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/a', BACKEND_REMEDIES)?.command).toBe('codemie proxy analytics include /work/a --claude-otlp');
    });

    it('quotes a path that contains spaces', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'project-excluded', '/work/my project', BACKEND_REMEDIES)?.command).toBe(
        'codemie proxy analytics include "/work/my project" --claude-otlp'
      );
    });

    it('preferences-corrupt explains how to recover', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(CLAUDE, 'preferences-corrupt', '/work/a', BACKEND_REMEDIES)?.description).toMatch(/corrupt/);
    });

    it('allowlist-unresolved names the settings file that cannot be applied, no path and no status command', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(CLAUDE, 'allowlist-unresolved', '/work/a', BACKEND_REMEDIES);
      expect(advice).toEqual({
        description: 'the Project-scope allowlist cannot be applied',
        action: 'fix the Claude Code settings file: it cannot be read, does not parse, or its project filter is not a list of absolute paths',
      });
      expect(advice?.description).not.toContain('~/');
      expect(advice?.action).not.toContain('~/');
    });
  });

  describe.each([
    [CLI],
    [CHAT],
  ])('%s (suggested commands carry the Copilot vendor flag)', (id) => {
    it('analytics-disabled suggests enable with the flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'analytics-disabled', '/work/a', BACKEND_REMEDIES)?.command).toBe('codemie proxy analytics enable --copilot-otlp');
    });

    it('project-excluded suggests include with the path and the flag', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'project-excluded', '/work/a', BACKEND_REMEDIES)?.command).toBe('codemie proxy analytics include /work/a --copilot-otlp');
    });

    it('scope-untracked points at connect --scope project for that connector', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-untracked', '/work/a', BACKEND_REMEDIES);
      expect(advice?.description).toMatch(/Project scope/);
      expect(advice?.action).toContain('codemie proxy connect --copilot-otlp --scope project');
    });

    it('scope-disabled says the connector is not connected and suggests connect', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-disabled', '/work/a', BACKEND_REMEDIES);
      expect(advice?.description).toMatch(/not connected/);
      expect(advice?.command).toBe('codemie proxy connect --copilot-otlp');
    });

    it('scope-corrupt does not suggest a reconnect that would be refused', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      const advice = adviceForReason(id, 'scope-corrupt', '/work/a', BACKEND_REMEDIES);
      expect(advice?.description).toMatch(/corrupt/);
      expect(advice?.action).toBe('fix or delete ~/.codemie/copilot-connectors.json, then reconnect');
    });

    it('preferences-corrupt is recognised', async () => {
      const { adviceForReason } = await import('../analytics-hints.js');
      expect(adviceForReason(id, 'preferences-corrupt', '/work/a', BACKEND_REMEDIES)?.description).toMatch(/corrupt/);
    });
  });
});

describe('adviceForReason with the local mode\'s remedies', () => {
  it('names codemie analytics sync install where a connect is the fix, and never proxy connect', async () => {
    const { adviceForReason } = await import('../analytics-hints.js');
    const { LOCAL_REMEDIES } = await import('../../shared/analytics-collection/local-doctor.js');
    const reasons = ['disabled', 'project-excluded', 'not-in-allowlist', 'hooks-not-installed', 'preferences-corrupt',
      'analytics-disabled', 'scope-untracked', 'scope-disabled', 'scope-corrupt'];
    const advice = [CLAUDE, CLI, CHAT].flatMap((id) => reasons.map((reason) => adviceForReason(id, reason, '/work/a', LOCAL_REMEDIES)));
    const texts = advice.flatMap((entry) => (entry ? [entry.command ?? '', entry.action ?? ''] : []));

    expect(adviceForReason(CLAUDE, 'hooks-not-installed', '/work/a', LOCAL_REMEDIES)?.command).toBe('codemie analytics sync install');
    expect(texts.filter((text) => /proxy (connect|disconnect)/.test(text))).toEqual([]);
    expect(texts.filter((text) => /reconnect/.test(text))).toEqual([]);
  });

  it.each([CLI, CHAT])('%s scope-corrupt names the install as the way to set the connector up again', async (id) => {
    const { adviceForReason } = await import('../analytics-hints.js');
    const { LOCAL_REMEDIES } = await import('../../shared/analytics-collection/local-doctor.js');

    expect(adviceForReason(id, 'scope-corrupt', '/work/a', LOCAL_REMEDIES)?.action)
      .toBe('fix or delete ~/.codemie/copilot-connectors.json, then run `codemie analytics sync install`');
  });
});
