/**
 * MetricsSender: with analytics prompt reduction on, the posted body keeps only the metrics keep-list.
 * @group unit
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MetricsSender } from '../metrics-api-client.js';
import type { SessionMetric } from '../metrics-types.js';
import { logger } from '@/utils/logger.js';
import { createHash } from 'node:crypto';
import { keyedDigest, resetEventKeyCache } from '@/agents/core/analytics-event-key.js';

const BRANCH = 'feature/EPMCDME-17748-secret-customer-name';

function session(workingDirectory: string): Parameters<MetricsSender['sendSessionEnd']>[0] {
  return {
    sessionId: 'sess-reduction',
    agentName: 'claude',
    provider: 'ai-run-sso',
    project: 'demo-project',
    startTime: 1000,
    workingDirectory,
    repository: 'owner/repo',
    gitBranch: BRANCH,
    model: 'gpt-test'
  };
}

const toolUsageMetric = (): SessionMetric => ({
  name: MetricsSender.METRIC_TOOL_USAGE_TOTAL,
  attributes: {
    agent: 'claude', agent_version: '1.0.0', codemie_client: 'codemie-claude',
    repository: 'owner/repo', session_id: 'sess-reduction', branch: BRANCH, project: 'demo-project',
    count: 1, delta_id: `batch-1:${BRANCH}`, llm_model: 'gpt-test',
    total_user_prompts: 3, session_duration_ms: 50, had_errors: true,
    error_tools: ['Bash'], error_messages: ['cannot read /home/me/secret.txt'], api_errors: ['model 500 for secret prompt'],
    tool_names: ['Read', 'Bash', 'Read'], total_tool_calls: 3, successful_tool_calls: 2, failed_tool_calls: 1,
    files_created: 0, files_modified: 1, files_deleted: 0, total_lines_added: 4, total_lines_removed: 2
  }
});

describe('MetricsSender prompt reduction', () => {
  let home: string;
  let project: string;
  let originalHome: string | undefined;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalHome = process.env.CODEMIE_HOME;
    home = mkdtempSync(join(tmpdir(), 'metrics-reduction-home-'));
    project = mkdtempSync(join(tmpdir(), 'metrics-reduction-project-'));
    process.env.CODEMIE_HOME = home;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, message: 'ok' }), {
      status: 200, headers: { 'content-type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (originalHome === undefined) delete process.env.CODEMIE_HOME;
    else process.env.CODEMIE_HOME = originalHome;
    await logger.close();
    for (const dir of [home, project]) {
      try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* best-effort */ }
    }
  });

  const setReduction = (dir: string, on: boolean): void => {
    mkdirSync(join(dir, '.codemie'), { recursive: true });
    writeFileSync(join(dir, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ analytics: { promptReduction: on } }));
  };
  const sender = (): MetricsSender => new MetricsSender({ baseUrl: 'http://api.test', cookies: 'c=1', retryAttempts: 0, version: '1.0.0' });
  const posted = (): { name: string; attributes: Record<string, unknown> } =>
    JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body);
  const postedHeaders = (): Record<string, string> => (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;

  it('reduces a session end metric when the project has reduction on', async () => {
    setReduction(project, true);
    await sender().sendSessionEnd(session(project), project, { status: 'failed', reason: 'user said secret' }, 100,
      { type: 'AgentError', code: 'E1', message: 'secret path /home/me' }, 90, 2000);

    const { attributes } = posted();
    expect(attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
    expect(attributes.reason).toBe('REDACTED:REASON');
    expect(attributes.branch).toBe('EPMCDME-17748');
    expect(postedHeaders()['X-CodeMie-Branch']).toBe('EPMCDME-17748');
    expect(attributes).toMatchObject({
      agent: 'claude', session_id: 'sess-reduction', repository: 'owner/repo', project: 'demo-project',
      llm_model: 'gpt-test', status: 'failed', error_tools: ['AgentError'], session_duration_ms: 100, count: 1
    });
  });

  it('reduces a session start metric when the project has reduction on (CR-027)', async () => {
    setReduction(project, true);
    await sender().sendSessionStart(session(project), project, { status: 'failed', reason: 'user said secret' },
      { type: 'AgentError', code: 'E1', message: 'secret path /home/me' });

    const { attributes } = posted();
    // The start metric detects its branch from the directory (none here): an empty branch stays empty, it is not a hidden one.
    expect(attributes.branch).toBe('');
    expect(attributes.reason).toBe('REDACTED:REASON');
    expect(JSON.stringify(attributes)).not.toContain('secret');
    expect(postedHeaders()['X-CodeMie-Branch']).toBe('');
  });

  it('reduces a tool usage metric and keeps name lists and counts', async () => {
    setReduction(project, true);
    await sender().sendSessionMetric(toolUsageMetric(), project);

    const { name, attributes } = posted();
    expect(name).toBe(MetricsSender.METRIC_TOOL_USAGE_TOTAL);
    expect(attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
    expect(attributes.api_errors).toEqual(['REDACTED:API-ERRORS']);
    expect(attributes.branch).toBe('EPMCDME-17748');
    expect(JSON.stringify(attributes)).not.toContain('secret');
    expect(attributes.delta_id).not.toContain('secret');
    expect(attributes.delta_id).toMatch(/^batch-1:/);
    expect(attributes).toMatchObject({
      tool_names: ['Read', 'Bash', 'Read'], error_tools: ['Bash'], total_tool_calls: 3, failed_tool_calls: 1,
      files_modified: 1, total_lines_added: 4, total_user_prompts: 3
    });
  });

  it('cuts a branch without ticket keys to REDACTED:BRANCH and keeps delta ids of different branches apart', async () => {
    setReduction(project, true);
    const a = toolUsageMetric();
    a.attributes.branch = 'alpha-secret'; a.attributes.delta_id = 'batch-1:alpha-secret';
    const b = toolUsageMetric();
    b.attributes.branch = 'beta-secret'; b.attributes.delta_id = 'batch-1:beta-secret';
    await sender().sendSessionMetric(a, project);
    await sender().sendSessionMetric(b, project);

    const first = JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).attributes;
    const second = JSON.parse((fetchMock.mock.calls[1][1] as { body: string }).body).attributes;
    expect(first.branch).toBe('REDACTED:BRANCH');
    expect(first.delta_id).not.toBe(second.delta_id);
  });

  it('keys the reduced delta_id branch suffix with the local analytics key, not a plain sha256', async () => {
    setReduction(project, true);
    resetEventKeyCache();
    await sender().sendSessionMetric(toolUsageMetric(), project);

    const deltaId = posted().attributes.delta_id as string;
    const suffix = deltaId.slice('batch-1:'.length);
    expect(suffix).not.toBe(createHash('sha256').update(BRANCH).digest('hex').slice(0, 12));
    expect(suffix).toBe(keyedDigest(BRANCH).slice(0, 12));
  });

  it('gives different branches different reduced delta_id suffixes', async () => {
    setReduction(project, true);
    resetEventKeyCache();
    const a = toolUsageMetric();
    a.attributes.branch = 'feature/one'; a.attributes.delta_id = 'batch-1:feature/one';
    const b = toolUsageMetric();
    b.attributes.branch = 'feature/two'; b.attributes.delta_id = 'batch-1:feature/two';
    await sender().sendSessionMetric(a, project);
    await sender().sendSessionMetric(b, project);

    const first = JSON.parse(fetchMock.mock.calls[0][1].body).attributes.delta_id as string;
    const second = JSON.parse(fetchMock.mock.calls[1][1].body).attributes.delta_id as string;
    expect(first).not.toBe(second);
  });

  it('does not mutate the metric it was given', async () => {
    setReduction(project, true);
    const metric = toolUsageMetric();
    await sender().sendSessionMetric(metric, project);
    expect(metric).toEqual(toolUsageMetric());
  });

  it('reduces when only the global setting is on', async () => {
    writeFileSync(join(home, 'codemie-cli.config.json'), JSON.stringify({ analytics: { promptReduction: true } }));
    await sender().sendSessionMetric(toolUsageMetric(), project);
    expect(posted().attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
  });

  it('posts the unchanged body when reduction is off', async () => {
    setReduction(project, false);
    const metric = toolUsageMetric();
    await sender().sendSessionMetric(metric, project);
    expect(fetchMock.mock.calls[0][1].body).toBe(JSON.stringify(metric));
    expect(postedHeaders()['X-CodeMie-Branch']).toBeDefined();
  });

  it('reduces a metric with no working directory when any project opted in, and leaves it when none did (CR-025)', async () => {
    await sender().sendSessionMetric(toolUsageMetric(), undefined);
    expect(posted().attributes.error_messages).toEqual(['cannot read /home/me/secret.txt']);

    fetchMock.mockClear();
    writeFileSync(join(home, 'analytics-reduction-projects.json'), JSON.stringify([project]));
    await sender().sendSessionMetric(toolUsageMetric(), undefined);
    expect(posted().attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
  });

  it('reduces a metric whose working directory no longer exists when any project opted in', async () => {
    const gone = join(project, 'moved-away');
    await sender().sendSessionMetric(toolUsageMetric(), gone);
    expect(posted().attributes.error_messages).toEqual(['cannot read /home/me/secret.txt']);

    fetchMock.mockClear();
    writeFileSync(join(home, 'analytics-reduction-projects.json'), JSON.stringify([project]));
    await sender().sendSessionMetric(toolUsageMetric(), gone);
    expect(posted().attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
  });

  it('reduces when a nested .codemie without the flag sits under a root that has it (CR-002)', async () => {
    setReduction(project, true);
    mkdirSync(join(project, '.git'));
    const nested = join(project, 'packages', 'billing');
    mkdirSync(join(nested, '.codemie'), { recursive: true });
    writeFileSync(join(nested, '.codemie', 'codemie-cli.config.json'), JSON.stringify({ version: 2, activeProfile: 'p', profiles: {} }));
    await sender().sendSessionMetric(toolUsageMetric(), nested);
    expect(posted().attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
  });

  it('reads the setting on every send', async () => {
    setReduction(project, false);
    await sender().sendSessionMetric(toolUsageMetric(), project);
    setReduction(project, true);
    await sender().sendSessionMetric(toolUsageMetric(), project);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).attributes.error_messages).toEqual(['cannot read /home/me/secret.txt']);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).attributes.error_messages).toEqual(['REDACTED:ERROR-MESSAGES']);
  });
});
