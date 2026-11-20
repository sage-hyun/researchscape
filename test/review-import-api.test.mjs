import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {normalize} from '../lib/extract.mjs';
import {loadJSON} from '../lib/local-store.mjs';
import {FIGURE_SCHEMA_VERSION} from '../lib/figure-manager.mjs';
import {exportConversations,reviewStore,candidateId,linkedName,orphanName,linkedDoi,orphanDoi,orphanTitle} from './fixtures/review-candidates.mjs';

test('one download, one import of 1,100+ decisions above 2MB, restart, approval and preserved personal records through the API',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-review-api-')),data=path.join(temp,'data'),state=path.join(temp,'state'),media=path.join(state,'media');
  await fs.mkdir(data);await fs.mkdir(media,{recursive:true});
  const root=path.dirname(path.dirname(fileURLToPath(import.meta.url))),project='g-p-fixture-research';
  const paperTitle='A Specific Motion Representation Learning Research Paper',titleId='title:'+normalize(paperTitle),paperDoi='10.4242/specific';
  // A paper with a local PDF, extracted figures and Zotero keys, still without official metadata.
  const pdf=Buffer.from('%PDF-1.7\ncontrolled fixture'),pdfHash=createHash('sha256').update(pdf).digest('hex'),pdfFile=path.join(temp,'source.pdf'),imageDirectory=path.join(media,'figures',pdfHash);
  await fs.writeFile(pdfFile,pdf);await fs.mkdir(imageDirectory,{recursive:true});
  const webp=Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA','base64');
  const figures=[{id:'figure-1-p1',number:'1',kind:'figure',page:1,file:'one.webp',caption:'Figure 1. Pipeline'},{id:'figure-2-p2',number:'2',kind:'figure',page:2,file:'two.webp',caption:'Figure 2. Results'}];
  for(const figure of figures)await fs.writeFile(path.join(imageDirectory,figure.file),webp);
  await fs.writeFile(path.join(media,'zotero.json'),JSON.stringify({records:[{id:'zotero:PDFK0001',attachmentKey:'PDFK0001',itemKey:'ITEM0001',source:'zotero',title:paperTitle,path:pdfFile,exists:true,hash:pdfHash}],available:1,total:1}));
  await fs.writeFile(path.join(media,'state.json'),JSON.stringify({artifacts:{[pdfHash]:{version:FIGURE_SCHEMA_VERSION,pdfHash,pages:2,pageSizes:[[600,800],[600,800]],figures,defaultFigureId:'figure-1-p1'}}}));
  const conversations=[...exportConversations({linked:560,orphans:560,project}),{id:'c-specific',title:'PRIVATE_PROJECT_TITLE',conversation_template_id:project,create_time:5,current_node:'m-specific',mapping:{'m-specific':{parent:null,message:{id:'m-specific',author:{role:'user'},create_time:5,content:{parts:[`PRIVATE_CHAT_BODY **${paperTitle}** 논문`]}}}}}];
  const manualId=candidateId(linkedName(0)),keyedId=candidateId(linkedName(5));
  const originals={
    [path.join(data,'conversations.json')]:conversations,
    [path.join(state,'bibliography.json')]:reviewStore(560),
    [path.join(state,'bibliography-decisions.json')]:{[manualId]:{action:'separate',updatedAt:'2025-01-01T00:00:00.000Z',note:'kept by a person'}},
    [path.join(state,'reviews.json')]:{[keyedId]:{status:'confirmed',itemKey:'ITEM0005',pdfKey:'PDFK0005'},[titleId]:{status:'confirmed',itemKey:'ITEM0001',pdfKey:'PDFK0001'}},
    [path.join(state,'projects.json')]:{[project]:{name:'Private research',category:'research'}},
    [path.join(state,'conversation-labels.json')]:{['c-'+linkedName(5).toLowerCase()]:{category:'coursework'}}
  };
  for(const [file,value] of Object.entries(originals))await fs.writeFile(file,JSON.stringify(value));
  const untouched=['reviews.json','projects.json','conversation-labels.json'].map(name=>path.join(state,name)).concat(path.join(data,'conversations.json')),bytes=()=>Promise.all(untouched.map(file=>fs.readFile(file,'utf8')));
  // Provider stand-in inside the server process. While "hold" exists, Crossref never answers.
  const preload=path.join(temp,'provider-fixture.mjs');
  await fs.writeFile(preload,`
    import fs from 'node:fs';import path from 'node:path';
    const directory=process.env.RESEARCHSCAPE_PROVIDER_FIXTURE;
    const works={${JSON.stringify(paperDoi)}:${JSON.stringify({DOI:paperDoi,title:[paperTitle],author:[{given:'Official',family:'Author'}]})},${JSON.stringify(orphanDoi(0))}:${JSON.stringify({DOI:orphanDoi(0),title:[orphanTitle(0)]})},'10.4242/other':{DOI:'10.4242/other',title:['Deep Reinforcement Learning for Autonomous Warehouse Robots']}};
    globalThis.fetch=async(input,options={})=>{
      const url=new URL(input);fs.appendFileSync(path.join(directory,'requests.jsonl'),JSON.stringify({url:url.href})+'\\n');
      if(url.hostname!=='api.crossref.org'||!url.pathname.startsWith('/works/'))throw new Error('Unexpected provider request in fixture');
      if(fs.existsSync(path.join(directory,'hold')))return new Promise((resolve,reject)=>{options.signal.throwIfAborted();options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
      const work=works[decodeURIComponent(url.pathname.slice(7))];
      return new Response(JSON.stringify(work?{message:work}:{}),{status:work?200:404,headers:{'Content-Type':'application/json'}});
    };
  `);
  let child,url,serverLogs='';
  async function start(){
    child=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state,RESEARCHSCAPE_PROVIDER_FIXTURE:temp,RESEARCHSCAPE_FIGURE_PYTHON:path.join(temp,'not-needed-python'),OPENALEX_API_KEY:'',SEMANTIC_SCHOLAR_API_KEY:''},stdio:['ignore','pipe','pipe']});
    let logs='';serverLogs='';child.stderr.on('data',d=>{logs+=d;serverLogs+=d;});
    url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(logs||'Server did not start')),20000);child.stdout.on('data',d=>{logs+=d;const match=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(match){clearTimeout(timer);resolve(match[1]);}});child.on('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error(logs||'Server exited before startup'));});});
  }
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  const route='/api/bibliography/review/import';
  const get=async path=>{try{return await(await fetch(url+path)).json();}catch(e){throw new Error(`${path}: ${e.message}; server exit ${child.exitCode}; ${serverLogs}`,{cause:e});}};
  const send=async(path,body,headers={})=>{try{return await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:typeof body==='string'?body:JSON.stringify(body)});}catch(e){throw new Error(`${path}: ${e.message}; server exit ${child.exitCode}; ${serverLogs}`,{cause:e});}};
  const post=async(path,body)=>{const response=await send(path,body);return {status:response.status,...await response.json()};};
  const view=(id,params={})=>get(route+'?'+new URLSearchParams({id,...params}));
  const until=async predicate=>{const end=Date.now()+30000;while(Date.now()<end){const value=await predicate();if(value)return value;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Fixture condition timed out');};
  const requests=async()=>{try{return (await fs.readFile(path.join(temp,'requests.jsonl'),'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line).url);}catch(e){if(e.code==='ENOENT')return [];throw e;}};
  const evidence=text=>[1,2,3].map(n=>({type:'explicit-alias-expansion',detail:`${text} ${n} `.padEnd(950,'·')}));
  try{
    await fs.writeFile(path.join(temp,'hold'),'1');await start();
    // ---- the default screen and one download ----
    const page=await(await fetch(url+'/')).text();
    for(const text of ['전체 LLM 검토 JSON 다운로드','LLM 검토 결과 JSON 가져오기','검토 결과 미리보기','최종 승인·적용','고급 설정','/api/bibliography/export?format=bundle'])assert.ok(page.includes(text),text);
    assert.ok(page.indexOf('id="bibExportGroup"')>page.indexOf('<details class="bib-advanced"'),'per-group and per-page downloads live under advanced settings');
    const initial=await get('/api/bibliography');assert.deepEqual(initial.reviewTotals,{withCandidates:559,withoutCandidates:561});assert.equal(initial.reviewImport,null);
    const before=await get('/api/overview'),keyedBefore=await get('/api/paper?id='+encodeURIComponent(keyedId)),specificBefore=before.papers.find(p=>p.id===titleId);
    assert.equal(specificBefore.media.thumbnail.figureId,'figure-1-p1');
    assert.equal((await send('/api/media/thumbnail',{paperId:titleId,figureId:'figure-2-p2'})).status,200);
    const download=await fetch(url+'/api/bibliography/export?format=bundle'),bundle=await download.json();
    assert.match(download.headers.get('content-disposition'),new RegExp(`^attachment; filename="researchscape-llm-review-${bundle.snapshot.slice(0,8)}\\.json"$`));
    assert.equal(bundle.kind,'llm-review-bundle');assert.equal(bundle.total,1120);assert.equal(bundle.items.length,1120);assert.equal(new Set(bundle.items.map(i=>i.candidateId)).size,1120);assert.equal(bundle.batches.length,14);
    assert.ok(bundle.items.every((item,at)=>!at||bundle.items[at-1].count>=item.count));assert.ok(!bundle.items.some(i=>i.candidateId===manualId));
    const exported=JSON.stringify(bundle);for(const secret of ['PRIVATE_CHAT_BODY','PRIVATE_PROJECT_TITLE',project,'ITEM0005','PDFK0005','sourceUrl','c-vela'])assert.ok(!exported.includes(secret),secret);
    assert.equal((await get('/api/bibliography/export?format=bundle&batchSize=100')).batches.length,12);assert.equal((await fetch(url+'/api/bibliography/export?format=bundle&batchSize=10')).status,400);
    // Earlier export forms keep working.
    const compact=await get('/api/bibliography/export?format=compact&limit=30');assert.equal(compact.snapshot,bundle.snapshot);assert.equal(compact.items.length,30);
    assert.equal((await get('/api/bibliography/export')).kind,'diagnostics');assert.equal((await fetch(url+'/api/bibliography/export?format=everything')).status,400);

    // ---- one result file: ordinary decisions first, four proposals last ----
    const proposals=[
      {candidateId:titleId,decision:'propose',recordId:null,proposal:{doi:paperDoi,title:paperTitle},evidence:evidence('Known DOI'),needsManualReview:false},
      {candidateId:candidateId(orphanName(0)),decision:'propose',recordId:null,proposal:{doi:orphanDoi(0)},evidence:evidence('Known DOI'),needsManualReview:false},
      {candidateId:candidateId(orphanName(1)),decision:'propose',recordId:null,proposal:{doi:'10.4242/unknown'},evidence:evidence('Guess'),needsManualReview:false},
      {candidateId:candidateId(orphanName(2)),decision:'propose',recordId:null,proposal:{doi:'10.4242/other',title:orphanName(2)+': A Paper That Does Not Have This DOI'},evidence:evidence('Guess'),needsManualReview:false}
    ],proposed=new Set(proposals.map(p=>p.candidateId));
    const decisions=bundle.items.filter(item=>!proposed.has(item.candidateId)).map(item=>item.candidates.length?{candidateId:item.candidateId,decision:'match',recordId:item.candidates[0].recordId,evidence:evidence('Prefix of the official title'),needsManualReview:false}:{candidateId:item.candidateId,decision:Number(/\d+/.exec(item.title)[0])%2?'separate':'defer',recordId:null,evidence:evidence('Not a paper'),needsManualReview:false});
    decisions.push({candidateId:manualId,decision:'match',recordId:'doi:'+linkedDoi(0),evidence:evidence('Would overwrite a manual decision'),needsManualReview:false},...proposals);
    const body=JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions});
    assert.equal(decisions.length,1121);assert.ok(Buffer.byteLength(body)>3_000_000,'larger than the 2MB limit of ordinary requests');
    // Rejected uploads create nothing.
    assert.equal((await fetch(url+route,{method:'POST',headers:{'Content-Type':'text/plain'},body})).status,415);
    assert.equal((await send(route,body,{Origin:'https://outside.example'})).status,403);
    assert.deepEqual(await post(route,'{"schemaVersion":2,'),{status:400,error:'JSON 형식이 올바르지 않습니다. LLM 응답에서 JSON 부분만 저장했는지 확인해주세요.',code:'INVALID_JSON'});
    assert.equal((await post(route,exported)).status,400,'the downloaded bundle is not a result');
    assert.equal((await post(route,JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions:[],padding:'x'.repeat(17*1024*1024)}))).code,'UPLOAD_TOO_LARGE');
    assert.equal((await send('/api/bibliography/review/dry-run',body)).status,400,'the legacy in-memory preview keeps its 2MB / 50-row limits');
    assert.deepEqual((await get(route)).imports,[]);

    const created=await post(route+'?filename=llm-result.json',body);
    assert.equal(created.status,202);assert.equal(created.duplicate,false);assert.equal(created.job.total,1121);assert.equal(created.job.status,'validating');
    const id=created.job.id;
    // ---- the server stops while the last chunk waits for a provider ----
    await until(async()=>(await requests()).length>0);
    const waiting=await view(id);assert.equal(waiting.running,true);assert.equal(waiting.processed,1100);assert.equal(waiting.progress.stage,'lookup');assert.equal(waiting.counts.ready,822);
    assert.equal((await post('/api/bibliography/sync',{limit:1})).status,409,'a sync may not start while proposals are being looked up');
    assert.equal((await post(route+'/apply',{importId:id,approved:true,candidateIds:[decisions[0].candidateId]})).status,409);
    await stop();await fs.rm(path.join(temp,'hold'));await start();
    const interrupted=await view(id);
    assert.equal(interrupted.status,'interrupted');assert.equal(interrupted.running,false);assert.equal(interrupted.processed,1100);assert.equal(interrupted.rowsTotal,1100);assert.equal(interrupted.resumable,true);assert.equal(interrupted.counts.ready,822);
    assert.deepEqual((await get('/api/bibliography')).reviewImport,{id,status:'interrupted',total:1121,processed:1100},'the dialog can reopen the unfinished import');
    assert.equal((await send(route+'/resume',{importId:id})).status,202);
    const done=await until(async()=>{const job=await view(id,{ids:'ready',status:'ready',limit:200});return !job.running&&job;});
    assert.equal(done.status,'ready');assert.equal(done.processed,1121);assert.equal(done.error,null);
    assert.deepEqual(done.counts,{ready:840,needsManualReview:2,preserved:1,deferred:278,duplicate:0,error:0,applied:0,stale:0,lookupFailed:0,registered:2});
    assert.equal(done.readyIds.length,840);assert.equal(done.rows.length,200);assert.equal(done.rowsTotal,840);assert.equal(done.snapshot.status,'current');assert.equal(done.snapshot.changed,0);
    assert.equal((await view(id,{status:'ready',offset:800,limit:200})).rows.length,40);
    const reviewRows=(await view(id,{status:'needs-manual-review'})).rows;
    assert.deepEqual(reviewRows.map(r=>r.verification.status),['not-found','title-mismatch']);
    const proposedRow=(await view(id,{status:'ready',offset:800})).rows.find(r=>r.candidateId===titleId);
    assert.equal(proposedRow.recordId,'doi:'+paperDoi);assert.deepEqual(proposedRow.verification.record.authors,['Official Author']);
    assert.deepEqual((await view(id,{status:'preserved'})).rows.map(r=>r.candidateId),[manualId]);
    // Preview: provider lookups are cached and candidates registered, but nothing is linked yet.
    const sent=await requests();assert.equal(sent.length,5,'four proposals; the interrupted lookup is asked once more');assert.ok(sent.every(u=>u.startsWith('https://api.crossref.org/works/10.')&&!u.includes('PRIVATE')));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8')),originals[path.join(state,'bibliography-decisions.json')]);
    const cache=loadJSON(state,'bibliography.json',{});assert.equal(cache.records['doi:'+paperDoi].provider,'Crossref');assert.deepEqual(Object.keys(cache.proposedLinks).sort(),[candidateId(orphanName(0)),titleId].sort());
    const queue=(await get('/api/bibliography')).queue.find(q=>q.id===candidateId(orphanName(0)));assert.equal(queue.suggestions[0].recordId,'doi:'+orphanDoi(0));assert.ok(queue.evidence.some(e=>e.source==='llm-proposal'));
    assert.equal((await get('/api/paper?id='+encodeURIComponent(titleId))).paper.metadata,null);
    const personal=await bytes();

    // ---- the same JSON is not imported twice ----
    const repeat=await post(route,body);assert.equal(repeat.status,200);assert.equal(repeat.duplicate,true);assert.equal(repeat.job.id,id);assert.equal((await get(route)).imports.length,1);

    // ---- approval ----
    assert.equal((await post(route+'/apply',{importId:id,approved:false,candidateIds:done.readyIds})).code,'APPROVAL_REQUIRED');
    assert.equal((await post(route+'/apply',{importId:id,approved:true,candidateIds:[]})).status,400);
    assert.equal((await post(route+'/apply',{importId:id,approved:true,candidateIds:[manualId]})).code,'INVALID_SELECTION');
    assert.equal((await send(route+'/apply',{importId:id,approved:true,candidateIds:done.readyIds},{Origin:'https://outside.example'})).status,403);
    assert.equal((await post(route+'/apply',{importId:'00000000-0000-4000-8000-000000000000',approved:true,candidateIds:['x']})).status,404);
    assert.deepEqual(await post(route+'/apply',{importId:id,approved:true,candidateIds:done.readyIds}),{status:200,ok:true,applied:840,skipped:[],remaining:0});
    const finished=await view(id);assert.equal(finished.status,'completed');assert.equal(finished.counts.applied,840);assert.equal((await get('/api/bibliography')).reviewImport.id,id,'unresolved manual rows remain available in the unified workspace');

    // ---- what a person or Zotero recorded is exactly as before ----
    const stored=JSON.parse(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8'));
    assert.equal(Object.keys(stored).length,841);assert.deepEqual(stored[manualId],{action:'separate',updatedAt:'2025-01-01T00:00:00.000Z',note:'kept by a person'});
    assert.equal(stored[titleId].recordId,'doi:'+paperDoi);assert.equal(stored[titleId].importId,id);
    assert.deepEqual(await bytes(),personal,'reviews, Zotero keys, project names, labels and the export are byte-identical');
    const after=await get('/api/overview');
    assert.equal(after.stats.mentions,before.stats.mentions);assert.equal(after.stats.conversations,before.stats.conversations);assert.equal(after.stats.metadataVerified,before.stats.metadataVerified+559+2);
    const keyed=await get('/api/paper?id='+encodeURIComponent(keyedId));
    assert.equal(keyed.paper.id,'doi:'+linkedDoi(5));assert.equal(keyed.paper.resolution.reason,'user-confirmed');assert.equal(keyed.paper.status,'confirmed');assert.equal(keyed.paper.itemKey,'ITEM0005');assert.equal(keyed.paper.pdfKey,'PDFK0005');
    assert.equal(keyed.total,keyedBefore.total);
    for(const [n,mention] of keyed.mentions.entries())for(const key of ['quote','excerpt','contentHash','date','role','conversationId','messageId','start','end','category','projectId','projectName'])assert.deepEqual(mention[key],keyedBefore.mentions[n][key],key);
    assert.equal(keyed.mentions[0].category,'coursework');assert.equal(keyed.mentions[0].projectId,project);
    const specific=after.papers.find(p=>p.id==='doi:'+paperDoi);
    assert.equal(specific.title,paperTitle);assert.equal(specific.metadata.authors[0],'Official Author');assert.equal(specific.status,'confirmed');assert.equal(specific.itemKey,'ITEM0001');assert.equal(specific.pdfKey,'PDFK0001');
    assert.equal(specific.media.pdfId,'zotero:PDFK0001');assert.equal(specific.media.thumbnail.figureId,'figure-2-p2','the manually chosen figure stays selected');assert.equal(specific.media.thumbnail.mode,'manual');assert.equal(specific.media.figureCount,2);
    assert.equal((await fetch(url+specific.media.thumbnail.url)).status,200);

    // ---- restart again: decisions and the finished job are durable; the preview can be closed ----
    await stop();await start();
    assert.equal((await get('/api/paper?id='+encodeURIComponent(titleId))).paper.id,'doi:'+paperDoi);assert.equal((await view(id)).counts.applied,840);
    assert.equal((await post(route,body)).duplicate,true);
    assert.equal((await post(route+'/discard',{importId:id})).status,200);assert.equal((await fetch(url+route+'?id='+id)).status,404);
    assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8'))).length,841,'closing a preview never removes approved decisions');
    const next=await get('/api/bibliography/export?format=bundle');assert.equal(next.total,1120-840);assert.notEqual(next.snapshot,bundle.snapshot);
  }finally{await stop();const absolute=path.resolve(temp);assert.ok(absolute.startsWith(path.resolve(os.tmpdir())+path.sep));await fs.rm(absolute,{recursive:true,force:true});}
});
