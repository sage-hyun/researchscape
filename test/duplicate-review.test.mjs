import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {crossrefRecord} from '../lib/bibliography.mjs';
import {duplicateReviewExport,duplicateSubject,duplicateSubjectHash,duplicatePairId,validateDuplicateSuggestion,DUPLICATE_RELATIONS} from '../lib/duplicate-review.mjs';
import {reviewBundleExport,reviewGroups,parseReviewUpload,reviewResultSchema} from '../lib/bibliography-review.mjs';
import {ReviewImportManager} from '../lib/review-import.mjs';
import {BibliographyWorkspace} from '../lib/bibliography-workspace.mjs';

const title='An Inertial Motion Foundation Model for Human Activity Recognition';
function paper(id,name=title){return {id,title:name,aliases:[],identifiers:[],count:1,sourceCandidateIds:[id],conversationCount:1};}
function sample(){
  const a=paper('name:alpha'),b=paper('name:beta',title+' Revisited');
  a.metadata=crossrefRecord({DOI:'10.4242/alpha',title:[a.title],author:[{given:'Synthetic',family:'Author'}]});
  b.metadata=crossrefRecord({DOI:'10.4242/beta',title:[b.title],author:[{given:'Synthetic',family:'Author'}]});
  a.identifiers=a.metadata.identifiers;b.identifiers=b.metadata.identifiers;
  return {papers:[a,b],resolutionQueue:[],redirects:{}};
}
function claim(review,decision='same_paper'){
  const pair=review.pairs[0];
  return {...pair,reasons:undefined,decision,evidence:[{type:'author-year-match',detail:'Synthetic relation for testing; a person must verify.'}],identifiers:{doi:review.subjects.flatMap(s=>s.doi),arxiv:[]},needsManualReview:true};
}
function result(bundle,decision='same_paper'){const item=claim(bundle.duplicateReview,decision);delete item.reasons;return {...bundle.resultTemplate,duplicateSuggestions:[item]};}
function harness(t){
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'rs-duplicate-'));
  t.after(()=>{assert.equal(path.dirname(path.resolve(state)),path.resolve(os.tmpdir()));fs.rmSync(state,{recursive:true,force:true});});
  const resolved=sample(),raw={papers:resolved.papers.map(({metadata,...p})=>p)},h={raw,resolved,store:{records:Object.fromEntries(resolved.papers.map(p=>[p.metadata.id,p.metadata]))},decisions:{},reviews:{},writes:0};
  h.manager=(options={})=>new ReviewImportManager({state,context:()=>h,saveStore:()=>{h.writes++;},saveDecisions:()=>{h.writes++;},...options});h.imports=h.manager();
  h.workspace=new BibliographyWorkspace({context:()=>h,imports:h.imports,saveDecisions:v=>{h.decisions=v;h.writes++;},saveReviews:()=>{h.writes++;}});
  h.bundle=()=>{const groups=reviewGroups(h.raw,h.resolved,h.decisions),bundle=reviewBundleExport(h.raw,h.resolved,h.decisions,{},groups);h.imports.recordExport(groups,bundle.generatedAt);h.imports.recordDuplicateExport(bundle.duplicateReview);return bundle;};
  return h;
}

test('duplicate export narrows pairs, retains versions and uses stable bibliographic projections without private state',()=>{
  const resolved=sample();resolved.papers.push(paper('name:chi','CHI'),paper('name:zupt','ZUPT'),paper('name:heading','Method Overview'));
  resolved.papers[0].itemKey='SECRETKEY';resolved.papers[0].sources=[{sourceUrl:'PRIVATE_URL'}];resolved.papers[0].mentions=[{quote:'PRIVATE_CHAT'}];
  const before=JSON.stringify(resolved),review=duplicateReviewExport(resolved);
  assert.equal(review.pairs.length,1);assert.equal(review.subjects.length,2);assert.deepEqual(review.pairs[0].paperIds,['name:alpha','name:beta']);assert.ok(review.pairs[0].reasons.includes('similar-specific-title'));
  assert.equal(review.snapshot,duplicateReviewExport({...resolved,papers:[...resolved.papers].reverse()}).snapshot);
  assert.equal(review.snapshot,duplicateReviewExport({...resolved,papers:resolved.papers.map(p=>({...p,count:p.count+99}))}).snapshot);
  const text=JSON.stringify(review);for(const secret of ['SECRETKEY','PRIVATE_URL','PRIVATE_CHAT','sourceUrl','conversationId','messageId','sources'])assert.equal(text.includes(secret),false);
  assert.equal(JSON.stringify(resolved),before);
  assert.equal(duplicatePairId(['a','b']),duplicatePairId(['b','a']));
  assert.notEqual(duplicateSubjectHash(duplicateSubject(resolved.papers[0])),duplicateSubjectHash(duplicateSubject({...resolved.papers[0],metadata:{...resolved.papers[0].metadata,title:'Changed title'}})));
});

test('only curated acronyms generate title pairs, with explicit per-paper and global caps',()=>{
  const resolved={papers:[paper('a','MAML'),paper('b','Model-Agnostic Meta-Learning for Fast Adaptation of Deep Networks'),paper('c','UNKNOWN'),paper('d','Unknown: A Specific Neural Motion Prediction Research Paper')]};
  assert.deepEqual(duplicateReviewExport(resolved).pairs.map(p=>p.paperIds),[['a','b']]);
  const many={papers:Array.from({length:25},(_,i)=>paper('p'+String(i).padStart(2,'0')))},review=duplicateReviewExport(many,{maxPairs:8,maxPerPaper:2}),count=new Map();
  assert.equal(review.pairs.length,8);assert.equal(review.coverage.truncated,true);assert.equal(review.coverage.candidatePairs,300);
  for(const pair of review.pairs)for(const id of pair.paperIds)count.set(id,(count.get(id)||0)+1);
  assert.ok([...count.values()].every(n=>n<=2));assert.equal(duplicateReviewExport({papers:Array.from({length:80},(_,i)=>paper('p'+i))}).coverage.skippedLargeBuckets>0,true);
});

test('an unresolved acronym can be compared to an approved paper via a known record candidate, without inventing acronym identities',()=>{
  const unresolved=paper('name:coma','CoMA'),linked=paper('doi:10.4242/coma','Generating 3D Faces using Convolutional Mesh Autoencoders');linked.metadata=crossrefRecord({DOI:'10.4242/coma',title:[linked.title]});
  const resolved={papers:[unresolved,linked],resolutionQueue:[{id:unresolved.id,suggestions:[{recordId:linked.metadata.id}]}]},review=duplicateReviewExport(resolved);
  assert.equal(review.pairs.length,1);assert.deepEqual(review.pairs[0].reasons,['shared-record-candidate']);
  assert.equal(duplicateReviewExport({...resolved,resolutionQueue:[]}).pairs.length,0);
});

test('bundle instructions and schema describe all four relations and accept duplicate-only or legacy partial results',()=>{
  const resolved=sample(),bundle=reviewBundleExport({papers:resolved.papers},resolved),value=result(bundle);
  assert.deepEqual(Object.keys(bundle.instructions.duplicateReview.decisions),DUPLICATE_RELATIONS);assert.ok(bundle.instructions.duplicateReview.rules.some(r=>r.includes('自動')||r.includes('자동')));
  assert.equal(bundle.resultTemplate.duplicateSnapshot,bundle.duplicateReview.snapshot);assert.deepEqual(reviewResultSchema.properties.duplicateSuggestions.items.properties.decision.enum,DUPLICATE_RELATIONS);
  const parsed=parseReviewUpload(value);assert.equal(parsed.decisions.length,0);assert.equal(parsed.duplicateSuggestions.length,1);assert.deepEqual(parsed.warnings,[]);
  assert.equal(parseReviewUpload([value,value]).duplicateSuggestions.length,2);
  assert.equal(parseReviewUpload({schemaVersion:1,decisions:[{}]}).duplicateSuggestions.length,0);
  assert.throws(()=>parseReviewUpload({...value,duplicateSnapshot:'bad'}));assert.throws(()=>parseReviewUpload({...value,duplicateSuggestions:[]}));
});

test('forged pairs, invented identifiers, absent manifests and malformed evidence remain per-item errors',()=>{
  const review=duplicateReviewExport(sample()),item=JSON.parse(JSON.stringify(claim(review)));
  assert.equal(validateDuplicateSuggestion(item,review).status,'proposed');
  for(const bad of [{...item,paperIds:['made-up','name:beta']},{...item,identifiers:{doi:['10.4242/invented'],arxiv:[]}},{...item,evidence:[]},{...item,needsManualReview:false},{...item,extra:true},{...item,decision:'merge'}])assert.equal(validateDuplicateSuggestion(bad,review).status,'error');
  assert.equal(validateDuplicateSuggestion(item,null).status,'error');
});

test('duplicate-only import persists, deduplicates, restores and suggests a manual merge without writing decisions',async t=>{
  const h=harness(t),bundle=h.bundle(),value=result(bundle),created=h.imports.create(value);await h.imports.idle();
  const id=created.job.id,job=h.imports.view(id),state=h.imports.reviewState(id);
  assert.equal(job.duplicateReview.proposed,1);assert.equal(job.duplicateReview.errors.length,0);assert.equal(h.writes,0);assert.deepEqual(h.decisions,{});assert.equal(state.duplicateRows[0].status,'proposed');
  const queue=h.workspace.view({importId:id}),row=queue.rows.find(r=>r.candidateId==='name:alpha');
  assert.ok(row.mergeSuggestions.includes('name:beta'));assert.equal(row.duplicateRecommendations[0].decision,'same_paper');assert.equal(row.defaultAction,'');assert.equal(row.statusGroup,'pending');
  assert.throws(()=>h.workspace.apply({importId:id,selections:[]}),e=>e.code==='APPROVAL_REQUIRED');
  assert.equal(h.imports.create(value).duplicate,true);h.imports=h.manager();assert.equal(h.imports.latest().id,id);assert.equal(h.imports.view(id).duplicateReview.proposed,1);
  // Explicit merge writes via the existing human approval path and records application.
  h.workspace.imports=h.imports;const target=queue.libraryTargets.find(t=>t.paperId==='name:beta');
  const applied=h.workspace.apply({importId:id,approved:true,selections:[{candidateId:row.candidateId,token:row.token,action:'merge',targetPaperId:target.paperId,targetToken:target.token}]});
  assert.equal(applied.merged,1);assert.equal(h.decisions['name:alpha'].recordId,target.recordId);assert.equal(h.imports.view(id).duplicateReview.applied,1);
});

test('versions, different papers and uncertain relations never become LLM merge recommendations; changed metadata stays stale',async t=>{
  for(const relation of DUPLICATE_RELATIONS.slice(1)){
    const h=harness(t),bundle=h.bundle(),{job}=h.imports.create(result(bundle,relation));await h.imports.idle();
    const q=h.workspace.view({importId:job.id,status:'all'}),row=q.rows.find(r=>r.candidateId==='name:alpha');
    assert.deepEqual(row.mergeSuggestions,[]);assert.equal(row.duplicateRecommendations[0].decision,relation);assert.equal(h.writes,0);
  }
  const h=harness(t),bundle=h.bundle(),{job}=h.imports.create(result(bundle));await h.imports.idle();h.resolved.papers[0].metadata.title='A Completely Changed Official Title';
  const q=h.workspace.view({importId:job.id,status:'all'});assert.equal(q.staleDuplicatePairs,1);assert.deepEqual(q.rows.find(r=>r.candidateId==='name:alpha').mergeSuggestions,[]);
  assert.ok(q.rows[0].duplicateRecommendations[0].stale);assert.equal(h.writes,0);
});

test('conflicting pair suggestions produce errors while valid independent proposals survive and no automatic lookup runs',async t=>{
  const h=harness(t),bundle=h.bundle(),value=result(bundle);value.duplicateSuggestions.push({...value.duplicateSuggestions[0],decision:'different'},{...value.duplicateSuggestions[0],pairId:'pair:forged'});
  const {job}=h.imports.create(value);await h.imports.idle();const view=h.imports.view(job.id);
  assert.equal(view.duplicateReview.proposed,0);assert.equal(view.duplicateReview.errors.length,2);assert.equal(h.writes,0);
  assert.deepEqual(h.workspace.view({importId:job.id}).rows,[]);
});

test('interrupted duplicate validation resumes from its durable cursor after restart without repeating finished rows',async t=>{
  const h=harness(t);h.imports=h.manager({chunkSize:1});const bundle=h.bundle(),value=result(bundle);value.duplicateSuggestions=Array.from({length:40},()=>structuredClone(value.duplicateSuggestions[0]));
  const {job}=h.imports.create(value);
  for(let n=0;n<100&&h.imports.view(job.id).duplicateReview.processed<3;n++)await new Promise(r=>setImmediate(r));
  h.imports.stop(job.id);await h.imports.idle();const stopped=h.imports.view(job.id);
  assert.equal(stopped.status,'interrupted');assert.equal(stopped.resumable,true);assert.ok(stopped.duplicateReview.processed>=3&&stopped.duplicateReview.processed<40);
  h.imports=h.manager();h.imports.resume(job.id);await h.imports.idle();const finished=h.imports.view(job.id);
  assert.equal(finished.duplicateReview.processed,40);assert.equal(finished.duplicateReview.proposed,1);assert.equal(h.imports.reviewState(job.id).duplicateRows.length,40);assert.equal(h.writes,0);
});
