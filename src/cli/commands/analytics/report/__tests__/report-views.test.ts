/**
 * Report views contract test — verifies nav ids and view keys are in sync.
 * Reads template.html and app.js from disk; parses nav data-view ids and VIEWS.* keys.
 * Asserts: both sets include 'frameworks' and sorted(nav ids) equals sorted(view keys).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { renderReportHtml } from '../report-generator.js';

const template = `<style>/* __CODEMIE_CSS__ */</style>
<script>window.__ANALYTICS__ = /*__ANALYTICS_DATA__*/ null;</script>
<script>/* __CLIENT_APP__ */</script>`;

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

describe('cost view surfaces unpriced and estimated models', () => {
  it('app.js reads meta.estimatedModels alongside meta.unpricedModels for the cost banner', () => {
    const appPath = fileURLToPath(new URL('../client/app.js', import.meta.url));
    const app = readFileSync(appPath, 'utf-8');

    // The run-level cost banner (VIEWS.cost) must surface both lists (spec section B:
    // "The HTML report and the terminal summary show both lists").
    expect(app).toMatch(/DATA\.meta\.estimatedModels/);
    // The per-session payload rebuild (sessionPayload) must keep estimatedModels consistent
    // with unpricedModels, derived from perModelCost[].estimated.
    expect(app).toMatch(/estimatedModels:\s*estimatedModels/);
    expect(app).toMatch(/m\.estimated/);
  });

  it('rendered HTML embeds meta.estimatedModels so the cost view can read it', () => {
    const payload = {
      meta: { agents: ['claude'], unpricedModels: [], estimatedModels: ['claude-opus-4-7'] },
      sessions: [],
    } as never;
    const html = renderReportHtml({ template, css: '', clientJs: '', payload });

    expect(html).toContain('claude-opus-4-7');
    const m = html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s);
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1]);
    expect(data.meta.estimatedModels).toEqual(['claude-opus-4-7']);
  });
});
