import {identifiers,normalize} from './extract.mjs';
import {titleSimilarity} from './paper-links.mjs';
import {specificTitle,aliasIdentity,exactTitle} from './bibliography-policy.mjs';
import {httpUrl,recordLinks,mergeLinks,linkKind} from './bibliography-links.mjs';

const sleep=(ms,signal)=>new Promise((resolve,reject)=>{signal?.throwIfAborted();const done=()=>{signal?.removeEventListener('abort',abort);resolve();};const timer=setTimeout(done,ms);const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};signal?.addEventListener('abort',abort,{once:true});});
const decode=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>String.fromCodePoint(n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n))).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/\s+/g,' ').trim();
const tag=(xml,name)=>decode(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`,'i').exec(xml)?.[1]);
const now=()=>new Date().toISOString();
export const lookupKey=p=>`title:${normalize(p.title)}`;

export function crossrefRecord(item,sourceUrl='') {
  if(!item?.DOI||!item.title?.[0])return null;
  const doi=String(item.DOI).toLowerCase(),url=`https://doi.org/${doi}`;
  const mainTitle=decode(item.title[0]),subtitle=decode(item.subtitle?.[0]);
  const title=subtitle&&!normalize(mainTitle).endsWith(normalize(subtitle))?`${mainTitle}${/[:;]$/.test(mainTitle)?' ':': '}${subtitle}`:mainTitle;
  const record={id:`doi:${doi}`,title,mainTitle,subtitle,schemaVersion:2,authors:(item.author||[]).map(a=>[a.given,a.family].filter(Boolean).join(' ')||a.name).filter(Boolean),year:(item.published||item['published-print']||item['published-online'])?.['date-parts']?.[0]?.[0]||null,venue:decode(item['container-title']?.[0]),provider:'Crossref',url,sourceUrl:sourceUrl||`https://api.crossref.org/works/${encodeURIComponent(doi)}`,fetchedAt:now(),identifiers:[{key:`doi:${doi}`,kind:'doi',value:doi,url}]};
  record.publicationType=item.type;record.links=recordLinks(record);
  for(const value of [item.resource?.primary?.URL,item.URL])appendLink(record,value);
  for(const link of item.link||[])appendLink(record,link.URL,link['content-type']==='application/pdf'?'pdf':undefined);
  return record;
}

export function arxivRecords(xml,sourceUrl) {
  const result=[];
  for(const m of xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)){
    const text=m[1],id=identifiers(tag(text,'id')).find(i=>i.kind==='arxiv');
    const title=tag(text,'title');if(!id||!title||title.toLowerCase()==='error')continue;
    const doi=tag(text,'arxiv:doi').toLowerCase(),doiId=doi?identifiers(doi)[0]:null;
    const authors=[...text.matchAll(/<author>([\s\S]*?)<\/author>/g)].map(a=>tag(a[1],'name')).filter(Boolean);
    const record={id:doiId?.key||id.key,title,authors,year:Number(tag(text,'published').slice(0,4))||null,venue:tag(text,'arxiv:journal_ref'),provider:'arXiv',url:id.url,sourceUrl,fetchedAt:now(),identifiers:[id,...(doiId?[doiId]:[])]};
    record.links=recordLinks(record);appendLink(record,`https://arxiv.org/pdf/${id.value}`,'pdf');result.push(record);
  }
  return result;
}

export function putRecord(store,record) {
  if(!record)return;
  const old=store.records[record.id];
  const preferred=old?.provider==='Crossref'&&record.provider!=='Crossref'?old:record;
  const conflicts=[...(old?.metadataConflicts||[]),...(record.metadataConflicts||[])];
  if(old&&specificTitle(old.title)&&specificTitle(record.title)&&titleSimilarity(old.title,record.title)<.55)conflicts.push({title:record.title,previousTitle:old.title,provider:record.provider,sourceUrl:record.sourceUrl,fetchedAt:record.fetchedAt});
  const source=r=>({provider:r.provider,sourceUrl:r.sourceUrl,fetchedAt:r.fetchedAt});
  store.records[record.id]={...preferred,...(conflicts.length?{metadataConflicts:conflicts}:{}),links:mergeLinks(old&&recordLinks(old),recordLinks(record)),sources:[...new Map([...(old?.sources||[]),...(record.sources||[]),...(old?[source(old)]:[]),source(record)].map(s=>[JSON.stringify(s),s])).values()],alternateTitles:[...new Set([...(old?.alternateTitles||[]),...(record.alternateTitles||[]),old?.title,record.title].filter(t=>t&&t!==preferred.title))],identifiers:[...new Map([...(old?.identifiers||[]),...record.identifiers].map(i=>[i.key,{key:i.key,kind:i.kind,value:i.value,url:i.url}])).values()]};
  // A record a lookup just returned stands on its own; review-proposals.mjs re-marks the ones
  // that exist only because an LLM proposal was checked.
  if(!record.provisional)delete store.records[record.id].provisional;
}

function appendLink(record,value,kind){const url=httpUrl(value);if(!url)return;kind??=linkKind(url);record.links=mergeLinks(record.links,{[kind]:[{url,provider:record.provider,sourceUrl:record.sourceUrl,fetchedAt:record.fetchedAt}]});}
function externalIds(values={}){
  const result=[];
  if(values.DOI)result.push(...identifiers(`https://doi.org/${String(values.DOI).replace(/^https?:\/\/(?:dx\.)?doi.org\//i,'')}`));
  if(values.ArXiv)result.push(...identifiers(`https://arxiv.org/abs/${values.ArXiv}`));
  return result.map(({key,kind,value,url})=>({key,kind,value,url}));
}
export function openalexRecord(item,sourceUrl=''){
  if(!item?.id||!(item.title||item.display_name))return null;
  const ids=externalIds({DOI:item.doi}),native={key:`openalex:${item.id.split('/').at(-1)}`,kind:'openalex',value:item.id.split('/').at(-1),url:item.id};
  const locations=[item.primary_location,item.best_oa_location,...(item.locations||[])].filter(Boolean);
  for(const l of locations)for(const value of [l.landing_page_url,l.pdf_url])if(value)ids.push(...identifiers(value).filter(i=>['doi','arxiv','openreview'].includes(i.kind)));
  const record={id:ids.find(i=>i.kind==='doi')?.key||ids.find(i=>i.kind==='arxiv')?.key||native.key,title:decode(item.title||item.display_name),authors:(item.authorships||[]).map(a=>a.author?.display_name).filter(Boolean),year:item.publication_year||null,venue:item.primary_location?.source?.display_name||'',provider:'OpenAlex',url:locations.find(l=>httpUrl(l.landing_page_url))?.landing_page_url||ids[0]?.url||item.id,sourceUrl,fetchedAt:now(),publicationType:item.type,identifiers:[...ids,native]};
  record.links=recordLinks(record);for(const l of locations){appendLink(record,l.landing_page_url);appendLink(record,l.pdf_url,'pdf');}return record;
}
export function semanticScholarRecord(item,sourceUrl=''){
  if(!item?.paperId||!item.title)return null;
  const ids=externalIds(item.externalIds),native={key:`s2:${item.paperId}`,kind:'s2',value:item.paperId,url:`https://www.semanticscholar.org/paper/${item.paperId}`};
  const record={id:ids.find(i=>i.kind==='doi')?.key||ids.find(i=>i.kind==='arxiv')?.key||native.key,title:decode(item.title),authors:(item.authors||[]).map(a=>a.name).filter(Boolean),year:item.year||null,venue:item.venue||'',provider:'Semantic Scholar',url:ids[0]?.url||httpUrl(item.url)||native.url,sourceUrl,fetchedAt:now(),publicationType:item.publicationTypes?.[0],identifiers:[...ids,native]};
  record.links=recordLinks(record);appendLink(record,item.openAccessPdf?.url,'pdf');appendLink(record,item.url);return record;
}

const scrubUrl=url=>{const u=new URL(url);u.searchParams.delete('api_key');return u.href;};
const retryAfter=value=>{if(!value)return 0;const seconds=Number(value);return Number.isFinite(seconds)?Math.max(0,seconds*1000):Math.max(0,Date.parse(value)-Date.now())||0;};
export async function fetchMetadata(url,{fetchFn=fetch,delay=0,headers={},signal,maxRetries=2,sleepFn=sleep,onAttempt=()=>{},onRetry=()=>{}}={}){
  for(let attempt=0;;attempt++){
    signal?.throwIfAborted();if(delay)await sleepFn(delay,signal);signal?.throwIfAborted();onAttempt();
    let res,error;
    try{res=await fetchFn(url,{headers:{'User-Agent':'Researchscape/0.3 (local bibliographic normalization)',...headers},signal:signal?AbortSignal.any([signal,AbortSignal.timeout(18000)]):AbortSignal.timeout(18000)});}
    catch(e){if(signal?.aborted)throw signal.reason;error=new Error(`${e.name==='TimeoutError'?'Timeout':'Network error'} · ${new URL(url).hostname}`);error.code=e.name==='TimeoutError'?'timeout':'transport-error';}
    if(res?.ok)return res;
    if(res){error=new Error(`HTTP ${res.status} · ${new URL(url).hostname}`);error.status=res.status;error.code=res.status===429?'rate-limited':[401,403].includes(res.status)?'access-denied':'http-error';error.retryAfterMs=retryAfter(res.headers.get('retry-after'));await res.body?.cancel().catch(()=>{});}
    const retry=(!res||res.status===429||res.status>=500)&&attempt<maxRetries;
    const wait=Math.max(error.retryAfterMs||0,1000*2**attempt);
    // A long Retry-After becomes a persisted cooldown, never a truncated wait followed by an early request.
    if(!retry||wait>60000)throw error;
    onRetry({attempt:attempt+1,wait,status:error.status,code:error.code});
    await sleepFn(wait,signal);
  }
}

export const providerLookupKey=(provider,key)=>`${provider}|${key}`;
export function recentLookup(entry,store,at=Date.now()){
  if(!entry)return false;
  if(entry.retryAt&&at<Date.parse(entry.retryAt))return true;
  if((entry.recordIds||[]).some(id=>!store.records[id]||(store.records[id]?.provider==='Crossref'&&store.records[id].schemaVersion!==2)))return false;
  const ttl=entry.status==='ok'&&entry.recordIds?.length?30*86400000:30*60000;
  return at-Date.parse(entry.updatedAt)<ttl;
}

export async function synchronizeBibliography(index,store,{limit=80,onSave=()=>{},onProgress=()=>{},fetchFn=fetch,delay=350,sleepFn=sleep,signal,maxRetries=2,openalexApiKey=process.env.OPENALEX_API_KEY,semanticScholarApiKey=process.env.SEMANTIC_SCHOLAR_API_KEY}={}) {
  store.records??={};store.lookups??={};store.providerLookups??={};store.providerCooldowns??={};
  for(const [key,entry] of Object.entries(store.lookups))if(key.startsWith('title:')&&!entry.providers)store.providerLookups[providerLookupKey('crossref',key)]??={...entry,provider:'crossref'};
  const counts={completed:0,total:0,errors:0,requests:0,cached:0,retries:0};
  const curated=index.papers.flatMap(p=>[p.title,...(p.aliases||[])].flatMap(t=>aliasIdentity(t)?.identifiers||[])).flatMap(key=>identifiers(key.startsWith('arxiv:')?key:key.slice(4)));
  const allIds=[...new Map([...index.papers.flatMap(p=>p.identifiers||[]),...(index.bibliographyHints||[]).map(h=>h.identifier),...curated].filter(i=>['arxiv','doi','openreview'].includes(i.kind)).map(i=>[i.key,i])).values()];
  // Pick uncached work before applying the limit, so successive button presses advance through the backlog.
  const titlePapers=index.papers.filter(p=>specificTitle(p.title)).sort((a,b)=>b.count-a.count);
  const providers=['crossref','openalex','semantic-scholar'];
  const cachedStage=(provider,key)=>store.providerLookups[providerLookupKey(provider,key)]||(provider==='crossref'&&!store.lookups[key]?.providers?store.lookups[key]:null);
  const exactRecords=(key,title)=>[...new Set(providers.flatMap(provider=>cachedStage(provider,key)?.recordIds||[]))].map(id=>store.records[id]).filter(r=>r&&[r.title,...(r.alternateTitles||[])].some(t=>exactTitle(t,title)));
  const titleComplete=p=>{
    const key=lookupKey(p),entries=providers.map(provider=>cachedStage(provider,key));
    // A valid unique exact Crossref result preserves its existing 30-day cache. Fallback stages resume independently.
    if(exactRecords(key,p.title).length&&entries.some(e=>recentLookup(e,store)&&e.recordIds?.some(id=>[store.records[id]?.title,...(store.records[id]?.alternateTitles||[])].some(t=>t&&exactTitle(t,p.title)))))return true;
    return entries.every(e=>recentLookup(e,store));
  };
  const ids=allIds.filter(i=>!recentLookup(store.lookups[i.key],store));
  const titles=titlePapers.filter(p=>!titleComplete(p)).slice(0,limit);
  counts.cached=allIds.length-ids.length+titlePapers.filter(titleComplete).length;counts.total=ids.length+titles.length;
  const tick=(stage,current)=>onProgress({...counts,stage,current});
  const save=()=>{store.updatedAt=now();onSave(store);};
  const blocked=new Map(Object.entries(store.providerCooldowns).filter(([,e])=>Date.parse(e.retryAt)>Date.now()));
  const attempt=async(provider,key,query,method,url,parse,{noMatch404=false,headers={},checkpoint=true}={})=>{
    signal?.throwIfAborted();
    let entry;
    const prior=method==='title-search'?cachedStage(provider,key):store.lookups[key];
    if(recentLookup(prior,store)){counts.cached++;return prior;}
    if(blocked.has(provider))entry={status:'error',outcome:'provider-cooldown',...blocked.get(provider),recordIds:[],updatedAt:now()};
    else try{
      const res=await fetchMetadata(url,{fetchFn,delay:fetchFn===fetch?Math.max(delay,provider==='arxiv'?3000:provider==='semantic-scholar'?1100:350):delay,headers,signal,maxRetries,sleepFn,onAttempt:()=>counts.requests++,onRetry:()=>{counts.retries++;tick('retry',`${provider}: ${query}`);}});
      const records=(await parse(res,scrubUrl(url))).filter(Boolean);records.forEach(r=>putRecord(store,r));
      entry={status:records.length?'ok':'not-found',outcome:records.length?'retrieved':method==='identifier'?'identifier-not-indexed':'no-match',recordIds:[...new Set(records.map(r=>r.id))],updatedAt:now()};
      delete store.providerCooldowns[provider];
    }catch(e){
      if(signal?.aborted)throw e;
      if(noMatch404&&e.status===404)entry={status:'not-found',outcome:method==='identifier'?'identifier-not-indexed':'no-match',httpStatus:404,recordIds:[],updatedAt:now()};
      else {
        entry={status:'error',outcome:e.code||'invalid-response',httpStatus:e.status,error:e.message,recordIds:[],updatedAt:now()};counts.errors++;
        if([401,403,429].includes(e.status)||e.retryAfterMs>60000){
          entry.retryAt=new Date(Date.now()+Math.max(e.retryAfterMs||0,30*60000)).toISOString();
          const cooldown={retryAt:entry.retryAt,httpStatus:e.status,error:e.message,cause:entry.outcome};blocked.set(provider,cooldown);store.providerCooldowns[provider]=cooldown;
        }
      }
    }
    entry={...entry,provider,query,method,sourceUrl:scrubUrl(url)};
    if(method==='title-search')store.providerLookups[providerLookupKey(provider,key)]=entry;
    else store.lookups[key]=entry;
    // Persist every provider stage, including failures, so a stopped job never discards completed fallbacks.
    if(checkpoint)save();return entry;
  };
  tick('starting','공식 서지정보 조회');
  // Retain batched arXiv lookup and its legacy identifier cache keys.
  const arxiv=ids.filter(i=>i.kind==='arxiv');
  for(let at=0;at<arxiv.length;at+=40){
    const batch=arxiv.slice(at,at+40),url=`https://export.arxiv.org/api/query?id_list=${batch.map(i=>encodeURIComponent(i.value)).join(',')}&max_results=${batch.length}`;
    tick('identifiers',`arXiv ${at+1}–${at+batch.length}`);
    const entry=await attempt('arxiv',batch[0].key,batch.map(i=>i.value).join(','),'identifier',url,async(res,source)=>{
      const xml=await res.text();if(!/<feed(?:\s|>)/i.test(xml)||/<id>[^<]*api\/errors/i.test(xml))throw new Error('Invalid arXiv response');return arxivRecords(xml,source);
    },{checkpoint:false});
    for(const id of batch)store.lookups[id.key]={...entry,query:id.value,recordIds:(entry.recordIds||[]).filter(key=>store.records[key]?.identifiers.some(i=>i.key===id.key))};
    for(const id of batch)if(store.lookups[id.key].status==='ok'&&!store.lookups[id.key].recordIds.length)Object.assign(store.lookups[id.key],{status:'not-found',outcome:'identifier-not-indexed'});
    counts.completed+=batch.length;save();
  }
  for(const id of ids.filter(i=>i.kind!=='arxiv')){
    tick('identifiers',`${id.kind}: ${id.value}`);
    if(id.kind==='doi'){
      const url=`https://api.crossref.org/works/${encodeURIComponent(id.value)}`;
      await attempt('crossref',id.key,id.value,'identifier',url,async(res,source)=>{const data=await res.json();if(!data.message?.DOI)throw new Error('Invalid Crossref work response');return [crossrefRecord(data.message,source)];},{noMatch404:true});
    }else{
      const url=`https://api2.openreview.net/notes?id=${encodeURIComponent(id.value)}`;
      await attempt('openreview',id.key,id.value,'identifier',url,async(res,sourceUrl)=>{
        const data=await res.json();if(!Array.isArray(data.notes))throw new Error('Invalid OpenReview response');const note=data.notes.find(n=>n.id===id.value),value=x=>x?.value??x;
        const title=value(note?.content?.title);if(!title)return [];
        const record={id:id.key,title,authors:value(note.content.authors)||[],year:note.cdate?new Date(note.cdate).getUTCFullYear():null,venue:value(note.content.venue)||'',provider:'OpenReview',url:id.url,sourceUrl,fetchedAt:now(),identifiers:[id]};
        record.links=recordLinks(record);appendLink(record,`https://openreview.net/pdf?id=${encodeURIComponent(id.value)}`,'pdf');return [record];
      });
    }
    counts.completed++;save();
  }
  for(const paper of titles){
    const key=lookupKey(paper),entries=[];tick('titles',paper.title);
    for(const provider of providers){
      let url,parse,options={};
      if(provider==='crossref'){
        url='https://api.crossref.org/works?'+new URLSearchParams({'query.bibliographic':paper.title,rows:'5',select:'DOI,title,subtitle,author,published,container-title,URL,resource,link,type'});
        parse=async(res,source)=>{const data=await res.json();if(!Array.isArray(data.message?.items))throw new Error('Invalid Crossref search response');return data.message.items.map(i=>crossrefRecord(i,source));};
      }else if(provider==='openalex'){
        const params=new URLSearchParams({'search.title':paper.title,per_page:'5',select:'id,doi,title,publication_year,authorships,primary_location,best_oa_location,locations,type'});if(openalexApiKey)params.set('api_key',openalexApiKey);
        url='https://api.openalex.org/works?'+params;
        parse=async(res,source)=>{const data=await res.json();if(!Array.isArray(data.results))throw new Error('Invalid OpenAlex response');return data.results.map(i=>openalexRecord(i,source));};
      }else{
        url='https://api.semanticscholar.org/graph/v1/paper/search/match?'+new URLSearchParams({query:paper.title,fields:'paperId,title,externalIds,url,authors,year,venue,openAccessPdf,publicationTypes'});
        options={noMatch404:true,headers:semanticScholarApiKey?{'x-api-key':semanticScholarApiKey}:{}};
        parse=async(res,source)=>{const data=await res.json();if(!Array.isArray(data.data))throw new Error('Invalid Semantic Scholar response');return data.data.map(i=>semanticScholarRecord(i,source));};
      }
      entries.push(await attempt(provider,key,paper.title,'title-search',url,parse,options));
      if(exactRecords(key,paper.title).length)break;
    }
    // Keep the original title key as a backwards-compatible aggregate, not as the Crossref provider cache.
    const recordIds=[...new Set(entries.flatMap(e=>e.recordIds||[]))];
    store.lookups[key]={status:recordIds.length?'ok':entries.some(e=>e.status==='error')?'error':'not-found',outcome:exactRecords(key,paper.title).length?'exact-title-retrieved':recordIds.length?'matching-failed':entries.some(e=>e.status==='error')?'lookup-failed':'no-match',recordIds,providers:entries.map(e=>e.provider),query:paper.title,method:'title-search',updatedAt:now()};
    counts.completed++;save();
  }
  tick('complete','조회 완료');save();return counts;
}

export function validRecord(record) {
  return !!record?.id&&typeof record.title==='string'&&record.title.trim().length>2&&httpUrl(record.url)&&Array.isArray(record.identifiers)&&record.identifiers.length>0;
}
