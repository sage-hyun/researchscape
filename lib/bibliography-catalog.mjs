import {recordLinks,mergeLinks} from './bibliography-links.mjs';
const rank=r=>r.provider==='Crossref'?0:r.provider==='arXiv'?1:r.provider==='OpenReview'?2:3;
export const paperRecord=r=>!['dataset','data-set','book','book-series','proceedings','proceedings-article-collection','other','Dataset'].includes(r.publicationType);

// Build a view; never rename/delete cached records referenced by a user's decisions.
// Shared identifiers can unify provider records, but contradictory identifiers cannot.
export function metadataCatalog(records){
  const byIdentifier=new Map(),adj=new Map(records.map(r=>[r.id,new Set()])),map=new Map(records.map(r=>[r.id,r]));
  for(const r of records)for(const i of r.identifiers){if(!byIdentifier.has(i.key))byIdentifier.set(i.key,[]);byIdentifier.get(i.key).push(r.id);}
  for(const ids of byIdentifier.values())for(const id of ids)for(const other of ids)adj.get(id).add(other);
  const seen=new Set(),result=[],redirects=new Map();
  for(const r of records){
    if(seen.has(r.id))continue;
    const ids=new Set(),pending=[r.id];while(pending.length){const id=pending.pop();if(ids.has(id))continue;ids.add(id);pending.push(...adj.get(id));}for(const id of ids)seen.add(id);
    const group=[...ids].map(id=>map.get(id)),allIds=[...new Map(group.flatMap(x=>x.identifiers).map(i=>[i.key,i])).values()];
    const conflicting=['doi','arxiv','openreview'].some(kind=>new Set(allIds.filter(i=>i.kind===kind&&!(kind==='doi'&&i.value.startsWith('10.48550/arxiv.'))).map(i=>i.key)).size>1);
    const titleConflict=group.some(a=>group.some(b=>{
      const words=t=>new Set(t.toLowerCase().match(/[a-z0-9]+/g)||[]),x=words(a.title),y=words(b.title);
      return 2*[...x].filter(w=>y.has(w)).length/(x.size+y.size)<.55;
    }));
    if(conflicting||titleConflict||group.some(r=>r.metadataConflicts?.length)){for(const item of group){result.push({...item,links:recordLinks(item),identityConflict:true});redirects.set(item.id,item.id);}continue;}
    group.sort((a,b)=>rank(a)-rank(b)||a.id.localeCompare(b.id));const preferred=group[0];
    result.push({...preferred,identifiers:allIds,links:mergeLinks(...group.map(recordLinks)),alternateTitles:[...new Set(group.flatMap(x=>[x.title,...(x.alternateTitles||[])]) .filter(t=>t!==preferred.title))],sources:group.flatMap(x=>x.sources||[{provider:x.provider,sourceUrl:x.sourceUrl,fetchedAt:x.fetchedAt}])});
    for(const item of group)redirects.set(item.id,preferred.id);
  }
  return {records:result,redirects};
}
