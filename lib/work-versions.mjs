import {normalize} from './extract.mjs';
import {specificTitle} from './bibliography-policy.mjs';

const authors=r=>[...new Set((r.authors||[]).map(a=>normalize(a.normalize('NFKD').replace(/\p{M}/gu,''))))].filter(Boolean).sort();
const arxiv=r=>r.identifiers.some(i=>i.kind==='arxiv'||i.kind==='doi'&&i.value.toLowerCase().startsWith('10.48550/arxiv.'));
const published=r=>r.identifiers.some(i=>i.kind==='doi'&&!i.value.toLowerCase().startsWith('10.48550/arxiv.'));
// Suggestions only. Equal titles and author names never create identifier edges.
export function workVersionProposals(records){
  const titles=new Map(),pairs=new Set(),result=[];
  for(const r of records)for(const title of new Set([r.title,...(r.alternateTitles||[])].filter(specificTitle).map(normalize))){if(!titles.has(title))titles.set(title,[]);titles.get(title).push(r);}
  for(const group of titles.values())for(let i=0;i<group.length;i++)for(let j=i+1;j<group.length;j++){
    const a=group[i],b=group[j],ids=[a.id,b.id].sort(),key=JSON.stringify(ids);
    if(pairs.has(key)||!((arxiv(a)&&published(b))||(arxiv(b)&&published(a)))||a.identifiers.some(x=>b.identifiers.some(y=>x.key===y.key)))continue;
    pairs.add(key);const x=authors(a),y=authors(b),agree=x.length&&y.length&&JSON.stringify(x)===JSON.stringify(y);
    if(x.length&&y.length&&!agree)continue;
    result.push({recordIds:ids,title:a.title,versions:[a,b].map(r=>({recordId:r.id,title:r.title,authors:r.authors||[],year:r.year||null,identifiers:r.identifiers.filter(i=>['doi','arxiv'].includes(i.kind)).map(i=>({kind:i.kind,value:i.value}))})),reason:agree?'possible-work-versions':'insufficient-version-evidence',evidenceTypes:agree?['exact-title','same-authors','arxiv-published-pair']:['exact-title','arxiv-published-pair','missing-authors'],needsManualReview:true});
  }
  return result.sort((a,b)=>a.recordIds.join('|').localeCompare(b.recordIds.join('|')));
}
