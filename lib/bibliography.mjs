import {identifiers,normalize} from './extract.mjs';
import {titleTokens} from './paper-links.mjs';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const decode=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\s+/g,' ').trim();
const tag=(xml,name)=>decode(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i').exec(xml)?.[1]);
const httpUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}};
const now=()=>new Date().toISOString();
export const lookupKey=p=>`title:${normalize(p.title)}`;

export function crossrefRecord(item,sourceUrl='') {
  if(!item?.DOI||!item.title?.[0])return null;
  const doi=String(item.DOI).toLowerCase(),url=`https://doi.org/${doi}`;
  const mainTitle=decode(item.title[0]),subtitle=decode(item.subtitle?.[0]);
  const title=subtitle&&!normalize(mainTitle).endsWith(normalize(subtitle))?`${mainTitle}${/[:;]$/.test(mainTitle)?' ':': '}${subtitle}`:mainTitle;
  return {id:`doi:${doi}`,title,mainTitle,subtitle,schemaVersion:2,authors:(item.author||[]).map(a=>[a.given,a.family].filter(Boolean).join(' ')||a.name).filter(Boolean),year:(item.published||item['published-print']||item['published-online'])?.['date-parts']?.[0]?.[0]||null,venue:decode(item['container-title']?.[0]),provider:'Crossref',url,sourceUrl:sourceUrl||`https://api.crossref.org/works/${encodeURIComponent(doi)}`,fetchedAt:now(),identifiers:[{key:`doi:${doi}`,kind:'doi',value:doi,url}]};
}

export function arxivRecords(xml,sourceUrl) {
  const result=[];
  for(const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)){
    const text=m[1],id=identifiers(tag(text,'id')).find(i=>i.kind==='arxiv');
    const title=tag(text,'title');if(!id||!title||title.toLowerCase()==='error')continue;
    const doi=tag(text,'arxiv:doi').toLowerCase(),doiId=doi?identifiers(doi)[0]:null;
    const authors=[...text.matchAll(/<author>([\s\S]*?)<\/author>/g)].map(a=>tag(a[1],'name')).filter(Boolean);
    result.push({id:doiId?.key||id.key,title,authors,year:Number(tag(text,'published').slice(0,4))||null,venue:tag(text,'arxiv:journal_ref'),provider:'arXiv',url:id.url,sourceUrl,fetchedAt:now(),identifiers:[id,...(doiId?[doiId]:[])]});
  }
  return result;
}

export function putRecord(store,record) {
  if(!record)return;
  const old=store.records[record.id];
  const preferred=old?.provider==='Crossref'&&record.provider!=='Crossref'?old:record;
  store.records[record.id]={...preferred,alternateTitles:[...new Set([...(old?.alternateTitles||[]),...(record.alternateTitles||[]),old?.title,record.title].filter(t=>t&&t!==preferred.title))],identifiers:[...new Map([...(old?.identifiers||[]),...record.identifiers].map(i=>[i.key,{key:i.key,kind:i.kind,value:i.value,url:i.url}])).values()]};
}

export async function fetchMetadata(url,{fetchFn=fetch,delay=0}={}){
  if(delay)await sleep(delay);
  const res=await fetchFn(url,{headers:{'User-Agent':'Researchscape/0.2 (local bibliographic normalization)'},signal:AbortSignal.timeout(18000)});
  if(!res.ok){const error=new Error(`HTTP ${res.status} · ${new URL(url).hostname}`);error.status=res.status;throw error;}
  return res;
}

export async function synchronizeBibliography(index,store,{limit=80,onSave=()=>{},onProgress=()=>{},fetchFn=fetch,delay=350}={}) {
  store.records??={};store.lookups??={};
  const counts={completed:0,total:0,errors:0,requests:0,cached:0};
  const allIds=[...new Map([...index.papers.flatMap(p=>p.identifiers),...(index.bibliographyHints||[]).map(h=>h.identifier)].filter(i=>['arxiv','doi','openreview'].includes(i.kind)).map(i=>[i.key,i])).values()];
  const titles=index.papers.filter(p=>titleTokens(p.title).length>=4&&p.title.length>=24&&!/^(?:arXiv|DOI|OpenReview|논문 링크) · /i.test(p.title)&&!/https?:\/\//i.test(p.title)).sort((a,b)=>b.count-a.count).slice(0,limit);
  const recent=key=>{const entry=store.lookups[key];if(!entry)return false;if((entry.recordIds||[]).some(id=>{const r=store.records[id];return r?.provider==='Crossref'&&r.schemaVersion!==2;}))return false;const ttl=entry.status==='ok'&&entry.recordIds?.length?30*86400000:30*60000;return Date.now()-Date.parse(entry.updatedAt)<ttl;};
  const ids=allIds.filter(i=>!recent(i.key));
  const pendingTitles=titles.filter(p=>!recent(lookupKey(p)));
  counts.cached=allIds.length+titles.length-ids.length-pendingTitles.length;counts.total=ids.length+pendingTitles.length;
  const tick=(stage,current)=>{onProgress({...counts,stage,current});};
  const save=()=>{store.updatedAt=now();onSave(store);};
  const remember=(key,records,extra={})=>{const valid=records.filter(Boolean);valid.forEach(r=>putRecord(store,r));store.lookups[key]={status:valid.length?'ok':'not-found',recordIds:valid.map(r=>r.id),updatedAt:now(),...extra};counts.completed++;};
  const failed=(key,e)=>{store.lookups[key]={status:'error',error:e.message,updatedAt:now(),recordIds:[]};counts.completed++;counts.errors++;};
  const request=async url=>{counts.requests++;return fetchMetadata(url,{fetchFn,delay});};
  tick('starting','공식 서지정보 조회');
  const arxiv=ids.filter(i=>i.kind==='arxiv');
  for(let at=0;at<arxiv.length;at+=40){
    const batch=arxiv.slice(at,at+40),url=`https://export.arxiv.org/api/query?id_list=${batch.map(i=>encodeURIComponent(i.value)).join(',')}&max_results=${batch.length}`;
    tick('identifiers',`arXiv ${at+1}–${at+batch.length}`);
    try{
      const records=arxivRecords(await(await request(url)).text(),url);
      for(const id of batch)remember(id.key,records.filter(r=>r.identifiers.some(i=>i.key===id.key)),{query:id.value,method:'identifier'});
    }catch(e){for(const id of batch)failed(id.key,e);}
    save();if(at+40<arxiv.length)await sleep(fetchFn===fetch?3000:0);
  }
  let openreviewBlocked=false;
  for(const id of ids.filter(i=>i.kind!=='arxiv')){
    tick('identifiers',`${id.kind}: ${id.value}`);
    if(id.kind==='openreview'&&openreviewBlocked){failed(id.key,new Error('OpenReview 접근 제한 · 이번 실행에서 재시도하지 않음'));continue;}
    try{
      if(id.kind==='doi'){
        const url=`https://api.crossref.org/works/${encodeURIComponent(id.value)}`;
        const data=await(await request(url)).json();remember(id.key,[crossrefRecord(data.message,url)].filter(Boolean),{query:id.value,method:'identifier'});
      }else{
        const url=`https://api2.openreview.net/notes?id=${encodeURIComponent(id.value)}`;
        const data=await(await request(url)).json(),note=data.notes?.[0],value=x=>x?.value??x;
        const title=value(note?.content?.title);
        const record=title?{id:id.key,title,authors:value(note.content.authors)||[],year:note.cdate?new Date(note.cdate).getUTCFullYear():null,venue:value(note.content.venue)||'',provider:'OpenReview',url:id.url,sourceUrl:url,fetchedAt:now(),identifiers:[id]}:null;
        remember(id.key,record?[record]:[],{query:id.value,method:'identifier'});
      }
    }catch(e){if(id.kind==='openreview'&&[403,429].includes(e.status))openreviewBlocked=true;failed(id.key,e);}
    save();
  }
  for(const paper of pendingTitles){
    const key=lookupKey(paper);tick('titles',paper.title);
    const url='https://api.crossref.org/works?'+new URLSearchParams({'query.bibliographic':paper.title,rows:'3',select:'DOI,title,subtitle,author,published,container-title,URL'});
    try{const data=await(await request(url)).json();remember(key,(data.message?.items||[]).map(i=>crossrefRecord(i,url)).filter(Boolean),{query:paper.title,method:'title-search'});}catch(e){failed(key,e);}
    save();
  }
  tick('complete','조회 완료');save();return counts;
}

export function validRecord(record) {
  return !!record?.id&&typeof record.title==='string'&&record.title.trim().length>2&&httpUrl(record.url)&&Array.isArray(record.identifiers)&&record.identifiers.length>0;
}
