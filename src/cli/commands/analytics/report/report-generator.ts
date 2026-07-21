/**
 * Assembles the self-contained HTML report: inline the design-system CSS, embed
 * the analytics payload as valid JS, and inline the client app. No server, no
 * external data files — the result opens anywhere.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, html, 'utf-8');
}

/**
 * Writes the report payload as a standalone JSON file — the exact cost-enriched
 * dataset embedded in the HTML report ({ meta, sessions }). Plain JSON.stringify:
 * the `<` escaping used by renderReportHtml is defense for inline-<script> embedding
 * only and must NOT be applied to a .json file on disk.
 */
export function generateReportJson(payload: ReportPayload, outputPath: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(payload, null, 2), 'utf-8');
}

function emailSlug(email: string): string {
  return email.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

export function getDefaultReportPath(cwd: string, userEmail?: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = userEmail ? `${emailSlug(userEmail)}-` : '';
  return join(cwd, `codemie-analytics-${slug}${date}.html`);
}

export function getDefaultReportJsonPath(cwd: string, userEmail?: string): string {
  const date = new Date().toISOString().split('T')[0];
  const slug = userEmail ? `${emailSlug(userEmail)}-` : '';
  // `.report.json` (not `.json`) so the default never collides with `--export json`,
  // which writes the cost-less analytics tree to `codemie-analytics-<date>.json`.
  return join(cwd, `codemie-analytics-${slug}${date}.report.json`);
}

/**
 * Permission / read-only fs errors that a *different output directory* can resolve.
 * Seen when the report defaults to a cwd that is a drive root (Windows `D:\`) or a
 * read-only / write-protected volume (removable, network, BitLocker-locked, etc.).
 */
export function isUnwritableLocationError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EROFS';
}

/** Result of {@link writeReportWithFallback}: where the file actually landed. */
export interface ReportWriteResult {
  /** The path the report was finally written to. */
  path: string;
  /** Set only when the preferred path was unwritable and we relocated. */
  relocatedFrom?: string;
}

/**
 * Writes a report via `write(path)`. If the preferred location is unwritable
 * (drive root, read-only volume) AND `allowFallback` is true, retries the same
 * filename under the user's home dir, then the OS temp dir, and reports where it
 * landed. With `allowFallback` false (an explicit `--report-output`) or for any
 * non-permission error, the original error propagates unchanged.
 */
export function writeReportWithFallback(
  write: (path: string) => void,
  preferredPath: string,
  allowFallback: boolean
): ReportWriteResult {
  try {
    write(preferredPath);
    return { path: preferredPath };
  } catch (err) {
    if (!allowFallback || !isUnwritableLocationError(err)) throw err;
    const name = basename(preferredPath);
    for (const dir of [homedir(), tmpdir()]) {
      const candidate = join(dir, name);
      if (candidate === preferredPath) continue;
      try {
        write(candidate);
        return { path: candidate, relocatedFrom: preferredPath };
      } catch (inner) {
        if (!isUnwritableLocationError(inner)) throw inner;
      }
    }
    throw err;
  }
}
