import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright-core';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateReport, generateReportJson } from '../report-generator.js';
import type { ReportPayload, ReportSessionRecord } from '../types.js';

const cases = [
  { zone: 'UTC', day: '2026-03-08', start: '2026-03-08T00:00:00Z', next: '2026-03-09T00:00:00Z', hours: 24 },
  { zone: 'UTC', day: '2026-11-01', start: '2026-11-01T00:00:00Z', next: '2026-11-02T00:00:00Z', hours: 24 },
  { zone: 'America/New_York', day: '2026-03-08', start: '2026-03-08T05:00:00Z', next: '2026-03-09T04:00:00Z', hours: 23 },
  { zone: 'America/New_York', day: '2026-11-01', start: '2026-11-01T04:00:00Z', next: '2026-11-02T05:00:00Z', hours: 25 },
  { zone: 'Europe/Berlin', day: '2026-03-29', start: '2026-03-28T23:00:00Z', next: '2026-03-29T22:00:00Z', hours: 23 },
  { zone: 'Europe/Berlin', day: '2026-10-25', start: '2026-10-24T22:00:00Z', next: '2026-10-25T23:00:00Z', hours: 25 },
];

function record(sessionId: string, startTime: number, turns: number): ReportSessionRecord {
  return {
    sessionId, startTime, turns, agentName: turns === 3 ? 'pi' : 'copilot-cli', provider: 'native',
    project: turns === 3 ? 'C:\\repo' : '/repo', branch: 'main',
    title: 'fixture <img src=x onerror="window.injected=true">', durationMs: 1,
    fileOps: 1, linesAdded: 5, linesRemoved: 0, linesModified: 0, netLines: 5,
    filesChanged: 1, filesWritten: 1, filesEdited: 0,
    toolCallsTotal: 2, toolCallsSuccess: 1, toolCallsFailure: 1,
    models: ['claude-haiku-4-5'], languages: ['TypeScript'], tools: [],
    skillInvocations: [], agentInvocations: [], commandInvocations: [], sessionSource: 'Pure chat',
    tokens: { input: 100, output: 10, cacheRead: 5, cacheCreation: 2, cacheCreation1h: 0, total: 117 },
    costUSD: turns * 1.25, cacheReadCostUSD: 0, perModelCost: [], hadLog: true,
  };
}

function payload(start: number, next: number): ReportPayload {
  const sessions = [
    record('before', start - 1, 1), record('first', start, 2),
    record('middle', start + 4 * 3_600_000, 3), record('last', next - 1, 4),
    record('after', next, 5),
  ];
  return {
    sessions,
    meta: {
      generatedAt: '2026-11-01T12:00:00Z', rangeLabel: 'all',
      agents: ['copilot-cli', 'pi'], projectFilter: 'all',
      totals: { sessions: 5, durationMs: 5, turns: 15, files: 5, netLines: 25,
        toolCallsTotal: 10, toolSuccessRate: 50, totalCostUSD: 18.75, cacheReadCostUSD: 0, pricedSessions: 5 },
      unpricedModels: [], estimatedModels: [], localModels: [], coverage: [],
    },
  };
}

async function kpis(page: Page): Promise<Record<string, string>> {
  return page.locator('.kpi').evaluateAll((nodes) => Object.fromEntries(nodes.map((node) => [
    node.querySelector('.kpi-label')?.textContent, node.querySelector('.kpi-value')?.textContent,
  ])));
}

async function dateFilter(page: Page, day: string): Promise<void> {
  await page.locator('#date-from').fill(day);
  await page.locator('#date-from').dispatchEvent('change');
  await page.locator('#date-to').fill(day);
  await page.locator('#date-to').dispatchEvent('change');
}

describe.skipIf(process.env.ANALYTICS_BROWSER_TESTS !== 'true')('R64 actual offline dashboard in timezone contexts', () => {
  let browser: Browser;
  let directory: string;

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'analytics-browser-'));
    browser = await chromium.launch({
      channel: process.env.ANALYTICS_BROWSER_EXECUTABLE ? undefined : 'chrome',
      executablePath: process.env.ANALYTICS_BROWSER_EXECUTABLE,
      headless: true,
      timeout: 45_000,
    }, 60_000);
  });

  afterAll(async () => {
    await browser?.close();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  const contract = process.env.ANALYTICS_STRICT_CONTRACTS === 'true' ? it : it.fails;
  contract.each(cases.filter((item) => item.zone === 'America/New_York'))('KNOWN DEFECT offline Date column $day agrees with local day filter', async ({ zone, day, start, next }) => {
    const htmlPath = join(directory, `date-contract-${day}.html`);
    generateReport(payload(Date.parse(start), Date.parse(next)), htmlPath);
    const context = await browser.newContext({ timezoneId: zone });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      await page.goto(pathToFileURL(htmlPath).href);
      await dateFilter(page, day);
      await page.locator('.nav-i[data-view="sessions"]').click();
      const displayed = await page.locator('tr[data-session="last"] td').first().textContent();
      expect(displayed?.slice(0, 10)).toBe(day);
    } finally {
      await context.close();
    }
  });

  it.each(cases)('$zone $day: inclusive local-day membership, independent totals, charts and controls', async ({ zone, day, start, next, hours }) => {
    expect(Date.parse(next) - Date.parse(start)).toBe(hours * 3_600_000);
    const data = payload(Date.parse(start), Date.parse(next));
    const htmlPath = join(directory, `${zone.replaceAll('/', '-')}-${day}.html`);
    const jsonPath = htmlPath.replace('.html', '.json');
    generateReport(data, htmlPath);
    generateReportJson(data, jsonPath);
    const context = await browser.newContext({ timezoneId: zone });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(5_000);
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', (route) => route.request().url().startsWith('file:') ? route.continue() : route.abort());
      await page.goto(pathToFileURL(htmlPath).href);
      await page.locator('.kpi-value').first().waitFor();
      expect(await kpis(page)).toMatchObject({ Sessions: '5', Turns: '15', 'Est. cost': '$18.75' });
      expect(await page.locator('canvas').count()).toBeGreaterThan(0);
      expect(await page.evaluate(() => (window as Window & { __ANALYTICS__: unknown }).__ANALYTICS__))
        .toEqual(JSON.parse(readFileSync(jsonPath, 'utf8')));

      await dateFilter(page, day);
      expect(await kpis(page)).toMatchObject({
        Sessions: '3', Turns: '9', 'Est. cost': '$11.25', 'Tool calls': '6',
        'Input tokens': '300', 'Output tokens': '30', 'Cache write': '6', 'Cache read': '15', 'Total tokens': '351',
      });
      await page.locator('.nav-i[data-view="sessions"]').click();
      expect((await page.locator('tr[data-session]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-session')))).sort())
        .toEqual(['first', 'last', 'middle']);
      expect(await page.locator('tr[data-session] img').count()).toBe(0);
      expect(await page.locator('tr[data-session="last"] td').first().textContent())
        .toBe(new Date(Date.parse(next) - 1).toISOString().slice(0, 16).replace('T', ' '));

      const evidence = process.env.ANALYTICS_EVIDENCE_DIR;
      if (evidence) {
        mkdirSync(evidence, { recursive: true });
        const name = `${zone.replaceAll('/', '-')}-${day}`;
        await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
        writeFileSync(join(evidence, `${name}.html`), await page.content());
      }
      await page.locator('.nav-i[data-view="overview"]').click();
      await page.locator('#project-select').selectOption('C:\\repo');
      expect(await kpis(page)).toMatchObject({ Sessions: '1', Turns: '3', 'Est. cost': '$3.75' });
      await page.locator('#project-select').selectOption('all');
      await page.locator('#agent-chips .chip-tog').filter({ hasText: /^Pi$/ }).click();
      expect(await kpis(page)).toMatchObject({ Sessions: '2', Turns: '6', 'Est. cost': '$7.50' });
      await page.locator('#date-clear').click();
      expect(await kpis(page)).toMatchObject({ Sessions: '4', Turns: '12', 'Est. cost': '$15.00' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
