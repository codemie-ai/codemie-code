/**
 * Unit tests for mention utilities
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  parseMentions,
  hasMentions,
  extractMentionSlugs,
  highlightMention,
  highlightMentionsInText,
  parseAtMentionCommand,
  MENTION_TYPES,
  MENTION_PATTERNS,
  DEFAULT_MENTION_COLOR,
} from '../mentions.js';

beforeAll(() => {
  process.env.FORCE_COLOR = '1';
});

describe('mentions utilities', () => {
  describe('parseMentions', () => {
    it('should parse simple @mention', () => {
      const text = 'Hello @john-doe how are you?';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: MENTION_TYPES.SIMPLE,
        slug: 'john-doe',
        fullMatch: '@john-doe',
        startIndex: 6,
        endIndex: 15,
      });
    });

    it('should parse [Assistant @slug] pattern', () => {
      const text = 'Check [Assistant @code-reviewer] for help';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0]).toEqual({
        type: MENTION_TYPES.ASSISTANT_REFERENCE,
        slug: 'code-reviewer',
        fullMatch: '[Assistant @code-reviewer]',
        startIndex: 6,
        endIndex: 32,
      });
    });

    it('should parse multiple mentions', () => {
      const text = 'Ask @john and @jane about [Assistant @helper]';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(3);
      expect(mentions[0].slug).toBe('john');
      expect(mentions[1].slug).toBe('jane');
      expect(mentions[2].slug).toBe('helper');
    });

    it('should not duplicate mentions inside [Assistant @slug]', () => {
      const text = '[Assistant @code-reviewer] is great';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].type).toBe(MENTION_TYPES.ASSISTANT_REFERENCE);
    });

    it('should return empty array for text without mentions', () => {
      const text = 'No mentions here';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(0);
    });

    it('should handle mentions with hyphens', () => {
      const text = '@my-cool-assistant';
      const mentions = parseMentions(text);

      expect(mentions).toHaveLength(1);
      expect(mentions[0].slug).toBe('my-cool-assistant');
    });

    it('should sort mentions by position', () => {
      const text = 'End @third middle @second start @first';
      const mentions = parseMentions(text);

      expect(mentions[0].slug).toBe('third');
      expect(mentions[1].slug).toBe('second');
      expect(mentions[2].slug).toBe('first');
    });
  });

  describe('hasMentions', () => {
    it('should return true for simple @mention', () => {
      expect(hasMentions('Hello @john')).toBe(true);
    });

    it('should return true for [Assistant @slug] pattern', () => {
      expect(hasMentions('[Assistant @helper] says hi')).toBe(true);
    });

    it('should return false for text without mentions', () => {
      expect(hasMentions('No mentions here')).toBe(false);
    });

    it('should return false for incomplete patterns', () => {
      expect(hasMentions('Just an @ symbol')).toBe(false);
      expect(hasMentions('[Assistant without mention]')).toBe(false);
    });
  });

  describe('extractMentionSlugs', () => {
    it('should extract slug from simple mention', () => {
      const slugs = extractMentionSlugs('Hello @john-doe');

      expect(slugs).toEqual(['john-doe']);
    });

    it('should extract multiple slugs', () => {
      const slugs = extractMentionSlugs('Ask @john and @jane');

      expect(slugs).toEqual(['john', 'jane']);
    });

    it('should extract slug from [Assistant @slug]', () => {
      const slugs = extractMentionSlugs('[Assistant @code-reviewer]');

      expect(slugs).toEqual(['code-reviewer']);
    });

    it('should return empty array for no mentions', () => {
      const slugs = extractMentionSlugs('No mentions');

      expect(slugs).toEqual([]);
    });

    it('should handle mixed mention types', () => {
      const slugs = extractMentionSlugs('@simple [Assistant @reference] @another');

      expect(slugs).toEqual(['simple', 'reference', 'another']);
    });
  });

  describe('highlightMention', () => {
    it('should return text', () => {
      const result = highlightMention('@test');

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept custom color options', () => {
      const result = highlightMention('@test', {
        color: { r: 255, g: 0, b: 0 },
      });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept bold styling option', () => {
      const result = highlightMention('@test', { bold: true });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept underline styling option', () => {
      const result = highlightMention('@test', { underline: true });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should accept multiple style options', () => {
      const result = highlightMention('@test', {
        bold: true,
        underline: true,
      });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('highlightMentionsInText', () => {
    it('should process simple mentions', () => {
      const result = highlightMentionsInText('Hello @john-doe');

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should process [Assistant @slug] patterns', () => {
      const result = highlightMentionsInText('[Assistant @code-reviewer]');

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should process multiple mentions', () => {
      const result = highlightMentionsInText('Ask @john and @jane');

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });

    it('should not modify text without mentions', () => {
      const text = 'No mentions here';
      const result = highlightMentionsInText(text);

      expect(result).toBe(text);
    });

    it('should accept custom options', () => {
      const result = highlightMentionsInText('Hello @test', { bold: true });

      expect(result).toBeTruthy();
      expect(typeof result).toBe('string');
    });
  });

  describe('parseAtMentionCommand', () => {
    it('should parse @slug followed by message', () => {
      const result = parseAtMentionCommand('@helper Please help me');

      expect(result).toEqual({
        assistantSlug: 'helper',
        message: 'Please help me',
      });
    });

    it('should parse @slug with multiline message', () => {
      const result = parseAtMentionCommand('@helper Line 1\nLine 2\nLine 3');

      expect(result).toEqual({
        assistantSlug: 'helper',
        message: 'Line 1\nLine 2\nLine 3',
      });
    });

    it('should return null for text without @mention at start', () => {
      const result = parseAtMentionCommand('Hello @helper');

      expect(result).toBeNull();
    });

    it('should return null for @mention without message', () => {
      const result = parseAtMentionCommand('@helper');

      expect(result).toBeNull();
    });

    it('should parse @slug with hyphenated name', () => {
      const result = parseAtMentionCommand('@code-reviewer Check this code');

      expect(result).toEqual({
        assistantSlug: 'code-reviewer',
        message: 'Check this code',
      });
    });

    it('should handle leading/trailing whitespace in message', () => {
      const result = parseAtMentionCommand('@helper   Message with spaces   ');

      expect(result?.assistantSlug).toBe('helper');
      expect(result?.message).toBe('Message with spaces   ');
    });
  });

  describe('constants', () => {
    it('should export MENTION_TYPES', () => {
      expect(MENTION_TYPES.SIMPLE).toBe('simple');
      expect(MENTION_TYPES.ASSISTANT_REFERENCE).toBe('assistant_reference');
    });

    it('should export DEFAULT_MENTION_COLOR', () => {
      expect(DEFAULT_MENTION_COLOR).toEqual({
        r: 177,
        g: 185,
        b: 249,
      });
    });

    it('should export MENTION_PATTERNS as regex', () => {
      expect(MENTION_PATTERNS.SIMPLE).toBeInstanceOf(RegExp);
      expect(MENTION_PATTERNS.ASSISTANT_REFERENCE).toBeInstanceOf(RegExp);
      expect(MENTION_PATTERNS.AT_START).toBeInstanceOf(RegExp);
    });

    it('MENTION_PATTERNS.SIMPLE should match @slug', () => {
      const regex = new RegExp(MENTION_PATTERNS.SIMPLE.source, 'g');
      const match = regex.exec('@test-slug');

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('test-slug');
    });

    it('MENTION_PATTERNS.ASSISTANT_REFERENCE should match [Assistant @slug]', () => {
      const regex = new RegExp(MENTION_PATTERNS.ASSISTANT_REFERENCE.source, 'g');
      const match = regex.exec('[Assistant @test-slug]');

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('@test-slug');
    });

    it('MENTION_PATTERNS.AT_START should match @slug at start', () => {
      const regex = new RegExp(MENTION_PATTERNS.AT_START.source, MENTION_PATTERNS.AT_START.flags);
      const match = regex.exec('@helper Message here');

      expect(match).not.toBeNull();
      expect(match?.[1]).toBe('helper');
      expect(match?.[2]).toBe('Message here');
    });
  });
});
