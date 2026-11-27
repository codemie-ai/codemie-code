import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { parse } from 'node:path';
import { resolveConsentProject } from '../consent-project.js';

describe('resolveConsentProject', () => {
  it('refuses the home directory before resolving a project', async () => {
    await expect(resolveConsentProject(homedir(), 'Proj-A')).rejects.toThrow(/home directory/);
  });

  it('refuses a filesystem root', async () => {
    await expect(resolveConsentProject(parse(homedir()).root, 'Proj-A')).rejects.toThrow(/filesystem root/);
  });
});
