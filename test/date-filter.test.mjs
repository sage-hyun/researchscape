import test from 'node:test';
import assert from 'node:assert/strict';
import {dateRange,inDateRange,filterIndex} from '../lib/date-filter.mjs';
import {buildIndex,graphEdges} from '../lib/extract.mjs';

const range=(from='',to='')=>dateRange(new URLSearchParams({from,to}));
const ts=s=>Date.parse(s)/1000;
test('date boundaries include both dates in Korea time, including fractional seconds',()=>{
  const r=range('2026-11-01','2026-11-01');
  assert.equal(inDateRange(ts('2026-10-31T23:59:59.999+09:00'),r),false);
  assert.equal(inDateRange(ts('2026-11-01T00:00:00+09:00'),r),true);
  assert.equal(inDateRange(ts('2026-11-01T23:59:59.999+09:00'),r),true);
  assert.equal(inDateRange(ts('2026-11-02T00:00:00+09:00'),r),false);
  assert.equal(inDateRange(null,r),false);
  assert.equal(inDateRange(null,range()),true);
});
test('invalid dates and reversed intervals fail; open bounds are supported',()=>{
  for(const [from,to] of [['2026-02-30',''],['not-a-date',''],['2026-11-02','2026-11-01']])assert.throws(()=>range(from,to));
  assert.equal(inDateRange(ts('2027-01-01T00:00:00+09:00'),range('2026-11-01')),true);
  assert.equal(inDateRange(ts('2020-01-01T00:00:00+09:00'),range('','2026-11-01')),true);
  assert.equal(range('2024-02-29').active,true);
});
test('all paper metrics, activity and links use in-range messages without changing the index',()=>{
  const message=(id,text,date,role='user')=>({id,text,date:date?ts(date):null,role});
  const index=buildIndex([
    {id:'long',title:'Old conversation',messages:[message('before','SlotFM 논문','2026-10-31T23:59:59+09:00'),message('start','SlotFM 논문과 RoNIN 논문','2026-11-01T00:00:00+09:00'),message('end','RoNIN 논문','2026-11-01T23:59:59.999+09:00','assistant')]},
    {id:'after',messages:[message('after','SlotFM 논문과 RoNIN 논문','2026-11-02T00:00:00+09:00')]},
    {id:'plain',messages:[message('plain','논문이 없는 일반 메시지','2026-11-01T12:00:00+09:00')]},
    {id:'unknown',messages:[message('unknown','SlotFM 논문',null)]}
  ]);
  const filtered=filterIndex(index,range('2026-11-01','2026-11-01'));
  const slot=filtered.papers.find(p=>p.title==='SlotFM'),ronin=filtered.papers.find(p=>p.title==='RoNIN');
  assert.equal(slot.count,1);assert.equal(slot.messageCount,1);assert.equal(slot.conversationCount,1);assert.equal(slot.userCount,1);assert.equal(slot.assistantCount,0);
  assert.equal(ronin.count,2);assert.equal(ronin.messageCount,2);assert.equal(ronin.userCount,1);assert.equal(ronin.assistantCount,1);
  assert.equal(ronin.firstSeen,ts('2026-11-01T00:00:00+09:00'));assert.equal(ronin.lastSeen,ts('2026-11-01T23:59:59.999+09:00'));
  assert.equal(filtered.stats.conversations,2);assert.equal(filtered.stats.messages,3);assert.equal(filtered.stats.mentions,3);assert.equal(filtered.stats.researchConversations,1);
  assert.equal(graphEdges(filtered.papers,filtered.mentions)[0].weight,1);
  assert.equal(graphEdges(index.papers,index.mentions)[0].weight,2);
  assert.equal(filterIndex(index,range()).mentions,index.mentions);
  assert.equal(filterIndex(index,range('2030-01-01')).papers.length,0);
});
