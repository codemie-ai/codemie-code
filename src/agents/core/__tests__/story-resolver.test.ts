import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_KEY = 'SDLC_ANALYTICS_STORY_ID';

async function makeTempProjectDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'otlp-story-resolver-'));
}

async function writeAnalyticsLocalJson(cwd: string, data: Record<string, unknown>): Promise<void> {
  const dir = join(cwd, '.claude');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'analytics.local.json'), JSON.stringify(data), 'utf-8');
}

describe('story-resolver', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    delete process.env[ENV_KEY];
    for (const dir of tempDirs.splice(0)) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('resolveExplicitStory', () => {
    it('prefers the env var over the file when both are set', async () => {
      const { resolveExplicitStory } = await import('../story-resolver.js');

      const cwd = await makeTempProjectDir();
      tempDirs.push(cwd);
      await writeAnalyticsLocalJson(cwd, { storyId: 'FILE-1' });
      process.env[ENV_KEY] = 'ENV-1';

      const result = await resolveExplicitStory(cwd);

      expect(result).toEqual({ storyId: 'ENV-1', storySource: 'explicit' });
    });

    it('falls back to the analytics.local.json file when the env var is unset', async () => {
      const { resolveExplicitStory } = await import('../story-resolver.js');

      const cwd = await makeTempProjectDir();
      tempDirs.push(cwd);
      await writeAnalyticsLocalJson(cwd, { storyId: 'FILE-1' });
      delete process.env[ENV_KEY];

      const result = await resolveExplicitStory(cwd);

      expect(result).toEqual({ storyId: 'FILE-1', storySource: 'explicit' });
    });

    it('returns null when neither the env var nor the file is set', async () => {
      const { resolveExplicitStory } = await import('../story-resolver.js');

      const cwd = await makeTempProjectDir();
      tempDirs.push(cwd);
      delete process.env[ENV_KEY];

      const result = await resolveExplicitStory(cwd);

      expect(result).toBeNull();
    });

    it('returns null when the file is malformed JSON (never throws)', async () => {
      const { resolveExplicitStory } = await import('../story-resolver.js');

      const cwd = await makeTempProjectDir();
      tempDirs.push(cwd);
      const dir = join(cwd, '.claude');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'analytics.local.json'), '{not valid json', 'utf-8');
      delete process.env[ENV_KEY];

      const result = await resolveExplicitStory(cwd);

      expect(result).toBeNull();
    });
  });

  describe('resolveBranchStory', () => {
    it("extracts EPMCDME-15301 from 'feature/epmcdme-15301-foo' uppercased", async () => {
      const { resolveBranchStory } = await import('../story-resolver.js');

      const result = resolveBranchStory('feature/epmcdme-15301-foo');

      expect(result).toEqual({ storyId: 'EPMCDME-15301', storySource: 'branch' });
    });

    it('returns null for a branch with no ticket-shaped substring', async () => {
      const { resolveBranchStory } = await import('../story-resolver.js');

      const result = resolveBranchStory('just-some-branch-name');

      expect(result).toBeNull();
    });

    it(
      'returns null for a leading-digit identifier where the negative lookbehind blocks the only possible match start (verified: TICKET_RE requires the match to start on a letter, and the lookbehind forbids an alphanumeric char immediately before that start)',
      async () => {
        const { resolveBranchStory } = await import('../story-resolver.js');

        const result = resolveBranchStory('1ABC-123');

        expect(result).toBeNull();
      }
    );

    it(
      'matches ABC-123 inside "ABC-123X" (verified actual regex behavior: the trailing (?!\\d) lookahead only blocks a FOLLOWING DIGIT, not a following letter, so "ABC-123X" is NOT a word-boundary case the literal regex rejects)',
      async () => {
        const { resolveBranchStory } = await import('../story-resolver.js');

        const result = resolveBranchStory('ABC-123X');

        expect(result).toEqual({ storyId: 'ABC-123', storySource: 'branch' });
      }
    );

    it('does not corrupt matching across repeated calls (fresh RegExp per call, no shared lastIndex state)', async () => {
      const { resolveBranchStory } = await import('../story-resolver.js');

      const first = resolveBranchStory('feature/epmcdme-15301-foo');
      const second = resolveBranchStory('feature/epmcdme-15301-foo');

      expect(first).toEqual({ storyId: 'EPMCDME-15301', storySource: 'branch' });
      expect(second).toEqual({ storyId: 'EPMCDME-15301', storySource: 'branch' });
    });

    it('is unaffected by the prompt-only filters: prefix keys and hex-looking suffixes still resolve (AC6, AC12)', async () => {
      const { resolveBranchStory } = await import('../story-resolver.js');

      const expectBranch = (branch: string, storyId: string): void => {
        expect(resolveBranchStory(branch), branch).toEqual({ storyId, storySource: 'branch' });
      };
      expectBranch('feature/EPMCDME-16013-x', 'EPMCDME-16013');
      expectBranch('feature/epmcdme-16013-x', 'EPMCDME-16013');
      expectBranch('feature/ABC-1234-fade', 'ABC-1234');
      expectBranch('feature/ISO-77-login', 'ISO-77');
      expectBranch('feature/GPT-4-support', 'GPT-4');
      expectBranch('feature/gpt-4o-mini-2024-07-18', 'GPT-4');
    });

    it('still drops a UUID-shaped branch name', async () => {
      const { resolveBranchStory } = await import('../story-resolver.js');

      expect(resolveBranchStory('feature/38a8bb8d-39d4-49b2-a43e-20c8e1f66c87')).toBeNull();
    });
  });

  describe('resolveMarkerStory', () => {
    it("matches the 'story: X' marker shape, uppercased", async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('story: EPMCDME-999');

      expect(result).toEqual({ storyId: 'EPMCDME-999', storySource: 'marker' });
    });

    it("matches the 'ticket #X' marker shape, uppercased", async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('ticket #EPMCDME-999');

      expect(result).toEqual({ storyId: 'EPMCDME-999', storySource: 'marker' });
    });

    it('matches the marker word case-insensitively (STORY:) and uppercases a lowercase id', async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('STORY: epmcdme-999');

      expect(result).toEqual({ storyId: 'EPMCDME-999', storySource: 'marker' });
    });

    it('matches a marker embedded in a longer prompt', async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('please fix the bug, story: EPMCDME-999, thanks');

      expect(result).toEqual({ storyId: 'EPMCDME-999', storySource: 'marker' });
    });

    it('returns null when no marker phrase is present', async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('just fix the bug please, no ticket mentioned');

      expect(result).toBeNull();
    });

    it('returns null for empty prompt text', async () => {
      const { resolveMarkerStory } = await import('../story-resolver.js');

      const result = resolveMarkerStory('');

      expect(result).toBeNull();
    });
  });

  describe('resolveMentionStory', () => {
    it('matches a bare ticket-shaped mention anywhere in the text, uppercased', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      const result = resolveMentionStory('can you look into ABC-42 when you get a chance');

      expect(result).toEqual({ storyId: 'ABC-42', storySource: 'mention' });
    });

    it('returns null when no ticket-shaped substring exists', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      const result = resolveMentionStory('no ticket here, just a plain request');

      expect(result).toBeNull();
    });

    it('returns null for empty prompt text', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      const result = resolveMentionStory('');

      expect(result).toBeNull();
    });

    it('does not corrupt matching across repeated calls (fresh RegExp per call)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      const first = resolveMentionStory('ping on ABC-42 please');
      const second = resolveMentionStory('ping on ABC-42 please');

      expect(first).toEqual({ storyId: 'ABC-42', storySource: 'mention' });
      expect(second).toEqual({ storyId: 'ABC-42', storySource: 'mention' });
    });

    const UUID = '38a8bb8d-39d4-49b2-a43e-20c8e1f66c87';

    it('resolves no story for UUIDs, tails and listed tokens (AC1-AC4)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      for (const prompt of [
        `look at session ${UUID}`,
        `session-${UUID}`,
        `agent-${UUID}`,
        `${UUID}-v2`,
        '5da24492-df51-48cd-aeac-a43e8c1f66c8-2',
        'a43e8c1f66c8-123',
        'explain what sha-256 and utf-8 are',
        'try grok-4 today',
      ]) {
        expect(resolveMentionStory(prompt), prompt).toBeNull();
      }
    });

    it('still resolves a real key, also after noise (AC5)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      for (const prompt of [
        'check EPMCDME-15301 please',
        'sha-256 then EPMCDME-15301',
        `${UUID} then EPMCDME-15301`,
        `${UUID}-2 then EPMCDME-15301`,
        'try grok-4 for EPMCDME-15301',
      ]) {
        expect(resolveMentionStory(prompt), prompt).toEqual({ storyId: 'EPMCDME-15301', storySource: 'mention' });
      }
    });

    it('drops full model ids and keeps a key not glued to them (AC10, AC11)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      expect(resolveMentionStory('switch to gpt-4o-mini-2024-07-18')).toBeNull();
      expect(resolveMentionStory('use gemini-2.0-flash-001')).toBeNull();
      expect(resolveMentionStory('gpt-4o-EPMCDME-15301')).toBeNull();
      expect(resolveMentionStory('gpt-4o_EPMCDME-15301')).toEqual({
        storyId: 'EPMCDME-15301',
        storySource: 'mention',
      });
      expect(resolveMentionStory('use gemini-2.0-flash-001, EPMCDME-15301')).toEqual({
        storyId: 'EPMCDME-15301',
        storySource: 'mention',
      });
    });

    it('prefers an upper-case key over lower-case ones (AC13)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      const expectStory = (prompt: string, storyId: string): void => {
        expect(resolveMentionStory(prompt), prompt).toEqual({ storyId, storySource: 'mention' });
      };
      expectStory('use node-20 for EPMCDME-15301', 'EPMCDME-15301');
      expectStory('check epmcdme-15301', 'EPMCDME-15301');
      expectStory('use node-20 or java-17', 'NODE-20');
      expectStory('node-20 then epmcdme-15301', 'NODE-20');
      expectStory('Node-20 then EPMCDME-1', 'EPMCDME-1');
      expectStory('a1-1 then EPMCDME-1', 'EPMCDME-1');
      expectStory('A1-1 then EPMCDME-1', 'A1-1');
      expectStory('RFC-2616 for EPMCDME-15301', 'RFC-2616');
      expectStory('sha-256 then epmcdme-1', 'EPMCDME-1');
    });

    it('accepts that an upper-case off-list key beats a lower-case real key (AR-8 consequence)', async () => {
      const { resolveMentionStory } = await import('../story-resolver.js');

      // Accepted behaviour of the upper-case preference: `PR-123` is upper-case, `epmcdme-15301` is not.
      expect(resolveMentionStory('fix epmcdme-15301, see PR-123')).toEqual({
        storyId: 'PR-123',
        storySource: 'mention',
      });
    });
  });

  describe('resolveStoryFor', () => {
    it('prefers explicit over marker, branch and mention', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');
      process.env[ENV_KEY] = 'EXP-1';

      const result = await resolveStoryFor({
        cwd: '/nonexistent',
        branch: 'feature/BR-2',
        prompt: 'story: MK-3 and also ME-4',
      });

      expect(result).toEqual({ storyId: 'EXP-1', storySource: 'explicit' });
    });

    it('prefers marker over branch and mention', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');

      const result = await resolveStoryFor({
        cwd: '/nonexistent',
        branch: 'feature/BR-2',
        prompt: 'story: MK-3 and also ME-4',
      });

      expect(result).toEqual({ storyId: 'MK-3', storySource: 'marker' });
    });

    it('prefers branch over mention', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');

      const result = await resolveStoryFor({ cwd: '/nonexistent', branch: 'feature/BR-2', prompt: 'look at ME-4' });

      expect(result).toEqual({ storyId: 'BR-2', storySource: 'branch' });
    });

    it('falls back to mention when nothing else resolves', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');

      const result = await resolveStoryFor({ cwd: '/nonexistent', branch: 'main', prompt: 'look at ME-4' });

      expect(result).toEqual({ storyId: 'ME-4', storySource: 'mention' });
    });

    it('keeps the marker tier unfiltered and resolves model ids and UUIDs correctly through the chain', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');
      const cwd = '/nonexistent';

      expect(await resolveStoryFor({ cwd, branch: 'main', prompt: 'story: ABC-5 do nothing' })).toEqual({
        storyId: 'ABC-5',
        storySource: 'marker',
      });
      expect(await resolveStoryFor({ cwd, branch: 'main', prompt: 'story: ISO-77' })).toEqual({
        storyId: 'ISO-77',
        storySource: 'marker',
      });
      expect(
        await resolveStoryFor({ cwd, branch: 'main', prompt: 'look at session 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87' })
      ).toBeNull();
      expect(await resolveStoryFor({ cwd, branch: 'main', prompt: 'fix ABC-1234-added' })).toEqual({
        storyId: 'ABC-1234',
        storySource: 'mention',
      });
      expect(await resolveStoryFor({ cwd, branch: 'main', prompt: 'gpt-4o-mini-2024-07-18 then EPMCDME-15301' })).toEqual({
        storyId: 'EPMCDME-15301',
        storySource: 'mention',
      });
      expect(await resolveStoryFor({ cwd, branch: 'main', prompt: 'gpt-4o-2024-08-06' })).toBeNull();
    });

    it('ignores marker and mention tiers without a prompt', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');

      expect(await resolveStoryFor({ cwd: '/nonexistent', branch: 'main' })).toBeNull();
      expect(await resolveStoryFor({ cwd: '/nonexistent', branch: 'feature/BR-2' })).toEqual({
        storyId: 'BR-2',
        storySource: 'branch',
      });
    });

    it('reads the explicit story from a configurable file path', async () => {
      const { resolveStoryFor } = await import('../story-resolver.js');
      const cwd = await makeTempProjectDir();
      tempDirs.push(cwd);
      await mkdir(join(cwd, '.other'), { recursive: true });
      await writeFile(join(cwd, '.other', 'story.json'), JSON.stringify({ storyId: 'CFG-9' }), 'utf-8');

      const result = await resolveStoryFor({ cwd, explicitConfigPath: ['.other', 'story.json'] });
      const withDefault = await resolveStoryFor({ cwd });

      expect(result).toEqual({ storyId: 'CFG-9', storySource: 'explicit' });
      expect(withDefault).toBeNull();
    });
  });
});
