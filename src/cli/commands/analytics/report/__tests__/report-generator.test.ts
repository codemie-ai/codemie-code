/**
 * Report generator unit tests — focuses on VALID-JS data injection.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderReportHtml, getDefaultReportPath, getDefaultReportJsonPath, generateReportJson } from '../report-generator.js';
import { buildPayload } from '../payload-builder.js';

const template = `<style>/* __CODEMIE_CSS__ */</style>
<script>window.__ANALYTICS__ = /*__ANALYTICS_DATA__*/ null;</script>
<script>/* __CLIENT_APP__ */</script>`;

describe('renderReportHtml', () => {
  it('exports the same complete single-session snapshot to HTML and JSON without private captures', () => {
    const start = 1_700_000_000_000;
    const tokens = { input: 80, output: 0, cacheRead: 0, cacheCreation: 0, cacheCreation1h: 0, total: 80 };
    const session = { sessionId: 'snapshot', agentName: 'claude', provider: 'native', startTime: start, duration: 1, models: [], languages: [], tools: [] };
    const cost = { sessionId: 'snapshot', tokens, costUSD: 2, perModel: [], priced: true, hadLog: true,
      capturedAt: start + 10_000, observedStart: start, observedEnd: start + 9_000, costSource: 'native-estimate', costBasis: 'standard-api-tokens', dispatchesComplete: true,
      rootOwnTokens: tokens, rootOwnCostUSD: 2, unlinkedTokens: { ...tokens, input: 0, total: 0 }, unlinkedCostUSD: 0,
      costSeries: [{ t: start, cost: 1, tokens: 40 }, { t: start + 9_000, cost: 2, tokens: 80 }],
      dispatches: Array.from({ length: 80 }, (_, i) => ({ kind: 'agent', name: 'repeated', id: `dispatch-${i}`, parentId: i ? 'dispatch-0' : undefined,
        start: start + i, durationMs: 1, depth: i ? 2 : 1, status: 'completed', completedAt: start + 9_000,
        elapsedMs: 9_000 - i, inclusiveTokens: tokens, inclusiveCostUSD: 2, attributionStatus: 'exact', messages: ['PRIVATE_BODY'],
      })),
    };
    const payload = buildPayload({ projects: [{ projectPath: '/repo', branches: [{ branchName: 'main', sessions: [session] }] }] } as never,
      new Map([['snapshot', cost]]) as never, { totalCostUSD: 2, pricedSessions: 1, totalSessions: 1, unpricedModels: [] },
      { rangeLabel: 'all', projectFilter: 'all', generatedAt: new Date(start + 20_000).toISOString() });
    const html = renderReportHtml({ template, css: '', clientJs: '', payload });
    const fromHtml = JSON.parse(html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s)![1]);
    const directory = mkdtempSync(join(tmpdir(), 'analytics-projection-'));
    try {
      const output = join(directory, 'session.json');
      generateReportJson(payload, output);
      const json = readFileSync(output, 'utf8');
      expect(JSON.parse(json)).toEqual(fromHtml);
      expect(json).not.toContain('PRIVATE_BODY');
      expect(html).not.toContain('PRIVATE_BODY');
      expect(fromHtml.sessions[0].dispatches).toHaveLength(80);
      expect(fromHtml.sessions[0].agentInvocations[0].totalCalls).toBe(80);
      expect(fromHtml.sessions[0]).toMatchObject({ capturedAt: start + 10_000, durationMs: 9_000, rootOwnCostUSD: 2, costSource: 'native-estimate' });
      expect(fromHtml.sessions[0].dispatches[79]).toMatchObject({ parentId: 'dispatch-0', depth: 2, status: 'completed', inclusiveCostUSD: 2 });
      expect(fromHtml.meta.periodEnd).toBe(new Date(start + 9_000).toISOString());
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('injects css/app and produces a VALID, parseable data assignment', () => {
    const payload = { meta: { agents: ['claude'] }, sessions: [{ sessionId: 's1' }] } as never;
    const html = renderReportHtml({ template, css: '.x{color:red}', clientJs: 'console.log(1)', payload });

    expect(html).toContain('.x{color:red}');
    expect(html).toContain('console.log(1)');
    expect(html).not.toContain('__CODEMIE_CSS__');
    expect(html).not.toContain('__ANALYTICS_DATA__');
    expect(html).not.toContain('__CLIENT_APP__');
    // the ` null` fallback must be consumed, not left dangling after the JSON
    expect(html).not.toContain('= /*');

    // The assignment must be valid: extract the RHS and JSON.parse it.
    const m = html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s);
    expect(m).not.toBeNull();
    const data = JSON.parse(m![1]);
    expect(data.meta.agents).toEqual(['claude']);
    expect(data.sessions[0].sessionId).toBe('s1');
  });

  it('preserves $ sequences in injected JS (no String.replace $-pattern corruption)', () => {
    // app.js contains things like `'$'` (which embeds the `$'` "after-match" pattern)
    // and could contain `$&`, `$$`, `$1`. A plain string-replacement would mangle these.
    const tricky = "function fmtUSD(n){ return '$' + n; } /* $& $` $' $$ $1 */";
    const html = renderReportHtml({ template, css: '.a{color:red}', clientJs: tricky, payload: { meta: { agents: [] }, sessions: [] } });
    expect(html).toContain(tricky);
  });

  it('preserves $ sequences in css and data too', () => {
    const css = '.x::after{content:"$&$$"}';
    const html = renderReportHtml({ template, css, clientJs: '', payload: { meta: { agents: [] }, sessions: [{ sessionId: 'a$&b' }] } });
    expect(html).toContain(css);
    const m = html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s);
    expect(JSON.parse(m![1]).sessions[0].sessionId).toBe('a$&b');
  });

  it('escapes </script> in string fields so the tag cannot be closed early', () => {
    const payload = { meta: { agents: [] }, sessions: [{ sessionId: '</script><b>x' }] } as never;
    const html = renderReportHtml({ template, css: '', clientJs: '', payload });
    expect(html).not.toContain('</script><b>x'); // raw closing tag must be escaped
    const m = html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s);
    const data = JSON.parse(m![1]); // still valid JSON ( < is a valid escape )
    expect(data.sessions[0].sessionId).toBe('</script><b>x');
  });

  it('inlines vendored Chart.js before the client app (offline, no CDN)', () => {
    const tpl = `<style>/* __CODEMIE_CSS__ */</style>
<script>window.__ANALYTICS__ = /*__ANALYTICS_DATA__*/ null;</script>
<script>/* __CHARTJS__ */</script>
<script>/* __CLIENT_APP__ */</script>`;
    const html = renderReportHtml({
      template: tpl,
      css: '',
      chartJs: 'window.Chart = function(){};/* chart$umd */',
      clientJs: 'new Chart();',
      payload: { meta: { agents: [] }, sessions: [] } as never,
    });
    expect(html).toContain('window.Chart = function(){};'); // inlined, $-safe
    expect(html).not.toContain('__CHARTJS__');
    expect(html).not.toContain('cdn.jsdelivr'); // no CDN dependency
    // Chart must be defined before the client app runs
    expect(html.indexOf('window.Chart =')).toBeLessThan(html.indexOf('new Chart();'));
  });

  it('escapes every < — covers <!-- and bare <script, not just </', () => {
    const payload = { meta: { agents: [] }, sessions: [{ sessionId: '<!--<script>alert(1)' }] } as never;
    const html = renderReportHtml({ template, css: '', clientJs: '', payload });
    expect(html).not.toContain('<!--'); // comment-open from data must be neutralized
    expect(html).not.toContain('<script>alert(1)'); // bare opening tag from data must be neutralized
    const m = html.match(/window\.__ANALYTICS__ = (.*?);<\/script>/s);
    expect(JSON.parse(m![1]).sessions[0].sessionId).toBe('<!--<script>alert(1)');
  });
});

describe('getDefaultReportPath', () => {
  it('includes email slug in filename when email is provided', () => {
    const p = getDefaultReportPath('/tmp', 'alice@example.com');
    expect(p).toMatch(/codemie-analytics-alice-example-com-\d{4}-\d{2}-\d{2}\.html$/);
  });

  it('uses original format when email is absent', () => {
    const p = getDefaultReportPath('/tmp');
    expect(p).toMatch(/codemie-analytics-\d{4}-\d{2}-\d{2}\.html$/);
    expect(p).not.toContain('example');
  });
});

describe('getDefaultReportJsonPath', () => {
  it('includes email slug in filename when email is provided', () => {
    const p = getDefaultReportJsonPath('/tmp', 'alice@example.com');
    expect(p).toMatch(/codemie-analytics-alice-example-com-\d{4}-\d{2}-\d{2}\.report\.json$/);
  });

  it('uses original format when email is absent', () => {
    const p = getDefaultReportJsonPath('/tmp');
    expect(p).toMatch(/codemie-analytics-\d{4}-\d{2}-\d{2}\.report\.json$/);
    expect(p).not.toContain('example');
  });
});
