import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ParsedSession } from '../../../../agents/core/session/BaseSessionAdapter.js';
import type { ProcessingContext } from '../../../../agents/core/session/BaseProcessor.js';
import { ClaudeSessionAdapter } from '../../../../agents/plugins/claude/claude.session.js';
import { ClaudePluginMetadata } from '../../../../agents/plugins/claude/claude.plugin.js';
import { PiSessionAdapter } from '../../../../agents/plugins/pi/pi.session.js';
import { PiPluginMetadata } from '../../../../agents/plugins/pi/pi.plugin.js';
import { CopilotCliMetricsProcessor } from '../../../../agents/plugins/copilot-cli/session/processors/copilot-cli.metrics-processor.js';
import { MetricsWriter } from '../../../../providers/plugins/sso/session/processors/metrics/MetricsWriter.js';
import { MetricsSyncProcessor } from '../../../../providers/plugins/sso/session/processors/metrics/metrics-sync-processor.js';
import { MetricsSender } from '../../../../providers/plugins/sso/session/processors/metrics/metrics-api-client.js';
import { logger } from '../../../../utils/logger.js';
import { synthesizeRawSession } from '../native-loader.js';
import { AnalyticsAggregator } from '../aggregator.js';
import { MetricsDataLoader, type RawSessionData } from '../data-loader.js';
import { enrichCosts } from '../cost/cost-enricher.js';
import { costBreakdown } from '../cost/cost-calculator.js';
import { lookupPrice } from '../../../../utils/pricing.js';

// These assert the desired contract, not the current defect. A fix makes it.fails fail
// visibly so the expectation can be promoted. Strict mode preserves ordinary red evidence.
const contract = process.env.ANALYTICS_STRICT_CONTRACTS === 'true' ? it : it.fails;
const time = '2026-10-25T12:00:00Z';
const descriptor = { sessionId: 'fixture', filePath: '', projectPath: '/repo', createdAt: Date.parse(time), agentName: 'claude' };

function raw(sessionId: string): RawSessionData {
  return { sessionId, deltas: [], startEvent: {
    type: 'session_start', recordId: sessionId, timestamp: Date.parse(time), codeMieSessionId: sessionId,
    agentName: 'claude', syncStatus: 'synced', data: { provider: 'native', workingDirectory: '/repo', startTime: Date.parse(time) },
  } };
}

describe('KNOWN DEFECT contracts (expected failures, never product PASS)', () => {
  let directory: string;
  let split: RawSessionData;
  let supplement: RawSessionData;
  let prompts: RawSessionData;
  let pi: RawSessionData;
  let pricedCount: number;
  const concurrentRecords = new Map<boolean, string[]>();

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), 'analytics-known-contracts-'));
    vi.stubEnv('CODEMIE_HOME', directory);
    const file = join(directory, 'claude.jsonl');
    writeFileSync(file, [
      { type: 'user', uuid: 'u1', timestamp: time, cwd: '/repo', message: { role: 'user', content: 'read a.ts' } },
      { type: 'assistant', uuid: 'a1', timestamp: time, cwd: '/repo', requestId: 'r1',
        message: { id: 'm1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'text', text: 'reading' }] } },
      { type: 'assistant', uuid: 'a2', timestamp: time, cwd: '/repo', requestId: 'r1',
        message: { id: 'm1', role: 'assistant', model: 'claude-haiku-4-5', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.ts' } }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const claude = new ClaudeSessionAdapter(ClaudePluginMetadata);
    const parsed = await claude.parseSessionFile(file, 'split');
    expect(parsed.messages.filter((line) => (line as { type?: string }).type === 'assistant')).toHaveLength(2);
    split = synthesizeRawSession('claude', { ...descriptor, sessionId: 'split', filePath: file }, parsed);

    const processor = new CopilotCliMetricsProcessor();
    const context: ProcessingContext = { apiBaseUrl: 'http://127.0.0.1', cookies: '', clientType: 'qa',
      version: 'fixture', dryRun: true, agentSessionId: 'native-fixture', gitBranch: 'main' };
    const copilot: ParsedSession = { sessionId: 'supplement', agentName: 'copilot-cli', metadata: {},
      messages: [{ type: 'assistant', timestamp: time, message: { model: 'claude-haiku-4-5' } }], metrics: { tools: {} } };
    expect((await processor.process(copilot, context)).success).toBe(true);
    expect((await processor.process({ ...copilot, metrics: { tools: { read: 1 } } }, context)).success).toBe(true);
    expect((await processor.process({ ...copilot, metrics: { tools: { read: 1 } } }, context)).success).toBe(true);
    supplement = { ...raw('supplement'), deltas: await new MetricsWriter('supplement').readAll() };
    expect(supplement.deltas.map((delta) => delta.recordId)).toEqual(['native-fixture-turn-0', 'native-fixture-supplement-1']);

    const multi: ParsedSession = { ...copilot, sessionId: 'prompts',
      messages: [...copilot.messages, { type: 'assistant', timestamp: time, message: { model: 'claude-haiku-4-5' } }],
      metrics: { tools: {}, userPrompts: [{ count: 1, text: 'first' }, { count: 1, text: 'second' }] } };
    expect((await processor.process(multi, context)).success).toBe(true);
    prompts = { ...raw('prompts'), deltas: await new MetricsWriter('prompts').readAll() };
    expect(prompts.deltas).toHaveLength(2);

    const piFile = join(directory, 'pi.jsonl');
    writeFileSync(piFile, [
      { type: 'session', version: 3, id: 'pi-tools', timestamp: time, cwd: '/repo' },
      { type: 'message', id: 'u', parentId: null, timestamp: time, message: { role: 'user', content: 'read a.ts', timestamp: Date.parse(time) } },
      { type: 'message', id: 'a', parentId: 'u', timestamp: time, message: { role: 'assistant', model: 'claude-haiku-4-5',
        content: [{ type: 'toolCall', id: 'c', name: 'read', arguments: { path: '/repo/a.ts' } }], timestamp: Date.parse(time) } },
      { type: 'message', id: 't', parentId: 'a', timestamp: time, message: { role: 'toolResult', toolCallId: 'c',
        toolName: 'read', content: [{ type: 'text', text: 'file' }], isError: false, timestamp: Date.parse(time) } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    const piParsed = await new PiSessionAdapter(PiPluginMetadata).parseSessionFile(piFile, 'pi-tools');
    expect(piParsed.messages).toHaveLength(4);
    pi = synthesizeRawSession('pi', { ...descriptor, sessionId: 'pi-tools', filePath: piFile }, piParsed);

    const { index, summary } = await enrichCosts([raw('unpriced')], {
      resolveAgentName: () => 'claude', loadAgentSessionFile: async () => file,
      parseNative: async () => ({ sessionId: 'unpriced', agentName: 'claude', metadata: {},
        messages: [{ type: 'assistant', message: { model: 'claude-router-standard',
          usage: { input_tokens: 1000, output_tokens: 100 } } }] }),
    });
    expect(index.get('unpriced')?.tokens.total).toBe(1100);
    expect(summary.unpricedModels).toContain('claude-router-standard');
    pricedCount = summary.pricedSessions;

    for (const success of [true, false]) {
      const id = success ? 'race-success' : 'race-failure';
      mkdirSync(join(directory, 'sessions'), { recursive: true });
      writeFileSync(join(directory, 'sessions', `${id}.json`), JSON.stringify({ sessionId: id, agentName: 'claude',
        provider: 'native', workingDirectory: '/repo', project: 'fixture', startTime: Date.parse(time), gitBranch: 'main' }));
      const writer = new MetricsWriter(id);
      const delta = { recordId: `${id}-first`, sessionId: id, agentSessionId: id,
        timestamp: Date.parse(time), gitBranch: 'main', tools: { Read: 1 } };
      await writer.appendDelta(delta);
      const send = vi.spyOn(MetricsSender.prototype, 'sendSessionMetric').mockImplementation(async () => {
        await writer.appendDelta({ ...delta, recordId: `${id}-late` });
        return { success, message: 'local fixture response' };
      });
      try {
        await new MetricsSyncProcessor().process({ sessionId: id, agentName: 'claude', metadata: {}, messages: [] }, context);
        expect(send).toHaveBeenCalledOnce();
        const persisted = await writer.readAll();
        expect(persisted.find((item) => item.recordId === `${id}-first`)?.syncStatus).toBe(success ? 'synced' : 'failed');
        concurrentRecords.set(success, persisted.map((item) => item.recordId));
      } finally {
        send.mockRestore();
      }
    }
  });

  afterAll(async () => {
    await logger.close();
    vi.unstubAllEnvs();
    if (directory) rmSync(directory, { recursive: true, force: true });
  });

  contract('EPMCDME-16626: split records for one native Claude message are one turn at every level', () => {
    const root = AnalyticsAggregator.aggregate([split]);
    expect(root.totalTurns).toBe(1);
    expect(root.projects[0].totalTurns).toBe(1);
    expect(root.projects[0].branches[0].totalTurns).toBe(1);
    expect(root.projects[0].branches[0].sessions[0].totalTurns).toBe(1);
  });
  contract('EPMCDME-16616: a late supplementary tool delta must not add a turn', () => {
    expect(AnalyticsAggregator.aggregate([supplement]).totalTurns).toBe(1);
  });
  contract('EPMCDME-16608: two persisted assistant turns retain both real user prompts', () => {
    expect(prompts.deltas.flatMap((delta) => delta.userPrompts ?? []).reduce((sum, prompt) => sum + prompt.count, 0)).toBe(2);
  });
  contract('EPMCDME-16644: a session with only unresolved usage is not counted as priced', () => {
    expect(pricedCount).toBe(0);
  });
  contract('EPMCDME-16655: slash-separated partial project query matches native Windows path', () => {
    const session = raw('windows');
    session.startEvent!.data.workingDirectory = 'C:\\work\\team\\app';
    expect(new MetricsDataLoader(directory).sessionMatchesFilter(session, { projectPattern: 'team/app' })).toBe(true);
  });
  contract('EPMCDME-16258 tracked scope: native Pi read tool survives disk parser and synthesis', () => {
    expect(AnalyticsAggregator.aggregate([pi]).totalToolCalls).toBe(1);
  });
  contract('Haiku 5.5 long-context: above 100k input uses the published higher token rates', () => {
    const price = lookupPrice('claude-haiku-5-5');
    if (!price) throw new Error('Missing base mapping is a different defect');
    const usage = { input: 110000, output: 1000, cacheRead: 10000, cacheCreation: 5000, cacheCreation1h: 1000, total: 126000 };
    // .11*.5 + .001*2.5 + .01*.05 + .004*.625 + .001*1 = .0615 USD.
    expect(costBreakdown(usage, price).total).toBeCloseTo(0.0615, 10);
  });
  contract.each([true, false])('EPMCDME-16546: append during sync survives success=%s without erasing local metrics', (success) => {
    const id = success ? 'race-success' : 'race-failure';
    expect(concurrentRecords.get(success)).toEqual([`${id}-first`, `${id}-late`]);
  });
});
