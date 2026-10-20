import { describe, it, expect } from 'vitest';
import { truncateProjectPath } from '../metrics-post-processor.js';

describe('truncateProjectPath', () => {
  it.each([
    ['', 'unknown'],
    ['   ', 'unknown'],
  ])('returns "unknown" for empty input (%j)', (input, expected) => {
    expect(truncateProjectPath(input)).toBe(expected);
  });

  it.each([
    ['/Users/Nikita/repos/EPMCDME/codemie-ai/codemie-code', 'codemie-ai/codemie-code'],
    ['/', 'unknown'],
  ])('truncates an absolute filesystem path to its last two segments: %s', (input, expected) => {
    expect(truncateProjectPath(input)).toBe(expected);
  });

  it.each([
    ['qa-group-a/shared/svc', 'qa-group-a/shared/svc'],
    ['qa-top/qa-sub/qa-subsub/deep-svc', 'qa-top/qa-sub/qa-subsub/deep-svc'],
    ['qaorg/qa project/qa-ado-repo', 'qaorg/qa project/qa-ado-repo'],
    ['codemie-ai/codemie-code', 'codemie-ai/codemie-code'],
  ])(
    'passes an already-short, canonical repository identifier through unchanged: %s',
    (input, expected) => {
      expect(truncateProjectPath(input)).toBe(expected);
    }
  );

  it('does not collapse two distinct multi-segment repositories into the same truncated name', () => {
    expect(truncateProjectPath('qa-group-a/shared/svc')).not.toBe(truncateProjectPath('qa-group-b/shared/svc'));
  });
});
