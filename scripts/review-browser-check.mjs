// Optional development check for the LLM review dialog. It needs a Chromium/Edge started with
// --remote-debugging-port=9337 (or RESEARCHSCAPE_CDP_URL) and uses only a disposable fixture:
// 1,220 fictional candidates, a temporary state folder and a stand-in for the metadata providers.
// It never reads personal data and never opens a logged-in browser profile.
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {exportConversations,reviewStore,orphanDoi,orphanTitle} from '../test/fixtures/review-candidates.mjs';

const endpoint=process.env.RESEARCHSCAPE_CDP_URL||'http://127.0.0.1:9337',root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const shots=process.env.RESEARCHSCAPE_SCREENSHOT_DIR||path.join(root,'.local');
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'researchscape-review-browser-')),data=path.join(temp,'data'),state=path.join(temp,'state');
await fs.mkdir(data);await fs.mkdir(state);await fs.mkdir(shots,{recursive:true});
await fs.writeFile(path.join(data,'conversations.json'),JSON.stringify(exportConversations()));
await fs.writeFile(path.join(state,'bibliography.json'),JSON.stringify(reviewStore()));
const proposedIds=[0,4,8,12],preload=path.join(temp,'provider-fixture.mjs');
await fs.writeFile(preload,`
  const works=${JSON.stringify(Object.fromEntries(proposedIds.slice(0,3).map(i=>[orphanDoi(i),{DOI:orphanDoi(i),title:[orphanTitle(i)],author:[{given:'Fixture',family:'Author'}],published:{'date-parts':[[2024]]}}])))};
  globalThis.fetch=async input=>{
    const url=new URL(input);if(url.hostname!=='api.crossref.org'||!url.pathname.startsWith('/works/'))throw new Error('Unexpected provider request in fixture');
    const work=works[decodeURIComponent(url.pathname.slice(7))];
    return new Response(JSON.stringify(work?{message:work}:{}),{status:work?200:404,headers:{'Content-Type':'application/json'}});
  };
`);
const child=spawn(process.execPath,['--import',pathToFileURL(preload).href,path.join(root,'server.mjs')],{env:{...process.env,PORT:'0',RESEARCHSCAPE_DATA_DIR:data,RESEARCHSCAPE_STATE_DIR:state},stdio:['ignore','pipe','pipe']});
let logs='';child.stderr.on('data',d=>logs+=d);
let target,ws;
try{
  const base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('fixture startup timeout '+logs)),20000);child.stdout.on('data',d=>{logs+=d;const m=/ready at (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);if(m){clearTimeout(timer);resolve(m[1]);}});child.on('error',reject);});
  target=await(await fetch(endpoint+'/json/new?about:blank',{method:'PUT'})).json();
  ws=new WebSocket(target.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
  let serial=0;const pending=new Map(),errors=[],requests=[],dialogs=[],approvals=[];
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  ws.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.id){const p=pending.get(message.id);if(!p)return;pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description||''));
    if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
    if(message.method==='Network.requestWillBeSent'&&message.params.request.url.endsWith('/review/queue/apply'))approvals.push(JSON.parse(message.params.request.postData));
    // The final approval asks once more before writing; the check answers like a person who agrees.
    if(message.method==='Page.javascriptDialogOpening'){dialogs.push(message.params.message);call('Page.handleJavaScriptDialog',{accept:true});}
  };
  const run=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const until=async(expression,label=expression)=>{for(let i=0;i<300;i++){if(await run(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for '+label+' · '+await run('document.querySelector("#bibImportStatus")?.textContent+" | "+document.querySelector("#bibReviewPreview")?.textContent.slice(0,300)'));};
  const shot=async name=>{const {data:image}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(shots,name),Buffer.from(image,'base64'));};
  const visible=selector=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.checkVisibility();})()`);
  const text=selector=>run(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
  const chooseFiles=async files=>{const {root:doc}=await call('DOM.getDocument'),{nodeId}=await call('DOM.querySelector',{nodeId:doc.nodeId,selector:'#bibReviewFile'});await call('DOM.setFileInputFiles',{nodeId,files});};

  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('DOM.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:base+'/'});
  await until('document.querySelector("#statPapers")?.textContent==="1,220"','overview');
  await run('document.querySelector("#bibliographyOpen").click()');
  await until('document.querySelector("#bibBundleInfo").textContent.includes("1,220건")','bundle totals');

  // ---- unified queue, with no separate candidate section or per-row buttons ----
  await until('document.querySelectorAll(".bib-row").length===50','initial unified queue');
  assert.equal(await run('!!document.querySelector("#bibQueue")'),false);
  assert.equal(await run('document.querySelector("#bibAdvanced").open'),false);
  assert.equal(await run('document.querySelectorAll(".bib-row button").length'),0);
  assert.ok((await text('#bibBundleInfo')).includes('파일 1개'));
  const href=await run('document.querySelector("#bibBundleDownload").href'),bundle=await(await fetch(href)).json();assert.equal(bundle.total,1220);
  const proposed=new Map(proposedIds.map(i=>['name:orph'+i+'lab',i])),evidence=[{type:'explicit-alias-expansion',detail:'Fixture evidence for the browser check.'}];
  const decisions=bundle.items.map(item=>proposed.has(item.candidateId)?{candidateId:item.candidateId,decision:'propose',recordId:null,proposal:{doi:orphanDoi(proposed.get(item.candidateId))},evidence,needsManualReview:false}:item.candidates.length?{candidateId:item.candidateId,decision:'match',recordId:item.candidates[0].recordId,evidence,needsManualReview:false}:{candidateId:item.candidateId,decision:Number(/\d+/.exec(item.title)[0])%2?'separate':'defer',recordId:null,evidence,needsManualReview:false});
  decisions.sort((a,b)=>(b.decision==='propose')-(a.decision==='propose'));decisions.push(structuredClone(decisions[0]),{candidateId:'name:never-seen',decision:'separate',recordId:null,evidence,needsManualReview:false});
  const half=Math.floor(decisions.length/2),files=[path.join(temp,'result-part-1.json'),path.join(temp,'result-part-2.json')];
  await fs.writeFile(files[0],JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions:decisions.slice(0,half)}));await fs.writeFile(files[1],JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions:decisions.slice(half)}));
  await chooseFiles(files);await until('document.querySelector("#bibImportStatus strong")?.textContent.includes("가져온 JSON 1,222건")','validation finished');
  const imports=await(await fetch(base+'/api/bibliography/review/import')).json(),importId=imports.imports[0].id;
  const queue=await(await fetch(base+'/api/bibliography/review/queue?'+new URLSearchParams({importId,status:'all'}))).json();
  assert.equal(queue.counts.ready,913);assert.equal(queue.counts['needs-manual-review'],1);assert.equal(queue.counts.error,1);assert.equal(queue.total,1221,'duplicate import rows appear once');
  assert.equal(await run('document.querySelectorAll("[data-review-approve]:checked").length'),0);
  assert.equal(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8').catch(()=>null),null);
  const change=(id,value)=>run(`(()=>{const e=document.querySelector(${JSON.stringify('#'+id)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change'));})()`);
  assert.deepEqual(await run('[...document.querySelector("#bibQueueStatus").options].map(o=>o.textContent)'),['검토할 항목','처리 완료','오류','전체']);
  await change('bibQueueStatus','error');await until('document.querySelectorAll(".bib-row[data-status=error]").length===1','error filter');
  await shot('review-error.png');
  await change('bibQueueStatus','pending');await run('document.querySelector("#bibQueueSearch").value="Vela";document.querySelector("#bibQueueSearch").dispatchEvent(new Event("input"))');await until('document.querySelector("#bibQueueSummary").textContent.includes("현재 필터 600건")','search candidates');
  await run('document.querySelector("[data-review-approve]").click()');assert.equal(await text('#bibReviewApply'),'선택한 1건 최종 승인·적용');
  await run('document.querySelector("#bibSelectFiltered").click()');await until('document.querySelector("#bibReviewApply").textContent==="선택한 600건 최종 승인·적용"','select entire filter');
  await run('document.querySelectorAll("[data-review-approve]:checked")[1].click()');assert.equal(await text('#bibReviewApply'),'선택한 599건 최종 승인·적용');
  await run('document.querySelector("#bibPreviewTitle").scrollIntoView({block:"start"})');await shot('review-selected.png');
  // A delayed search request must not clear choices made on its rendered results.
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.equal(await run('document.querySelector("#bibReviewApply").disabled'),false,await text('#bibSelectedCount'));
  await run('document.querySelector("#bibReviewApply").click()');
  for(let i=0;!approvals.length&&i<100;i++)await new Promise(r=>setTimeout(r,25));
  assert.equal(approvals[0]?.selections?.length,599);assert.deepEqual(approvals[0].selections.filter(s=>!['match','separate','dismiss'].includes(s.action)||typeof s.candidateId!=='string'||typeof s.token!=='string'||s.action==='match'&&typeof s.recordId!=='string'),[]);
  await until('document.querySelector("#bibImportStatus")?.textContent.includes("적용 599건")','explicit approval');
  assert.equal(dialogs.length,0,'the single final approval button replaces an extra confirmation dialog');
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8'))).length,599);
  await until('document.querySelector("#bibBundleInfo").textContent.includes("621건")','remaining candidates');
  await change('bibQueueStatus','completed');await until('document.querySelector("#bibQueueSummary").textContent.includes("현재 필터 599건")','completed group');
  assert.equal(await run('document.querySelectorAll(".bib-row input:not(:disabled)").length'),0);
  await chooseFiles(files);await until('document.querySelector("#bibReviewNotices").textContent.includes("이미 가져온 JSON")','reopen duplicate');
  assert.equal((await(await fetch(base+'/api/bibliography/review/import')).json()).imports.length,1);
  await run('document.querySelector("#bibAdvanced").open=true');await change('bibBatchSize','50');assert.ok((await run('document.querySelector("#bibBundleDownload").href')).includes('batchSize=50'));
  await run('document.querySelector("#bibReviewInput").value="{\\"schemaVersion\\":2}";document.querySelector("#bibReviewPaste").click()');await until('document.querySelector("#bibImportStatus").textContent.includes("decisions 배열")','invalid paste');
  await call('Page.reload');await until('!!document.querySelector("#bibliographyOpen")','reload');await run('document.querySelector("#bibliographyOpen").click()');await until('document.querySelector("#bibImportStatus")?.textContent.includes("적용 599건")','restore pending manual rows');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
  assert.ok(await run('(()=>{const d=document.querySelector("#bibliographyDialog");return d.scrollWidth<=d.clientWidth+1;})()'),'phone dialog has no horizontal overflow');
  await run('document.querySelector("#bibPreviewTitle").scrollIntoView({block:"start"})');await shot('review-mobile.png');
  assert.deepEqual(errors,[]);assert.deepEqual(requests.filter(u=>{const parsed=new URL(u);return ['http:','https:'].includes(parsed.protocol)&&parsed.origin!==new URL(base).origin;}),[]);
  console.log('Passed: four review groups, unified queue, search, duplicate removal, partial-file import, explicit approval of 599 choices, completed group, preservation, reload and mobile layout.');

}finally{
  ws?.close();if(target)await fetch(endpoint+'/json/close/'+target.id).catch(()=>{});
  if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('researchscape-review-browser-'));
  await fs.rm(resolved,{recursive:true,force:true});
}
