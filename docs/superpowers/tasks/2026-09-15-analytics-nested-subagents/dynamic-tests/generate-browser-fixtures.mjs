
import { generateReport, generateReportJson } from '../../../../../dist/cli/commands/analytics/report/report-generator.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const t = Date.parse('2026-09-15T08:00:00Z');
const tok = total => ({ input: total / 2, output: total / 10, cacheRead: total / 5, cacheCreation: total / 5, total });
const sumTok = arr => tok(arr.reduce((sum, x) => sum + x.total, 0));
const session = (id, overrides = {}) => ({
 sessionId: id, agentName: 'claude', provider: 'fixture', project: '/synthetic/browser-validation',
 branch: 'synthetic-fixture', title: 'Synthetic report fixture ' + id, startTime: t, durationMs: 900000,
 turns: 20, fileOps: 10, linesAdded: 20, linesRemoved: 5, linesModified: 3, netLines: 15,
 filesChanged: 5, filesWritten: 2, filesEdited: 3, toolCallsTotal: 10, toolCallsSuccess: 9,
 toolCallsFailure: 1, models: ['fixture-model'], languages: ['TypeScript'],
 tools: [{toolName:'Read',totalCalls:10,successCount:9,failureCount:1}],
 skillInvocations: [], agentInvocations: [], commandInvocations: [], sessionSource: 'Synthetic',
 tokens: tok(2600), costUSD: 2.25, cacheReadCostUSD: .2,
 perModelCost: [{model:'fixture-model',tokens:tok(2600),costUSD:2.25,cacheReadCostUSD:.2,unpriced:false}],
 hadLog: true, ...overrides
});
const ds = Array.from({length:80}, (_,i) => ({
 kind:'agent',name:'duplicate-worker',id:'step-'+i,agentId:'agent-'+i,
 ownerAgentId:i===0?'synthetic-deep':'agent-'+Math.floor((i-1)/2),
 ...(i ? {parentId:'step-'+Math.floor((i-1)/2)}:{}),
 relationshipStatus:i===0?'root':'resolved',depth:Math.floor(Math.log2(i+1))+1,
 start:t+i*1000, acknowledgedAt:t+i*1000+25, observedEnd:t+890000-i*1000,
 completedAt:t+890000-i*1000, elapsedMs:890000-2*i*1000,durationMs:25,
 status:'completed',attributionStatus:'exact',attributionScope:'own',
 tokens:tok((i+1)*100),costUSD:(i+1)*.01000001,tools:[{name:'Read',calls:i+1}]
}));
for (let i=79;i>=0;i--) {
 const descendants = [ds[i], ...ds.filter((_,j)=>j>i && (()=>{let p=Math.floor((j-1)/2);while(p>i)p=Math.floor((p-1)/2);return p===i;})())];
 ds[i].inclusiveTokens=sumTok(descendants.map(d=>d.tokens));
 ds[i].inclusiveCostUSD=descendants.reduce((s,d)=>s+d.costUSD,0);
}
for(let i=0;i<5;i++) ds.push({
 kind:i<3?'skill':'command',name:i<3?'synthetic-skill':'synthetic-command',
 id:'annotation-'+i,ownerAgentId:'agent-'+(i+1),parentId:'step-'+(i+1),
 relationshipStatus:'resolved',depth:3,start:t+20000+i*1000,durationMs:1200,elapsedMs:1200,
 observedEnd:t+21200+i*1000,completedAt:t+21200+i*1000,status:'completed',
 attributionStatus:'estimated',attributionScope:'own',tokens:tok(100),costUSD:.001
});
const rootCost=.5,unlinkedCost=.25;
const totalTokens=1000+500+ds.filter(d=>d.kind==='agent').reduce((s,d)=>s+d.tokens.total,0);
const totalCost=rootCost+unlinkedCost+ds.filter(d=>d.kind==='agent').reduce((s,d)=>s+d.costUSD,0);
const deep=session('synthetic-deep',{
 tokens:tok(totalTokens),costUSD:totalCost,dispatches:ds,dispatchesComplete:true,
 observedStart:t,observedEnd:t+900000,capturedAt:t+901000,costSource:'native-estimate',costBasis:'standard-api-tokens',
 rootOwnTokens:tok(1000),rootOwnCostUSD:rootCost,unlinkedTokens:tok(500),unlinkedCostUSD:unlinkedCost,
 unlinkedAgentIds:['unlinked-synthetic'],perModelCost:[{model:'fixture-model',tokens:tok(totalTokens),costUSD:totalCost,cacheReadCostUSD:.2}],
 costSeries:[{t,cost:.5,tokens:1000},{t:t+900000,cost:totalCost,tokens:totalTokens}]
});
const legacy=session('synthetic-legacy',{
 dispatches:[{kind:'agent',name:'legacy-worker',start:t+100,durationMs:1200},
 {kind:'skill',name:'legacy-skill',start:t+1500,durationMs:200},
 {kind:'command',name:'legacy-command',start:t+1800,durationMs:300}],
 agentInvocations:[{name:'legacy-worker',totalCalls:7}],skillInvocations:[{name:'legacy-skill',totalCalls:5}],
 commandInvocations:[{name:'legacy-command',totalCalls:3}],dispatchesComplete:false
});
const reported=session('synthetic-source-reported',{
 agentName:'codex',costSource:'authoritative',costBasis:'source-reported',dispatchesComplete:true,
 dispatches:[{kind:'agent',name:'source-worker',id:'source-step',ownerAgentId:'synthetic-source-reported',
 start:t+1000,durationMs:1100,status:'completed',costUSD:2.25,tokens:tok(2600),attributionScope:'own'}],
 costSeries:[{t,cost:0,tokens:0},{t:t+900000,cost:2.25,tokens:2600}]
});
const noTimeline=session('synthetic-no-timeline',{
 agentName:'gemini',rootOwnTokens:tok(2000),rootOwnCostUSD:2,unlinkedTokens:tok(600),unlinkedCostUSD:.25,
 unlinkedAgentIds:['synthetic-unlinked-one','synthetic-unlinked-two']
});
const unfinished=session('synthetic-incomplete',{
 costSource:'native-estimate',costBasis:'standard-api-tokens',dispatchesComplete:true,
 observedStart:t,observedEnd:t+900000,capturedAt:t+901000,
 dispatches:[
 {kind:'agent',name:'incomplete-worker',id:'unfinished',ownerAgentId:'synthetic-incomplete',relationshipStatus:'root',start:t+1000,acknowledgedAt:t+1050,observedEnd:t+11000,elapsedMs:10000,durationMs:50,status:'incomplete',attributionStatus:'unavailable'},
 {kind:'agent',name:'unknown-worker',id:'unknown',ownerAgentId:'synthetic-incomplete',relationshipStatus:'root',start:t+2000,acknowledgedAt:t+2050,durationMs:50,status:'unknown',attributionStatus:'unavailable'},
 {kind:'agent',name:'missing-parent',id:'missing',parentId:'absent',start:t+3000,durationMs:200,status:'unknown',relationshipStatus:'missing',attributionStatus:'ambiguous'},
 {kind:'agent',name:'cycle-worker',id:'cycle-a',parentId:'cycle-b',start:t+4000,durationMs:200,status:'unknown',relationshipStatus:'cycle',attributionStatus:'ambiguous'},
 {kind:'agent',name:'cycle-worker',id:'cycle-b',parentId:'cycle-a',start:t+5000,durationMs:200,status:'unknown',relationshipStatus:'cycle',attributionStatus:'ambiguous'},
 {kind:'agent',name:'failed-worker',id:'failed',ownerAgentId:'synthetic-incomplete',relationshipStatus:'root',start:t+6000,completedAt:t+6600,elapsedMs:600,durationMs:20,status:'failed',costUSD:0,tokens:tok(0),attributionScope:'own'}
 ]
});
const payload = sessions => ({
 meta:{generatedAt:'2026-09-15T08:20:00Z',rangeLabel:'all',agents:[...new Set(sessions.map(s=>s.agentName))],projectFilter:'all',
 totals:{sessions:sessions.length,durationMs:sessions.reduce((s,x)=>s+x.durationMs,0),turns:sessions.reduce((s,x)=>s+x.turns,0),
 files:50,netLines:75,toolCallsTotal:50,toolSuccessRate:90,totalCostUSD:sessions.reduce((s,x)=>s+x.costUSD,0),cacheReadCostUSD:1,pricedSessions:sessions.length},
 coverage:[...new Set(sessions.map(s=>s.agentName))].map(agentName=>({agentName,total:sessions.filter(s=>s.agentName===agentName).length,priced:sessions.filter(s=>s.agentName===agentName).length,withLog:sessions.filter(s=>s.agentName===agentName).length})),unpricedModels:[]},
 sessions
});
for(const [name,sessions] of [['synthetic-deep-traces',[deep]],['legacy-nonclaude-incomplete',[legacy,reported,noTimeline,unfinished]]]) {
 generateReport(payload(sessions),join(here,name+'.html'));
 generateReportJson(payload(sessions),join(here,name+'.json'));
}
