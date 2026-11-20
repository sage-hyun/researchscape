import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex} from '../lib/extract.mjs';
import {crossrefRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {BibliographyWorkspace,reviewStatusGroup} from '../lib/bibliography-workspace.mjs';

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
