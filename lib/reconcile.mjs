import {normalize,hash} from './extract.mjs';
import {titleTokens,titleSimilarity} from './paper-links.mjs';
import {lookupKey,validRecord} from './bibliography.mjs';

const distinctive=t=>t.length>=24&&titleTokens(t).length>=4&&!/^(?:arXiv|DOI|OpenReview|논문 링크) · /i.test(t);
export function reconcileIndex(raw,store={records:{},lookups:{}},decisions={}) {
  const records=Object.values(store.records||{}).filter(validRecord),byId=new Map(),byTitle=new Map(),byPrefix=new Map();
  const recordMap=new Map(records.map(r=>[r.id,r]));
  const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
  for(const r of records){
    for(const id of r.identifiers)add(byId,id.key,r.id);
    for(const t of [r.title,...(r.alternateTitles||[])]){
      if(distinctive(t))add(byTitle,normalize(t),r.id);
      const prefix=/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(t)?.[1];if(prefix)add(byPrefix,normalize(prefix),r.id);
    }
  }
  const redirects={},groups=new Map(),queue=[];
  for(const p of raw.papers){
    const decision=decisions[p.id],observed=[...new Set([p.title,...p.aliases])];
    let targets=new Set(),reason=null;
    for(const id of p.identifiers)for(const target of byId.get(id.key)||[])targets.add(target);
    if(targets.size)reason='same-identifier';
    if(!targets.size){for(const title of observed.filter(distinctive))for(const target of byTitle.get(normalize(title))||[])targets.add(target);if(targets.size)reason='exact-official-title';}
    let target=targets.size===1?[...targets][0]:null;
    if(target&&reason==='same-identifier'){
      const titles=observed.filter(distinctive),r=recordMap.get(target);
      if(titles.length&&Math.max(...titles.map(t=>titleSimilarity(t,r.title)))<.55){target=null;reason='identifier-title-conflict';}
    }
    if(decision?.action==='separate'){target=null;reason='kept-separate';}
    else if(decision?.action==='match'&&recordMap.has(decision.recordId)){target=decision.recordId;reason='user-confirmed';}
    const possible=new Set(targets);
    for(const id of store.lookups?.[lookupKey(p)]?.recordIds||[])possible.add(id);
    for(const alias of observed.filter(a=>!a.includes(' ')))for(const id of byPrefix.get(normalize(alias))||[])possible.add(id);
    const suggestions=[...possible].filter(id=>recordMap.has(id)).map(id=>({recordId:id,score:Math.max(...observed.map(t=>titleSimilarity(t,recordMap.get(id).title))),record:recordMap.get(id)})).filter(s=>targets.has(s.recordId)||s.score>=.45||[...byPrefix.get(normalize(p.title))||[]].includes(s.recordId)).sort((a,b)=>b.score-a.score).slice(0,3);
    const review=!target&&decision?.action!=='separate'&&suggestions.length>0;
    if(review)queue.push({id:p.id,title:p.title,count:p.count,reason:targets.size>1?'conflicting-metadata':reason==='identifier-title-conflict'?reason:'similar-title-or-alias',suggestions});
    const key=target||((review&&recordMap.has(p.id))?`candidate:${hash(p.id)}`:p.id),record=target?recordMap.get(target):null;redirects[p.id]=key;
    if(!groups.has(key))groups.set(key,{id:key,title:record?.title||p.title,canonicalTitle:record?.title||null,metadata:record||null,observedTitles:[],aliases:[],identifiers:[],memberIds:[],sourceCandidateIds:[],resolution:{status:record?'verified':review?'needs-review':'unresolved',reason},status:'unreviewed',evidence:p.evidence,linkEvidence:[]});
    const g=groups.get(key);g.memberIds.push(p.id,...(p.memberIds||[]));g.sourceCandidateIds.push(p.id);
    for(const legacy of p.memberIds||[])if(!redirects[legacy])redirects[legacy]=key;
    g.observedTitles.push(...observed.map(text=>({text,sourceId:p.id})));
    g.aliases.push(...observed,...(record?[record.title,...(record.alternateTitles||[])]:[]));
    g.identifiers.push(...p.identifiers,...(record?.identifiers||[]));g.linkEvidence.push(...(p.linkEvidence||[]));
    if(reason==='user-confirmed')g.resolution.reason=reason;
  }
  // Merging evidence must not add repeated citations for the same text span.
  const seen=new Set(),mentions=[];
  for(const m of [...raw.mentions].sort((a,b)=>(b.end-b.start)-(a.end-a.start))){
    const paperId=redirects[m.paperId]||m.paperId;
    const key=JSON.stringify([m.conversationId,m.messageId,paperId,m.start,m.end]);if(seen.has(key))continue;seen.add(key);
    mentions.push({...m,paperId,sourcePaperId:m.sourcePaperId||m.paperId,id:hash(key)});
  }
  const spans=new Map(),deduped=[];
  for(const m of mentions){const key=JSON.stringify([m.conversationId,m.messageId,m.paperId]);const prior=spans.get(key)||[];if(prior.some(s=>s.start<m.end&&m.start<s.end))continue;prior.push(m);spans.set(key,prior);deduped.push(m);}
  const byPaper=new Map();for(const m of deduped){if(!byPaper.has(m.paperId))byPaper.set(m.paperId,[]);byPaper.get(m.paperId).push(m);}
  const papers=[];
  for(const p of groups.values()){
    const ms=byPaper.get(p.id)||[];if(!ms.length)continue;
    p.memberIds=[...new Set(p.memberIds)];p.aliases=[...new Set(p.aliases)];p.observedTitles=[...new Map(p.observedTitles.map(t=>[t.text,t])).values()];p.identifiers=[...new Map(p.identifiers.map(i=>[i.key,i])).values()];
    const dates=ms.map(m=>m.date).filter(Number.isFinite);
    papers.push({...p,count:ms.length,messageCount:new Set(ms.map(m=>JSON.stringify([m.conversationId,m.messageId]))).size,conversationCount:new Set(ms.map(m=>m.conversationId)).size,userCount:ms.filter(m=>m.role==='user').length,assistantCount:ms.filter(m=>m.role==='assistant').length,firstSeen:dates.length?Math.min(...dates):null,lastSeen:dates.length?Math.max(...dates):null});
  }
  papers.sort((a,b)=>b.count-a.count);
  return {...raw,papers,mentions:deduped,redirects,resolutionQueue:queue.sort((a,b)=>b.count-a.count),stats:{...raw.stats,papers:papers.length,mentions:deduped.length,rawCandidates:raw.papers.length,mergedCandidates:raw.papers.length-papers.length,metadataVerified:papers.filter(p=>p.metadata).length,needsMetadataReview:queue.length}};
}
