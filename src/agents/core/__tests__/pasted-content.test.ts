import { describe, it, expect } from 'vitest';
import { stripPastedContentTags } from '@/agents/core/pasted-content.js';

describe('stripPastedContentTags', () => {
  it.each([
    [
      'whole-prompt paste',
      '<pasted_content id="b23a">\nStep 1\nStep 2\n</pasted_content id="b23a">\n',
      'Step 1\nStep 2',
    ],
    [
      'typed prefix plus mid-prompt block, inner newlines verbatim',
      'Run smoke\n\n<pasted_content id="b">\nA\nB\n</pasted_content id="b">\n',
      'Run smoke\n\n\nA\nB',
    ],
    [
      'two blocks with different ids',
      '<pasted_content id="a">\nOne\n</pasted_content id="a">\nmid\n<pasted_content id="b">\nTwo\n</pasted_content id="b">',
      'One\n\nmid\n\nTwo',
    ],
    ['unterminated block', '<pasted_content id="x">\ntext', 'text'],
    ['orphan closing tag', 'text\n</pasted_content id="x">', 'text'],
    [
      'tags removed tag by tag, mismatched ids keep the text between them',
      '<pasted_content id="a">between</pasted_content id="b">',
      'between',
    ],
    ['empty block', '<pasted_content id="x"></pasted_content id="x">', ''],
    [
      'CRLF and tabs inside the block',
      '<pasted_content id="x">\r\n\tindented\r\n\tmore\r\n</pasted_content id="x">',
      'indented\r\n\tmore',
    ],
    ['closing tag without attributes', '<pasted_content>a</pasted_content>', 'a'],
  ])('%s', (_name, input, expected) => {
    expect(stripPastedContentTags(input)).toBe(expected);
  });

  it.each([
    ['plain text with surrounding whitespace', '  hello world \n'],
    ['similar tag name', ' see <pasted_contents> here '],
    ['bare word without angle brackets', 'the pasted_content id="x" thing\n'],
    ['empty string', ''],
  ])('returns text without the marker unchanged: %s', (_name, input) => {
    expect(stripPastedContentTags(input)).toBe(input);
  });
});
