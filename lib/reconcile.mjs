import {normalize,hash} from './extract.mjs';
import {titleSimilarity} from './paper-links.mjs';
import {lookupKey,validRecord} from './bibliography.mjs';
import {specificTitle,blockedCandidate,candidatePolicy,aliasIdentity,exactTitle} from './bibliography-policy.mjs';
import {recordLinks,mergeLinks} from './bibliography-links.mjs';
import {metadataCatalog,paperRecord} from './bibliography-catalog.mjs';
import {messagePositions,localAliasEvidence,explicitExpansion} from './alias-context.mjs';

const distinctive=specificTitle;
export function reconcileIndex(raw,store={records:{},lookups:{}},decisions={}) {
  const cached=Object.values(store.records||{}).filter(validRecord),catalog=metadataCatalog(cached);
  const records=catalog.records,byId=new Map(),byTitle=new Map(),byPrefix=new Map();
  const recordMap=new Map(records.map(r=>[r.id,r]));
  const add=(map,key,id)=>{if(!map.has(key))map.set(key,new Set());map.get(key).add(id);};
  // A record fetched only to check an LLM proposal is a link candidate. It becomes automatic
  // evidence when a person approves a link to it or when a regular lookup returns it as well.
  const approved=new Set(Object.values(decisions).filter(d=>d?.action==='match').map(d=>catalog.redirects.get(d.recordId))),trusted=new Set();
  for(const r of cached){
    const id=catalog.redirects.get(r.id);if(r.provisional&&!approved.has(id))continue;
    trusted.add(id);
    for(const identifier of r.identifiers)add(byId,identifier.key,id);
    for(const t of [r.title,...(r.alternateTitles||[])]){
      if(distinctive(t))add(byTitle,normalize(t),id);
      const prefix=/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(t)?.[1];if(prefix)add(byPrefix,normalize(prefix),id);
    }
  }
  const mentionsByPaper=new Map(),conversationPapers=new Map();
  const positions=messagePositions(raw);
  for(const m of raw.mentions){if(!mentionsByPaper.has(m.paperId))mentionsByPaper.set(m.paperId,[]);mentionsByPaper.get(m.paperId).push(m);if(!conversationPapers.has(m.conversationId))conversationPapers.set(m.conversationId,new Set());conversationPapers.get(m.conversationId).add(m.paperId);}
  const evidenceTargets=p=>{
    const ids=new Set(),titles=new Set();
    for(const id of p.identifiers||[])for(const target of byId.get(id.key)||[])ids.add(target);
    for(const title of [p.title,...(p.aliases||[])].filter(distinctive))for(const target of byTitle.get(normalize(title))||[])titles.add(target);
    return {ids,titles};
  };
  const rawMap=new Map(raw.papers.map(p=>[p.id,p]));
  const baseTargets=new Map(raw.papers.map(p=>[p.id,evidenceTargets(p)]));
  const combinedTargets=(p,base)=>{
    if(!base.ids.size)return new Set(base.titles);
    // A directly identified edition is not ambiguous merely because other editions
    // have the same title. A different exact observed title remains a real conflict.
    const disjoint=[p.title,...(p.aliases||[])].filter(distinctive).some(t=>{
      const exact=byTitle.get(normalize(t));return exact?.size&&![...exact].some(id=>base.ids.has(id));
    });
    return new Set([...base.ids,...(disjoint?base.titles:[])]);
  };
  const identifierConflict=(p,r,base)=>{
    const titles=[p.title,...(p.aliases||[])].filter(distinctive);
    if(titles.length&&Math.min(...titles.map(t=>titleSimilarity(t,r.title)))<.55)return 'identifier-title-conflict';
    const curated=aliasIdentity(p.title);if(curated&&![r.title,...(r.alternateTitles||[])].some(t=>exactTitle(t,curated.title)))return 'identifier-title-conflict';
    const direct=(mentionsByPaper.get(p.id)||[]).some(m=>m.method==='identifier');
    if(p.linkEvidence?.length&&!direct&&!base.titles.has(r.id)&&!p.linkEvidence.some(e=>titles.some(t=>exactTitle(t,e.title))))return 'citation-title-conflict';
    return null;
  };
  const safeContextTarget=p=>{
    if(decisions[p.id]?.action==='separate'||blockedCandidate(p.title))return null;
    if(decisions[p.id]?.action==='match')return catalog.redirects.get(decisions[p.id].recordId)||null;
    const base=baseTargets.get(p.id),all=combinedTargets(p,base);if(all.size!==1)return null;
    const id=[...all][0],r=recordMap.get(id);if(r.identityConflict||!paperRecord(r))return null;
    if(base.ids.size&&identifierConflict(p,r,base))return null;
    return id;
  };
  const redirects={},groups=new Map(),queue=[];
  for(const p of raw.papers){
    const decision=decisions[p.id],observed=[...new Set([p.title,...(p.aliases||[])])],policy=candidatePolicy(p.title);
    const evidence=baseTargets.get(p.id);
    let targets=combinedTargets(p,evidence),reason=evidence.ids.size?'same-identifier':evidence.titles.size?'exact-official-title':null;
    const aliasEvidence=[];
    // A conversation can span unrelated topics. Every acronym occurrence needs
    // local expansion/identifier evidence, unless a curated identity proves it.
    if(!targets.size&&policy.kind==='acronym'){
      const curated=aliasIdentity(p.title),verified=new Set();
      if(curated)for(const r of records)if(trusted.has(r.id)&&r.identifiers.some(i=>curated.identifiers.includes(i.key))&&[r.title,...(r.alternateTitles||[])].some(t=>exactTitle(t,curated.title))){verified.add(r.id);aliasEvidence.push({source:'verified-alias',alias:curated.alias,sourceUrl:curated.source,recordId:r.id});}
      const occurrences=mentionsByPaper.get(p.id)||[],context=new Set(),nearby=new Set();let covered=occurrences.length>0;
      for(const occurrence of occurrences){
        const cid=occurrence.conversationId,local=new Set();
        for(const otherId of conversationPapers.get(cid)||[]){
          if(otherId===p.id||decisions[otherId]?.action==='separate')continue;
          const other=rawMap.get(otherId),safe=other&&safeContextTarget(other);if(!safe)continue;
          for(const id of [safe]){
            const r=recordMap.get(id),named=[...(other.aliases||[]),other.title,r.title,...(r.alternateTitles||[])];
            const otherMentions=(mentionsByPaper.get(otherId)||[]).filter(m=>m.conversationId===cid);
            const related=named.some(t=>normalize(/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(t)?.[1]||'')===normalize(p.title))||curated&&r.identifiers.some(i=>curated.identifiers.includes(i.key))||otherMentions.some(m=>explicitExpansion(m.excerpt,p.title,r.title));
            if(!related)continue;
            nearby.add(id);
            for(const otherMention of otherMentions){const proof=localAliasEvidence(p.title,occurrence,otherMention,r,positions);if(proof){local.add(id);aliasEvidence.push({...proof,conversationId:cid,messageId:occurrence.messageId,relatedMessageId:otherMention.messageId,recordId:id});}}
            if(!local.has(id))aliasEvidence.push({source:'same-conversation',conversationId:cid,recordId:id});
          }
        }
        if(!local.size)covered=false;
        for(const id of local)context.add(id);
      }
      if(verified.size){targets=new Set([...verified,...nearby]);reason='verified-alias-identifier';}
      else if(covered&&context.size){targets=context;reason='local-alias-expansion';}
      else if(nearby.size)reason='insufficient-local-alias-evidence';
    }
    let target=targets.size===1?[...targets][0]:null;
    if(target&&(recordMap.get(target).identityConflict||!paperRecord(recordMap.get(target)))){target=null;reason='conflicting-metadata';}
    if(target&&reason==='same-identifier'){
      const conflict=identifierConflict(p,recordMap.get(target),evidence);if(conflict){target=null;reason=conflict;}
    }
    if(blockedCandidate(p.title)){target=null;reason=`candidate-type:${policy.kind}`;}
    if(target&&targets.size===1&&reason==='same-identifier'&&evidence.titles.size&&!evidence.titles.has(target)){target=null;reason='identifier-title-conflict';}
    if(decision?.action==='separate'){target=null;reason='kept-separate';}
    else if(decision?.action==='match'&&catalog.redirects.has(decision.recordId)){target=catalog.redirects.get(decision.recordId);reason='user-confirmed';}
    // An LLM-proposed record that a provider lookup confirmed is a link candidate for a person to
    // approve. It never becomes an automatic target.
    const proposed=new Set((store.proposedLinks?.[p.id]?.recordIds||[]).map(id=>catalog.redirects.get(id)).filter(id=>recordMap.has(id)));
    for(const id of proposed)aliasEvidence.push({source:'llm-proposal',recordId:id});
    const possible=new Set(targets);
    for(const e of aliasEvidence)possible.add(e.recordId);
    for(const entry of [store.lookups?.[lookupKey(p)],...['crossref','openalex','semantic-scholar'].map(provider=>store.providerLookups?.[`${provider}|${lookupKey(p)}`])])for(const id of entry?.recordIds||[])possible.add(catalog.redirects.get(id)||id);
    for(const alias of observed.filter(a=>!a.includes(' ')))for(const id of byPrefix.get(normalize(alias))||[])possible.add(id);
    const suggestions=[...possible].filter(id=>recordMap.has(id)).map(id=>({recordId:id,score:Math.max(...observed.map(t=>titleSimilarity(t,recordMap.get(id).title))),record:recordMap.get(id)})).filter(s=>targets.has(s.recordId)||aliasEvidence.some(e=>e.recordId===s.recordId)||s.score>=.45||[...byPrefix.get(normalize(p.title))||[]].includes(s.recordId)).sort((a,b)=>proposed.has(b.recordId)-proposed.has(a.recordId)||b.score-a.score||a.recordId.localeCompare(b.recordId)).slice(0,3);
    const review=!target&&decision?.action!=='separate'&&(suggestions.length>0||blockedCandidate(p.title)||policy.kind==='acronym'||targets.size>0);
    if(!target&&targets.size>1)reason=evidence.ids.size&&evidence.titles.size&&![...evidence.titles].some(id=>evidence.ids.has(id))?'identifier-title-conflict':'conflicting-metadata';
    if(!target&&!reason)reason=suggestions.length?'similar-title-or-alias':policy.kind==='acronym'?'insufficient-alias-evidence':'unresolved';
    if(review)queue.push({id:p.id,title:p.title,count:p.count,reason,suggestions,evidence:aliasEvidence});
    const key=target||(recordMap.has(p.id)?`candidate:${hash(p.id)}`:p.id),record=target?recordMap.get(target):null;redirects[p.id]=key;
    if(!groups.has(key))groups.set(key,{id:key,title:record?.title||p.title,canonicalTitle:record?.title||null,metadata:record||null,observedTitles:[],aliases:[],identifiers:[],links:record?recordLinks(record):{},memberIds:[],sourceCandidateIds:[],resolution:{status:record?'verified':review?'needs-review':'unresolved',reason,evidence:aliasEvidence,candidateType:policy.kind},status:'unreviewed',evidence:p.evidence,linkEvidence:[]});
    const g=groups.get(key);g.memberIds.push(p.id,...(p.memberIds||[]));g.sourceCandidateIds.push(p.id);
    g.resolution.evidence=[...new Map([...g.resolution.evidence,...aliasEvidence].map(e=>[JSON.stringify(e),e])).values()];
    if(record)g.memberIds.push(...[...catalog.redirects].filter(([,id])=>id===target).map(([id])=>id));
    for(const legacy of p.memberIds||[])if(!redirects[legacy])redirects[legacy]=key;
    g.observedTitles.push(...observed.map(text=>({text,sourceId:p.id})));
    g.aliases.push(...observed,...(record?[record.title,...(record.alternateTitles||[])]:[]));
    g.identifiers.push(...p.identifiers,...(record?.identifiers||[]));g.linkEvidence.push(...(p.linkEvidence||[]));
    g.links=mergeLinks(g.links,p.links,recordLinks({provider:'conversation',sourceUrl:'local-export',identifiers:p.identifiers}));
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
