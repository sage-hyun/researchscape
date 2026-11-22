import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex} from '../lib/extract.mjs';
import {crossrefRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {BibliographyWorkspace,reviewStatusGroup} from '../lib/bibliography-workspace.mjs';
import {REVIEW_EVIDENCE,evidenceOrder} from '../lib/review-evidence.mjs';
import {EVIDENCE_TYPES} from '../lib/bibliography-review.mjs';
import {FigureManager} from '../lib/figure-manager.mjs';
import {matchLibrary,prepareLibrary} from '../lib/pdf-library.mjs';

function fixture(){
  const raw=buildIndex([{id:'c',messages:[{id:'m',role:'user',date:1,text:'CoMA 논문 ResNet 논문 Video-to-IMU 논문 NMAL 논문'}]}]);
  const coma=crossrefRecord({DOI:'10.1234/coma',title:['Generating 3D Faces using Convolutional Mesh Autoencoders'],author:[{given:'Fixture',family:'Author'}]}),resnet=crossrefRecord({DOI:'10.1234/resnet',title:['Deep Residual Learning for Image Recognition']});
  for(const r of [coma,resnet])r.provisional='llm-proposal';
  const h={raw,store:{records:{[coma.id]:coma,[resnet.id]:resnet},lookups:{},proposedLinks:{'name:coma':{recordIds:[coma.id]},'name:resnet':{recordIds:[resnet.id]}}},decisions:{},reviews:{'name:coma':{status:'unreviewed',itemKey:'KEEP0001',pdfKey:'KEEP0002',note:'retain'}},busy:false,writes:0};
  const external=[{type:'external-identifier',detail:'The canonical paper proposed by the LLM.'}],insufficient=[{type:'insufficient-evidence',detail:'A research topic, not a known paper title.'}];
  h.imported={requiresConfirmation:false,running:false,rows:[{candidateId:'name:coma',status:'needs-manual-review',decision:'propose',recordId:null,evidence:external,verification:{status:'weak-link',registered:true,record:{recordId:coma.id,title:coma.title}}},{candidateId:'name:resnet',status:'needs-manual-review',decision:'propose',evidence:external,verification:{status:'weak-link',registered:true,record:{recordId:resnet.id}}},{candidateId:'name:videotoimu',status:'needs-manual-review',decision:'separate',evidence:insufficient},{candidateId:'name:coma',status:'duplicate',evidence:external}]};
  h.refresh=()=>h.resolved=reconcileIndex(h.raw,h.store,h.decisions);h.refresh();
  h.workspace=new BibliographyWorkspace({context:()=>h,imports:{reviewState:()=>h.imported,recordManualApplications:(id,selections)=>h.recorded=selections},saveDecisions:v=>{h.decisions=v;h.writes++;},saveReviews:v=>{if(h.failReviews)throw Error('fixture disk failure');h.reviews=v;h.writes++;},refresh:h.refresh,busy:()=>h.busy});
  h.row=id=>h.workspace.view({importId:'fixture',status:'all'}).rows.find(r=>r.candidateId===id);
  h.selection=(id,action='match',recordId)=>{const r=h.row(id);return {candidateId:id,token:r.token,action,recordId:recordId||r.recordId};};
  return h;
}

test('verified weak acronym proposals are selectable in one deduplicated queue but never link on preview',()=>{
  const h=fixture(),before=structuredClone(h.raw),q=h.workspace.view({importId:'fixture',evidence:'external-identifier'});
  assert.equal(q.total,2);assert.equal(q.rows[0].status,'needs-manual-review');assert.equal(q.rows.every(r=>r.selectable&&r.manualConfirmation),true);
  const r=h.row('name:coma');assert.equal(r.recordId,'doi:10.1234/coma');assert.equal(r.duplicates,1);assert.equal(r.candidates.length,1);assert.equal(h.writes,0);assert.equal(h.resolved.stats.metadataVerified,0);
  assert.deepEqual(h.raw,before);assert.equal(JSON.stringify(q).includes('KEEP0001'),false);
  assert.throws(()=>h.workspace.apply({importId:'fixture',selections:[h.selection('name:coma')]}),e=>e.code==='APPROVAL_REQUIRED');
  const chosen=[h.selection('name:coma'),h.selection('name:resnet')],result=h.workspace.apply({importId:'fixture',approved:true,selections:chosen});
  assert.equal(result.matched,2);assert.equal(h.decisions['name:coma'].decisionSource,'human-review');assert.equal(h.resolved.stats.metadataVerified,2);assert.deepEqual(h.raw,before);
  assert.equal(h.workspace.apply({importId:'fixture',approved:true,selections:chosen}).applied,0);
});

test('insufficient evidence stays unexcluded until a human chooses dismiss, preserving Zotero keys and distinct separation',()=>{
  const h=fixture(),r=h.row('name:videotoimu');assert.equal(r.selectable,true);assert.equal(r.defaultAction,'separate');assert.equal(h.reviews['name:videotoimu'],undefined);
  const original=structuredClone(h.reviews['name:coma']);
  const result=h.workspace.apply({importId:'fixture',approved:true,selections:[h.selection('name:coma','dismiss'),h.selection('name:videotoimu','separate')]});
  assert.equal(result.dismissed,1);assert.equal(result.separated,1);assert.equal(h.reviews['name:coma'].status,'dismissed');
  assert.equal(h.reviews['name:coma'].itemKey,original.itemKey);assert.equal(h.reviews['name:coma'].pdfKey,original.pdfKey);assert.equal(h.reviews['name:coma'].note,original.note);
  assert.equal(h.decisions['name:coma'],undefined);assert.equal(h.decisions['name:videotoimu'].action,'separate');assert.equal(h.reviews['name:videotoimu'],undefined);
});

test('ambiguous records need explicit selection; unmatched, conflicting and non-paper records cannot be forged',()=>{
  const h=fixture(),other=crossrefRecord({DOI:'10.1234/other',title:['Another Verified Research Paper About Mesh Prediction']});other.provisional='llm-proposal';
  h.store.records[other.id]=other;h.store.proposedLinks['name:nmal']={recordIds:['doi:10.1234/coma',other.id]};h.refresh();
  const r=h.row('name:nmal');assert.equal(r.defaultAction,'');assert.equal(r.recordId,null);assert.equal(r.candidates.length,2);
  const bad=h.workspace.apply({approved:true,selections:[{candidateId:r.candidateId,token:r.token,action:'match',recordId:'doi:10.1234/missing'}]});assert.equal(bad.applied,0);assert.equal(bad.skipped.length,1);
  assert.equal(h.workspace.apply({approved:true,selections:[{candidateId:r.candidateId,token:r.token,action:'match',recordId:other.id}]}).applied,1);
  const dataset=crossrefRecord({DOI:'10.1234/data',title:['A Motion Capture Dataset for Wearable Inertial Sensors'],type:'dataset'});h.store.records[dataset.id]=dataset;h.store.proposedLinks['name:videotoimu']={recordIds:[dataset.id]};h.refresh();
  assert.equal(h.row('name:videotoimu').candidates.length,0);
});

test('stale metadata, a new manual decision, unknown snapshots and active jobs prevent writes',()=>{
  const h=fixture(),s=h.selection('name:coma');h.store.records['doi:10.1234/coma'].title='A Different Official Title';h.refresh();assert.equal(h.workspace.apply({approved:true,selections:[s]}).skipped.length,1);assert.equal(h.writes,0);
  const fresh=h.selection('name:resnet');h.decisions['name:resnet']={action:'separate',updatedAt:'manual'};h.refresh();assert.equal(h.workspace.apply({approved:true,selections:[fresh]}).applied,0);assert.equal(h.decisions['name:resnet'].updatedAt,'manual');
  h.imported.requiresConfirmation=true;assert.throws(()=>h.workspace.apply({importId:'fixture',approved:true,selections:[h.selection('name:coma','dismiss')]}),e=>e.code==='SNAPSHOT_CONFIRMATION_REQUIRED');
  h.busy=true;assert.throws(()=>h.workspace.apply({approved:true,selections:[h.selection('name:coma','dismiss')]}),e=>e.code==='REVIEW_BUSY');
});

test('partial file-save failure keeps completed decisions and permits retry of only remaining actions',()=>{
  const h=fixture(),selections=[h.selection('name:coma'),h.selection('name:videotoimu','dismiss')];h.failReviews=true;
  assert.throws(()=>h.workspace.apply({approved:true,selections}),e=>e.code==='PARTIAL_APPLY'&&e.details.applied===1);assert.equal(h.decisions['name:coma'].action,'match');
  h.failReviews=false;const result=h.workspace.apply({approved:true,selections});assert.equal(result.applied,1);assert.equal(result.skipped.length,1);assert.equal(h.reviews['name:videotoimu'].status,'dismissed');
});

test('confirmed paper reviews still allow bibliography linking while their status and Zotero keys cannot be overwritten by exclusion',()=>{
  const h=fixture();h.reviews['name:coma'].status='confirmed';const before=structuredClone(h.reviews['name:coma']),r=h.row('name:coma');
  assert.equal(r.selectable,true);assert.equal(r.allowedActions.includes('dismiss'),false);
  assert.equal(h.workspace.apply({approved:true,selections:[h.selection('name:coma','dismiss')]}).applied,0);
  assert.equal(h.workspace.apply({approved:true,selections:[h.selection('name:coma')]}).matched,1);
  assert.deepEqual(h.reviews['name:coma'],before);
});

test('the entire filtered selection includes candidates beyond the old 60-row ceiling',()=>{
  const h=fixture();h.raw=buildIndex([{id:'c',messages:Array.from({length:130},(_,i)=>({id:'m'+i,role:'user',date:1,text:`MotionFixture${i} 논문`}))}]);h.refresh();
  const first=h.workspace.view({status:'pending',limit:50,ids:'selectable'});assert.equal(first.total,130);assert.equal(first.rows.length,50);assert.equal(first.selections.length,130);
  const last=h.workspace.view({status:'pending',offset:100,limit:50});assert.equal(last.rows.length,30);assert.equal(new Set([...first.rows,...last.rows].map(r=>r.candidateId)).size,80);
});

test('four visible review groups partition every row while legacy statuses and saved decisions stay intact',()=>{
  for(const status of ['ready','needs-manual-review','deferred','stale'])assert.equal(reviewStatusGroup(status),'pending');
  for(const status of ['preserved','applied'])assert.equal(reviewStatusGroup(status),'completed');
  assert.equal(reviewStatusGroup('error'),'error');
  const h=fixture();h.imported.rows.find(r=>r.candidateId==='name:resnet').status='ready';h.imported.rows.find(r=>r.candidateId==='name:videotoimu').status='deferred';h.imported.rows.push({candidateId:'name:unknown',status:'error',reason:'Unknown ID'});
  h.decisions['name:nmal']={action:'separate',updatedAt:'preserve'};h.refresh();
  const before=structuredClone(h.imported),options={importId:'fixture'},pending=h.workspace.view({...options,status:'pending'}),completed=h.workspace.view({...options,status:'completed'}),error=h.workspace.view({...options,status:'error'}),all=h.workspace.view({...options,status:'all'});
  assert.equal(pending.total,3);assert.equal(completed.total,1);assert.equal(error.total,1);assert.equal(all.total,5);
  assert.deepEqual(all.groups,{pending:3,completed:1,error:1});
  assert.equal(new Set([...pending.rows,...completed.rows,...error.rows].map(r=>r.candidateId)).size,all.total);
  assert.ok(pending.rows.every(r=>r.statusGroup==='pending'));assert.equal(completed.rows[0].appliedAction,'separate');
  assert.equal(h.workspace.view({...options,status:'ready'}).rows[0].candidateId,'name:resnet','old API filter still works');
  const choice=h.selection('name:coma');h.workspace.apply({importId:'fixture',approved:true,selections:[choice]});
  const done=h.workspace.view({...options,status:'completed'});assert.equal(done.total,2);assert.ok(done.rows.some(r=>r.status==='applied'));assert.ok(done.rows.some(r=>r.status==='preserved'));
  assert.deepEqual(h.imported,before);assert.equal(h.decisions['name:nmal'].updatedAt,'preserve');
});

test('all ten evidence types and missing evidence can be filtered, counted and ordered without changing approval or stored evidence',()=>{
  assert.deepEqual([...REVIEW_EVIDENCE.map(e=>e.type)].sort(),[...EVIDENCE_TYPES].sort());
  const h=fixture();h.raw=buildIndex([{id:'c',messages:Array.from({length:11},(_,i)=>({id:'m'+i,role:'user',date:1,text:`EvidenceFixture${i} 논문`}))}]);
  h.imported.rows=REVIEW_EVIDENCE.map((e,i)=>({candidateId:'name:evidencefixture'+i,status:'needs-manual-review',evidence:[{type:e.type,detail:'Fixture claim'}]}));h.refresh();
  h.raw.papers.find(p=>p.id==='name:evidencefixture9').count=1000;
  const before=structuredClone(h.imported),query={importId:'fixture',status:'pending'};
  const all=h.workspace.view(query);assert.equal(all.total,11);assert.equal(all.rows[0].candidateId,'name:evidencefixture9');
  for(const e of REVIEW_EVIDENCE){const filtered=h.workspace.view({...query,evidence:e.type,ids:'selectable'});assert.equal(filtered.total,1);assert.deepEqual(filtered.rows[0].evidenceTypes,[e.type]);assert.equal(filtered.selections.length,1);assert.equal(filtered.evidenceCounts[e.type],1);}
  assert.equal(h.workspace.view({...query,evidence:'none'}).total,1);
  const ordered=h.workspace.view({...query,sort:'evidence'});assert.deepEqual(ordered.rows.map(r=>r.evidencePriority),Array.from({length:11},(_,i)=>i+1));
  assert.deepEqual(h.workspace.view({...query,sort:'evidence',offset:5,limit:3}).rows.map(r=>r.evidencePriority),[6,7,8]);
  assert.deepEqual(h.imported,before);assert.equal(h.writes,0);
  assert.throws(()=>h.workspace.view({evidence:'made-up'}),e=>e.code==='INVALID_FILTER');assert.throws(()=>h.workspace.view({sort:'made-up'}),e=>e.code==='INVALID_SORT');
});

test('negative or incomplete verification overrides optimistic LLM evidence labels in the review order',()=>{
  const claimed={evidence:[{type:'identifier-match',detail:'LLM claim'}]};
  assert.equal(evidenceOrder({...claimed,verification:{status:'weak-link'}}).evidencePriority,5);
  assert.equal(evidenceOrder({...claimed,verification:{status:'lookup-failed'}}).evidencePriority,9);
  assert.equal(evidenceOrder({...claimed,verification:{status:'ambiguous'}}).evidencePriority,10);
  assert.equal(evidenceOrder({...claimed,reason:'identifier-title-conflict'}).evidencePriority,10);
  assert.equal(evidenceOrder({evidence:[...claimed.evidence,{type:'conflicting-identifiers'}]}).evidencePriority,10);
  assert.equal(evidenceOrder({evidence:[...claimed.evidence,{type:'insufficient-evidence'}]}).evidencePriority,9);
  assert.equal(evidenceOrder({evidence:[...claimed.evidence,{type:'possible-work-version'}]}).evidencePriority,8);
  assert.deepEqual(evidenceOrder({evidence:[...claimed.evidence,...claimed.evidence]}).evidenceTypes,['identifier-match']);
});

test('a contradictory OpenAlex record stays blocked without suppressing an independent clean arXiv candidate',()=>{
  const h=fixture(),title='Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer';
  const id={key:'arxiv:1701.06538',kind:'arxiv',value:'1701.06538',url:'https://arxiv.org/abs/1701.06538'};
  const arxiv={id:id.key,title,provider:'arXiv',url:id.url,identifiers:[id],authors:[]},openalex=crossrefRecord({DOI:'10.48550/arxiv.1701.06538',title:[title]});
  openalex.provider='OpenAlex';openalex.identifiers.push(id,...['10.5281/zenodo.17754506','10.5281/zenodo.17754507'].map(value=>({key:'doi:'+value,kind:'doi',value,url:'https://doi.org/'+value})));
  h.raw=buildIndex([{id:'c',messages:[{id:'m',role:'user',date:1,text:title+' https://arxiv.org/abs/1701.06538'}]}]);
  h.store={records:{[arxiv.id]:arxiv,[openalex.id]:openalex},lookups:{}};
  h.imported.rows=[{candidateId:id.key,status:'needs-manual-review',decision:'match',recordId:id.key,evidence:[{type:'exact-title',detail:'The titles match.'}]}];h.refresh();
  const before=structuredClone(h.store),r=h.row(id.key);assert.equal(r.candidates.length,1);assert.equal(r.candidates[0].recordId,id.key);assert.equal(r.blockedCandidates.length,1);
  for(const candidate of r.blockedCandidates){const issue=candidate.issues.find(i=>i.type==='multiple-identifiers'&&i.kind==='doi');assert.deepEqual(issue.values,['doi:10.5281/zenodo.17754506','doi:10.5281/zenodo.17754507']);}
  assert.equal(h.workspace.apply({approved:true,selections:[{candidateId:id.key,action:'match',recordId:openalex.id,token:r.token}]}).applied,0);
  assert.equal(h.workspace.apply({approved:true,selections:[{candidateId:id.key,action:'match',recordId:id.key,token:r.token}]}).applied,1);
  assert.deepEqual(h.store,before);
});

test('old snapshot warnings point to current manual review and do not force a fresh LLM result',()=>{
  const h=fixture(),imported=h.imported.rows.find(r=>r.candidateId==='name:coma');imported.snapshotCheck='changed';imported.reason='검토 JSON을 내려받은 뒤 이 후보의 연결 후보가 바뀌었습니다. 최신 검토 JSON으로 다시 검토해주세요.';
  const r=h.row('name:coma');assert.match(r.snapshotNotice,/현재 후보|아래의 현재/);assert.match(r.snapshotNotice,/반드시 다시 받을 필요는 없습니다/);assert.equal(r.candidates.length,1);
  assert.equal(h.workspace.apply({importId:'fixture',approved:true,selections:[h.selection('name:coma')]}).matched,1);
  assert.equal(imported.reason,'검토 JSON을 내려받은 뒤 이 후보의 연결 후보가 바뀌었습니다. 최신 검토 JSON으로 다시 검토해주세요.','stored import history is not rewritten');
});

test('explicit merge into an approved library paper combines all mentions and preserves source records, keys and target approval',()=>{
  const h=fixture();h.raw=buildIndex([{id:'c-one',conversation_template_id:'g-p-fixture-a',messages:[{id:'first',role:'user',date:1,text:'CoMA 논문'}]},{id:'c-two',conversation_template_id:'g-p-fixture-b',messages:[{id:'second',role:'user',date:2,text:'Video-to-IMU 논문'}]}]);h.decisions['name:coma']={action:'match',recordId:'doi:10.1234/coma',updatedAt:'already approved',note:'keep'};h.reviews['name:videotoimu']={status:'unreviewed',itemKey:'KEEP0003',pdfKey:'KEEP0004'};h.refresh();
  const rawBefore=structuredClone(h.raw),reviewsBefore=structuredClone(h.reviews),targetBefore=structuredClone(h.decisions['name:coma']),view=h.workspace.view({importId:'fixture'}),target=view.libraryTargets.find(t=>t.paperId==='doi:10.1234/coma'),source=h.row('name:videotoimu');
  assert.equal(target.approved,true);assert.equal(source.mergeSuggestions.length,0,'a bare unrelated name is not automatically associated');
  const s={candidateId:source.candidateId,token:source.token,action:'merge',targetPaperId:target.paperId,targetToken:target.token};
  assert.throws(()=>h.workspace.apply({importId:'fixture',selections:[s]}),e=>e.code==='APPROVAL_REQUIRED');
  assert.equal(h.workspace.apply({importId:'fixture',approved:true,selections:[s]}).merged,1);
  const merged=h.resolved.papers.find(p=>p.id===target.paperId);assert.equal(merged.count,2);assert.equal(merged.conversationCount,2);assert.ok(merged.sourceCandidateIds.includes('name:coma'));assert.ok(merged.sourceCandidateIds.includes('name:videotoimu'));
  assert.deepEqual(h.raw,rawBefore);assert.deepEqual(h.reviews,reviewsBefore);assert.deepEqual(h.decisions['name:coma'],targetBefore);
  assert.deepEqual(new Set(h.resolved.mentions.filter(m=>m.paperId===target.paperId).map(m=>m.sourcePaperId)),new Set(['name:coma','name:videotoimu']));
  for(const m of h.resolved.mentions){const original=h.raw.mentions.find(o=>o.paperId===m.sourcePaperId&&o.start===m.start);for(const key of ['quote','excerpt','messageId','conversationId','date','role'])assert.equal(m[key],original[key]);}
  assert.equal(h.workspace.apply({importId:'fixture',approved:true,selections:[s]}).applied,0);
});

test('an explicitly re-merged prior approval is retained as history and stale or cyclic merge targets are rejected',()=>{
  const h=fixture();h.decisions={'name:coma':{action:'match',recordId:'doi:10.1234/coma',updatedAt:'first'},'name:resnet':{action:'match',recordId:'doi:10.1234/resnet',updatedAt:'second',evidence:[{type:'exact-title',detail:'original'}]}};h.refresh();
  const view=h.workspace.view({importId:'fixture',status:'completed'}),coma=view.libraryTargets.find(t=>t.paperId==='doi:10.1234/coma'),resnet=view.libraryTargets.find(t=>t.paperId==='doi:10.1234/resnet');
  const choose=(id,target)=>({candidateId:id,token:h.row(id).token,action:'merge',targetPaperId:target.paperId,targetToken:target.token});
  assert.equal(h.row('name:resnet').mergeOnly,true);assert.deepEqual(h.row('name:resnet').allowedActions,['merge']);
  const cycle=h.workspace.apply({approved:true,selections:[choose('name:coma',resnet),choose('name:resnet',coma)]});assert.equal(cycle.applied,0);assert.equal(cycle.skipped.length,2);
  const stale=choose('name:resnet',coma);h.store.records[coma.recordId].authors=['Updated Author'];h.refresh();assert.equal(h.workspace.apply({approved:true,selections:[stale]}).applied,0);
  const updated=h.workspace.view({status:'all'}).libraryTargets.find(t=>t.paperId===coma.paperId),old=structuredClone(h.decisions['name:resnet']);
  assert.equal(h.workspace.apply({approved:true,selections:[choose('name:resnet',updated)]}).merged,1);
  assert.deepEqual(h.decisions['name:resnet'].history,[old]);assert.equal(h.decisions['name:coma'].updatedAt,'first');assert.equal(h.resolved.papers.find(p=>p.id===coma.paperId).count,2);
});

test('merging a previously grouped paper carries every source, old paper link, manual PDF and cropped thumbnail forward',()=>{
  const h=fixture(),oldId='doi:10.1234/resnet',targetId='doi:10.1234/coma';h.decisions={'name:coma':{action:'match',recordId:targetId},'name:resnet':{action:'match',recordId:oldId,note:'source one'},'name:nmal':{action:'match',recordId:oldId,note:'source two'}};h.refresh();
  const oldDecisions=structuredClone(h.decisions),view=h.workspace.view({status:'all'}),target=view.libraryTargets.find(t=>t.paperId===targetId),row=h.row('name:nmal');assert.equal(row.mergeSource.count,2);
  const result=h.workspace.apply({approved:true,selections:[{candidateId:row.candidateId,token:row.token,action:'merge',targetPaperId:targetId,targetToken:target.token}]});assert.equal(result.merged,1);assert.equal(result.applied,2);
  const merged=h.resolved.papers.find(p=>p.id===targetId);assert.equal(merged.count,3);assert.ok(merged.memberIds.includes(oldId));assert.equal(h.resolved.redirects[oldId],targetId);
  for(const id of ['name:resnet','name:nmal'])assert.deepEqual(h.decisions[id].history,[oldDecisions[id]]);assert.deepEqual(h.decisions['name:coma'],oldDecisions['name:coma']);
  const hash='a'.repeat(64),figure={id:'old-manual-crop',kind:'custom'},media={state:{figureChoices:{[oldId]:{pdfHash:hash,figureId:figure.id,mode:'manual'}}},figures:()=>[figure]};
  assert.equal(FigureManager.prototype.selectedFigure.call(media,merged,hash).figure.id,figure.id);
  const records=prepareLibrary([{id:'pdf:source',title:'Previously selected manual PDF',source:'zotero',exists:true,path:'fixture.pdf',hash}]);
  const match=matchLibrary(merged,records,{[oldId]:{pdfId:'pdf:source',mode:'manual'}});assert.equal(match.status,'matched');assert.equal(match.selected.id,'pdf:source');
});
