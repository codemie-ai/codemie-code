/**
 * Assembles the self-contained HTML report: inline the design-system CSS, embed
 * the analytics payload as valid JS, and inline the client app. No server, no
 * external data files — the result opens anywhere.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDirname } from '../../../../utils/paths.js';
import type { ReportPayload } from './types.js';

const HERE = getDirname(import.meta.url); // dist/.../analytics/report at runtime

/** Pure string assembly — unit-testable without fs. */
export function renderReportHtml(input: {
  template: string;
  css: string;
  clientJs: string;
  payload: ReportPayload;
  chartJs?: string; // vendored Chart.js UMD, inlined so the report works fully offline
}): string {
  // Escape EVERY `<` as the JS/JSON string escape `<`. `<` only appears inside
  // JSON string values (never as JSON structure), so this round-trips through JSON.parse,
  // while making it impossible for embedded data to emit `</script>`, `<!--`, or `<script`
  // and break out of the inline <script> block (defense-in-depth against HTML injection).
  const safeData = JSON.stringify(input.payload).replace(/</g, '\\u003c');
  // IMPORTANT: use FUNCTION replacements. A string replacement would interpret `$`
  // patterns ($&, $', $`, $$, $n) in CSS/JS/JSON content (e.g. app.js contains `'$'`),
  // corrupting the output and breaking the embedded script. Functions are not subject to that.
  // Inject the trusted CSS and client JS FIRST, then the (data-derived) payload LAST, so no
  // later replace can scan or mis-target a sentinel string that happens to appear in the data.
  return input.template
    .replace('/* __CODEMIE_CSS__ */', () => input.css)
    .replace('/* __CHARTJS__ */', () => input.chartJs ?? '')
    .replace('/* __CLIENT_APP__ */', () => input.clientJs)
    // Replace the comment AND its ` null` fallback so the assignment becomes
    // `window.__ANALYTICS__ = {…};` (valid), and the un-injected template stays valid too.
    .replace('/*__ANALYTICS_DATA__*/ null', () => safeData);
}

/** Reads vendored assets next to this module and writes the self-contained report. */
export function generateReport(payload: ReportPayload, outputPath: string): void {
  const template = readFileSync(join(HERE, 'template.html'), 'utf-8');
  const css = readFileSync(join(HERE, 'assets', 'codemie-bundle.css'), 'utf-8');
  const chartJs = readFileSync(join(HERE, 'assets', 'chart.umd.js'), 'utf-8');
  const clientJs = readFileSync(join(HERE, 'client', 'app.js'), 'utf-8');
  const html = renderReportHtml({ template, css, chartJs, clientJs, payload });
  writeFileSync(outputPath, html, 'utf-8');
}

/**
 * Writes the report payload as a standalone JSON file — the exact cost-enriched
 * dataset embedded in the HTML report ({ meta, sessions }). Plain JSON.stringify:
 * the `<` escaping used by renderReportHtml is defense for inline-<script> embedding
 * only and must NOT be applied to a .json file on disk.
 */
export function generateReportJson(payload: ReportPayload, outputPath: string): void {
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

export function getDefaultReportPath(cwd: string): string {
  const date = new Date().toISOString().split('T')[0];
  return `${cwd}/codemie-analytics-${date}.html`;
}

export function getDefaultReportJsonPath(cwd: string): string {
  const date = new Date().toISOString().split('T')[0];
  // `.report.json` (not `.json`) so the default never collides with `--export json`,
  // which writes the cost-less analytics tree to `codemie-analytics-<date>.json`.
  return `${cwd}/codemie-analytics-${date}.report.json`;
}
