import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {buildIndex} from '../lib/extract.mjs';
import {crossrefRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {saveJSON,loadJSON} from '../lib/local-store.mjs';
import {reviewBundleExport,reviewGroups} from '../lib/bibliography-review.mjs';
import {verifyProposals} from '../lib/review-proposals.mjs';
import {ReviewImportManager} from '../lib/review-import.mjs';
import {reviewConversations,reviewStore,reviewDecision,providerFetch,candidateId,linkedName,orphanName,linkedDoi,orphanDoi,orphanTitle} from './fixtures/review-candidates.mjs';

// 600 candidates with a cached link candidate and 620 without one. Read-only across tests.
const raw=buildIndex(reviewConversations());
const evidence=[{type:'exact-title',detail:'The official title starts with this name.'}];

// The server's wiring in miniature: state lives in `h`, files in a temporary state directory.
function harness(t,decisions={}){
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'researchscape-review-import-'));
  t.after(()=>{assert.ok(path.resolve(state).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(state,{recursive:true,force:true});});
  const h={state,store:reviewStore(),decisions,calls:[],saves:{store:0,decisions:0},failDecisionSave:()=>false,verify:verifyProposals,syncRunning:false};
  h.resolved=reconcileIndex(raw,h.store,h.decisions);
  h.create=(options={})=>new ReviewImportManager({
    state,context:()=>({raw,store:h.store,resolved:h.resolved,decisions:h.decisions}),syncRunning:()=>h.syncRunning,
    saveStore:value=>{h.store=value;h.saves.store++;},
    saveDecisions:value=>{h.saves.decisions++;if(h.failDecisionSave(h.saves.decisions))throw new Error('disk full (fixture)');saveJSON(state,'bibliography-decisions.json',value);h.decisions=value;},
    refresh:()=>{h.resolved=reconcileIndex(raw,h.store,h.decisions);},verify:(items,options)=>h.verify(items,options),
    lookup:{fetchFn:providerFetch(h.calls),delay:0,sleepFn:async()=>{},maxRetries:0,openalexApiKey:'',semanticScholarApiKey:''},...options
  });
  h.manager=h.create();
  // Downloading the bundle also records what the snapshot contained, as the export route does.
  h.bundle=()=>{const groups=reviewGroups(raw,h.resolved,h.decisions),bundle=reviewBundleExport(raw,h.resolved,h.decisions,{},groups);h.manager.recordExport(groups,bundle.generatedAt);return bundle;};
  h.result=(bundle,decisions=bundle.items.map(reviewDecision))=>({schemaVersion:2,snapshot:bundle.snapshot,decisions});
  return h;
}
const code=(httpStatus,name)=>e=>e.httpStatus===httpStatus&&(!name||e.code===name);
const rowsOf=(manager,id,status='all')=>{const rows=[];for(let offset=0;;offset+=200){const page=manager.view(id,{status,offset,limit:200});rows.push(...page.rows);if(rows.length>=page.rowsTotal)return rows;}};

test('a 1,200-row result is imported once, validated in chunks and applied only after explicit approval',async t=>{
  const manual={[candidateId(linkedName(0))]:{action:'separate',updatedAt:'2025-01-01T00:00:00.000Z',note:'kept by a person'},[candidateId(linkedName(1))]:{action:'match',recordId:'doi:'+linkedDoi(1),updatedAt:'2025-01-01T00:00:00.000Z'}};
  const h=harness(t,manual),bundle=h.bundle(),mentionsBefore=h.resolved.mentions.length;
  assert.equal(bundle.total,1218);
  const decisions=bundle.items.map(reviewDecision),matches=decisions.filter(d=>d.decision==='match');
  matches[0].recordId='doi:10.0000/not-in-cache';                                   // error: unknown record
  matches[1].needsManualReview=true;                                                // extra review
  matches[2].evidence=[{type:'possible-work-version',detail:'May be another edition.'}];
  matches[3].recordId=matches[4].recordId;                                          // a real record, but not this candidate's
  matches[5].evidence=[];
  const titled=decisions.find(d=>d.candidateId===candidateId(orphanName(4)));titled.proposal.title=orphanTitle(4)+' LLM_ONLY_WORD';
  decisions.push(
    {candidateId:candidateId(linkedName(0)),decision:'match',recordId:'doi:'+linkedDoi(0),evidence,needsManualReview:false},   // a person kept it separate
    {candidateId:candidateId(linkedName(1)),decision:'separate',recordId:null,evidence,needsManualReview:false},             // a person already linked it
    structuredClone(decisions[0]),                                                                                          // duplicate
    {candidateId:'name:never-seen',decision:'separate',recordId:null,evidence,needsManualReview:false},                      // unknown candidate
    {candidateId:'name:malformed',decision:'match',recordId:null,evidence,needsManualReview:false,comment:'extra'}           // malformed row
  );
  const expected={ready:903,needsManualReview:159,preserved:2,deferred:155,duplicate:1,error:3,applied:0,stale:0,lookupFailed:0,registered:155};
  const {duplicate,job}=h.manager.create(h.result(bundle,decisions),{fileName:'llm-result.json'});
  assert.equal(duplicate,false);assert.equal(job.status,'validating');assert.equal(job.total,1223);assert.equal(job.processed,0,'the upload returns before validation work starts');assert.equal(job.running,true);
  await h.manager.idle();
  let view=h.manager.view(job.id,{ids:'ready'});
  assert.equal(view.status,'ready');assert.equal(view.running,false);assert.equal(view.processed,1223);assert.equal(view.fileName,'llm-result.json');
  assert.deepEqual(view.counts,expected);assert.equal(view.applicable,903);assert.equal(view.readyIds.length,903);assert.equal(view.resumable,false);
  assert.equal(view.snapshot.status,'current');assert.equal(view.snapshot.requiresConfirmation,false);assert.equal(view.snapshot.changed,0);
  assert.equal(view.rows.length,50);assert.equal(view.rowsTotal,1223);
  const all=rowsOf(h.manager,job.id);assert.deepEqual(all.map(r=>r.index),Array.from({length:1223},(_,i)=>i));assert.ok(all.every(r=>r.itemHash===undefined));
  assert.equal(rowsOf(h.manager,job.id,'ready').length,903);assert.equal(h.manager.view(job.id,{status:'error'}).rowsTotal,3);
  const row=id=>all.find(r=>r.candidateId===id&&r.status!=='duplicate');
  assert.match(row(matches[0].candidateId).reason,/recordId를 찾지 못했습니다/);assert.equal(row(matches[3].candidateId).status,'needs-manual-review');
  assert.equal(row(candidateId(linkedName(0))).status,'preserved');assert.equal(row(candidateId(linkedName(1))).status,'preserved');
  assert.equal(all.at(-3).status,'duplicate');assert.equal(all.at(-2).status,'error');assert.match(all.at(-1).reason,/알 수 없는 필드/);
  // A proposed DOI is looked up again; the official record is what gets shown and linked.
  const proposed=row(candidateId(orphanName(4)));
  assert.equal(proposed.status,'ready');assert.equal(proposed.recordId,'doi:'+orphanDoi(4));assert.equal(proposed.recordTitle,orphanTitle(4));assert.equal(proposed.verification.status,'verified');assert.equal(proposed.verification.record.title,orphanTitle(4));
  const missing=row(candidateId(orphanName(3)));assert.equal(missing.status,'needs-manual-review');assert.equal(missing.verification.status,'not-found');assert.equal(missing.recordId,null);
  assert.equal(h.store.records['doi:'+orphanDoi(4)].title,orphanTitle(4));assert.ok(!JSON.stringify(h.store).includes('LLM_ONLY_WORD'));
  assert.equal(h.calls.length,310,'one identifier lookup per proposal, nothing else');assert.ok(h.calls.every(url=>!url.includes('PRIVATE_CHAT_BODY')&&!url.includes('Fixture')));
  // Preview only: no decision was written, by value or by file.
  assert.equal(h.saves.decisions,0);assert.equal(h.decisions,manual);assert.equal(fs.existsSync(path.join(h.state,'bibliography-decisions.json')),false);

  const ids=view.readyIds,deferred=all.find(r=>r.status==='deferred').candidateId;
  assert.throws(()=>h.manager.apply(job.id,{approved:false,candidateIds:ids}),code(400,'APPROVAL_REQUIRED'));
  assert.throws(()=>h.manager.apply(job.id,{candidateIds:ids}),code(400));
  for(const candidateIds of [[],undefined,[ids[0],ids[0]],[42],[ids[0],deferred],['name:never-seen']])assert.throws(()=>h.manager.apply(job.id,{approved:true,candidateIds}),code(400,'INVALID_SELECTION'));
  assert.equal(h.saves.decisions,0,'a rejected request writes nothing');
  // Individual selection first, then everything that is still applicable.
  assert.deepEqual(h.manager.apply(job.id,{approved:true,candidateIds:ids.slice(0,10)}),{ok:true,applied:10,skipped:[],remaining:893});
  assert.equal(h.manager.view(job.id).status,'ready');
  const rest=h.manager.view(job.id,{ids:'ready'}).readyIds;assert.equal(rest.length,893);
  assert.deepEqual(h.manager.apply(job.id,{approved:true,candidateIds:rest}),{ok:true,applied:893,skipped:[],remaining:0});
  view=h.manager.view(job.id);assert.equal(view.status,'completed');assert.deepEqual(view.counts,{...expected,ready:0,applied:903});
  assert.equal(Object.keys(h.decisions).length,905);
  for(const [id,value] of Object.entries(manual))assert.deepEqual(h.decisions[id],value,'manual decisions are never overwritten');
  const linked=h.decisions[matches[6].candidateId],viaProposal=h.decisions[candidateId(orphanName(4))],separated=h.decisions[candidateId(orphanName(1))];
  assert.deepEqual({...linked,updatedAt:'t'},{action:'match',recordId:matches[6].recordId,evidence:matches[6].evidence,decisionSource:'llm-reviewed',importId:job.id,updatedAt:'t'});
  assert.equal(viaProposal.action,'match');assert.equal(viaProposal.recordId,'doi:'+orphanDoi(4));assert.equal(viaProposal.verification,'provider-lookup');assert.ok(!JSON.stringify(h.decisions).includes('LLM_ONLY_WORD'));
  assert.equal(separated.action,'separate');assert.equal(separated.recordId,undefined);
  assert.deepEqual(loadJSON(h.state,'bibliography-decisions.json',null),h.decisions);
  // Linked papers carry the official record and every mention they had before.
  const paper=h.resolved.papers.find(p=>p.id==='doi:'+orphanDoi(4));
  assert.equal(paper.metadata.title,orphanTitle(4));assert.equal(paper.resolution.reason,'user-confirmed');assert.equal(paper.count,raw.papers.find(p=>p.id===candidateId(orphanName(4))).count);assert.ok(paper.observedTitles.some(o=>o.text===orphanName(4)));
  assert.equal(h.resolved.mentions.length,mentionsBefore);assert.equal(h.resolved.stats.metadataVerified,1+593+155);

  // The same JSON again opens the earlier job instead of creating a second one.
  const again=h.manager.create(h.result(bundle,decisions));assert.equal(again.duplicate,true);assert.equal(again.job.id,job.id);assert.equal(h.manager.list().imports.length,1);
  assert.deepEqual(h.manager.apply(job.id,{approved:true,candidateIds:ids}),{ok:true,applied:0,skipped:[],remaining:0},'re-sending an applied selection changes nothing');
  assert.equal(Object.keys(h.decisions).length,905);
});

test('a failed chunk keeps finished rows; a restarted server continues from the checkpoint without repeating lookups',async t=>{
  const h=harness(t),bundle=h.bundle(),first=[];let calls=0;
  h.verify=async(items,options)=>{if(++calls===3)throw new Error('socket hang up (fixture)');first.push(...items.map(i=>i.candidateId));return verifyProposals(items,options);};
  const {job}=h.manager.create(h.result(bundle));await h.manager.idle();
  let view=h.manager.view(job.id,{ids:'ready'});
  assert.equal(view.status,'interrupted');assert.equal(view.running,false);assert.equal(view.processed,900,'nine finished chunks are checkpointed');assert.equal(view.total,1220);
  assert.match(view.error,/socket hang up/);assert.equal(view.resumable,true);assert.equal(view.rowsTotal,900);
  assert.equal(first.length,155);assert.equal(view.counts.needsManualReview,155);assert.ok(view.counts.ready>400);
  // Finished rows are usable right away.
  assert.equal(h.manager.apply(job.id,{approved:true,candidateIds:view.readyIds.slice(0,5)}).applied,5);

  // "Restart": a new manager over the same state directory.
  const second=[];h.verify=async(items,options)=>{second.push(...items.map(i=>i.candidateId));return verifyProposals(items,options);};
  const restarted=h.create();
  view=restarted.view(job.id);assert.equal(view.status,'interrupted');assert.equal(view.processed,900);assert.equal(view.counts.applied,5);
  assert.equal(restarted.resume(job.id).running,true);assert.throws(()=>restarted.resume(job.id),code(409,'IMPORT_BUSY'));
  await restarted.idle();
  view=restarted.view(job.id,{ids:'ready'});
  assert.equal(view.status,'ready');assert.equal(view.processed,1220);assert.equal(view.error,null);
  assert.deepEqual(view.counts,{ready:905,needsManualReview:155,preserved:0,deferred:155,duplicate:0,error:0,applied:5,stale:0,lookupFailed:0,registered:155});
  assert.equal(second.length,155);assert.ok(second.every(id=>!first.includes(id)),'rows validated before the failure are not looked up again');
  assert.deepEqual(rowsOf(restarted,job.id).map(r=>r.index),Array.from({length:1220},(_,i)=>i),'no row is lost or repeated');
  assert.equal(restarted.apply(job.id,{approved:true,candidateIds:view.readyIds}).applied,905);assert.equal(Object.keys(h.decisions).length,910);

  // A job a crashed process left in "validating" is recognised as interrupted.
  const crashed=harness(t),stuck=crashed.manager.create(crashed.result(crashed.bundle())).job;await crashed.manager.idle();
  const file=path.join(crashed.state,'review-imports',stuck.id),saved=loadJSON(file,'job.json',null);
  saveJSON(file,'job.json',{...saved,status:'validating',ownerPid:2**30,processed:300,rows:saved.rows.slice(0,300)});
  const index=loadJSON(path.join(crashed.state,'review-imports'),'index.json',null);index.imports[0].status='validating';saveJSON(path.join(crashed.state,'review-imports'),'index.json',index);
  const recovered=crashed.create();
  assert.equal(recovered.view(stuck.id).status,'interrupted');assert.equal(recovered.view(stuck.id).processed,300);assert.equal(recovered.latest().id,stuck.id);
  recovered.resume(stuck.id);await recovered.idle();assert.equal(recovered.view(stuck.id).status,'ready');assert.equal(recovered.view(stuck.id).counts.ready,910);
});

test('validation can be stopped, waits for a running bibliography sync and retries only failed lookups',async t=>{
  const h=harness(t),bundle=h.bundle(),until=async predicate=>{for(let i=0;i<2000&&!predicate();i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(predicate());};
  // Stop while a provider lookup is in flight.
  h.verify=(items,options)=>new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  const {job}=h.manager.create(h.result(bundle));
  await until(()=>h.manager.verifying);
  assert.throws(()=>h.manager.create(h.result(bundle,[reviewDecision(bundle.items[0])])),code(409,'IMPORT_BUSY'),'one validation at a time');
  assert.equal(h.manager.create(h.result(bundle)).duplicate,true,'the same file returns the running job');
  assert.throws(()=>h.manager.apply(job.id,{approved:true,candidateIds:['x']}),code(409,'IMPORT_BUSY'));assert.throws(()=>h.manager.discard(job.id),code(409,'IMPORT_BUSY'));
  assert.deepEqual(h.manager.stop(job.id),{ok:true});await h.manager.idle();
  let view=h.manager.view(job.id);assert.equal(view.status,'interrupted');assert.equal(view.processed,0);assert.match(view.error,/중단/);assert.equal(h.manager.verifying,false);
  assert.throws(()=>h.manager.stop(job.id),code(409,'IMPORT_NOT_RUNNING'));
  // A bibliography sync owns the lookup cache: the import pauses instead of racing it.
  h.verify=verifyProposals;h.syncRunning=true;h.manager.resume(job.id);await h.manager.idle();
  view=h.manager.view(job.id);assert.equal(view.status,'interrupted');assert.match(view.error,/공식 서지정보 조회가 실행 중/);assert.equal(h.calls.length,0);
  // Crossref is down for the first pass: affected rows stay retryable, the rest finishes.
  h.syncRunning=false;const down=providerFetch(h.calls);let outage=true;
  h.manager=h.create({lookup:{fetchFn:url=>outage&&url.includes('crossref')?Promise.resolve(new Response('{}',{status:503})):down(url),delay:0,sleepFn:async()=>{},maxRetries:0,openalexApiKey:'',semanticScholarApiKey:''}});
  h.manager.resume(job.id);await h.manager.idle();
  view=h.manager.view(job.id);assert.equal(view.status,'ready');assert.equal(view.processed,1220);assert.equal(view.counts.lookupFailed,310);assert.equal(view.counts.ready,755);assert.equal(view.resumable,true);
  assert.equal(h.manager.view(job.id,{status:'lookup-failed'}).rowsTotal,310);
  // Failed lookups are negative-cached for 30 minutes like any sync; expire them, then retry.
  outage=false;for(const entry of Object.values(h.store.lookups))entry.updatedAt=new Date(Date.now()-31*60000).toISOString();
  const before=h.calls.length;h.manager.resume(job.id);await h.manager.idle();
  view=h.manager.view(job.id);assert.equal(view.counts.lookupFailed,0);assert.equal(view.counts.ready,910);assert.equal(view.counts.needsManualReview,155);assert.equal(view.resumable,false);
  assert.equal(h.calls.length-before,310,'only the failed rows were retried');
});

test('a save failure during approval keeps applied chunks and the rest can be applied again',async t=>{
  const h=harness(t),{job}=h.manager.create(h.result(h.bundle()));await h.manager.idle();
  const ids=h.manager.view(job.id,{ids:'ready'}).readyIds;assert.equal(ids.length,910);
  h.failDecisionSave=n=>n===3;
  assert.throws(()=>h.manager.apply(job.id,{approved:true,candidateIds:ids}),e=>e.httpStatus===500&&e.code==='PARTIAL_APPLY'&&e.details.applied===400&&e.details.remaining===510);
  assert.equal(Object.keys(h.decisions).length,400);assert.equal(Object.keys(loadJSON(h.state,'bibliography-decisions.json',{})).length,400);
  let view=h.manager.view(job.id);assert.equal(view.counts.applied,400);assert.equal(view.counts.ready,510);assert.equal(view.status,'ready');
  assert.equal(h.resolved.stats.metadataVerified,rowsOf(h.manager,job.id,'applied').filter(r=>r.decision!=='separate').length,'applied chunks are live');
  // The same selection again: applied rows are skipped, the remaining ones are written.
  h.failDecisionSave=()=>false;
  assert.deepEqual(h.manager.apply(job.id,{approved:true,candidateIds:ids}),{ok:true,applied:510,skipped:[],remaining:0});
  assert.equal(Object.keys(h.decisions).length,910);assert.equal(h.manager.view(job.id).status,'completed');
  // Decisions written but the job file not updated (crash in between): acknowledged, not rewritten.
  const directory=path.join(h.state,'review-imports',job.id),saved=loadJSON(directory,'job.json',null),lost=saved.rows.find(r=>r.status==='applied');
  lost.status='ready';saveJSON(directory,'job.json',saved);
  const restarted=h.create(),writes=h.saves.decisions;
  assert.equal(restarted.view(job.id).counts.ready,1);
  assert.deepEqual(restarted.apply(job.id,{approved:true,candidateIds:[lost.candidateId]}),{ok:true,applied:0,skipped:[],remaining:0});
  assert.equal(h.saves.decisions,writes);assert.equal(restarted.view(job.id).counts.applied,910);
});

test('results written for another snapshot are compared per candidate; unknown snapshots need confirmation',async t=>{
  const hidden=candidateId(linkedName(20)),h=harness(t,{[hidden]:{action:'separate',updatedAt:'manual'}}),old=h.bundle();
  const [A,B,C,D,E]=[linkedName(10),linkedName(11),linkedName(12),orphanName(0),linkedName(13)].map(candidateId),decide=id=>reviewDecision(old.items.find(i=>i.candidateId===id));
  // After the download: a second record now competes for A, a person decides B, and `hidden` returns to review.
  const rival=i=>crossrefRecord({DOI:`10.5555/rival${i}`,title:[`${linkedName(i)}: A Different Paper With the Same Short Name`]});
  h.store={...h.store,records:{...h.store.records,[rival(10).id]:rival(10)}};h.decisions={[B]:{action:'separate',updatedAt:'manual'}};h.resolved=reconcileIndex(raw,h.store,h.decisions);
  const late={candidateId:hidden,decision:'match',recordId:'doi:'+linkedDoi(20),evidence,needsManualReview:false};
  const {job}=h.manager.create(h.result(old,[...[A,B,C,D,E].map(decide),late]));await h.manager.idle();
  let view=h.manager.view(job.id);
  assert.equal(view.snapshot.status,'known');assert.equal(view.snapshot.requiresConfirmation,false);assert.equal(view.snapshot.changed,2);assert.notEqual(view.snapshot.current,old.snapshot);assert.deepEqual(view.snapshot.provided,[old.snapshot]);
  const status=id=>h.manager.view(job.id).rows.find(r=>r.candidateId===id);
  assert.equal(status(A).status,'needs-manual-review');assert.match(status(A).reason,/내려받은 뒤/);assert.equal(status(A).snapshotCheck,'changed');
  assert.equal(status(B).status,'preserved');assert.equal(status(C).status,'ready');assert.equal(status(D).status,'ready','an unchanged candidate may still receive a verified proposal');assert.equal(status(E).status,'ready');
  assert.equal(status(hidden).status,'needs-manual-review');assert.match(status(hidden).reason,/없던 후보/);
  // Between preview and approval: C gets a rival candidate, a person decides E.
  h.store={...h.store,records:{...h.store.records,[rival(12).id]:rival(12)}};h.decisions={...h.decisions,[E]:{action:'separate',updatedAt:'manual-later'}};h.resolved=reconcileIndex(raw,h.store,h.decisions);
  const applied=h.manager.apply(job.id,{approved:true,candidateIds:[C,D,E]});
  assert.equal(applied.applied,1);assert.deepEqual(applied.skipped.map(s=>s.candidateId),[C,E]);assert.equal(h.decisions[D].recordId,'doi:'+orphanDoi(0));
  assert.equal(status(C).status,'stale');assert.match(status(C).reason,/다시 검증/);assert.equal(status(E).status,'preserved');assert.deepEqual(h.decisions[E],{action:'separate',updatedAt:'manual-later'});assert.equal(h.decisions[C],undefined);
  view=h.manager.view(job.id);assert.equal(view.resumable,true);assert.equal(view.counts.stale,1);
  h.manager.resume(job.id);await h.manager.idle();
  assert.equal(status(C).status,'needs-manual-review');assert.equal(status(C).snapshotCheck,'changed');assert.equal(status(D).status,'applied','applied rows are left alone');

  // A snapshot this server never exported cannot be compared per candidate.
  const F=candidateId(linkedName(14)),unknown=h.manager.create({schemaVersion:2,snapshot:'f'.repeat(64),decisions:[decide(F)]}).job;await h.manager.idle();
  view=h.manager.view(unknown.id);assert.equal(view.snapshot.status,'unknown');assert.equal(view.snapshot.requiresConfirmation,true);assert.equal(view.rows[0].status,'ready','still validated against the current state');
  assert.throws(()=>h.manager.apply(unknown.id,{approved:true,candidateIds:[F]}),code(409,'SNAPSHOT_CONFIRMATION_REQUIRED'));assert.equal(h.decisions[F],undefined);
  assert.equal(h.manager.apply(unknown.id,{approved:true,candidateIds:[F],confirmSnapshot:true}).applied,1);
  // Legacy schemaVersion 1 results carry no snapshot and are checked against the current state only.
  const G=candidateId(linkedName(15)),legacy=h.manager.create({schemaVersion:1,decisions:[decide(G)]}).job;await h.manager.idle();
  view=h.manager.view(legacy.id);assert.equal(view.snapshot.status,'none');assert.equal(view.snapshot.requiresConfirmation,false);assert.equal(view.rows[0].status,'ready');
});

test('partial results can be merged into one import or imported batch by batch over time',async t=>{
  const h=harness(t),bundle=h.bundle(),all=bundle.items.map(reviewDecision);
  const part=n=>{const batch=bundle.batches.at(n);return {schemaVersion:2,snapshot:bundle.snapshot,batchIds:[batch.batchId],decisions:all.slice(batch.offset,batch.offset+batch.count)};};
  // The last batch on its own, applied straight away. This changes the current snapshot.
  const last=h.manager.create(part(-1)).job;await h.manager.idle();
  let view=h.manager.view(last.id,{ids:'ready'});assert.equal(view.total,20);assert.equal(view.counts.ready,20);
  assert.equal(h.manager.apply(last.id,{approved:true,candidateIds:view.readyIds}).applied,20);
  assert.notEqual(reviewBundleExport(raw,h.resolved,h.decisions).snapshot,bundle.snapshot);
  // Later: two more batches from the same download in one import, with rows repeated across parts.
  const merged=h.manager.create([part(11),part(12),{schemaVersion:2,snapshot:bundle.snapshot,decisions:[part(11).decisions[0],all.at(-1)]}],{fileName:'b012.json 외 2개'}).job;await h.manager.idle();
  view=h.manager.view(merged.id,{ids:'ready'});
  assert.equal(view.parts,3);assert.equal(view.total,162);assert.equal(view.snapshot.status,'known');assert.equal(view.snapshot.changed,0,'untouched candidates stay approvable after an earlier partial import');assert.equal(view.snapshot.requiresConfirmation,false);
  assert.deepEqual(view.counts,{ready:160,needsManualReview:0,preserved:1,deferred:0,duplicate:1,error:0,applied:0,stale:0,lookupFailed:0,registered:125});
  const rows=rowsOf(h.manager,merged.id);assert.equal(rows[160].status,'duplicate');assert.equal(rows[160].part,2);assert.equal(rows[161].status,'preserved');assert.match(rows[161].reason,/이전 LLM 검토/);
  assert.equal(h.manager.apply(merged.id,{approved:true,candidateIds:view.readyIds}).applied,160);assert.equal(Object.keys(h.decisions).length,180);
  // Two different answers for one candidate are never applied silently.
  const row=all.find(d=>d.decision==='match'&&!h.decisions[d.candidateId]),conflict=h.manager.create(h.result(bundle,[row,{...row,decision:'defer',recordId:null}])).job;await h.manager.idle();
  view=h.manager.view(conflict.id);assert.deepEqual(view.rows.map(r=>r.status),['needs-manual-review','duplicate']);assert.match(view.rows[0].reason,/서로 다른 결정/);assert.equal(view.counts.ready,0);
});

test('imports can be discarded and re-imported; old previews are pruned but still recognised',async t=>{
  const h=harness(t),bundle=h.bundle(),all=bundle.items.map(reviewDecision),one=n=>h.result(bundle,[all.at(-1-n)]);
  const first=h.manager.create(one(0)).job;await h.manager.idle();
  const directory=path.join(h.state,'review-imports',first.id);assert.ok(fs.existsSync(path.join(directory,'input.json')));
  assert.deepEqual(h.manager.discard(first.id),{ok:true});assert.equal(fs.existsSync(directory),false);
  for(const call of [()=>h.manager.view(first.id),()=>h.manager.resume(first.id),()=>h.manager.apply(first.id,{approved:true,candidateIds:['x']})])assert.throws(call,code(404,'IMPORT_NOT_FOUND'));
  const again=h.manager.create(one(0));assert.equal(again.duplicate,false,'a discarded import may be imported again');await h.manager.idle();assert.equal(h.manager.list().imports.length,1);
  for(const id of ['../../outside','','not-a-uuid',null])assert.throws(()=>h.manager.view(id),code(400,'INVALID_IMPORT'));
  assert.throws(()=>h.manager.view(again.job.id,{limit:500}),code(400));assert.throws(()=>h.manager.view(again.job.id,{status:'everything'}),code(400));
  // Only the newest previews are kept on disk; the file hash of a pruned one is still known.
  const small=h.create({keep:2});
  const second=small.create(one(1)).job;await small.idle();const third=small.create(one(2)).job;await small.idle();
  assert.throws(()=>small.view(again.job.id),code(404));assert.equal(small.view(second.id).status,'ready');assert.equal(small.latest().id,third.id);
  const archived=small.create(one(0));assert.equal(archived.duplicate,true);assert.equal(archived.job.status,'archived');
  assert.deepEqual(fs.readdirSync(path.join(h.state,'review-imports')).filter(name=>name!=='index.json').sort(),[second.id,third.id].sort());
  // Export records are bounded as well.
  const exportsDirectory=path.join(h.state,'review-exports');assert.equal(fs.readdirSync(exportsDirectory).length,1);
  const bounded=h.create({keepExports:2});for(let i=0;i<4;i++){h.decisions={...h.decisions,[candidateId(linkedName(100+i))]:{action:'separate',updatedAt:'manual'}};h.resolved=reconcileIndex(raw,h.store,h.decisions);bounded.recordExport(reviewGroups(raw,h.resolved,h.decisions));}
  assert.equal(fs.readdirSync(exportsDirectory).length,2);
});
