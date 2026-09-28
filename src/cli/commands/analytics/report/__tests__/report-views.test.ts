/**
 * Report views contract test — verifies nav ids and view keys are in sync.
 * Reads template.html and app.js from disk; parses nav data-view ids and VIEWS.* keys.
 * Asserts: both sets include 'frameworks' and sorted(nav ids) equals sorted(view keys).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { runInNewContext } from 'vm';
import { renderReportHtml } from '../report-generator.js';

/**
 * Executes app.js's `sessionPayload()` in isolation, following the vm-slice pattern in
 * modal-focus.test.ts: slice the function's real source out of app.js and run it in a
 * fresh vm context with just the globals it touches (`DATA`).
 */
function sessionPayloadHarness(): (s: unknown) => { meta: { estimatedModels: string[]; unpricedModels: string[]; localModels: string[] } } {
  const appPath = fileURLToPath(new URL('../client/app.js', import.meta.url));
  const source = readFileSync(appPath, 'utf-8');
  const start = source.indexOf('function sessionPayload(s) {');
  const end = source.indexOf('function openSessionModal(s, onBack) {', start);
  if (start === -1 || end === -1) throw new Error('sessionPayload slice markers not found in app.js');
  const context = { DATA: { meta: {} } };
  return runInNewContext(`${source.slice(start, end)} sessionPayload`, context) as never;
}

/** Executes app.js's `costBannerMessage()` builder in isolation (see the harness above). */
function costBannerHarness(): (meta: unknown) => string {
  const appPath = fileURLToPath(new URL('../client/app.js', import.meta.url));
  const source = readFileSync(appPath, 'utf-8');
  const start = source.indexOf('function costBannerMessage(meta) {');
  const end = source.indexOf('VIEWS.cost = function (host, fs) {', start);
  if (start === -1 || end === -1) throw new Error('costBannerMessage slice markers not found in app.js');
  return runInNewContext(`${source.slice(start, end)} costBannerMessage`, {}) as never;
}

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
  it('CR-014 sessionPayload derives meta.estimatedModels from perModelCost[].estimated', () => {
    const sessionPayload = sessionPayloadHarness();
    const session = {
      agentName: 'claude',
      perModelCost: [{ model: 'claude-opus-4-7', estimated: true }],
    };

    const result = sessionPayload(session);

    expect(result.meta.estimatedModels).toEqual(['claude-opus-4-7']);
    expect(result.meta.unpricedModels).toEqual([]);
  });

  it('CR-014 the cost banner text names estimated models', () => {
    const costBannerMessage = costBannerHarness();

    const msg = costBannerMessage({
      totals: { pricedSessions: 1, sessions: 1 },
      unpricedModels: [],
      estimatedModels: ['claude-opus-4-7'],
    });

    expect(msg).toContain('Estimated models: claude-opus-4-7');
  });

  it('sessionPayload derives meta.localModels from perModelCost[].local', () => {
    const sessionPayload = sessionPayloadHarness();
    const result = sessionPayload({
      agentName: 'codex',
      perModelCost: [{ model: 'gpt-oss:120b', local: true, unpriced: false }],
    });

    expect(result.meta.localModels).toEqual(['gpt-oss:120b']);
    expect(result.meta.unpricedModels).toEqual([]);
  });

  it('the cost banner text names local (free) models', () => {
    const costBannerMessage = costBannerHarness();

    const msg = costBannerMessage({
      totals: { pricedSessions: 1, sessions: 1 },
      unpricedModels: [],
      estimatedModels: [],
      localModels: ['gpt-oss:120b', 'qwen3.8:27b'],
    });

    expect(msg).toContain('Local models (free): gpt-oss:120b, qwen3.8:27b');
  });

  it('the cost banner tolerates a payload without meta.localModels', () => {
    const costBannerMessage = costBannerHarness();

    const msg = costBannerMessage({ totals: { pricedSessions: 1, sessions: 1 }, unpricedModels: [], estimatedModels: [] });

    expect(msg).not.toContain('Local models');
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
