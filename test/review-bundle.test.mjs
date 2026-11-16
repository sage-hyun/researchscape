import test from 'node:test';
import assert from 'node:assert/strict';
import {buildIndex} from '../lib/extract.mjs';
import {crossrefRecord} from '../lib/bibliography.mjs';
import {reconcileIndex} from '../lib/reconcile.mjs';
import {compactReviewExport,reviewBundleExport,reviewGroups,reviewItemHash,reviewManifest,reviewResultSchema,parseReviewUpload,normalizeDecision,REVIEW_UPLOAD} from '../lib/bibliography-review.mjs';
import {reviewConversations,reviewStore,reviewDecision,candidateId,linkedName} from './fixtures/review-candidates.mjs';

const raw=buildIndex(reviewConversations()),store=reviewStore(),decisions={[candidateId(linkedName(0))]:{action:'separate',updatedAt:'manual'}},resolved=reconcileIndex(raw,store,decisions);

test('one bundle holds every unresolved candidate once, most mentioned first, with logical batches',()=>{
  const before=JSON.stringify([raw,store,decisions]),bundle=reviewBundleExport(raw,resolved,decisions),groups=reviewGroups(raw,resolved,decisions);
  assert.equal(bundle.schemaVersion,2);assert.equal(bundle.kind,'llm-review-bundle');assert.match(bundle.snapshot,/^[a-f0-9]{64}$/);assert.ok(!Number.isNaN(Date.parse(bundle.generatedAt)));
  assert.equal(bundle.total,1219,'1,220 candidates minus the one a person kept separate');assert.equal(bundle.items.length,bundle.total);
  assert.deepEqual(bundle.totals,{withCandidates:599,withoutCandidates:620});
  assert.equal(new Set(bundle.items.map(i=>i.candidateId)).size,bundle.total,'candidateId is unique across both groups');
  assert.ok(!bundle.items.some(i=>i.candidateId===candidateId(linkedName(0))));
  for(const [at,item] of bundle.items.entries()){
    assert.deepEqual(Object.keys(item),['candidateId','title','count','reason','candidateStatus','batchId','candidates']);
    assert.equal(item.candidateStatus,item.candidates.length?'with-candidates':'without-candidates');
    if(at)assert.ok(bundle.items[at-1].count>=item.count,'mention count descending');
  }
  assert.deepEqual(Object.keys(bundle.items.find(i=>i.candidates.length).candidates[0]),['recordId','title','authors','year','doi','arxiv','evidenceTypes']);
  // Batches are ranges inside the single file; together they cover every item exactly once.
  assert.equal(bundle.batchSize,80);assert.equal(bundle.batches.length,Math.ceil(bundle.total/80));
  let offset=0;
  for(const [n,batch] of bundle.batches.entries()){
    assert.equal(batch.offset,offset);assert.equal(batch.index,n+1);assert.ok(batch.count<=80&&batch.count>0);assert.equal(batch.withCandidates+batch.withoutCandidates,batch.count);
    assert.ok(bundle.items.slice(offset,offset+batch.count).every(i=>i.batchId===batch.batchId));offset+=batch.count;
  }
  assert.equal(offset,bundle.total);assert.ok(bundle.batches.slice(0,-1).every(b=>b.count===80));
  assert.equal(reviewBundleExport(raw,resolved,decisions,{batchSize:50}).batches.length,Math.ceil(bundle.total/50));assert.equal(reviewBundleExport(raw,resolved,decisions,{batchSize:'100'}).batches[0].count,100);
  for(const batchSize of [49,101,0,60.5,'many'])assert.throws(()=>reviewBundleExport(raw,resolved,decisions,{batchSize}),/50~100/);
  // The result an LLM writes starts from the embedded template and schema.
  assert.deepEqual(bundle.resultTemplate,{schemaVersion:2,snapshot:bundle.snapshot,batchIds:[],decisions:[]});assert.ok(bundle.instructions.decisions.propose.includes('proposal'));
  // Same privacy projection as the per-page export: no conversation text, IDs, lookup URLs or scores.
  const text=JSON.stringify(bundle);for(const forbidden of ['PRIVATE_CHAT_BODY','sourceUrl','fetchedAt','conversationId','messageId','"links"','"sources"','"score"','c-vela','m-vela','Fixture Vela'])assert.ok(!text.includes(forbidden),forbidden);
  assert.equal(JSON.stringify([raw,store,decisions]),before,'exporting never changes state');
  // The per-page compact export stays available and shares the snapshot of the same state.
  const page=compactReviewExport(raw,resolved,decisions,{limit:30});assert.equal(page.snapshot,bundle.snapshot);assert.equal(page.items.length,30);assert.deepEqual(Object.keys(page.items[0]),['candidateId','title','count','reason','candidates']);
  assert.equal(compactReviewExport(raw,resolved,decisions,{group:'without-candidates',limit:50,offset:600}).items.length,20);
  assert.equal(reviewManifest(groups).snapshot,bundle.snapshot);assert.equal(Object.keys(reviewManifest(groups).items).length,bundle.total);
});

test('duplicated raw candidates and an empty review state still produce one consistent file',()=>{
  const copy={...raw,papers:[...raw.papers,raw.papers[0],raw.papers[5]]};
  assert.equal(reviewBundleExport(copy,resolved,decisions).total,1219);
  const linked=crossrefRecord({DOI:'10.1234/only',title:['A Fully Linked Motion Representation Learning Paper']}),one=buildIndex([{id:'c',messages:[{id:'m',role:'user',date:1,text:'**A Fully Linked Motion Representation Learning Paper** 논문'}]}]);
  const empty=reviewBundleExport(one,reconcileIndex(one,{records:{[linked.id]:linked},lookups:{}}),{});
  assert.equal(empty.total,0);assert.deepEqual(empty.items,[]);assert.deepEqual(empty.batches,[]);
});

test('item hashes ignore mention counts and verified-proposal candidates but see real candidate changes',()=>{
  const item={candidateId:'name:x',title:'X',count:3,reason:'unresolved',candidates:[{recordId:'doi:10.1/a',evidenceTypes:['title-or-alias-candidate']}]},hash=reviewItemHash(item);
  assert.equal(reviewItemHash({...item,count:99,reason:'similar-title-or-alias'}),hash);
  assert.equal(reviewItemHash({...item,candidates:[...item.candidates,{recordId:'doi:10.1/p',evidenceTypes:['llm-proposal']}]}),hash);
  assert.notEqual(reviewItemHash({...item,candidates:[...item.candidates,{recordId:'doi:10.1/b',evidenceTypes:['exact-title']}]}),hash);
  assert.notEqual(reviewItemHash({...item,candidates:[]}),hash);
});

test('uploads accept one document or merged partial results and report problems per row',()=>{
  const snapshot='a'.repeat(64),bundle=reviewBundleExport(raw,resolved,decisions),all=bundle.items.map(reviewDecision);
  assert.equal(all.length,1219);
  const whole=parseReviewUpload({schemaVersion:2,snapshot,decisions:all});assert.equal(whole.decisions.length,1219,'no 50-row limit');assert.equal(whole.parts.length,1);assert.deepEqual(whole.warnings,[]);
  // Two partial results, one per batch range, plus an LLM note at the top level.
  const parts=parseReviewUpload([{schemaVersion:2,snapshot,batchIds:['b001'],decisions:all.slice(0,80),notes:'first half'},{schemaVersion:2,snapshot,batchIds:['b002'],decisions:all.slice(80,160)}]);
  assert.equal(parts.parts.length,2);assert.deepEqual(parts.parts.map(p=>p.count),[80,80]);assert.deepEqual(parts.parts[0].batchIds,['b001']);assert.equal(parts.decisions[80].part,1);assert.equal(parts.warnings.length,1);
  // Legacy schemaVersion 1 documents keep working without a snapshot.
  assert.equal(parseReviewUpload({schemaVersion:1,decisions:all.slice(0,3)}).parts[0].snapshot,null);
  // Repeats: identical ones are plain duplicates, different ones also flag the first occurrence.
  const repeated=parseReviewUpload({schemaVersion:2,snapshot,decisions:[all[0],all[1],all[0],{...all[1],decision:'defer',recordId:null,proposal:undefined}]});
  assert.equal(repeated.decisions[2].duplicateOf,0);assert.equal(repeated.decisions[0].conflicting,undefined);assert.equal(repeated.decisions[3].duplicateOf,1);assert.equal(repeated.decisions[1].conflicting,true);
  for(const value of [null,'text',{schemaVersion:2,snapshot},{schemaVersion:3,snapshot,decisions:all.slice(0,1)},{schemaVersion:2,decisions:all.slice(0,1)},{schemaVersion:2,snapshot:'not-a-snapshot',decisions:all.slice(0,1)},{schemaVersion:2,snapshot,decisions:[]},[],bundle])assert.throws(()=>parseReviewUpload(value));
  assert.throws(()=>parseReviewUpload({schemaVersion:2,snapshot,decisions:Array.from({length:REVIEW_UPLOAD.maxDecisions+1},()=>all[0])}),/20,000/);

  const match=all.find(d=>d.decision==='match'),propose=all.find(d=>d.decision==='propose');
  assert.deepEqual(normalizeDecision(match).value,match);
  assert.deepEqual(normalizeDecision(propose).value.proposal,{identifiers:[{key:'doi:'+propose.proposal.doi,kind:'doi',value:propose.proposal.doi,url:'https://doi.org/'+propose.proposal.doi}],doi:propose.proposal.doi});
  for(const [bad,pattern] of [
    [{...match,extra:true},/알 수 없는 필드/],[{...match,candidateId:''},/candidateId/],[{...match,decision:'merge'},/decision/],[{...match,recordId:null},/recordId/],
    [{...match,needsManualReview:'no'},/needsManualReview/],[{...match,evidence:[{type:'made-up',detail:'x'}]},/evidence/],[{...match,proposal:{doi:'10.1234/x'}},/proposal/],
    [{...propose,recordId:'doi:10.1234/x'},/recordId/],[{...propose,proposal:{}},/하나 이상/],[{...propose,proposal:{doi:'not a doi'}},/DOI 형식/],[{...propose,proposal:{arxiv:'12345'}},/arXiv ID/],[{...propose,proposal:{url:'https://example.org'}},/proposal/],['row',/객체가 아닙니다/]
  ]){const result=normalizeDecision(bad);assert.match(result.error,pattern);assert.equal(result.value,undefined);}
  assert.match(normalizeDecision(propose,1).error,/schemaVersion 2/,'proposals need the bundle format');
  assert.equal(normalizeDecision({...match,candidateId:42}).candidateId,null);
  // The published schema describes both versions; the legacy required keys are unchanged.
  assert.deepEqual(reviewResultSchema.properties.schemaVersion,{enum:[1,2]});assert.equal(reviewResultSchema.properties.decisions.maxItems,undefined);
  assert.deepEqual(reviewResultSchema.properties.decisions.items.required,['candidateId','decision','recordId','evidence','needsManualReview']);assert.ok(reviewResultSchema.properties.decisions.items.properties.proposal);
});
