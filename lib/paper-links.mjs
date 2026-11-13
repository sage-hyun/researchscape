export function publisherLink(value) {
  let u;try{u=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(u.protocol))return null;
  const host=u.hostname.toLowerCase().replace(/^www\./,''),p=u.pathname;
  let pathname=p;
  if(host==='aclanthology.org'&&/^\/[A-Za-z0-9][A-Za-z0-9.-]+(?:\.pdf|\/?)$/.test(p))pathname=p.replace(/\.pdf$/,'').replace(/\/$/,'')+'/';
  else if(host==='openaccess.thecvf.com'&&/\/content\/.+_paper\.(?:html|pdf)$/.test(p))pathname=p.replace('/papers/','/html/').replace(/\.pdf$/,'.html');
  else if(host==='proceedings.mlr.press'&&/^\/v\d+\/.+\.(?:html|pdf)$/.test(p)){const a=p.split('/');pathname=a.length>3?`/${a[1]}/${a[2]}.html`:p;}
  else if(['proceedings.neurips.cc','papers.nips.cc'].includes(host)&&/\/paper(?:_files)?\/paper\/.+/.test(p))pathname=p.replace('/file/','/hash/').replace(/-Paper(?:-Conference)?\.pdf$/, '-Abstract.html');
  else if(host==='ieeexplore.ieee.org'&&/^\/document\/\d+\/?$/.test(p))pathname=p.replace(/\/$/,'');
  else if(host==='nature.com'&&/^\/articles\/[A-Za-z0-9-]+(?:\.pdf)?$/.test(p))pathname=p.replace(/\.pdf$/,'');
  else return null;
  const url=`https://${host}${pathname}`;
  return {key:`url:${url}`,kind:'publisher',value:url,url};
}

export function webReferences(message) {
  const result=[],seen=new Set();
  const add=item=>{
    if(!item?.url||typeof item.title!=='string')return;
    try{if(!['http:','https:'].includes(new URL(item.url).protocol))return;}catch{return;}
    const key=item.url+'|'+item.title;if(seen.has(key))return;seen.add(key);
    result.push({url:item.url,title:item.title,source:'export-citation'});
  };
  for(const ref of message?.metadata?.content_references||[]){
    if(['file','hidden'].includes(ref.type))continue;
    add(ref);
    for(const item of [...(ref.items||[]),...(ref.fallback_items||[])]){add(item);for(const site of item.supporting_websites||[])add(site);}
  }
  // Search inventories are not included: being retrieved does not mean being mentioned.
  return result;
}

export function titleTokens(value) {
  return (value.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)||[]).filter(w=>!['a','an','the','of','for','and','to','in','with','on','from','by'].includes(w));
}
export function titleSimilarity(a,b) {
  const x=new Set(titleTokens(a)),y=new Set(titleTokens(b));if(!x.size||!y.size)return 0;
  return 2*[...x].filter(t=>y.has(t)).length/(x.size+y.size);
}
