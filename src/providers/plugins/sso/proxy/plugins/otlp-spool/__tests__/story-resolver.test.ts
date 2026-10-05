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
  });
});
