import test from 'node:test';
import assert from 'node:assert/strict';
import {activeMessages,identifiers,discover,buildIndex,graphEdges} from '../lib/extract.mjs';

test('only the selected branch contributes user and visible assistant messages',()=>{
  const message=(id,text,role='assistant',channel)=>({id,author:{role},content:{parts:[text]},channel});
  const c={current_node:'b',mapping:{root:{parent:null,message:message('root','system','system')},a:{parent:'root',message:message('a','SlotFM 논문','user')},b:{parent:'a',message:message('b','선택된 답변')},other:{parent:'a',message:message('other','재생성된 다른 답변')},analysis:{parent:'root',message:message('analysis','내부 내용','assistant','analysis')}}};
  assert.deepEqual(activeMessages(c).map(m=>m.id),['a','b']);
  assert.deepEqual(activeMessages({...c,current_node:null}),[]);
});
test('identifiers normalize versions, DOI case and trailing punctuation',()=>{
  const text='https://arxiv.org/pdf/2501.12345v3.pdf (https://doi.org/10.1000/ABC). https://openreview.net/forum?id=AbC_123';
  const ids=identifiers(text);
  assert.deepEqual(ids.map(x=>x.key),['arxiv:2501.12345','doi:10.1000/abc','openreview:AbC_123']);
  for(const id of ids)assert.ok(text.slice(id.start,id.end).length>0);
  assert.equal(identifiers('doi:10.1000/foo(bar)')[0].value,'10.1000/foo(bar)');
});
test('generic acronyms are not paper aliases; explicit paper names remain candidates',()=>{
  const d=discover('IMU 논문, PDF 논문, LLM 논문, Few-Shot 논문, fine-tuning 논문, Loss 논문, Full Body 논문, Wang 논문은 아니고 SlotFM 논문을 살펴보자.');
  assert.deepEqual(d.map(x=>x.title),['SlotFM']);
});
const doc=(id,text)=>({id,title:id,messages:[{id:'m1',text,role:'user',date:1}]});
test('two-pass aliases find earlier mentions and preserve exact spans and roles',()=>{
  const index=buildIndex([doc('c1','SlotFM 모델과 학습 방법을 비교하자.'),doc('c2','SlotFM 논문과 SlotFM 논문을 검토하자.')]);
  assert.equal(index.papers.length,1);assert.equal(index.papers[0].count,3);assert.equal(index.papers[0].conversationCount,2);
  assert.ok(index.mentions.every(m=>m.quote==='SlotFM'));
  for(const m of index.mentions)assert.equal(m.excerpt.slice(m.excerptStart,m.excerptEnd),m.quote);
});
test('a short paper alias does not also match its hyphenated variant',()=>{
  const index=buildIndex([doc('c1','SMPL 논문, SMPL-X 논문. SMPL-X 모델을 비교해보자.')]);
  assert.equal(index.papers.find(p=>p.title==='SMPL').count,1);
  assert.equal(index.papers.find(p=>p.title==='SMPL-X').count,2);
});
test('identifier link labels supply titles and merge unique short aliases',()=>{
  const index=buildIndex([doc('c1','[SlotFM: A Motion Foundation Model for Learning](https://arxiv.org/abs/2501.12345)와 SlotFM 논문을 비교.')]);
  assert.equal(index.papers.length,1);assert.equal(index.papers[0].id,'arxiv:2501.12345');assert.equal(index.papers[0].identifiers.length,1);
  assert.ok(index.papers[0].title.startsWith('SlotFM:'));
  assert.equal(index.papers[0].count,2,'a title + linked identifier is one citation, not two');
});
test('ambiguous short aliases do not merge different identifier records',()=>{
  const index=buildIndex([doc('c1','[PACT: A Learning Model for Motion](https://arxiv.org/abs/2501.11111)\n[PACT: Another Model for Motion Learning](https://arxiv.org/abs/2501.22222)\nPACT 논문')]);
  assert.equal(index.papers.filter(p=>p.identifiers.length).length,2);
  for(const p of index.papers.filter(p=>p.identifiers.length))assert.equal(p.count,1,'ambiguous acronym must not attach to both papers');
});
test('rebuilding is idempotent and edges count shared conversations, not repeated mentions',()=>{
  const docs=[doc('c1','SlotFM 논문, RoNIN 논문. SlotFM 모델의 학습 방법과 RoNIN 모델 비교.'),doc('c2','SlotFM 논문, RoNIN 논문.')];
  const a=buildIndex(docs),b=buildIndex(docs);
  assert.deepEqual(a.mentions,b.mentions);assert.equal(graphEdges(a.papers,a.mentions)[0].weight,2);
  assert.equal(graphEdges(a.papers,a.mentions)[0].type,'co-mention');
});
