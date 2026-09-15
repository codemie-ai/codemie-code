
async (page) => {
 const config = {"id":"legacy-nonclaude-incomplete","html":"/Users/Vadym_Vlasenko/AI/projects/codemie-code/docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/dynamic-tests/legacy-nonclaude-incomplete.html","json":"/Users/Vadym_Vlasenko/AI/projects/codemie-code/docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/dynamic-tests/legacy-nonclaude-incomplete.json","screenshotDir":"/Users/Vadym_Vlasenko/AI/projects/codemie-code/docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/evidence/screenshots","url":"file:///Users/Vadym_Vlasenko/AI/projects/codemie-code/docs/superpowers/tasks/2026-09-15-analytics-nested-subagents/dynamic-tests/legacy-nonclaude-incomplete.html","payloadHash":"3414f5f1c16f52201ba8fb35772be763be79e3e481b6f82038ee0dffd0017760"};
 let assertions=0;
 const consoleErrors=[],networkFailures=[],screenshots=[];
 const check=(ok,label)=>{if(!ok)throw new Error('SOURCE_ASSERTION: '+label);assertions++;};
 const num=text=>Number(String(text).replace(/[$,]/g,''));
 const near=(a,b)=>Math.abs(a-b)<1e-7;
 const compact=(str,n)=>{const m=String(str).match(/^([\d.]+)([KMB])?$/);if(!m)return false;const scale={K:1e3,M:1e6,B:1e9}[m[2]]||1;return Math.abs(Number(m[1])*scale-n)<=(m[2]?scale*.0500001:0);};
 const errors=msg=>{if(msg.type()==='error')consoleErrors.push(msg.text());};
 const pageError=error=>consoleErrors.push(String(error));
 const failed=request=>networkFailures.push(request.url());
 const response=res=>{if(res.status()>=400)networkFailures.push(res.url()+' '+res.status());};
 page.on('console',errors);page.on('pageerror',pageError);page.on('requestfailed',failed);page.on('response',response);
 const shot=async name=>{await page.waitForTimeout(1100);if(name.startsWith('timeline'))await page.locator('#session-modal .tl-side').evaluate(n=>n.scrollTop=0);const path=config.screenshotDir+'/'+config.id+'-'+name+'.png';await page.screenshot({path,fullPage:false});screenshots.push(path);};
 const stat=async (root,label)=>root.locator('.mstat').filter({has:page.locator('.mlabel').filter({hasText:new RegExp('^'+label+'$')})}).first().locator('.mval').innerText();
 const card=(root,title)=>root.locator('.card').filter({has:page.locator('.card-title').filter({hasText:new RegExp('^'+title.replace(/[&]/g,'&')+'$')})}).first();
 const counts=(s,kind)=>{const list=kind==='agent'?s.agentInvocations:kind==='skill'?s.skillInvocations:s.commandInvocations;return !s.dispatchesComplete&&list?.length?list.reduce((v,d)=>v+d.totalCalls,0):(s.dispatches||[]).filter(d=>d.kind===kind).length;};
 const elapsed=d=>Number.isFinite(d.elapsedMs)?Math.max(0,d.elapsedMs):Number.isFinite(d.completedAt)?Math.max(0,d.completedAt-d.start):Number.isFinite(d.observedEnd)?Math.max(0,d.observedEnd-d.start):d.status==='unknown'||d.status==='incomplete'?0:Math.max(0,d.durationMs||0);
 try {
 await page.setViewportSize({width:1440,height:1000});
 await page.goto(config.url,{waitUntil:'load'});
 const payload=await page.evaluate(()=>window.__ANALYTICS__);
 const hash=await page.evaluate(async()=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(window.__ANALYTICS__))))).map(x=>x.toString(16).padStart(2,'0')).join(''));
 check(hash===config.payloadHash,'embedded payload equals production JSON');
 check(await page.title()==='CodeMie Analytics','report document title');
 const totalCost=payload.sessions.reduce((x,s)=>x+s.costUSD,0);
 const totalTokens=payload.sessions.reduce((x,s)=>x+s.tokens.total,0);
 const overview=await page.locator('.kpi').evaluateAll(nodes=>nodes.map(n=>({label:n.querySelector('.kpi-label')?.textContent,value:n.querySelector('.kpi-value')?.textContent})));
 const ov=label=>overview.find(n=>n.label===label)?.value;
 check(num(ov('Sessions'))===payload.sessions.length,'overview session count');
 check(num(ov('Turns'))===payload.sessions.reduce((x,s)=>x+s.turns,0),'overview API response count');
 check(compact(ov('Total tokens'),totalTokens),'overview compact total tokens');
 check(Math.abs(num(ov('Est. cost'))-totalCost)<(totalCost>=100?.501:totalCost<.01?.000051:.00501),'overview cost rounding');
 await shot('overview');
 await page.locator('[data-view="toolsmodels"]').click();
 const modelData=await page.evaluate(()=>Object.values(Chart.instances).map(c=>({title:c.canvas.closest('.card')?.querySelector('.card-title')?.textContent,labels:c.data.labels,data:c.data.datasets[0].data})).find(c=>c.title==='Tokens by model'));
 const models={};for(const s of payload.sessions)for(const m of s.perModelCost||[])models[m.model]=(models[m.model]||0)+m.tokens.total;
 for(let i=0;i<modelData.labels.length;i++)check(modelData.data[i]===models[modelData.labels[i]],'aggregate model token bucket '+i);
 await page.locator('[data-view="cost"]').click();
 const costText=await page.locator('body').innerText();
 check(costText.length>0,'cost view rendered');
 const costCharts=await page.evaluate(()=>Object.values(Chart.instances).map(c=>({title:c.canvas.closest('.card')?.querySelector('.card-title')?.textContent,data:c.data.datasets.map(d=>d.data)})));
 for(const c of costCharts.filter(c=>/cost over time|cost by agent/i.test(c.title||'')))check(near(c.data.flat().reduce((a,b)=>a+Number(b),0),totalCost),'aggregate cost chart '+c.title);
 const cm=costCharts.find(c=>c.title==='Cost by model');
 const modelCosts={};for(const s of payload.sessions)for(const m of s.perModelCost||[])modelCosts[m.model]=(modelCosts[m.model]||0)+m.costUSD;
 const cmLabels=await page.evaluate(()=>Object.values(Chart.instances).find(c=>c.canvas.closest('.card')?.querySelector('.card-title')?.textContent==='Cost by model')?.data.labels||[]);
 for(let i=0;i<cmLabels.length;i++)check(near(cm.data[0][i],modelCosts[cmLabels[i]]),'aggregate model cost bucket '+i);
 const expectedCostDescription=payload.sessions.every(s=>s.costSource==='native-estimate')?'API-equivalent estimates':payload.sessions.every(s=>s.costSource==='authoritative')?'reported by the telemetry source':'source-reported amounts';
 check(costText.includes(expectedCostDescription),'cost view provenance description');
 await page.locator('[data-view="sessions"]').click();
 check(await page.locator('tr[data-session]').count()===payload.sessions.length,'sessions table row count');
 await shot('sessions');
 for(let i=0;i<payload.sessions.length;i++){const s=payload.sessions[i];const cells=await page.locator('tr[data-session='+JSON.stringify(s.sessionId)+'] td').allTextContents();
 check(num(cells[6])===s.turns,'session table turns '+i);check(compact(cells[8],s.tokens.input),'session table input '+i);check(compact(cells[9],s.tokens.output),'session table output '+i);check(compact(cells[10],s.tokens.cacheRead+s.tokens.cacheCreation),'session table cached '+i);check(Math.abs(num(cells[11])-s.costUSD)<(s.costUSD>=100?.501:s.costUSD<.01?.000051:.00501),'session table cost '+i);}
 await page.locator('.table-wrapper').evaluate(n=>n.scrollLeft=n.scrollWidth);await shot('sessions-cost');
 for(let si=0;si<payload.sessions.length;si++) {
  const s=payload.sessions[si];const ds=s.dispatches||[];
  await page.locator('tr[data-session='+JSON.stringify(s.sessionId)+']').click();
  const modal=page.locator('#session-modal');
  check(await modal.locator('[role="dialog"][aria-modal="true"]').count()===1,'accessible modal '+si);
  check(await modal.locator('.modal-close').evaluate(n=>n===document.activeElement),'initial focus close '+si);
  const costCard=card(modal,'Cost & Time');
  check(near(num(await stat(costCard,'Cost')),s.costUSD),'exact session cost '+si);
  const durationStat=costCard.locator('.mstat').filter({has:page.locator('.mlabel').filter({hasText:/^Duration$/})});
  check(num((await durationStat.locator('.msub').innerText()).replace(' ms',''))===s.durationMs,'exact session duration '+si);
  const expectedSource=s.costSource==='authoritative'?'reported by source':s.costSource==='native-estimate'?'API-equivalent estimate':'source not recorded';
  check((await costCard.innerText()).includes(expectedSource),'cost basis label '+si);
  const tokCard=card(modal,'Token usage');
  check(compact(await stat(tokCard,'Total'),s.tokens.total),'session compact token total '+si);
  const activity=card(modal,'Activity');
  for(const [label,kind] of [['Agents','agent'],['Skills','skill'],['Commands','command']])check(num(await stat(activity,label))===counts(s,kind),'invocation '+kind+' count '+si);
  check(num(await stat(activity,'Turns / API'))===s.turns,'session API count '+si);
  if(s.rootOwnTokens&&s.unlinkedTokens) {
   const allocation=await modal.locator('.tl-allocation tbody tr').evaluateAll(ns=>ns.map(n=>Array.from(n.querySelectorAll('td')).map(td=>td.textContent)));
   check(allocation.length===4,'disjoint allocation row count '+si);
   check(num(allocation[0][1])===s.rootOwnTokens.total,'root own tokens '+si);
   check(near(num(allocation[0][2]),s.rootOwnCostUSD),'root own cost '+si);
   check(num(allocation[1][1])===s.tokens.total-s.rootOwnTokens.total-s.unlinkedTokens.total,'linked own tokens '+si);
   check(near(num(allocation[1][2]),s.costUSD-s.rootOwnCostUSD-s.unlinkedCostUSD),'linked own cost '+si);
   check(num(allocation[2][1])===s.unlinkedTokens.total,'unlinked tokens '+si);
   check(num(allocation[3][1])===s.tokens.total&&near(num(allocation[3][2]),s.costUSD),'allocation session total '+si);
   check((await modal.locator('.tl-allocation').locator('..').innerText()).includes('Adding inclusive rows would count their usage again'),'inclusive accounting explanation '+si);
  }
  if(si===0)await shot('details');
  const growth=await modal.locator('canvas').evaluateAll(ns=>ns.map(n=>{const c=Chart.getChart(n);return c&&{title:n.closest('.card')?.querySelector('.card-title')?.textContent,data:c.data.datasets.map(d=>({label:d.label,data:d.data}))};}).filter(Boolean));
  const gc=growth.find(c=>c.title==='Token & cost growth');
  if(s.costSeries?.length>=2) {
   check(!!gc,'cumulative chart exists '+si);
   for(const [label,key] of [['Cost ($)','cost'],['Tokens','tokens']]) {
    const chartValues=gc.data.find(d=>d.label===label).data;
    check(chartValues.length===s.costSeries.length,'cumulative point count '+key+' '+si);
    check(chartValues.every((x,i)=>near(x,s.costSeries[i][key])),'cumulative all values '+key+' '+si);
    check(near(chartValues.at(-1),key==='cost'?s.costUSD:s.tokens.total),'cumulative endpoint total '+key+' '+si);
   }
  } else check((await card(modal,'Token & cost growth').innerText()).includes('Per-turn data not available'),'missing cumulative fallback '+si);
  const rows=modal.locator('.tl-row[data-dispatch]');
  check(await rows.count()===ds.length,'all dispatch rows visible in DOM '+si);
  if(ds.length) {
   const summary=await modal.locator('.tl-summary').innerText();
   check(summary.startsWith(ds.length+' steps'),'timeline total steps '+si);
   if(!s.dispatchesComplete)check((await modal.locator('.tl-wrap').innerText()).includes('older source may contain only part'),'legacy partial timeline explanation '+si);
   const ids=await rows.evaluateAll(ns=>ns.map(n=>n.getAttribute('data-dispatch')));
   check(new Set(ids).size===ds.length,'unique invocation selectors '+si);
   for(let ri=0;ri<ids.length;ri++) {
    const id=ids[ri],d=ds.find(x=>x.id!=null&&String(x.id)===id)||ds[Number(id.replace('legacy:',''))];
    const row=rows.nth(ri);await row.click();
    const side=modal.locator('.tl-side');
    check(await row.getAttribute('aria-pressed')==='true','selected pressed state '+si+':'+ri);
    check(await rows.locator('xpath=self::*[@aria-pressed="true"]').count()===1,'single selection '+si+':'+ri);
    if(d.id!=null)check((await side.locator('.tl-identity .modal-mono').innerText())===String(d.id),'selected stable identity '+si+':'+ri);
    const status={completed:'Completed',failed:'Failed',incomplete:'Incomplete',unknown:'Unknown'}[d.status]||'Not recorded';
    check((await side.locator('.tl-status').innerText()).startsWith(status),'lifecycle status '+si+':'+ri);
    const estimated=d.attributionStatus==='estimated',own=d.attributionScope==='own'||d.inclusiveTokens!=null;
    const costLabel=estimated?'Estimated cost':own?'Own cost':'Cost',tokenLabel=estimated?'Estimated tokens':own?'Own tokens':'Tokens';
    const shownCost=await stat(side,costLabel),shownTokens=await stat(side,tokenLabel);
    check(d.costUSD==null?shownCost==='—':near(num(shownCost),d.costUSD),'own or estimated cost '+si+':'+ri);
    check(d.tokens==null?shownTokens==='—':num(shownTokens)===d.tokens.total,'own or estimated tokens '+si+':'+ri);
    if(d.inclusiveTokens)check(num(await stat(side,'Inclusive tokens'))===d.inclusiveTokens.total,'inclusive tokens '+si+':'+ri);
    if(d.inclusiveCostUSD!=null)check(near(num(await stat(side,'Inclusive cost')),d.inclusiveCostUSD),'inclusive cost '+si+':'+ri);
    const elapsedLabel=d.status==='incomplete'||d.status==='unknown'?'Observed elapsed':'Elapsed';
    if(d.status==='unknown'&&!d.observedEnd) {
     check(await stat(side,elapsedLabel)==='Unknown','unknown elapsed label '+si+':'+ri);
     check((await row.locator('.tl-dur').innerText())==='Unknown','unknown timeline duration '+si+':'+ri);
    } else {
     const es=side.locator('.mstat').filter({has:page.locator('.mlabel').filter({hasText:new RegExp('^'+elapsedLabel+'$')})});
     check(num((await es.locator('.msub').innerText()).replace(' ms',''))===elapsed(d),'actual elapsed milliseconds '+si+':'+ri);
    }
    if(d.acknowledgedAt!=null)check((await side.innerText()).includes('Acknowledgement delay:'),'acknowledgement evidence '+si+':'+ri);
    if(d.status==='incomplete'||d.status==='unknown')check((await side.innerText()).includes('Completion was not recorded'),'incomplete explanation '+si+':'+ri);
    if(estimated)check((await side.innerText()).includes('not additional session cost'),'estimated overlapping explanation '+si+':'+ri);
    const p=d.parentId!=null?ds.find(x=>String(x.id)===String(d.parentId)):d.ownerAgentId?ds.find(x=>x.kind==='agent'&&x.agentId===d.ownerAgentId):null;
    if(p&&!['missing','cycle','conflict'].includes(d.relationshipStatus))check(await side.locator('.tl-link').filter({hasText:'↑ Parent:'}).count()===1,'parent link rendered '+si+':'+ri);
   }
   const candidate=ds.find(d=>d.parentId&&ds.some(p=>p.id===d.parentId)&&!['missing','cycle','conflict'].includes(d.relationshipStatus));
   if(candidate) {
    const cr=modal.locator('.tl-row[data-dispatch='+JSON.stringify(candidate.id)+']');await cr.click();
    const candidateLabel=await modal.locator('.tl-side-name').innerText();
    await modal.locator('.tl-side .tl-link').filter({hasText:'↑ Parent:'}).click();
    check((await modal.locator('.tl-side .tl-identity .modal-mono').innerText())===candidate.parentId,'parent jump stable identity '+si);
    await modal.getByRole('button',{name:'↳ '+candidateLabel,exact:true}).click();
    check((await modal.locator('.tl-side .tl-identity .modal-mono').innerText())===candidate.id,'child jump stable identity '+si);
   }
   const keys=await rows.evaluateAll(ns=>ns.slice(0,2).map(n=>n.getAttribute('data-dispatch')));
   if(keys.length===2) {
    await rows.nth(0).focus();await page.keyboard.press('Enter');check(await rows.nth(0).getAttribute('aria-pressed')==='true','Enter selects timeline '+si);
    await rows.nth(1).focus();await page.keyboard.press('Space');check(await rows.nth(1).getAttribute('aria-pressed')==='true','Space selects timeline '+si);
   }
   await modal.locator('.tl-wrap').scrollIntoViewIfNeeded();await shot('timeline-'+si);
   await rows.last().click();
   check(await rows.last().isVisible(),'last trace reachable '+si);
   await shot('timeline-last-'+si);
  } else {
   check((await card(modal,'Timeline').innerText()).includes('No agent, skill, or command dispatches'),'no timeline fallback '+si);
   const summary=modal.locator('summary');
   if(await summary.count()) {
    await modal.locator('.modal-close').focus();await page.keyboard.press('Tab');
    check(await summary.evaluate(n=>n===document.activeElement),'native summary keyboard reachable '+si);
    await page.keyboard.press('Enter');check(await summary.locator('..').getAttribute('open')!==null,'native summary Enter opens '+si);
    await page.keyboard.press('Space');check(await summary.locator('..').getAttribute('open')===null,'native summary Space closes '+si);
    await summary.scrollIntoViewIfNeeded();await shot('native-summary');
   }
  }
  const focusable=modal.locator('button:not([disabled]), a[href], input, select, textarea, summary, [tabindex="0"]').filter({visible:true});
  const first=focusable.first(),last=focusable.last();
  await last.focus();await page.keyboard.press('Tab');check(await first.evaluate(n=>n===document.activeElement),'forward focus trap '+si);
  await first.focus();await page.keyboard.press('Shift+Tab');check(await last.evaluate(n=>n===document.activeElement),'reverse focus trap '+si);
  await page.keyboard.press('Escape');check(await page.locator('#session-modal').count()===0,'Escape closes modal '+si);
 }
 check(consoleErrors.length===0,'zero browser console errors');
 check(networkFailures.length===0,'zero failed network requests');
 return {id:config.id,result:'PASS',assertions,screenshots,consoleErrors:consoleErrors.length,networkFailures:networkFailures.length};
 } catch(error) {
 return {id:config.id,result:'FAIL',assertions,error:String(error.message),screenshots,consoleErrors:consoleErrors.length,networkFailures:networkFailures.length};
 } finally {page.off('console',errors);page.off('pageerror',pageError);page.off('requestfailed',failed);page.off('response',response);}
}
