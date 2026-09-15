/** Reproduce a historical Claude analytics report without changing the source family. Run from the repository root with explicit private input/output paths. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const [nativePath, sessionId, cutoffIso, outputDir, runDir, originalReport] = process.argv.slice(2);
if (![nativePath, sessionId, cutoffIso, outputDir, runDir, originalReport].every(Boolean)) throw new Error('Arguments: nativePath sessionId cutoffISO privateOutputDir runDir originalReport');
const repo = process.cwd();
const cutoff = Date.parse(cutoffIso);
const load = async (name) => import(pathToFileURL(path.join(repo, 'dist', name)).href);
const [{ ClaudeSessionAdapter }, { ClaudePluginMetadata }, { synthesizeRawSession }, { enrichCosts }, { AnalyticsAggregator }, { buildPayload }, { generateReport, generateReportJson }, { gatherDedupedUsageRecords }, { INTERNAL_PARSED_FAMILY }] = await Promise.all([
  load('agents/plugins/claude/claude.session.js'), load('agents/plugins/claude/claude.plugin.js'), load('cli/commands/analytics/native-loader.js'), load('cli/commands/analytics/cost/cost-enricher.js'), load('cli/commands/analytics/aggregator.js'), load('cli/commands/analytics/report/payload-builder.js'), load('cli/commands/analytics/report/report-generator.js'), load('cli/commands/analytics/cost/usage-readers.js'), load('cli/commands/analytics/data-loader.js')
]);
const hash = (content) => createHash('sha256').update(content).digest('hex');
const originalHashBefore = hash(await fs.readFile(originalReport));
const sourceDir = path.join(path.dirname(nativePath), sessionId, 'subagents');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-analytics-cutoff-'));
const targetDir = path.join(temp, sessionId, 'subagents');
const manifest = [];
const copyCutoff = async (source, destination) => {
  const content = await fs.readFile(source, 'utf8');
  const rows = content.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const filtered = rows.filter(row => !Number.isFinite(Date.parse(row.timestamp)) || Date.parse(row.timestamp) <= cutoff);
  manifest.push({ file: path.basename(source), sourceHash: hash(content), sourceBytes: Buffer.byteLength(content), keptRows: filtered.length });
  if (!filtered.some(row => Number.isFinite(Date.parse(row.timestamp)) && Date.parse(row.timestamp) <= cutoff)) return false;
  await fs.writeFile(destination, filtered.map(row => JSON.stringify(row)).join('\n')+'\n', { mode: 0o600 });
  return true;
};
let result;
try {
  await fs.mkdir(targetDir, { recursive: true });
  const snapshotNative = path.join(temp, sessionId+'.jsonl');
  await copyCutoff(nativePath, snapshotNative);
  for (const filename of (await fs.readdir(sourceDir)).filter(name => name.startsWith('agent-') && name.endsWith('.jsonl')).sort()) {
    if (!await copyCutoff(path.join(sourceDir, filename), path.join(targetDir, filename))) continue;
    const metadataName = filename.replace('.jsonl', '.meta.json');
    try { await fs.copyFile(path.join(sourceDir, metadataName), path.join(targetDir, metadataName)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const adapter = new ClaudeSessionAdapter(ClaudePluginMetadata);
  const parsed = await adapter.parseSessionFile(snapshotNative, sessionId);
  parsed.metadata.projectPath = nativePath;
  for (const agent of parsed.subagents ?? []) agent.filePath = path.join(sourceDir, path.basename(agent.filePath));
  const raw = synthesizeRawSession('claude', { sessionId, filePath: nativePath, createdAt: cutoff, updatedAt: cutoff }, parsed);
  // A historical capture explicitly represents the cutoff, not the reproduction wall clock.
  raw[INTERNAL_PARSED_FAMILY].capturedAt = cutoff;
  let reparses = 0;
  const { index, summary } = await enrichCosts([raw], {
    resolveAgentName: () => 'claude', loadAgentSessionFile: async () => nativePath,
    parseNative: async () => { reparses += 1; return parsed; }
  });
  const analytics = AnalyticsAggregator.aggregate([raw], true, new Set([sessionId]));
  const payload = buildPayload(analytics, index, summary, { generatedAt: new Date().toISOString(), rangeLabel: 'historical snapshot', projectFilter: 'all' });
  const htmlPath = path.join(outputDir, 'claude-session-historical-corrected.html');
  const jsonPath = path.join(outputDir, 'claude-session-historical-corrected.report.json');
  generateReport(payload, htmlPath);
  generateReportJson(payload, jsonPath);
  const exported = JSON.parse(await fs.readFile(jsonPath, 'utf8'));
  const html = await fs.readFile(htmlPath, 'utf8');
  const match = html.match(/window\.__ANALYTICS__\s*=\s*([\s\S]*?);\s*<\/script>/);
  if (!match) throw new Error('Embedded report payload not found');
  const embedded = JSON.parse(match[1]);
  const row = exported.sessions.find(session => session.sessionId === sessionId);
  const dispatches = row.dispatches ?? [];
  const records = gatherDedupedUsageRecords('claude', parsed, new Set());
  const reference = JSON.parse(await fs.readFile(path.join(runDir, 'session-reconciliation.json'), 'utf8'));
  const checks = [];
  const check = (name, actual, expected) => { checks.push({ name, pass: typeof expected === 'number' ? Math.abs(actual - expected) <= 1e-8 : JSON.stringify(actual) === JSON.stringify(expected), actual, expected }); };
  check('exactHTMLJSONPayloadParity', embedded, exported);
  // Replace bulky equality proof with a numeric receipt; raw report data stays private.
  checks[checks.length-1] = { name: 'exactHTMLJSONPayloadParity', pass: JSON.stringify(embedded) === JSON.stringify(exported) };
  check('captureReparseCount', reparses, 0);
  check('privateCapturePresentInternally', Object.getOwnPropertySymbols(raw).includes(INTERNAL_PARSED_FAMILY), true);
  check('privateCaptureExcluded', /\"messages\"\s*:/.test(JSON.stringify(raw)), false);
  check('privateTranscriptExcluded', /"messages"\s*:|"requestShape"\s*:|"toolUseId"\s*:|"_taskId"\s*:|"_toolUseId"\s*:/.test(JSON.stringify(exported)), false);
  check('sessionCount', exported.sessions.length, 1);
  check('uniqueResponses', records.length, reference.independent.uniqueResponses);
  for (const key of Object.keys(reference.independent.tokens)) check('tokens.'+key, row.tokens[key], reference.independent.tokens[key]);
  check('totalCostUSD', row.costUSD, reference.independent.officialRateCostUSD);
  const oldRates = { 'claude-sonnet-5': [3,15,0.3,3.75,6], 'claude-opus-5': [5,25,0.5,6.25,10], 'claude-haiku-4-5-20251001': [1,5,0.1,1.25,2] };
  const oldRateCostUSD = records.reduce((total, record) => { const rate = oldRates[record.model]; if (!rate) throw new Error('No historical rate for '+record.model); const u=record.usage; return total+(u.input*rate[0]+u.output*rate[1]+u.cacheRead*rate[2]+(u.cacheCreation-(u.cacheCreation1h??0))*rate[3]+(u.cacheCreation1h??0)*rate[4])/1e6; },0);
  check('oldRateCostUSD', oldRateCostUSD, reference.independent.configuredRateCostUSD);
  check('headlineCostUSD', exported.meta.totals.totalCostUSD, row.costUSD);
  check('rootOwnCostUSD', row.rootOwnCostUSD, reference.independent.rootOwnOfficialCostUSD);
  const agents = dispatches.filter(dispatch => dispatch.kind === 'agent');
  const depthCounts = Object.fromEntries([1,2,3].map(depth => [depth, agents.filter(agent => agent.depth === depth).length]));
  check('depthCounts', depthCounts, reference.independent.depthCounts);
  check('agentCalls', agents.length, reference.independent.agentCalls);
  check('skillCalls', dispatches.filter(dispatch => dispatch.kind === 'skill').length, reference.independent.skillCalls);
  check('commandCalls', dispatches.filter(dispatch => dispatch.kind === 'command').length, reference.independent.commandCalls);
  check('dispatchesComplete', row.dispatchesComplete, true);
  const topLevelInclusiveCostUSD = agents.filter(agent => agent.depth === 1).reduce((sum, agent) => sum + (agent.inclusiveCostUSD ?? 0), 0);
  check('topLevelInclusiveCostUSD', topLevelInclusiveCostUSD, reference.independent.topLevelInclusiveOfficialCostUSD);
  check('disjointAccountingCostUSD', row.rootOwnCostUSD + topLevelInclusiveCostUSD + (row.unlinkedCostUSD ?? 0), row.costUSD);
  check('unlinkedCostUSD', row.unlinkedCostUSD, 0);
  check('observedEnd', new Date(row.observedEnd).toISOString(), reference.independent.activityEnd);
  check('durationMs', row.durationMs, reference.independent.activitySpanMs);
  check('costSeriesEndpointUSD', row.costSeries.at(-1).cost, row.costUSD);
  check('costSeriesEndpointTokens', row.costSeries.at(-1).tokens, row.tokens.total);
  check('costSource', row.costSource, 'native-estimate');
  check('costBasis', row.costBasis, 'standard-api-tokens');
  check('aggregateAgentCalls', row.agentInvocations.reduce((sum, stat) => sum+stat.totalCalls, 0), agents.length);
  check('aggregateSkillCalls', row.skillInvocations.reduce((sum, stat) => sum+stat.totalCalls, 0), 9);
  check('aggregateCommandCalls', row.commandInvocations.reduce((sum, stat) => sum+stat.totalCalls, 0), 3);
  for (const trace of reference.traces) {
    const agent = agents.find(dispatch => dispatch.agentId === trace.id);
    check('agentPresent.'+trace.id, Boolean(agent), true);
    if (agent) {
      check('agentOwnCost.'+trace.id, agent.costUSD, trace.ownOfficialCostUSD);
      check('agentInclusiveCost.'+trace.id, agent.inclusiveCostUSD, trace.subtreeOfficialCostUSD);
      check('agentOwnTokens.'+trace.id, agent.tokens, trace.ownTokens);
      check('agentInclusiveTokens.'+trace.id, agent.inclusiveTokens, trace.subtreeTokens);
    }
  }
  const requirements = agents.find(agent => agent.name === 'sdlc-factory:requirements-reader');
  check('requirementsReaderAckMs', requirements?.acknowledgedAt - requirements?.start, 1424);
  check('requirementsReaderElapsedMs', requirements?.elapsedMs, 412438);
  const slice = agents.filter(agent => agent.name === 'sdlc-factory:slice-runner').sort((a,b) => a.start-b.start)[3];
  check('fourthSliceIncomplete', slice?.status, 'incomplete');
  check('originalReportUnchanged', hash(await fs.readFile(originalReport)), originalHashBefore);
  result = {
    status: checks.every(item=>item.pass) ? 'PASS' : 'FAIL', reviewedHead: '667bdc219292b55958fc4f21ef8eb74fed0d0d99', generatedAt: new Date().toISOString(),
    originalReport: { sha256: originalHashBefore, unchangedDuringValidation: checks.at(-1).pass, researchBaselineSha256: '375cf250b6db7b1f035ed828c00192d4c8c519cbb8ab3e177f94ce5e10924842', matchesResearchBaseline: originalHashBefore === '375cf250b6db7b1f035ed828c00192d4c8c519cbb8ab3e177f94ce5e10924842', note: 'The supplied report differs from the initial research snapshot. Its observed bytes were unchanged during final validation; the writer of the intervening change was not established. Historical comparisons use the original research cutoff and numeric receipt. The validation script never writes to the input report.' },
    historical: { cutoff: cutoffIso, htmlPath, jsonPath, oldRateCostUSD, costUSD: row.costUSD, rootOwnCostUSD: row.rootOwnCostUSD, topLevelInclusiveCostUSD, unlinkedCostUSD: row.unlinkedCostUSD, tokens: row.tokens, uniqueResponses: records.length, dispatchCount: dispatches.length, agentCalls: agents.length, skillCalls: dispatches.filter(d=>d.kind==='skill').length, commandCalls: dispatches.filter(d=>d.kind==='command').length, depthCounts, observedStart: row.observedStart, observedEnd: row.observedEnd, durationMs: row.durationMs, requirementsReader: requirements && { id: requirements.id, acknowledgedAt: requirements.acknowledgedAt, completedAt: requirements.completedAt, acknowledgementDelayMs: requirements.durationMs, elapsedMs: requirements.elapsedMs, status: requirements.status }, fourthSlice: slice && { id: slice.id, status: slice.status, acknowledgementDelayMs: slice.durationMs, elapsedMs: slice.elapsedMs, observedEnd: slice.observedEnd }, source: row.costSource, basis: row.costBasis, htmlJSONParity: checks[0].pass },
    checks: { total: checks.length, passed: checks.filter(item=>item.pass).length, failed: checks.filter(item=>!item.pass) },
    sourceSnapshot: { transcriptCount: manifest.length, historicalTranscriptCount: (parsed.subagents?.length ?? 0)+1, temporarySnapshotRemoved: true }
  };
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
await fs.writeFile(path.join(runDir, 'validation-summary.json'), JSON.stringify(result, null, 2)+'\n');
console.log(JSON.stringify(result, null, 2));
if (result.status !== 'PASS') process.exitCode = 1;
