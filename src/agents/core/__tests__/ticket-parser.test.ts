import { describe, it, expect } from 'vitest';
import { extractTicketMarker, extractTicketMentions, parsePromptFields } from '../ticket-parser.js';

describe('ticket-parser', () => {
  describe('extractTicketMentions', () => {
    it('returns every distinct match upper-cased in first-seen order', () => {
      expect(extractTicketMentions('xyz-3 then ABC-12, abc-12 and XYZ-3', 20)).toEqual(['XYZ-3', 'ABC-12']);
    });

    it('stops at the limit', () => {
      expect(extractTicketMentions('A1-1 B2-2 C3-3', 2)).toEqual(['A1-1', 'B2-2']);
    });

    it('returns an empty list for empty text, no match, or a non-positive limit', () => {
      expect(extractTicketMentions('', 20)).toEqual([]);
      expect(extractTicketMentions('nothing here', 20)).toEqual([]);
      expect(extractTicketMentions('ABC-1', 0)).toEqual([]);
    });

    it('does not corrupt matching across repeated calls', () => {
      expect(extractTicketMentions('ping ABC-42', 5)).toEqual(['ABC-42']);
      expect(extractTicketMentions('ping ABC-42', 5)).toEqual(['ABC-42']);
    });
  });

  describe('extractTicketMarker', () => {
    it('returns the upper-cased id of a marker phrase', () => {
      expect(extractTicketMarker('please start on ticket #abc-7')).toBe('ABC-7');
    });

    it('returns an empty string without a marker phrase or for empty text', () => {
      expect(extractTicketMarker('see ABC-7')).toBe('');
      expect(extractTicketMarker('')).toBe('');
    });
  });

  describe('parsePromptFields', () => {
    it('returns the full length of the prompt', () => {
      expect(parsePromptFields('x'.repeat(450)).prompt_length).toBe(450);
    });

    it('combines marker and deduped mentions', () => {
      expect(parsePromptFields('story: abc-12 and see XYZ-3, abc-12')).toMatchObject({
        story_marker: 'ABC-12',
        ticket_mentions: ['ABC-12', 'XYZ-3'],
      });
    });

    it('caps the mentions at 20', () => {
      const prompt = Array.from({ length: 30 }, (_, i) => `ABC-${i + 1}`).join(' ');
      const { ticket_mentions } = parsePromptFields(prompt);
      expect(ticket_mentions).toHaveLength(20);
      expect(ticket_mentions[19]).toBe('ABC-20');
    });

    it('returns empty values for an empty prompt', () => {
      expect(parsePromptFields('')).toEqual({ story_marker: '', ticket_mentions: [], prompt_length: 0 });
    });
  });
});
