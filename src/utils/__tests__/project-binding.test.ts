import { describe, it, expect } from 'vitest';
import { describeProjectBinding, parseProjectBinding, sanitizeDisplayText } from '../project-binding.js';
import { renderProfileInfo } from '../profile.js';

describe('project binding (EPMCDME-15411)', () => {
  it('parses only known states', () => {
    expect(parseProjectBinding('own')).toBe('own');
    expect(parseProjectBinding('unowned')).toBe('unowned');
    expect(parseProjectBinding('bogus')).toBeUndefined();
    expect(parseProjectBinding(undefined)).toBeUndefined();
  });

  it('describes each state for the banner and profile list', () => {
    expect(describeProjectBinding('own', 'mtlx-csd')).toBe('mtlx-csd');
    expect(describeProjectBinding('unowned', 'mtlx-amsd')).toBe('mtlx-amsd (shared fallback)');
    expect(describeProjectBinding('unowned', undefined)).toBe('none (no project selected)');
    expect(describeProjectBinding('none', undefined)).toBe('off CodeMie');
    expect(describeProjectBinding('local', 'repo')).toBe('repo');
    expect(describeProjectBinding('not-applicable', 'shared')).toBeUndefined();
    expect(describeProjectBinding(undefined, 'x')).toBeUndefined();
  });

  it('strips control characters', () => {
    expect(sanitizeDisplayText('a\u001b[31mb\u0007')).toBe('a[31mb');
  });

  it('the banner shows a Project line only when a project text is given (AC8, AC7)', () => {
    const withProject = renderProfileInfo({ profile: 'mtlx-csd', provider: 'ai-run-sso', model: 'm', project: 'mtlx-csd' });
    expect(withProject).toContain('Project');
    expect(withProject).toContain('mtlx-csd');
    const without = renderProfileInfo({ profile: 'lite', provider: 'litellm', model: 'm' });
    expect(without).not.toContain('Project');
  });
});
