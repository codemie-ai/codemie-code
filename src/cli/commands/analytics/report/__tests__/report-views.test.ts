/**
 * Report views contract test — verifies nav ids and view keys are in sync.
 * Reads template.html and app.js from disk; parses nav data-view ids and VIEWS.* keys.
 * Asserts: both sets include 'frameworks' and sorted(nav ids) equals sorted(view keys).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

describe('report views contract', () => {
  it('nav ids and view keys match, and both include frameworks', () => {
    // Read template.html (relative to this test file)
    const templatePath = fileURLToPath(new URL('../template.html', import.meta.url));
    const template = readFileSync(templatePath, 'utf-8');

    // Parse nav ids from data-view="([a-zA-Z]+)"
    const navIdMatches = template.matchAll(/data-view="([a-zA-Z]+)"/g);
    const navIds = Array.from(navIdMatches, m => m[1]);
    const navIdSet = new Set(navIds);

    // Read app.js (relative to this test file)
    const appPath = fileURLToPath(new URL('../client/app.js', import.meta.url));
    const app = readFileSync(appPath, 'utf-8');

    // Parse view keys from VIEWS.([a-zA-Z]+)\s*=
    const viewMatches = app.matchAll(/VIEWS\.([a-zA-Z]+)\s*=/g);
    const viewKeys = Array.from(viewMatches, m => m[1]);
    const viewKeySet = new Set(viewKeys);

    // Assert: both include 'frameworks'
    expect(navIdSet.has('frameworks')).toBe(true);
    expect(viewKeySet.has('frameworks')).toBe(true);

    // Assert: sorted arrays are equal
    const sortedNavIds = Array.from(navIdSet).sort();
    const sortedViewKeys = Array.from(viewKeySet).sort();
    expect(sortedNavIds).toEqual(sortedViewKeys);
  });
});
