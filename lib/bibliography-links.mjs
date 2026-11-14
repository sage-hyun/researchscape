const kinds=['landing','doi','preprint','pdf'];
export function httpUrl(value){try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.href:null;}catch{return null;}}
export function linkKind(url){
  const u=new URL(url);
  if(u.hostname==='doi.org'||u.hostname==='dx.doi.org')return 'doi';
  const arxiv=u.hostname==='arxiv.org'||u.hostname.endsWith('.arxiv.org');
  if(/\.pdf$/i.test(u.pathname)||((arxiv||u.hostname==='openreview.net')&&u.pathname.startsWith('/pdf')))return 'pdf';
  if(arxiv)return 'preprint';
  return 'landing';
}
export function recordLinks(record){
  const links=Object.fromEntries(kinds.map(k=>[k,[]]));
  const add=(kind,value,extra={})=>{const url=httpUrl(value);if(url)links[kind].push({url,provider:record.provider,sourceUrl:record.sourceUrl||'',fetchedAt:record.fetchedAt,...extra});};
  for(const kind of kinds)for(const link of record.links?.[kind]||[])add(kind,link.url,link);
  for(const value of [record.url,...(record.identifiers||[]).map(i=>i.url)]){const url=httpUrl(value);if(url)add(linkKind(url),url);}
  return mergeLinks(links);
}
export function mergeLinks(...sets){
  return Object.fromEntries(kinds.map(kind=>[kind,[...new Map(sets.flatMap(s=>s?.[kind]||[]).filter(l=>httpUrl(l.url)).map(l=>[JSON.stringify([l.url,l.provider,l.sourceUrl]),l])).values()]]));
}
