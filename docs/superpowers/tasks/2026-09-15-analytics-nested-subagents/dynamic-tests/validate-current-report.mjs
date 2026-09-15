/** Verify a generated real-session CLI report against immutable timestamp-filtered raw usage. Inputs and generated reports remain outside git. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
const [nativePath, htmlPath, jsonPath, runDir, originalReport] = process.argv.slice(2);
if (![nativePath, htmlPath, jsonPath, runDir, originalReport].every(Boolean)) throw new Error('Arguments: nativePath privateHTML privateJSON runDir originalReport');
const readPayload = async (file) => JSON.parse((await fs.readFile(file,'utf8')).match(/window\.__ANALYTICS__\s*=\s*([\s\S]*?);\s*<\/script>/)[1]);
const summary = JSON.parse(await fs.readFile(path.join(runDir,'validation-summary.json'),'utf8'));
const payload = JSON.parse(await fs.readFile(jsonPath,'utf8'));
const embedded = await readPayload(htmlPath);
const row = payload.sessions[0];
const cutoff = row.capturedAt;
const familyDir = path.join(path.dirname(nativePath),row.sessionId,'subagents');
const paths = [nativePath,...(await fs.readdir(familyDir)).filter(name=>name.startsWith('agent-')&&name.endsWith('.jsonl')).sort().map(name=>path.join(familyDir,name))];
const records = new Map();
const weight = (usage) => (usage.input_tokens??0)+(usage.output_tokens??0)+(usage.cache_read_input_tokens??0)+(usage.cache_creation_input_tokens??0);
let readRows=0;
for (const file of paths) {
  const lines=(await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const raw=JSON.parse(line);
    if(Date.parse(raw.timestamp)>cutoff)continue;
    readRows++;
    const message=raw.message;
    if(!message?.usage || !message.model || message.model.startsWith('<'))continue;
    const key=(message.id??'')+'::'+(raw.requestId??'');
    if(key==='::')throw new Error('Independent verification encountered unkeyable usage');
    const existing=records.get(key);
    if(!existing || weight(message.usage)>weight(existing.message.usage) || (weight(message.usage)===weight(existing.message.usage) && Date.parse(raw.timestamp)>Date.parse(existing.timestamp)))records.set(key,{...raw,owner:file===nativePath?row.sessionId:path.basename(file,'.jsonl').replace('agent-','')});
  }
}
const tokens={input:0,output:0,cacheRead:0,cacheCreation:0,cacheCreation1h:0,total:0};
const byOwner=new Map();
const byModel=new Map();
let costUSD=0;
const knownRates={
  'claude-sonnet-5':[2,10,0.2,2.5,4],
  'claude-opus-5':[5,25,0.5,6.25,10],
  'claude-haiku-4-5-20251001':[1,5,0.1,1.25,2]
};
for(const raw of records.values()) {
  const usage=raw.message.usage;
  const t={input:usage.input_tokens??0,output:usage.output_tokens??0,cacheRead:usage.cache_read_input_tokens??0,cacheCreation:usage.cache_creation_input_tokens??0,cacheCreation1h:usage.cache_creation?.ephemeral_1h_input_tokens??0};
  t.total=t.input+t.output+t.cacheRead+t.cacheCreation;
  for(const key of Object.keys(tokens))tokens[key]+=t[key];
  const rates=knownRates[raw.message.model];
  if(!rates)throw new Error('No independently verified rate for model '+raw.message.model);
  const cost=(t.input*rates[0]+t.output*rates[1]+t.cacheRead*rates[2]+(t.cacheCreation-t.cacheCreation1h)*rates[3]+t.cacheCreation1h*rates[4])/1e6;
  costUSD+=cost;
  byOwner.set(raw.owner,(byOwner.get(raw.owner)??0)+cost);
  byModel.set(raw.message.model,(byModel.get(raw.message.model)??0)+cost);
}
const checks=[];
const equal=(name,actual,expected)=>checks.push({name,pass:typeof expected==='number'?Math.abs(actual-expected)<=1e-8:JSON.stringify(actual)===JSON.stringify(expected),actual,expected});
equal('currentHTMLJSONParity',JSON.stringify(embedded)===JSON.stringify(payload),true);
equal('currentRawCostUSD',row.costUSD,costUSD);
equal('currentRawTokens',row.tokens,tokens);
equal('currentRawRootOwnCostUSD',row.rootOwnCostUSD,byOwner.get(row.sessionId));
const agents=row.dispatches.filter(d=>d.kind==='agent');
const topLevelInclusive=agents.filter(a=>a.depth===1).reduce((sum,a)=>sum+(a.inclusiveCostUSD??0),0);
equal('currentDisjointAccountingCostUSD',row.rootOwnCostUSD+topLevelInclusive+(row.unlinkedCostUSD??0),row.costUSD);
equal('currentHeadlineCostUSD',payload.meta.totals.totalCostUSD,row.costUSD);
equal('currentSeriesEndpointCostUSD',row.costSeries.at(-1).cost,row.costUSD);
equal('currentSeriesEndpointTokens',row.costSeries.at(-1).tokens,row.tokens.total);
equal('currentAgentOwnSum',agents.reduce((sum,a)=>sum+(a.costUSD??0),0)+row.rootOwnCostUSD+(row.unlinkedCostUSD??0),row.costUSD);
equal('currentDispatchesComplete',row.dispatchesComplete,true);
equal('currentCostSource',row.costSource,'native-estimate');
equal('currentCostBasis',row.costBasis,'standard-api-tokens');
equal('currentNoPrivateTranscript',/"messages"\s*:|"requestShape"\s*:|"toolUseId"\s*:|"_taskId"\s*:|"_toolUseId"\s*:/.test(JSON.stringify(payload)),false);
equal('currentStableUniqueDispatchIDs',new Set(row.dispatches.map(d=>d.id)).size,row.dispatches.length);
for(const kind of ['agent','skill','command'])equal('currentAggregate.'+kind,row[kind+'Invocations'].reduce((sum,d)=>sum+d.totalCalls,0),row.dispatches.filter(d=>d.kind===kind).length);
const original=await fs.readFile(originalReport);
const originalPayload=JSON.parse(original.toString('utf8').match(/window\.__ANALYTICS__\s*=\s*([\s\S]*?);\s*<\/script>/)[1]);
const originalHash=createHash('sha256').update(original).digest('hex');
equal('suppliedReportUnchangedSinceFirstValidationRead',originalHash,summary.originalReport.sha256);
summary.current={
  command:'node bin/codemie.js analytics --report --report-format both --include-external --session '+row.sessionId+' --report-output '+htmlPath,
  htmlPath,jsonPath,generatedAt:payload.meta.generatedAt,capturedAt:new Date(row.capturedAt).toISOString(),observedStart:new Date(row.observedStart).toISOString(),observedEnd:new Date(row.observedEnd).toISOString(),durationMs:row.durationMs,
  costUSD:row.costUSD,independentRawCostUSD:costUSD,rootOwnCostUSD:row.rootOwnCostUSD,topLevelInclusiveCostUSD:topLevelInclusive,unlinkedCostUSD:row.unlinkedCostUSD,tokens:row.tokens,uniqueResponses:records.size,independentRawRowsAtCapture:readRows,
  dispatchCount:row.dispatches.length,counts:Object.fromEntries(['agent','skill','command'].map(kind=>[kind,row.dispatches.filter(d=>d.kind===kind).length])),depthCounts:agents.reduce((a,d)=>(a[d.depth]=(a[d.depth]??0)+1,a),{}),costSource:row.costSource,costBasis:row.costBasis,htmlJSONParity:checks[0].pass,
  checks:{total:checks.length,passed:checks.filter(c=>c.pass).length,failed:checks.filter(c=>!c.pass)}
};
Object.assign(summary.originalReport,{researchBaselineGeneratedAt:'2026-09-15T10:32:22.610Z',researchBaselineBytes:2056006,researchBaselineTargetCostUSD:45.1709518,observedBeforeSha256:summary.originalReport.sha256,observedAfterSha256:originalHash,observedBytes:original.length,observedGeneratedAt:originalPayload.meta.generatedAt,observedTargetCostUSD:originalPayload.sessions.find(s=>s.sessionId===row.sessionId)?.costUSD,unchangedDuringValidation:summary.originalReport.sha256===originalHash});
summary.status=summary.checks.failed.length===0&&checks.every(c=>c.pass)?'PASS':'FAIL';
summary.generatedAt=new Date().toISOString();
await fs.writeFile(path.join(runDir,'validation-summary.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({status:summary.status,current:summary.current,originalReport:summary.originalReport},null,2));
if(summary.status!=='PASS')process.exitCode=1;
