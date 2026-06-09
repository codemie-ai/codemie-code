/**
 * Report generator unit tests — focuses on VALID-JS data injection.
 */

import { describe, it, expect } from 'vitest';
import { renderReportHtml } from '../report-generator.js';

const template = `<style>/* __CODEMIE_CSS__ */</style>
<script>window.__ANALYTICS__ = /*__ANALYTICS_DATA__*/ null;</script>
<script>/* __CLIENT_APP__ */</script>`;

describe('renderReportHtml', () => {
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
