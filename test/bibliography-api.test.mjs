import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {crossrefRecord} from '../lib/bibliography.mjs';

test('official titles, preserved reviews, human matching, unmerge and restart work through the API',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-bib-api-'));
  const data=path.join(temp,'data'),state=path.join(temp,'state');await fs.mkdir(data);await fs.mkdir(state);
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),title='SMPL: A Skinned Multi-Person Linear Model';
  const make=(id,text)=>({id,title:id,current_node:id,create_time:1,mapping:{[id]:{parent:null,message:{id,author:{role:'user'},content:{parts:[text]},create_time:1}}}});
  await fs.writeFile(path.join(data,'conversations.json'),JSON.stringify([make('a',`PRIVATE_CONTEXT_NOT_FOR_EXPORT **${title}** 논문`),make('b','https://doi.org/10.1234/smpl'),make('c','GraCE 논문')]));
  const records=[crossrefRecord({DOI:'10.1234/smpl',title:[title],author:[{family:'Author'}]}),crossrefRecord({DOI:'10.1234/grace',title:['GraCE: Graph Contrastive Embeddings for Motion Learning']})];
  await fs.writeFile(path.join(state,'bibliography.json'),JSON.stringify({records:Object.fromEntries(records.map(r=>[r.id,r])),lookups:{}}));
  const titleId='title:smplaskinnedmultipersonlinearmodel';
  await fs.writeFile(path.join(state,'reviews.json'),JSON.stringify({[titleId]:{status:'confirmed',pdfKey:'AAAA1111'},'doi:10.1234/smpl':{status:'unreviewed',pdfKey:'BBBB2222'}}));
  let child,url;
  async function start(){child=spawn(process.execPath,[path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});let logs='';child.stderr.on('data',d=>logs+=d);url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs)),10000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});}
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const get=async route=>(await fetch(url+route)).json();
  const post=(route,body={})=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    await start();
    const overview=await get('/api/overview'),paper=overview.papers.find(p=>p.id==='doi:10.1234/smpl');
    assert.equal(overview.stats.rawCandidates,3);assert.equal(overview.stats.papers,2);assert.equal(overview.stats.mergedCandidates,1);
    assert.equal(paper.title,title);assert.equal(paper.status,'confirmed');assert.equal(paper.pdfKey,undefined);assert.equal(paper.reviewConflict,true);assert.equal(paper.memberReviews.length,2);
    assert.ok(paper.observedTitles.some(t=>t.text==='SMPL'));assert.equal(paper.count,2);
    assert.equal((await get('/api/paper?id='+titleId)).paper.id,'doi:10.1234/smpl');
    const bib=await get('/api/bibliography');assert.equal(bib.queue.length,1);assert.equal(bib.queue[0].id,'name:grace');
    assert.equal(bib.diagnostics.summary.linked,2);assert.ok(paper.links.doi.length);assert.equal((await post('/api/bibliography/stop')).status,409);
    assert.ok(!JSON.stringify(await get('/api/bibliography/export')).includes('PRIVATE_CONTEXT_NOT_FOR_EXPORT'));
    const full=await get('/api/bibliography/export?format=full'),compact=await get('/api/bibliography/export?format=compact&limit=30');
    assert.equal(full.kind,'diagnostics');assert.ok(full.records['doi:10.1234/grace'].sourceUrl);assert.ok(full.unresolved.every(p=>!full.queue.some(q=>q.id===p.id)));
    assert.equal(compact.kind,'llm-review');assert.equal(compact.items[0].candidateId,'name:grace');assert.ok(!JSON.stringify(compact).includes('sourceUrl'));assert.equal(compact.totals.withCandidates,1);
    assert.equal((await fetch(url+'/api/bibliography/export?format=compact&limit=200')).status,400);
    assert.equal((await get('/api/bibliography/review-schema')).properties.decisions.items.properties.needsManualReview.type,'boolean');
    const result={schemaVersion:1,decisions:[{candidateId:'name:grace',decision:'match',recordId:'doi:10.1234/grace',evidence:[{type:'exact-title',detail:'The official GraCE expansion matches.'}],needsManualReview:false}]};
    const decisionFile=path.join(state,'bibliography-decisions.json'),decisionsBefore=await fs.readFile(decisionFile,'utf8').catch(()=>null),reviewsBefore=await fs.readFile(path.join(state,'reviews.json'),'utf8'),metadataBefore=await fs.readFile(path.join(state,'bibliography.json'),'utf8');
    const preview=await(await post('/api/bibliography/review/dry-run',result)).json();assert.equal(preview.writes,0);assert.equal(preview.applicable,1);
    assert.equal(await fs.readFile(decisionFile,'utf8').catch(()=>null),decisionsBefore);
    assert.equal((await post('/api/bibliography/review/apply',{dryRunId:preview.dryRunId,approved:false,candidateIds:['name:grace']})).status,400);
    assert.equal((await post('/api/bibliography/review/apply',{dryRunId:preview.dryRunId,approved:true,candidateIds:[]})).status,400);
    await post('/api/bibliography/decision',{candidateId:'name:grace',action:'separate'});
    assert.equal((await post('/api/bibliography/review/apply',{dryRunId:preview.dryRunId,approved:true,candidateIds:['name:grace']})).status,409,'concurrent manual decisions invalidate a preview');
    const protectedPlan=await(await post('/api/bibliography/review/dry-run',result)).json();assert.equal(protectedPlan.rows[0].status,'preserved');assert.equal(protectedPlan.applicable,0);
    await post('/api/bibliography/decision',{candidateId:'name:grace',action:'reset'});
    const needsReview=structuredClone(result);needsReview.decisions[0].needsManualReview=true;
    const blocked=await(await post('/api/bibliography/review/dry-run',needsReview)).json();assert.equal(blocked.applicable,0);assert.equal((await post('/api/bibliography/review/apply',{dryRunId:blocked.dryRunId,approved:true,candidateIds:['name:grace']})).status,400);
    assert.equal((await fetch(url+'/api/bibliography/review/dry-run',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://outside.example'},body:JSON.stringify(result)})).status,403);
    const ready=await(await post('/api/bibliography/review/dry-run',result)).json();
    assert.equal((await post('/api/bibliography/review/apply',{dryRunId:ready.dryRunId,approved:true,candidateIds:['name:grace']})).status,200);
    assert.equal((await post('/api/bibliography/review/apply',{dryRunId:ready.dryRunId,approved:true,candidateIds:['name:grace']})).status,409,'applied previews cannot be replayed');
    assert.equal(await fs.readFile(path.join(state,'reviews.json'),'utf8'),reviewsBefore);assert.equal(await fs.readFile(path.join(state,'bibliography.json'),'utf8'),metadataBefore);
    const matched=await get('/api/paper?id=name:grace');assert.equal(matched.paper.title,records[1].title);assert.equal(matched.paper.resolution.reason,'user-confirmed');assert.equal(matched.paper.count,1);assert.ok(matched.paper.observedTitles.some(t=>t.text==='GraCE'));
    await post('/api/reindex');await stop();await start();assert.equal((await get('/api/paper?id=name:grace')).paper.id,'doi:10.1234/grace');
    await post('/api/bibliography/decision',{paperId:'doi:10.1234/grace',action:'separate'});assert.equal((await get('/api/paper?id=name:grace')).paper.metadata,null);
    await post('/api/bibliography/decision',{candidateId:'name:grace',action:'reset'});assert.equal((await get('/api/bibliography')).queue.length,1);
    await post('/api/bibliography/decision',{paperId:'doi:10.1234/smpl',action:'separate'});assert.equal((await get('/api/overview')).stats.papers,3);
    assert.equal((await get('/api/paper?id='+titleId)).paper.status,'confirmed');
    assert.equal((await post('/api/bibliography/sync',{limit:0})).status,400);
  }finally{await stop();const absolute=path.resolve(temp);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(absolute,{recursive:true,force:true});}
});
