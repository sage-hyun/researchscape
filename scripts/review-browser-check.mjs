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
  let serial=0;const pending=new Map(),errors=[],requests=[],dialogs=[];
  const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});
  ws.onmessage=event=>{
    const message=JSON.parse(event.data);
    if(message.id){const p=pending.get(message.id);if(!p)return;pending.delete(message.id);message.error?p.reject(new Error(JSON.stringify(message.error))):p.resolve(message.result);}
    if(message.method==='Runtime.exceptionThrown')errors.push(message.params.exceptionDetails.text+': '+(message.params.exceptionDetails.exception?.description||''));
    if(message.method==='Network.requestWillBeSent')requests.push(message.params.request.url);
    // The final approval asks once more before writing; the check answers like a person who agrees.
    if(message.method==='Page.javascriptDialogOpening'){dialogs.push(message.params.message);call('Page.handleJavaScriptDialog',{accept:true});}
  };
  const run=async expression=>{const r=await call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
  const until=async(expression,label=expression)=>{for(let i=0;i<300;i++){if(await run(expression))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out waiting for '+label+' · '+await run('document.querySelector("#bibImportStatus")?.textContent+" | "+document.querySelector("#bibReviewPreview")?.textContent.slice(0,300)'));};
  const shot=async name=>{const {data:image}=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});await fs.writeFile(path.join(shots,name),Buffer.from(image,'base64'));};
  const visible=selector=>run(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&e.checkVisibility();})()`);
  const text=selector=>run(`document.querySelector(${JSON.stringify(selector)})?.textContent||''`);
  const chooseFiles=async files=>{const {root:doc}=await call('DOM.getDocument'),{nodeId}=await call('DOM.querySelector',{nodeId:doc.nodeId,selector:'#bibReviewFile'});await call('DOM.setFileInputFiles',{nodeId,files});};
  const chip=name=>run(`[...document.querySelectorAll(".bib-chip")].find(b=>b.textContent.startsWith(${JSON.stringify(name)}))?.querySelector("strong").textContent`);

  await call('Page.enable');await call('Runtime.enable');await call('Network.enable');await call('DOM.enable');
  await call('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await call('Page.navigate',{url:base+'/'});
  await until('document.querySelector("#statPapers")?.textContent==="1,220"','overview');
  await run('document.querySelector("#bibliographyOpen").click()');
  await until('document.querySelector("#bibBundleInfo").textContent.includes("1,220건")','bundle totals');

  // ---- default screen: four things, everything else under advanced settings ----
  assert.equal(await text('#bibBundleDownload'),'전체 LLM 검토 JSON 다운로드');assert.equal(await text('#bibReviewPick'),'LLM 검토 결과 JSON 가져오기');
  for(const selector of ['#bibBundleDownload','#bibReviewPick','#bibReviewPreview','#bibReviewApply'])assert.ok(await visible(selector),selector+' is visible by default');
  assert.equal(await run('document.querySelector("#bibAdvanced").open'),false);
  for(const selector of ['#bibExportGroup','#bibExportSize','#bibExportPage','#bibCompactDownload','#bibBatchSize','#bibReviewInput'])assert.equal(await visible(selector),false,selector+' is hidden until advanced settings open');
  assert.ok((await text('#bibBundleInfo')).includes('파일 1개')&&(await text('#bibBundleInfo')).includes('배치 16개'));
  assert.equal(await run('document.querySelector("#bibReviewApply").disabled'),true);assert.ok((await text('#bibReviewPreview')).includes('가져온 검토 결과가 없습니다'));
  await run('document.querySelector(".bib-llm").scrollIntoView()');await shot('review-default.png');

  // ---- one download ----
  const href=await run('document.querySelector("#bibBundleDownload").href');assert.ok(href.includes('format=bundle')&&href.includes('batchSize=80'));
  const bundle=await(await fetch(href)).json();assert.equal(bundle.total,1220);assert.equal(bundle.batches.length,16);
  const proposed=new Map(proposedIds.map(i=>['name:orph'+i+'lab',i])),evidence=[{type:'explicit-alias-expansion',detail:'Fixture evidence for the browser check.'}];
  const decisions=bundle.items.map(item=>proposed.has(item.candidateId)?{candidateId:item.candidateId,decision:'propose',recordId:null,proposal:{doi:orphanDoi(proposed.get(item.candidateId))},evidence,needsManualReview:false}:item.candidates.length?{candidateId:item.candidateId,decision:'match',recordId:item.candidates[0].recordId,evidence,needsManualReview:false}:{candidateId:item.candidateId,decision:Number(/\d+/.exec(item.title)[0])%2?'separate':'defer',recordId:null,evidence,needsManualReview:false});
  // The file order is the reviewer's own: proposals first, so their lookups show at the top.
  decisions.sort((a,b)=>(b.decision==='propose')-(a.decision==='propose'));
  decisions.push(structuredClone(decisions[0]),{candidateId:'name:never-seen',decision:'separate',recordId:null,evidence,needsManualReview:false});
  const half=Math.floor(decisions.length/2),files=[path.join(temp,'result-part-1.json'),path.join(temp,'result-part-2.json')];
  await fs.writeFile(files[0],JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions:decisions.slice(0,half)}));
  await fs.writeFile(files[1],JSON.stringify({schemaVersion:2,snapshot:bundle.snapshot,decisions:decisions.slice(half)}));

  // ---- one import: two partial result files chosen together ----
  await chooseFiles(files);
  await until('document.querySelector("#bibImportStatus strong")?.textContent.startsWith("검증 완료")','validation finished');
  assert.ok((await text('#bibImportStatus')).includes('부분 결과 2개 병합'));
  const counts={ready:await chip('적용 가능'),review:await chip('추가 검토 필요'),preserved:await chip('기존 결정 보존'),duplicate:await chip('중복'),error:await chip('오류'),deferred:await chip('보류')};
  assert.deepEqual(counts,{ready:'913',review:'1',preserved:'0',duplicate:'1',error:'1',deferred:'306'});
  assert.equal(await run('document.querySelectorAll(".bib-row").length'),50);assert.ok((await text('[data-review-more]')).includes('863건 남음'));
  assert.equal(await run('document.querySelectorAll("[data-review-approve]:checked").length'),0,'nothing is selected until the person chooses');
  assert.equal(await run('document.querySelector("#bibReviewApply").disabled'),true);
  assert.ok((await text('#bibReviewPreview')).includes('3건을 연결 후보로 등록'));
  // A proposed DOI is shown next to what the provider returned for it.
  const first=await text('.bib-row');assert.ok(first.includes('LLM 제안: DOI '+orphanDoi(0))&&first.includes('공식 조회: '+orphanTitle(0))&&first.includes('Fixture Author'),first);
  await shot('review-preview.png');
  // Filters show the other outcomes with their reasons.
  await run('[...document.querySelectorAll(".bib-chip")].find(b=>b.textContent.startsWith("추가 검토 필요")).click()');
  await until('document.querySelectorAll(".bib-row").length===1&&document.querySelector(".bib-row").dataset.status==="needs-manual-review"','manual review filter');
  assert.ok((await text('.bib-row')).includes('찾지 못했습니다'));assert.equal(await run('document.querySelector(".bib-row input").disabled'),true);await shot('review-manual.png');
  await run('[...document.querySelectorAll(".bib-chip")].find(b=>b.textContent.startsWith("오류")).click()');
  await until('document.querySelector(".bib-row")?.dataset.status==="error"','error filter');
  await run('[...document.querySelectorAll(".bib-chip")].find(b=>b.textContent.startsWith("적용 가능")).click()');
  await until('document.querySelectorAll(".bib-row[data-status=ready]").length===50','ready filter');
  assert.equal(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8').catch(()=>null),null,'the preview wrote no decisions');

  // ---- individual selection, select all, final approval ----
  await run('document.querySelector("[data-review-approve]:not(:disabled)").click()');
  assert.equal(await text('#bibReviewApply'),'선택한 1건 최종 승인·적용');assert.equal(await run('document.querySelector("#bibReviewApply").disabled'),false);
  await run('document.querySelector("[data-review-select=all]").click()');
  await until('document.querySelector("#bibReviewApply").textContent==="선택한 913건 최종 승인·적용"','select all');
  await run('document.querySelectorAll("[data-review-approve]:checked")[1].click()');
  assert.equal(await text('#bibReviewApply'),'선택한 912건 최종 승인·적용');assert.equal(await text('#bibSelectedCount'),'912건 선택됨');
  await shot('review-selected.png');
  await run('document.querySelector("#bibReviewApply").click()');
  await until('document.querySelector("#bibImportStatus")?.textContent.includes("912건 적용")','applied');
  assert.equal(dialogs.length,1);assert.ok(dialogs[0].includes('912건'));
  assert.equal(Object.keys(JSON.parse(await fs.readFile(path.join(state,'bibliography-decisions.json'),'utf8'))).length,912);
  assert.equal(await chip('적용 가능'),'1');assert.equal(await chip('적용됨'),'912');assert.equal(await text('#bibReviewApply'),'선택한 0건 최종 승인·적용');
  await until('document.querySelector("#bibBundleInfo").textContent.includes("308건")','remaining candidates');
  await shot('review-applied.png');

  // ---- the same files again open the existing import; advanced settings stay available ----
  await chooseFiles(files);
  await until('document.querySelector("#bibReviewPreview").textContent.includes("같은 JSON을 이미 가져왔습니다")','duplicate notice');
  assert.equal((await(await fetch(base+'/api/bibliography/review/import')).json()).imports.length,1);
  await run('document.querySelector("#bibAdvanced").open=true');
  for(const selector of ['#bibExportGroup','#bibCompactDownload','#bibBatchSize','#bibReviewInput'])assert.ok(await visible(selector),selector);
  await run('document.querySelector("#bibBatchSize").value="50";document.querySelector("#bibBatchSize").dispatchEvent(new Event("change"))');
  assert.ok((await run('document.querySelector("#bibBundleDownload").href')).includes('batchSize=50'));assert.ok((await text('#bibBundleInfo')).includes('50건 배치 7개'));
  assert.ok((await run('document.querySelector("#bibCompactDownload").href')).includes('format=compact'));
  // A malformed paste is explained without leaving the dialog.
  await run('document.querySelector("#bibReviewInput").value="{\\"schemaVersion\\":2}";document.querySelector("#bibReviewPaste").click()');
  await until('document.querySelector("#bibImportStatus").textContent.includes("decisions 배열")','paste error');
  assert.ok(await run('(()=>{const d=document.querySelector("#bibliographyDialog").getBoundingClientRect(),s=document.querySelector("#bibImportStatus").getBoundingClientRect();return s.top>=d.top&&s.bottom<=d.bottom;})()'),'the error is scrolled into view');
  await run('document.querySelector(".bib-advanced").scrollIntoView()');await shot('review-advanced.png');

  // ---- reload: the unfinished import is restored from the server ----
  await call('Page.reload');await until('document.querySelector("#statPapers")?.textContent!=="—"&&!!document.querySelector("#bibliographyOpen")','reload');
  await run('document.querySelector("#bibliographyOpen").click()');
  await until('document.querySelector("#bibImportStatus strong")?.textContent.startsWith("검증 완료")','restored import');
  assert.equal(await chip('적용됨'),'912');
  await call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await new Promise(r=>setTimeout(r,500));
  assert.ok(await run('document.documentElement.scrollWidth<=window.innerWidth'),'mobile horizontal overflow');
  assert.ok(await run('(()=>{const d=document.querySelector("#bibliographyDialog");return d.scrollWidth<=d.clientWidth+1;})()'),'dialog content fits a phone');
  await run('document.querySelector(".bib-llm").scrollIntoView()');await shot('review-mobile.png');

  assert.deepEqual(errors,[],'browser JavaScript errors');
  const external=requests.filter(u=>{const parsed=new URL(u);return ['http:','https:'].includes(parsed.protocol)&&parsed.origin!==new URL(base).origin;});
  assert.deepEqual(external,[],'unexpected external network request');
  console.log(JSON.stringify({passed:['default screen shows four controls','advanced settings hidden by default','single bundle download (1,220 candidates, 16 batches)','two partial files imported as one','summary counts','status filters','no writes before approval','individual + select-all selection','final approval of 912 decisions','duplicate import reopened','advanced batch size + per-page download','paste error message','import restored after reload','mobile layout','no JS exceptions','no external requests'],screenshots:['review-default.png','review-preview.png','review-manual.png','review-selected.png','review-applied.png','review-advanced.png','review-mobile.png'].map(name=>path.join(shots,name))},null,2));
}finally{
  ws?.close();if(target)await fetch(endpoint+'/json/close/'+target.id).catch(()=>{});
  if(child.exitCode===null){const done=once(child,'exit');child.kill();await done;}
  const resolved=path.resolve(temp);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('researchscape-review-browser-'));
  await fs.rm(resolved,{recursive:true,force:true});
}
