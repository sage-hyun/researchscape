import {identifiers,normalize} from './extract.mjs';
import {specificTitle,aliasIdentity,blockedCandidate} from './bibliography-policy.mjs';

export const paperKeys=p=>[...new Set([p.id,...(p.memberIds||[]),...(p.sourceCandidateIds||[])])];
export function prepareLibrary(records){
  return records.map(r=>({...r,identifiers:r.identifiers||identifiers([r.doi,r.url,r.extra,/^\d{4}\.\d{4,5}(?:v\d+)?$/.test(r.archiveId||'')?'arxiv:'+r.archiveId:r.archiveId].filter(Boolean).join(' ')).map(({key,kind,value,url})=>({key,kind,value,url}))}));
}
export function matchLibrary(paper,records,choices={}){
  const manual=[...new Set(paperKeys(paper).map(key=>choices[key]).filter(c=>c?.pdfId&&(c.mode!=='auto'||!blockedCandidate(paper.title)||paper.status==='confirmed')).map(c=>c.pdfId))];
  if(manual.length>1)return {status:'needs-review',reason:'conflicting-manual-pdfs',candidates:records.filter(r=>manual.includes(r.id))};
  if(manual.length===1){const selected=records.find(r=>r.id===manual[0]);return {status:selected?.exists?'matched':'missing-file',mode:'manual',reason:'user-selected',selected,candidates:selected?[selected]:[]};}
  const byAttachment=records.filter(r=>paper.pdfKey&&r.attachmentKey===paper.pdfKey),byParent=records.filter(r=>paper.itemKey&&r.itemKey===paper.itemKey);
  if(paper.pdfKey&&paper.itemKey&&byAttachment.some(r=>r.itemKey!==paper.itemKey))return {status:'needs-review',reason:'zotero-key-conflict',candidates:[...new Map([...byAttachment,...byParent].map(r=>[r.id,r])).values()]};
  if(paper.pdfKey&&!byAttachment.length&&byParent.length)return {status:'needs-review',reason:'missing-explicit-attachment',candidates:byParent};
  const explicit=byAttachment.length?byAttachment:byParent;
  const ids=new Set((paper.identifiers||[]).map(i=>i.key)),titles=[paper.canonicalTitle,paper.title,...(paper.aliases||[])].filter(t=>t&&specificTitle(t));
  const byId=records.filter(r=>r.identifiers.some(i=>ids.has(i.key)));
  const byTitle=records.filter(r=>titles.some(t=>normalize(t)===normalize(r.title)));
  const curated=aliasIdentity(paper.title),byVerifiedAlias=curated?records.filter(r=>r.identifiers.some(i=>curated.identifiers.includes(i.key))&&normalize(r.title)===normalize(curated.title)):[];
  let candidates=explicit.length?explicit:byId.length?byId:byTitle.length?byTitle:byVerifiedAlias;
  const reason=explicit.length?'zotero-key':byId.length?'same-identifier':byTitle.length?'exact-title':'verified-alias';
  if(blockedCandidate(paper.title)&&paper.status!=='confirmed'&&!explicit.length)return {status:candidates.length?'needs-review':'missing',reason:'candidate-type-review',candidates};
  // Reject a Zotero item whose title points to a different paper, despite a mistyped DOI.
  if(byId.length&&!explicit.length&&titles.length){const disjoint=candidates.filter(r=>specificTitle(r.title)&&!titles.some(t=>normalize(t)===normalize(r.title)));if(disjoint.length)return {status:'needs-review',reason:'identifier-title-conflict',candidates};}
  if(!candidates.length){
    const prefixes=!paper.title.includes(' ')?records.filter(r=>normalize(/^([A-Za-z][A-Za-z0-9+._-]{2,30})\s*[:：]/.exec(r.title)?.[1]||'')===normalize(paper.title)):[];
    if(prefixes.length)return {status:'needs-review',reason:'alias-needs-confirmation',candidates:prefixes};
    return {status:'missing',reason:'no-local-pdf',candidates:[]};
  }
  const available=candidates.filter(r=>r.exists),main=available.filter(r=>!/\b(supplement(?:ary|al)?|appendix|supporting|slides|poster)\b/i.test(r.attachmentTitle||r.path||''));
  if(available.length>1&&available.every(r=>r.hash)&&new Set(available.map(r=>r.hash)).size===1)return {status:'matched',mode:'auto',reason:'same-pdf-content',selected:available.find(r=>r.source==='zotero')||available[0],candidates};
  if(main.length===1)candidates=main;
  else if(available.length===1)candidates=available;
  if(candidates.length===1)return {status:candidates[0].exists?'matched':'missing-file',mode:'auto',reason,selected:candidates[0],candidates};
  return {status:'needs-review',reason:'multiple-pdfs',candidates};
}

export function pdfDownloadCandidates(paper){
  const urls=[];
  for(const link of paper.links?.pdf||[])urls.push({url:link.url,source:link.provider||'bibliography',kind:'pdf'});
  for(const id of paper.identifiers||[]){
    if(id.kind==='arxiv')urls.push({url:`https://arxiv.org/pdf/${id.value}`,source:'arXiv',kind:'pdf'});
    if(id.kind==='openreview')urls.push({url:`https://openreview.net/pdf?id=${encodeURIComponent(id.value)}`,source:'OpenReview',kind:'pdf'});
    if(id.kind==='publisher'){
      const u=new URL(id.url);
      if(u.hostname==='aclanthology.org')urls.push({url:id.url.replace(/\/$/,'')+'.pdf',source:'ACL Anthology',kind:'pdf'});
      if(u.hostname==='openaccess.thecvf.com')urls.push({url:id.url.replace('/html/','/papers/').replace(/\.html$/,'.pdf'),source:'CVF',kind:'pdf'});
      if(u.hostname==='proceedings.mlr.press'&&u.pathname.endsWith('.html')){const stem=u.pathname.split('/').at(-1).slice(0,-5);urls.push({url:`${u.origin}${u.pathname.slice(0,u.pathname.lastIndexOf('/'))}/${stem}/${stem}.pdf`,source:'PMLR',kind:'pdf'});}
    }
  }
  for(const link of [...(paper.links?.landing||[]),...(paper.links?.preprint||[]),...(paper.links?.doi||[])])urls.push({url:link.url,source:link.provider||'bibliography',kind:'landing'});
  for(const i of paper.identifiers||[])if(i.url)urls.push({url:i.url,source:i.kind,kind:'landing'});
  return [...new Map(urls.filter(r=>/^https?:\/\//.test(r.url)).map(r=>[r.url,r])).values()].sort((a,b)=>(a.kind==='pdf'?0:1)-(b.kind==='pdf'?0:1));
}

export function verifyPdfIdentity(paper,info){
  const first=info.firstPageText||'',found=new Set(identifiers(first).map(i=>i.key)),same=(paper.identifiers||[]).filter(i=>found.has(i.key));
  const titles=[paper.canonicalTitle,paper.title,...(paper.aliases||[])].filter(t=>t&&specificTitle(t)),plain=normalize(first);
  const matchingTitle=titles.find(t=>plain.includes(normalize(t)));
  if(matchingTitle)return {ok:true,reason:'pdf-first-page-title',title:matchingTitle};
  if(same.length)return {ok:true,reason:'pdf-first-page-identifier',identifiers:same.map(i=>i.key)};
  return {ok:false,reason:'pdf-identity-unconfirmed'};
}
