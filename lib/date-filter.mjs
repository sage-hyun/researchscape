const DAY=86400;
const OFFSET=9*60*60*1000;

function midnight(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value))throw new Error('날짜는 YYYY-MM-DD 형식으로 입력해주세요.');
  const ms=Date.parse(value+'T00:00:00+09:00');
  if(!Number.isFinite(ms)||new Date(ms+OFFSET).toISOString().slice(0,10)!==value)throw new Error('유효한 날짜를 입력해주세요.');
  return ms/1000;
}

export function dateRange(params) {
  const from=params.get('from')||'',to=params.get('to')||'';
  const start=from?midnight(from):-Infinity,end=to?midnight(to)+DAY:Infinity;
  if(start>=end)throw new Error('시작일은 종료일보다 늦을 수 없습니다.');
  return {from,to,start,end,active:!!(from||to)};
}

export function inDateRange(date,range) {
  return !range.active || (Number.isFinite(date)&&date>=range.start&&date<range.end);
}

export function filterIndex(index,range,conversationIds=null) {
  if(!range.active&&!conversationIds)return {papers:index.papers,mentions:index.mentions,stats:index.stats};
  const matches=m=>inDateRange(m.date,range)&&(!conversationIds||conversationIds.has(m.conversationId));
  const mentions=index.mentions.filter(matches),counts=new Map();
  for(const m of mentions){
    if(!counts.has(m.paperId))counts.set(m.paperId,{count:0,userCount:0,assistantCount:0,conversations:new Set(),messages:new Set(),firstSeen:Infinity,lastSeen:-Infinity});
    const c=counts.get(m.paperId);c.count++;c[m.role==='user'?'userCount':'assistantCount']++;
    c.conversations.add(m.conversationId);c.messages.add(JSON.stringify([m.conversationId,m.messageId]));
    if(Number.isFinite(m.date)){c.firstSeen=Math.min(c.firstSeen,m.date);c.lastSeen=Math.max(c.lastSeen,m.date);}
  }
  const papers=index.papers.filter(p=>counts.has(p.id)).map(p=>{
    const c=counts.get(p.id);
    return {...p,count:c.count,userCount:c.userCount,assistantCount:c.assistantCount,conversationCount:c.conversations.size,messageCount:c.messages.size,firstSeen:Number.isFinite(c.firstSeen)?c.firstSeen:null,lastSeen:Number.isFinite(c.lastSeen)?c.lastSeen:null};
  }).sort((a,b)=>b.count-a.count);
  const activity=index.activity.filter(matches);
  return {papers,mentions,stats:{...index.stats,conversations:range.active?new Set(activity.map(m=>m.conversationId)).size:conversationIds.size,messages:activity.length,papers:papers.length,mentions:mentions.length,researchConversations:new Set(mentions.map(m=>m.conversationId)).size}};
}
