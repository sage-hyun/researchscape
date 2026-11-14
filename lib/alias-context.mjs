import {normalize} from './extract.mjs';

const escaped=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const clean=s=>String(s||'').normalize('NFKC').replace(/[*_`]/g,'').replace(/\s+/g,' ').trim();
export function explicitExpansion(text,alias,title){
  text=clean(text);title=clean(title);alias=clean(alias);
  const a=escaped(alias),t=escaped(title);
  return new RegExp(`${t}\\s*\\(\\s*${a}\\s*\\)|${a}\\s*\\(\\s*${t}\\s*\\)`,'i').test(text)||
    normalize(/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(text)?.[1]||'')===normalize(alias)&&normalize(text)===normalize(title);
}

export function messagePositions(raw){
  const positions=new Map(),counts=new Map();
  // activity retains the selected branch's message order, even with equal/missing dates.
  for(const m of raw.activity||[]){const key=JSON.stringify([m.conversationId,m.messageId]);if(positions.has(key))continue;const at=counts.get(m.conversationId)||0;positions.set(key,at);counts.set(m.conversationId,at+1);}
  return positions;
}

export function localAliasEvidence(alias,mention,other,record,positions){
  const prefix=normalize(/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(record.title)?.[1]||'')===normalize(alias);
  const expansion=explicitExpansion(other.quote,alias,record.title)||[mention,other].some(m=>explicitExpansion(m.excerpt,alias,record.title));
  if(mention.messageId===other.messageId&&(expansion||prefix&&other.method==='identifier'))return {source:expansion?'explicit-alias-expansion':'same-message-identifier',proximity:'same-message'};
  const a=positions.get(JSON.stringify([mention.conversationId,mention.messageId])),b=positions.get(JSON.stringify([other.conversationId,other.messageId]));
  if(Number.isInteger(a)&&Number.isInteger(b)&&Math.abs(a-b)===1&&expansion)return {source:'adjacent-message-expansion',proximity:'adjacent-message'};
  return null;
}
