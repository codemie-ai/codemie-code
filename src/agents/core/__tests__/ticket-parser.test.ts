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

    describe('rule 1: UUID-shaped tokens', () => {
      const UUID = '38a8bb8d-39d4-49b2-a43e-20c8e1f66c87';
      const TAIL_LETTER_LED = '5da24492-df51-48cd-aeac-a43e8c1f66c8';
      const TAIL_DIGIT_LED = '5da24492-df51-48cd-aeac-0b276375bb30';

      it.each([
        ['bare UUID', `look at session ${UUID}`],
        ['session- prefix', `session-${UUID}`],
        ['agent- prefix', `agent-${UUID}`],
        ['-v2 suffix', `${UUID}-v2`],
        ['digit-led last group', TAIL_DIGIT_LED],
        ['partial paste', 'df51-48cd-aeac-0b276375bb30'],
        ['letter-led tail with -2', `${TAIL_LETTER_LED}-2`],
        ['letter-led tail with -123', `${TAIL_LETTER_LED}-123`],
        ['session- prefix with numeric suffix', `session-${TAIL_LETTER_LED}-2`],
        ['upper-case with numeric suffix', `${TAIL_LETTER_LED.toUpperCase()}-2`],
        ['bare tail group', 'a43e8c1f66c8-123'],
        ['session_ prefix', `session_${UUID}`],
        ['id= prefix', `id=${UUID}`],
        ['.json, letter-led last group', `${TAIL_LETTER_LED}.json`],
        ['.json, digit-led last group', `${TAIL_DIGIT_LED}.json`],
      ])('yields nothing for %s', (_label, text) => {
        expect(extractTicketMentions(text, 5)).toEqual([]);
        expect(extractTicketMentions(text, 5, { source: 'branch' })).toEqual([]);
      });

      it('keeps real keys that only have a hex-looking suffix or prefix', () => {
        expect(extractTicketMentions('ABC-1234-added', 5)).toEqual(['ABC-1234']);
        expect(extractTicketMentions('feature/ABC-1234-fade', 5)).toEqual(['ABC-1234']);
        expect(extractTicketMentions('ABC-123-add', 5)).toEqual(['ABC-123']);
        expect(extractTicketMentions('fix-ABC-123', 5)).toEqual(['ABC-123']);
      });

      it('keeps short and long real keys', () => {
        expect(extractTicketMentions('ME-4 XYZ-3 A1-1 EPMCDME-15301', 10)).toEqual([
          'ME-4',
          'XYZ-3',
          'A1-1',
          'EPMCDME-15301',
        ]);
      });

      it('returns the real key that follows a UUID', () => {
        expect(extractTicketMentions(`${UUID} then EPMCDME-15301`, 5)).toEqual(['EPMCDME-15301']);
        expect(extractTicketMentions(`${TAIL_LETTER_LED}-2 then EPMCDME-15301`, 5)).toEqual(['EPMCDME-15301']);
      });

      it('stays linear on a 1 MB repeated input', () => {
        const started = Date.now();
        const result = extractTicketMentions('a1-1-'.repeat(200_000), 20);
        expect(result).toEqual(['A1-1']);
        expect(Date.now() - started).toBeLessThan(2000);
      });

      it('stays linear on a 200 KB dash-separated hex run', () => {
        const started = Date.now();
        const result = extractTicketMentions('ab12-34cd-'.repeat(20_000), 20);
        expect(Array.isArray(result)).toBe(true);
        expect(Date.now() - started).toBeLessThan(2000);
      });
    });

    describe('rule 2: known non-ticket prefixes (prompt source)', () => {
      it('drops standards and algorithm tokens', () => {
        expect(extractTicketMentions('explain what sha-256 and utf-8 are', 5)).toEqual([]);
        for (const token of ['X86-64', 'UTF-16', 'ISO-8601', 'CVE-2024', 'COVID-19', 'http-2', 'TLS-1']) {
          expect(extractTicketMentions(`see ${token} here`, 5), token).toEqual([]);
        }
      });

      it('drops model and vendor family tokens', () => {
        for (const token of [
          'GPT-4',
          'gpt-4o',
          'claude-3-5-sonnet',
          'gemini-2.5',
          'llama-3',
          'qwen-2',
          'grok-4',
          'GROK-4',
          'grok-code-fast-1',
          'codex-1',
          'chatgpt-4',
          'mistral-7b',
          'deepseek-67b',
          'kimi-k2-6',
        ]) {
          expect(extractTicketMentions(`try ${token} today`, 5), token).toEqual([]);
        }
      });

      it('matches the listed key exactly and anywhere in its run', () => {
        expect(extractTicketMentions('LLAMA3-8', 5)).toEqual(['LLAMA3-8']);
        expect(extractTicketMentions('my-sha-256', 5)).toEqual([]);
      });

      it('drops the whole run of a full model id led by a listed token (AC10)', () => {
        for (const text of [
          'switch to gpt-4o-mini-2024-07-18',
          'use gemini-2.0-flash-001',
          'claude-3-5-sonnet-20241022',
          'gpt-4o-2024-08-06',
          'gpt-4-turbo-2024-04-09',
          'gemini-1.5-pro-002',
          'GPT-4O-MINI-2024-07-18',
          'openai/gpt-4o-mini-2024-07-18',
        ]) {
          expect(extractTicketMentions(text, 5), text).toEqual([]);
        }
      });

      it('keeps a real key not glued by a dash to the model id (AC11)', () => {
        for (const text of [
          'gpt-4o-mini-2024-07-18 then EPMCDME-15301',
          'use gemini-2.0-flash-001, EPMCDME-15301',
          'claude-3-5-sonnet-20241022: EPMCDME-15301',
          'gpt-4o_EPMCDME-15301',
        ]) {
          expect(extractTicketMentions(text, 5), text).toEqual(['EPMCDME-15301']);
        }
      });

      it('loses a real key glued by a dash to a leading model token (accepted loss)', () => {
        expect(extractTicketMentions('gpt-4o-EPMCDME-15301', 5)).toEqual([]);
        expect(extractTicketMentions('gpt-4o-mini-2024-07-18-EPMCDME-15301', 5)).toEqual([]);
      });

      it('does not apply to the branch source (AC12) but still drops a UUID', () => {
        expect(extractTicketMentions('feature/GPT-4-support', 1, { source: 'branch' })).toEqual(['GPT-4']);
        expect(extractTicketMentions('feature/gpt-4o-mini-2024-07-18', 1, { source: 'branch' })).toEqual(['GPT-4']);
        expect(
          extractTicketMentions('feature/38a8bb8d-39d4-49b2-a43e-20c8e1f66c87', 1, { source: 'branch' })
        ).toEqual([]);
      });
    });

    describe('rule 3: upper-case preference', () => {
      const first = (text: string): string[] => extractTicketMentions(text, 1, { preferUpperCase: true });

      it.each([
        ['use node-20 for EPMCDME-15301', ['EPMCDME-15301']],
        ['check epmcdme-15301', ['EPMCDME-15301']],
        ['use node-20 or java-17', ['NODE-20']],
        ['node-20 then epmcdme-15301', ['NODE-20']],
        ['Node-20 then EPMCDME-1', ['EPMCDME-1']],
        ['node-20 abc-9 ABC-9', ['ABC-9']],
        ['a1-1 then EPMCDME-1', ['EPMCDME-1']],
        ['A1-1 then EPMCDME-1', ['A1-1']],
        ['EPMCDME-1 and EPMCDME-2', ['EPMCDME-1']],
        ['RFC-2616 for EPMCDME-15301', ['RFC-2616']],
        ['sha-256 then epmcdme-1', ['EPMCDME-1']],
        ['38a8bb8d-39d4-49b2-a43e-20c8e1f66c87 then epmcdme-1', ['EPMCDME-1']],
      ])('limit 1 on %j gives %j', (text, expected) => {
        expect(first(text)).toEqual(expected);
      });

      it('keeps first-seen order without the option', () => {
        expect(extractTicketMentions('use node-20 for EPMCDME-15301', 20)).toEqual(['NODE-20', 'EPMCDME-15301']);
      });

      it('orders upper-case ids first, each group in first-seen order, before the limit', () => {
        expect(
          extractTicketMentions('node-20 abc-9 XYZ-3 java-17 ABC-9', 20, { preferUpperCase: true })
        ).toEqual(['ABC-9', 'XYZ-3', 'NODE-20', 'JAVA-17']);
      });
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

    it('keeps first-seen order and drops UUID and prefix tokens from ticket_mentions', () => {
      const prompt = 'xyz-3 38a8bb8d-39d4-49b2-a43e-20c8e1f66c87 sha-256 then ABC-12, abc-12';
      expect(parsePromptFields(prompt).ticket_mentions).toEqual(['XYZ-3', 'ABC-12']);
      expect(parsePromptFields('use node-20 for EPMCDME-15301').ticket_mentions).toEqual([
        'NODE-20',
        'EPMCDME-15301',
      ]);
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
