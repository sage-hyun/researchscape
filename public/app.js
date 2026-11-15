const $=s=>document.querySelector(s);
const appBase=new URL('.',document.currentScript.src);
const appUrl=url=>url.startsWith('/')&&!url.startsWith('//')?new URL(url.slice(1),appBase).pathname+new URL(url.slice(1),appBase).search:url;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=n=>Number(n||0).toLocaleString('ko-KR');
const date=t=>t?new Date(t*1000).toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul'}):'날짜 없음';
const short=p=>p.aliases.find(a=>!a.includes(' ')&&a.length<32)||p.title.replace(/^(arXiv|DOI|OpenReview) · /,'');
const label=p=>{const t=short(p);return t.length>23?t.slice(0,22)+'…':t;};
const statusLabel=s=>s==='confirmed'?'직접 확인함':s==='dismissed'?'제외한 후보':'검토 전';
const hasPaperLink=p=>Object.values(p.links||{}).some(links=>links.length)||(p.identifiers||[]).some(i=>!!i.url);
const urlKindLabels={landing:'논문 페이지',doi:'DOI',preprint:'Preprint',pdf:'PDF'};
const bibliographyReason=reason=>({
  'conflicting-metadata':'서로 다른 서지정보가 충돌합니다.',
  'identifier-title-conflict':'식별자가 가리키는 논문과 대화의 제목이 다릅니다.',
  'citation-title-conflict':'예전 인용 메타데이터의 제목이 원문 표기와 정확히 맞지 않습니다.',
  'insufficient-alias-evidence':'약칭의 정식 제목·식별자 근거가 부족합니다.',
  'insufficient-local-alias-evidence':'같은 대화에 정식 제목이 있지만, 이 약칭의 동일·인접 메시지 근거가 부족합니다.',
  'candidate-type:conference':'학회명 후보입니다. 자동 연결에서 제외했습니다.',
  'candidate-type:technology':'일반 기술명 후보입니다. 자동 연결에서 제외했습니다.',
  'candidate-type:dataset':'데이터셋 이름 후보입니다. 자동 연결에서 제외했습니다.',
  'candidate-type:section-heading':'문서 소제목 후보입니다. 자동 연결에서 제외했습니다.'
})[reason]||'약칭 또는 유사 제목만 일치합니다. 검토가 필요합니다.';
function paperLinkButtons(p){
  const seen=new Set(),links=[];
  for(const [kind,items] of Object.entries(p.links||{}))for(const item of items){const key=kind+'|'+item.url;if(seen.has(key))continue;seen.add(key);links.push(`<a class="button" href="${esc(item.url)}" title="${esc(item.provider||'발견된 링크')}" target="_blank" rel="noopener noreferrer">${esc(urlKindLabels[kind]||kind)} ↗</a>`);}
  if(!links.length)for(const i of p.identifiers||[])links.push(`<a class="button" href="${esc(i.url)}" target="_blank" rel="noopener noreferrer">${esc(i.kind)} 원문 ↗</a>`);
  return links.join('');
}
const categoryLabels={research:'직접 연구',coursework:'수업·과제',unclassified:'미분류'};
const sourceFilterLabels={all:'전체 대화','non-coursework':'수업·과제 제외 (미분류 포함)',...categoryLabels};
const categoryBadges=counts=>Object.entries(categoryLabels).filter(([key])=>counts?.[key]).map(([key,name])=>`<span class="source-tag ${key}">${name} ${num(counts[key])}</span>`).join('');
let state={papers:[],selected:null,filtered:[],view:'graph',role:'',offset:0,mentions:[],metric:'count',range:{from:'',to:'',category:'all',project:''}}, renderVersion=0, detailVersion=0, loadVersion=0, lastFocus=null;
const scopedUrl=(url,params={},range=state.range)=>url+'?'+new URLSearchParams({...range,...params});
let toastTimer;
function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
async function api(url,options={}) {
  const res=await fetch(appUrl(url),{...options,headers:options.body?{'Content-Type':'application/json'}:undefined});
  const data=await res.json();if(!res.ok)throw new Error(data.error||'요청에 실패했습니다.');return data;
}
const post=(url,data={})=>api(url,{method:'POST',body:JSON.stringify(data)});
async function load(range=state.range){
  const version=++loadVersion;++renderVersion;
  const data=await api(scopedUrl('/api/overview',{},range));if(version!==loadVersion)return;
  state.range={from:data.range.from,to:data.range.to,category:data.filters.category,project:data.filters.project};state.papers=data.papers;
  $('#categoryFilter').value=state.range.category;renderProjectOptions(data.projects);
  $('#sourceScope').textContent=`${sourceFilterLabels[state.range.category]} · 미분류에도 연구 관련 대화가 포함될 수 있습니다.`;
  $('#conversationStatLabel').textContent=data.range.active?'기간 내 대화':data.filters.active?'선택한 대화':'가져온 대화';
  $('#conversationStatNote').textContent=data.range.active?'기간·분류에 맞는 메시지가 있는 대화':data.filters.active?'분류·프로젝트 선택 기준':'선택된 대화 경로 기준';
  const rangeLabel=data.range.active?`${data.range.from||'처음'} ~ ${data.range.to||'현재'}`:'전체 기간';
  $('#dateScope').textContent=rangeLabel+' · 메시지 작성일 (한국시간)';
  const address=new URL(location.href);for(const key of ['from','to','category','project']){if(state.range[key]&&state.range[key]!=='all')address.searchParams.set(key,state.range[key]);else address.searchParams.delete(key);}history.replaceState(null,'',address);
  $('#statConversations').textContent=num(data.stats.conversations);$('#statPapers').textContent=num(data.stats.papers);$('#statMentions').textContent=num(data.stats.mentions);$('#statResearch').textContent=num(data.stats.researchConversations);$('#navCount').textContent=num(data.stats.papers);
  $('#reviewSummary').textContent=`직접 확인 ${num(data.papers.filter(p=>p.status==='confirmed').length)}개 · 규칙 기반 후보`;
  $('#snapshotDate').textContent=new Date(data.generatedAt).toLocaleString('ko-KR',{timeZone:'Asia/Seoul',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})+' 기준';
  if(data.stats.warnings.length)toast(`선택 경로를 찾지 못한 대화 등 경고 ${data.stats.warnings.length}건 · README 참고`);
  await filter();
}
function renderProjectOptions(projects){
  const options=['<option value="">모든 프로젝트</option>','<option value="__none__">프로젝트 정보 없음</option>'];
  for(const [category,name] of Object.entries(categoryLabels)){
    const list=projects.filter(p=>p.category===category);if(!list.length)continue;
    options.push(`<optgroup label="${esc(category==='unclassified'?'이름 미등록 프로젝트':name)}">${list.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} (${num(p.conversationCount)})</option>`).join('')}</optgroup>`);
  }
  $('#projectFilter').innerHTML=options.join('');$('#projectFilter').value=state.range.project;
}
async function filter(){
  const version=++renderVersion;
  const q=$('#search').value.trim().toLowerCase(), status=$('#statusFilter').value, links=$('#linkFilter').value, metric=$('#sort').value;state.metric=metric;
  const address=new URL(location.href);if(links==='all')address.searchParams.delete('links');else address.searchParams.set('links',links);history.replaceState(null,'',address);
  $('#linkHint').hidden=links==='all';
  $('#linkHint').textContent=links==='missing'?'논문 원문 링크가 등록되지 않은 후보입니다. 링크가 없어도 실제 논문일 수 있습니다.':'Export 인용 또는 서지정보에서 연결한 논문 링크가 있는 후보입니다. 링크 유무와 서지정보 검증 상태는 별개입니다.';
  state.filtered=state.papers.filter(p=>{
    const match=[p.title,...p.aliases,...p.identifiers.map(i=>i.value)].some(v=>v.toLowerCase().includes(q));
    const linkMatch=links==='all'||(links==='missing'?!hasPaperLink(p):hasPaperLink(p));
    const statusMatch=status.startsWith('bib:')?p.resolution?.status===status.slice(4):status==='all'||status==='visible'&&p.status!=='dismissed'||p.status===status;
    return match&&linkMatch&&statusMatch;
  }).sort((a,b)=>(b[metric]||0)-(a[metric]||0)||b.count-a.count);
  const graphPapers=state.filtered.slice(0,Number($('#limit').value));
  $('#resultCount').textContent=`후보 ${num(state.filtered.length)}개 · 지도에 ${graphPapers.length}개 표시`;
  $('#graphCount').textContent=`${graphPapers.length} papers · ${metric==='userCount'?'내 언급':metric==='conversationCount'?'대화 수':metric==='lastSeen'?'최근 언급':'전체 언급'} 기준`;
  renderRanking();renderList();
  const params=new URLSearchParams(state.range);graphPapers.forEach(p=>params.append('id',p.id));
  try{const edges=await api('/api/graph?'+params);if(version!==renderVersion)return;renderGraph(graphPapers,edges);}catch(e){toast(e.message);}
}
function renderRanking(){
  $('#ranking').innerHTML=state.filtered.slice(0,5).map((p,i)=>`<button class="ranking-item" data-paper="${esc(p.id)}"><span class="rank">${String(i+1).padStart(2,'0')}</span><span class="rank-name"><strong>${esc(label(p))}</strong><small>${num(p.conversationCount)}개 대화 · ${p.identifiers.length?'식별자 있음':'제목·약칭 후보'}</small></span><span class="rank-count">${num(state.metric==='lastSeen'?p.count:p[state.metric])}</span></button>`).join('')||'<div class="empty">검색 결과가 없습니다.</div>';
}
function paperThumbnail(p){
  const figure=p.media?.thumbnail;
  if(!figure)return '<span class="paper-thumb-empty"><span aria-hidden="true">▧</span><span>대표 이미지 없음</span></span>';
  const caption=figure.kind==='page'?'첫 페이지':figure.kind==='custom'?'직접 선택':figure.number?`Figure ${figure.number}`:'대표 Figure';
  return `<img src="${esc(appUrl(figure.url))}" alt="${esc(p.title)} · ${esc(caption)}" loading="lazy" decoding="async"><span class="paper-thumb-caption">${esc(caption)}</span>`;
}
function renderList(limit=300){
  $('#listArea').innerHTML=state.filtered.slice(0,limit).map(p=>`<button class="paper-row" data-paper="${esc(p.id)}"><span class="paper-thumb" data-thumb-paper="${esc(p.id)}">${paperThumbnail(p)}</span><span class="row-title"><strong>${esc(p.title)}</strong><small>${num(p.conversationCount)}개 대화 · 내가 ${num(p.userCount)}회 / AI가 ${num(p.assistantCount)}회 · 최근 ${date(p.lastSeen)} · 원문 링크 ${hasPaperLink(p)?'있음':'없음'}</small><span class="paper-source-counts">${categoryBadges(p.categoryCounts)}</span></span><span class="badge ${p.status==='confirmed'?'':'amber'}">${statusLabel(p.status)}</span><span class="row-count">${num(p.count)}</span></button>`).join('')||'<div class="empty">검색에 맞는 논문 후보가 없습니다.</div>';
  if(state.filtered.length>limit){const b=document.createElement('button');b.className='button load-more';b.textContent=`목록 더 보기 (${num(state.filtered.length-limit)}개 남음)`;b.onclick=()=>renderList(limit+300);$('#listArea').append(b);}
}
const NS='http://www.w3.org/2000/svg';
function svgNode(tag,attrs={}){const el=document.createElementNS(NS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,v);return el;}
let graphTransform={x:0,y:0,k:1}, graphLayer=null, graphNodes=[], graphLinks=[];
function transformGraph(){graphLayer?.setAttribute('transform',`translate(${graphTransform.x} ${graphTransform.y}) scale(${graphTransform.k})`);}
function renderGraph(papers,edges){
  const svg=$('#graph'), area=$('#graphArea');svg.replaceChildren();area.querySelectorAll('.node-empty,.graph-tooltip').forEach(x=>x.remove());
  const w=area.clientWidth||800,h=area.clientHeight||520;svg.setAttribute('viewBox',`0 0 ${w} ${h}`);
  graphTransform={x:0,y:0,k:1};graphLayer=svgNode('g');svg.append(graphLayer);
  if(!papers.length){const e=document.createElement('div');e.className='node-empty';e.textContent='검색 조건을 바꿔 연구의 조각을 찾아보세요.';area.append(e);return;}
  const max=Math.max(...papers.map(p=>p[state.metric]||0),1), min=Math.min(...papers.map(p=>p[state.metric]||0));
  const nodes=papers.map((p,i)=>{const a=i*2.39996,rad=36+Math.sqrt(i/papers.length)*Math.min(w*.36,h*.33);const value=state.metric==='lastSeen'?p.count:p[state.metric];const peak=state.metric==='lastSeen'?Math.max(...papers.map(p=>p.count)):max;
    return {...p,x:w/2+Math.cos(a)*rad,y:h/2+Math.sin(a)*rad,r:7+Math.sqrt((value||0)/peak)*19,vx:0,vy:0};});
  const byId=new Map(nodes.map(n=>[n.id,n]));
  const links=edges.filter(e=>byId.has(e.source)&&byId.has(e.target)).slice(0,Math.max(80,papers.length*3)).map(e=>({...e,a:byId.get(e.source),b:byId.get(e.target)}));
  for(let t=0;t<260;t++) {
    const cooling=1-t/280;
    for(let i=0;i<nodes.length;i++)for(let j=i+1;j<nodes.length;j++) {
      const a=nodes[i],b=nodes[j];let dx=b.x-a.x,dy=b.y-a.y,d=Math.hypot(dx,dy)||.1;
      const force=Math.min(10,2600/(d*d)+(d<a.r+b.r+38?(a.r+b.r+38-d)*.25:0));
      a.vx-=dx/d*force;a.vy-=dy/d*force;b.vx+=dx/d*force;b.vy+=dy/d*force;
    }
    for(const e of links) {const dx=e.b.x-e.a.x,dy=e.b.y-e.a.y,d=Math.hypot(dx,dy)||1,f=(d-135-e.a.r-e.b.r)*.012*Math.min(2,1+Math.log1p(e.weight)*.1);e.a.vx+=dx/d*f;e.a.vy+=dy/d*f;e.b.vx-=dx/d*f;e.b.vy-=dy/d*f;}
    for(const n of nodes){n.vx+=(w/2-n.x)*.0004;n.vy+=(h/2-n.y)*.0004;n.vx*=.7;n.vy*=.7;n.x=Math.max(n.r+22,Math.min(w-n.r-25,n.x+n.vx*cooling));n.y=Math.max(100+n.r,Math.min(h-80-n.r,n.y+n.vy*cooling));}
  }
  graphLinks=links.map(e=>{const el=svgNode('line',{x1:e.a.x,y1:e.a.y,x2:e.b.x,y2:e.b.y,'stroke-width':Math.min(2.3,.4+Math.log1p(e.weight)*.25),class:'graph-edge'});graphLayer.append(el);return {...e,el};});
  const tooltip=document.createElement('div');tooltip.className='graph-tooltip';tooltip.hidden=true;area.append(tooltip);
  graphNodes=nodes.map((n,i)=>{
    const g=svgNode('g',{transform:`translate(${n.x},${n.y})`,class:'graph-node',tabindex:0,role:'button','aria-label':`${n.title}, ${n.count}회 언급`});
    const color=n.status==='confirmed'?'#547346':n.identifiers.length?'#7d9861':'#b7a36c';
    if(i<5)g.append(svgNode('circle',{r:n.r+5,fill:'none',stroke:color,'stroke-opacity':'.15','stroke-width':4}));
    g.append(svgNode('circle',{r:n.r,fill:color,'fill-opacity':n.identifiers.length?'.8':'.68',stroke:'#fcfdf8','stroke-width':2}));
    if(i<(w<450?10:24)||papers.length<=10){const text=svgNode('text',{y:n.r+15,'text-anchor':'middle'});text.textContent=label(n);g.append(text);}
    const title=svgNode('title');title.textContent=`${n.title}\n${n.count}회 언급 · ${n.conversationCount}개 대화`;g.append(title);
    g.addEventListener('pointerenter',()=>{const related=new Set([n.id,...links.filter(e=>e.source===n.id||e.target===n.id).flatMap(e=>[e.source,e.target])]);graphNodes.forEach(x=>x.el.style.opacity=related.has(x.id)?1:.18);graphLinks.forEach(e=>{e.el.style.strokeOpacity=(e.source===n.id||e.target===n.id)? .7 : .06;});const thumbnail=state.papers.find(p=>p.id===n.id)?.media?.thumbnail;tooltip.innerHTML=`${thumbnail?`<img class="graph-figure-preview" src="${esc(appUrl(thumbnail.url))}" alt="대표 Figure">`:''}<strong>${esc(n.title)}</strong><span>${num(n.count)}회 언급 · ${num(n.conversationCount)}개 대화 · ${statusLabel(n.status)}</span>`;tooltip.hidden=false;});
    g.addEventListener('pointermove',ev=>{const rect=area.getBoundingClientRect();tooltip.style.left=Math.max(8,Math.min(w-270,ev.clientX-rect.left+15))+'px';tooltip.style.top=Math.max(8,Math.min(h-90,ev.clientY-rect.top+15))+'px';});
    g.addEventListener('pointerleave',()=>{tooltip.hidden=true;graphNodes.forEach(x=>x.el.style.opacity=1);graphLinks.forEach(e=>e.el.style.strokeOpacity='');});
    g.addEventListener('click',()=>openPaper(n.id));g.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openPaper(n.id);}});graphLayer.append(g);return {...n,el:g};
  });
}
function zoom(factor,cx=$('#graphArea').clientWidth/2,cy=$('#graphArea').clientHeight/2){const old=graphTransform.k;graphTransform.k=Math.max(.3,Math.min(4,old*factor));const ratio=graphTransform.k/old;graphTransform.x=cx-(cx-graphTransform.x)*ratio;graphTransform.y=cy-(cy-graphTransform.y)*ratio;transformGraph();}
let pan=null;
$('#graph').addEventListener('pointerdown',e=>{if(e.target.closest('.graph-node'))return;pan={x:e.clientX,y:e.clientY,tx:graphTransform.x,ty:graphTransform.y};$('#graph').setPointerCapture(e.pointerId);});
$('#graph').addEventListener('pointermove',e=>{if(!pan)return;graphTransform.x=pan.tx+e.clientX-pan.x;graphTransform.y=pan.ty+e.clientY-pan.y;transformGraph();});
$('#graph').addEventListener('pointerup',()=>pan=null);$('#graph').addEventListener('pointercancel',()=>pan=null);
$('#graph').addEventListener('wheel',e=>{e.preventDefault();const rect=$('#graph').getBoundingClientRect();zoom(e.deltaY>0?.9:1.1,e.clientX-rect.left,e.clientY-rect.top);},{passive:false});
$('#zoomIn').onclick=()=>zoom(1.2);$('#zoomOut').onclick=()=>zoom(1/1.2);$('#resetGraph').onclick=()=>{graphTransform={x:0,y:0,k:1};transformGraph();};

function excerptHTML(m){return esc(m.excerpt.slice(0,m.excerptStart))+'<mark>'+esc(m.excerpt.slice(m.excerptStart,m.excerptEnd))+'</mark>'+esc(m.excerpt.slice(m.excerptEnd));}
function sourceLink(m){return m.url || (m.source!=='paste'&&/^[a-zA-Z0-9-]+$/.test(m.conversationId)?`https://chatgpt.com/c/${encodeURIComponent(m.conversationId)}`:null);}
function mentionHTML(m){const link=sourceLink(m);return `<article class="mention" data-mention="${esc(m.id)}"><div class="mention-meta"><span class="badge ${m.role==='user'?'':'gray'}">${m.source==='paste'?'수동 입력':m.role==='user'?'내 메시지':'AI 메시지'}</span><span>${date(m.date)}</span><span>${esc(m.method)}</span></div><h4>${esc(m.conversationTitle)}</h4><div class="mention-source"><span class="source-tag ${esc(m.category)}">${esc(categoryLabels[m.category]||'미분류')}${m.classificationSource==='manual'?' · 수동':''}</span>${m.projectId?`<a href="${esc(m.projectUrl)}" target="_blank" rel="noopener noreferrer">${esc(m.projectName)} ↗</a>`:'<span>프로젝트 정보 없음</span>'}</div><div class="excerpt">${excerptHTML(m)}</div><label class="conversation-classifier">이 대화 분류<select data-classify-conversation="${esc(m.conversationId)}" aria-label="이 대화의 분류 수정"><option value="inherit" ${!m.manualCategory?'selected':''}>${m.projectId?'프로젝트 기준':'기본값'} (${esc(categoryLabels[m.inheritedCategory]||'미분류')})</option>${Object.entries(categoryLabels).map(([key,name])=>`<option value="${key}" ${m.manualCategory===key?'selected':''}>${name}</option>`).join('')}</select><span>이 대화의 모든 언급에 적용</span></label><div class="mention-actions">${link?`<a class="text-button" href="${esc(link)}" target="_blank" rel="noopener noreferrer">ChatGPT 원문 ↗</a>`:''}<button class="text-button" data-copy="${esc(m.id)}">검색 구절 복사</button><button class="text-button" data-context="${esc(m.id)}">앞뒤 맥락 보기</button></div><div class="context-slot"></div></article>`;}
async function openPaper(id){
  lastFocus=document.activeElement;state.selected=id;state.offset=0;state.role='';state.mentions=[];
  const version=++detailVersion;$('#drawer').hidden=false;$('#drawerBackdrop').hidden=false;document.body.style.overflow='hidden';$('#paperDetail').innerHTML='<p class="empty">대화의 흔적을 불러오는 중…</p>';$('#closeDrawer').focus();
  try{const data=await api(scopedUrl('/api/paper',{id}));if(version!==detailVersion)return;state.selected=data.paper.id;state.mentions=data.mentions;renderDetail(data);if(state.range.from||state.range.to){const note=document.createElement('p');note.className='drawer-help';note.textContent='선택한 기간의 언급만 집계합니다. 앞뒤 맥락에는 기간 밖 메시지가 포함될 수 있습니다.';$('#mentions').before(note);}$('#drawer').scrollTop=0;}catch(e){if(version===detailVersion)$('#paperDetail').innerHTML=`<p class="empty">${esc(e.message)}</p>`;}
}
function renderDetail({paper:p,total,mentions}){
  $('#paperDetail').innerHTML=`<span class="badge ${p.identifiers.length?'':'amber'}">${p.identifiers.length?'식별자 감지 · 메타데이터 미검증':'제목·약칭 후보 · 미검증'}</span><h2>${esc(p.title)}</h2><p class="aliases">${p.aliases.filter(a=>a!==p.title).map(esc).join(' · ')}</p><div class="drawer-stats"><div><strong>${num(p.count)}</strong><span>전체 언급</span></div><div><strong>${num(p.conversationCount)}</strong><span>서로 다른 대화</span></div><div><strong>${num(p.userCount)}</strong><span>내 언급 (AI ${num(p.assistantCount)})</span></div></div><div class="paper-links">${paperLinkButtons(p)}${p.itemKey?`<a class="button" href="zotero://select/library/items/${esc(p.itemKey)}">Zotero 항목 ↗</a>`:''}${p.pdfKey?`<a class="button primary" href="zotero://open-pdf/library/items/${esc(p.pdfKey)}">Zotero PDF 열기 ↗</a>`:''}</div><div class="review-box"><label>후보 검토<select id="reviewStatus"><option value="unreviewed">검토 전</option><option value="confirmed">논문임을 직접 확인</option><option value="dismissed">논문 후보에서 제외</option></select></label><p>자동 추출 결과는 실제 논문·데이터셋·모델명이 섞일 수 있습니다. 원문 근거를 보고 판단해주세요.</p><details class="zotero"><summary>Zotero 수동 연결</summary><p>개인 라이브러리 항목 Key와 PDF 첨부 Key를 각각 입력하세요. PDF·Figure 라이브러리의 자동 연결과 별개로 직접 입력한 Key를 보관합니다.</p><div class="zotero-inputs"><input id="itemKey" placeholder="항목 Key (선택)" aria-label="Zotero 항목 Key" maxlength="8" value="${esc(p.itemKey||'')}"><input id="pdfKey" placeholder="PDF Key (선택)" aria-label="Zotero PDF Key" maxlength="8" value="${esc(p.pdfKey||'')}"><button class="button" id="saveZotero">저장</button></div></details></div><div class="context-heading"><h3>언급된 대화 <span class="muted" id="mentionTotal">${num(total)}</span></h3><select id="roleFilter" aria-label="메시지 작성자"><option value="">전체 작성자</option><option value="user">내 메시지만</option><option value="assistant">AI 메시지만</option></select></div><p class="drawer-help">텍스트 발췌만 표시합니다. 원문 링크는 대화 단위로 열리며, 구절을 복사해 원문에서 검색할 수 있습니다.</p><div id="mentions">${mentions.map(mentionHTML).join('')}</div><button class="button load-more" id="moreMentions" ${mentions.length>=total?'hidden':''}>언급 더 보기</button>`;
  $('#reviewStatus').value=p.status;$('#roleFilter').value=state.role;
  const identity=document.createElement('section');identity.className='paper-identity';
  identity.innerHTML=p.metadata?`<span class="badge">공식 서지정보 · ${esc(p.metadata.provider)}</span><p>${esc(p.metadata.authors.slice(0,6).join(', '))}${p.metadata.authors.length>6?' 외':''} ${p.metadata.year?'· '+esc(p.metadata.year):''}</p><p>${esc(p.metadata.venue||'')} <a href="${esc(p.metadata.sourceUrl)}" target="_blank" rel="noopener noreferrer">메타데이터 근거 ↗</a></p>`:`<span class="badge amber">공식 서지정보 미연결${p.resolution?.status==='needs-review'?' · 검토 필요':''}</span>`;
  identity.innerHTML+=`<details><summary>대화에서 발견한 표기 ${(p.observedTitles||[]).length}개</summary><ul>${(p.observedTitles||[]).map(t=>`<li>${esc(t.text)}</li>`).join('')}</ul></details>`;
  if(p.metadata?.sources?.length)identity.innerHTML+=`<details><summary>서지정보·링크 출처</summary><ul>${p.metadata.sources.map(s=>`<li>${esc(s.provider)} · <a href="${esc(s.sourceUrl)}" target="_blank" rel="noopener noreferrer">조회 근거 ↗</a> · ${esc(s.fetchedAt?.slice(0,10)||'')}</li>`).join('')}</ul></details>`;
  if(p.resolution?.status==='needs-review')identity.innerHTML+=`<p>${esc(bibliographyReason(p.resolution.reason))}</p>`;
  if(p.sourceCandidateIds?.length>1)identity.innerHTML+=`<p>원본 후보 ${p.sourceCandidateIds.length}개 연결 · 언급 위치를 기준으로 중복 집계 제거</p><button class="button" data-unmerge="${esc(p.id)}">이 병합 해제</button>`;
  if(p.resolution?.reason==='kept-separate')identity.innerHTML+=`<p>사용자가 이 후보를 따로 유지하도록 지정했습니다.</p><button class="button" data-bib-reset="${esc(p.sourceCandidateIds[0])}">서지 자동 연결 다시 허용</button>`;
  if(p.reviewConflict)identity.innerHTML+='<p>기존 후보들의 검토 상태가 다릅니다. 원래 검토 기록은 보존했습니다.</p>';
  $('#paperDetail h2').after(identity);
  if(p.metadata)$('#paperDetail > .badge').textContent='공식 서지정보 연결됨';
  if(!hasPaperLink(p)){const note=document.createElement('p');note.className='link-status-note';note.textContent='등록된 논문 원문 링크가 없습니다. 링크가 없어도 실제 논문일 수 있으며, 후보 검토 상태와는 별개입니다.';$('.paper-links').after(note);}
  const breakdown=document.createElement('div');breakdown.className='source-breakdown';breakdown.innerHTML=`<span>이 논문의 언급 출처</span><div>${categoryBadges(p.categoryCounts)}</div><small>선택한 필터 범위에서 집계 · 같은 논문도 여러 출처에 등장할 수 있습니다.</small>`;$('.drawer-stats').after(breakdown);
  window.researchscapeMedia?.render(p);
  window.researchscapeAnnotations?.render(p);
  $('#reviewStatus').onchange=()=>saveReview();$('#saveZotero').onclick=()=>saveReview();$('#roleFilter').onchange=()=>{state.role=$('#roleFilter').value;state.offset=0;fetchMentions(false);};$('#moreMentions').onclick=()=>fetchMentions(true);
}
async function saveReview(){
  try{await post('/api/review',{id:state.selected,status:$('#reviewStatus').value,itemKey:$('#itemKey').value.trim().toUpperCase(),pdfKey:$('#pdfKey').value.trim().toUpperCase()});toast('검토 결과를 로컬에 저장했습니다.');const id=state.selected;await load();if(state.selected===id)await openPaper(id);}catch(e){toast(e.message);}
}
async function fetchMentions(more){
  const id=state.selected,role=state.role,version=detailVersion;
  const offset=more?state.mentions.length:0;const button=$('#moreMentions');button.disabled=true;
  try{const data=await api(scopedUrl('/api/paper',{id,role,offset}));if(version!==detailVersion||role!==state.role)return;
    state.mentions=more?[...state.mentions,...data.mentions]:data.mentions;$('#mentions').innerHTML=state.mentions.map(mentionHTML).join('')||'<div class="empty">이 작성자의 언급이 없습니다.</div>';$('#mentionTotal').textContent=num(data.total);button.hidden=state.mentions.length>=data.total;
  }catch(e){toast(e.message);}finally{button.disabled=false;}
}
function closeDrawer(){++detailVersion;$('#drawer').hidden=true;$('#drawerBackdrop').hidden=true;document.body.style.overflow='';state.selected=null;lastFocus?.focus();}
$('#closeDrawer').onclick=closeDrawer;$('#drawerBackdrop').onclick=closeDrawer;
document.addEventListener('click',async e=>{
  const paper=e.target.closest('[data-paper]');if(paper){openPaper(paper.dataset.paper);return;}
  const copy=e.target.closest('[data-copy]');if(copy){const m=state.mentions.find(m=>m.id===copy.dataset.copy);if(!m)return;try{await navigator.clipboard.writeText(m.excerpt.slice(Math.max(0,m.excerptStart-30),Math.min(m.excerpt.length,m.excerptEnd+100)));toast('검색 구절을 복사했습니다. 원문에서 Ctrl+F로 찾아보세요.');}catch{toast('클립보드 접근이 안 됩니다. 발췌문을 직접 선택해 복사해주세요.');}return;}
  const btn=e.target.closest('[data-context]');if(btn){const m=state.mentions.find(m=>m.id===btn.dataset.context),slot=btn.closest('.mention').querySelector('.context-slot');if(!m)return;if(slot.innerHTML){slot.innerHTML='';btn.textContent='앞뒤 맥락 보기';return;}btn.disabled=true;
    try{const data=await api(`/api/context?cid=${encodeURIComponent(m.conversationId)}&mid=${encodeURIComponent(m.messageId)}`);slot.innerHTML='<div class="context-messages">'+data.messages.map(msg=>`<div class="context-message ${msg.target?'target':''}"><strong>${msg.role==='user'?'나':'ChatGPT'}${msg.target?' · 언급된 메시지':''}</strong><pre>${msg.target?esc(msg.text.slice(0,m.start))+'<mark>'+esc(msg.text.slice(m.start,m.end))+'</mark>'+esc(msg.text.slice(m.end)):esc(msg.text)}</pre>${msg.truncated?'<small class="muted">긴 메시지는 24,000자까지만 표시합니다. 전체 내용은 원문에서 확인하세요.</small>':''}</div>`).join('')+'</div>';if(!data.messages.length)slot.textContent='해당 메시지를 찾지 못했습니다.';btn.textContent='앞뒤 맥락 접기';}catch(err){toast(err.message);}finally{btn.disabled=false;}
  }
});
document.addEventListener('change',async e=>{
  const select=e.target.closest('[data-classify-conversation]');if(!select)return;
  select.disabled=true;const id=state.selected;
  try{
    await post('/api/conversation-label',{conversationId:select.dataset.classifyConversation,category:select.value});
    await load();
    if(state.selected===id){if(state.papers.some(p=>p.id===id))await openPaper(id);else closeDrawer();}
    toast('대화 분류를 저장했습니다. 원본 프로젝트 소속은 유지됩니다.');
  }catch(err){toast(err.message);select.disabled=false;}
});
function setView(view){state.view=view;$('#graphArea').hidden=view!=='graph';$('#listArea').hidden=view!=='list';$('#graphTab').classList.toggle('active',view==='graph');$('#listTab').classList.toggle('active',view==='list');$('#graphTab').setAttribute('aria-selected',view==='graph');$('#listTab').setAttribute('aria-selected',view==='list');$('#limit').hidden=view!=='graph';if(view==='graph')filter();}
$('#graphTab').onclick=()=>setView('graph');$('#listTab').onclick=()=>setView('list');
let searchTimer;$('#search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(filter,180);};['statusFilter','linkFilter','sort','limit'].forEach(id=>$('#'+id).onchange=filter);
async function applyDates(){
  const from=$('#dateFrom').value,to=$('#dateTo').value;
  const error=$('#dateError');
  if(!$('#dateFrom').validity.valid||!$('#dateTo').validity.valid||(from&&to&&from>to)){
    error.textContent='시작일은 종료일보다 늦을 수 없습니다. 유효한 날짜를 선택해주세요.';error.hidden=false;return;
  }
  error.hidden=true;if(!$('#drawer').hidden)closeDrawer();
  $('#dateScope').textContent='선택한 기간을 집계하는 중…';
  try{await load({...state.range,from,to,category:$('#categoryFilter').value,project:$('#projectFilter').value});}catch(e){error.textContent=e.message;error.hidden=false;$('#dateScope').textContent='필터를 적용하지 못했습니다.';}
}
$('#dateFrom').onchange=applyDates;$('#dateTo').onchange=applyDates;
$('#clearDates').onclick=()=>{$('#dateFrom').value='';$('#dateTo').value='';applyDates();};
$('#categoryFilter').onchange=applyDates;$('#projectFilter').onchange=applyDates;
$('#clearSources').onclick=()=>{$('#categoryFilter').value='all';$('#projectFilter').value='';applyDates();};
function openImport(){$('#importDialog').showModal();}
$('#addSource').onclick=openImport;$('#navImport').onclick=openImport;$('#closeImport').onclick=()=>$('#importDialog').close();
$('#navGraph').onclick=()=>{$('#navReview').classList.remove('active');$('#navGraph').classList.add('active');$('#statusFilter').value='visible';setView('graph');};
$('#navReview').onclick=()=>{$('#navGraph').classList.remove('active');$('#navReview').classList.add('active');$('#statusFilter').value='unreviewed';setView('list');filter();};
$('#importForm').onsubmit=async e=>{e.preventDefault();const b=$('#importSubmit');b.disabled=true;b.textContent='대화에서 논문 후보를 찾는 중…';try{const data=await post('/api/import',Object.fromEntries(new FormData(e.target)));await load();$('#importDialog').close();e.target.reset();toast(data.duplicate?'이미 추가한 대화입니다.':'대화를 추가하고 지도를 업데이트했습니다.');}catch(err){toast(err.message);}finally{b.disabled=false;b.textContent='대화 추가하고 지도 업데이트 ↗';}};
$('#reindex').onclick=async()=>{const b=$('#reindex');b.disabled=true;toast('data 폴더를 다시 읽고 있습니다. 잠시 기다려주세요.');try{await post('/api/reindex');await load();toast('Export를 다시 읽었습니다. 동일 출처는 중복 집계하지 않습니다.');}catch(e){toast(e.message);}finally{b.disabled=false;}};
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#drawer').hidden)closeDrawer();if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&$('#drawer').hidden&&!$('#importDialog').open){e.preventDefault();$('#search').focus();}});
// Keyboard focus stays inside the open details panel.
$('#drawer').addEventListener('keydown',e=>{if(e.key!=='Tab')return;const a=[...$('#drawer').querySelectorAll('button,a,input,select,summary,[tabindex="0"]')].filter(x=>!x.disabled&&x.getClientRects().length);const first=a[0],last=a.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
let resizeTimer;new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.papers.length&&state.view==='graph')filter();},200);}).observe($('#graphArea'));
const initialRange=new URLSearchParams(location.search);
for(const [value,text] of [['bib:verified','공식 서지정보 연결됨'],['bib:needs-review','서지 연결 검토 필요'],['bib:unresolved','공식 서지정보 미연결']]){const option=document.createElement('option');option.value=value;option.textContent=text;$('#statusFilter').append(option);}
$('#linkFilter').value=['missing','present'].includes(initialRange.get('links'))?initialRange.get('links'):'all';
state.range.category=Object.hasOwn(sourceFilterLabels,initialRange.get('category'))?initialRange.get('category'):'all';
state.range.project=initialRange.get('project')||'';
for(const [key,id] of [['from','dateFrom'],['to','dateTo']]){const value=initialRange.get(key)||'';$('#'+id).value=value;state.range[key]=$('#'+id).value;}
if(state.range.from&&state.range.to&&state.range.from>state.range.to){state.range={...state.range,from:'',to:''};$('#dateError').textContent='날짜 순서가 잘못되어 전체 기간을 표시합니다.';$('#dateError').hidden=false;}
load().catch(e=>{toast('데이터를 불러오지 못했습니다: '+e.message);$('#graphCount').textContent='서버 연결을 확인해주세요.';});

let bibTimer=null,bibWasRunning=false;
async function refreshBibDialog(){
  clearTimeout(bibTimer);
  try{
    const data=await api('/api/bibliography'),job=data.job||{};
    window.ResearchscapeBibliographyReview?.refresh(data);
    $('#bibSync').disabled=!!job.running;$('#bibStop').hidden=!job.running;
    $('#bibStatus').innerHTML=job.running?`<strong>조회 중 ${num(job.completed)} / ${num(job.total)}</strong><span>${esc(job.current||'준비 중')}</span>`:`<strong>${['error','interrupted'].includes(job.stage)?'조회 중단':job.finishedAt?'최근 조회 완료':'조회 대기'}</strong><span>${num(data.recordCount)}개 서지 레코드 · 조회 오류 ${num(data.lookupErrors)}건${job.error?' · '+esc(job.error):''}</span>`;
    $('#bibStats').innerHTML=`<span><strong>${num(data.stats.metadataVerified)}</strong> 공식정보 연결</span><span><strong>${num(data.stats.mergedCandidates)}</strong> 후보 병합</span><span><strong>${num(data.stats.recoveredCitationPapers)}</strong> 인용 메타데이터 복원</span><span><strong>${num(data.stats.needsMetadataReview)}</strong> 연결 검토</span>`;
    const d=data.diagnostics||{},summary=d.summary||{},lookup=d.lookupSummary||{};
    $('#bibDiagnostics').innerHTML=`<details><summary>미연결 원인 진단</summary><p>미조회 ${num(summary['not-searched'])} · 조회 실패 ${num(summary['lookup-failed'])} · 검색 결과 없음 ${num(summary['search-miss'])} · 결과는 있으나 매칭 실패 ${num(summary['matching-failed'])} · 충돌 ${num(summary.conflict)} · 근거 부족 ${num(summary['insufficient-evidence'])}</p><p>전체 조회 로그: 429 제한 ${num(lookup['rate-limited'])} · 접근 거부 ${num(lookup['access-denied'])} · 제공자 대기 ${num(lookup['provider-cooldown'])} · HTTP 오류 ${num(lookup['http-error'])} · 네트워크/응답 오류 ${num((lookup['transport-error']||0)+(lookup['invalid-response']||0)+(lookup['transport-or-parse-error']||0))}</p><p>검색 결과 없음은 논문 미존재 판정이 아닙니다. 구형 로그의 상세 원인을 복원할 수 없는 경우 별도로 집계합니다.</p></details>`;
    $('#bibQueue').innerHTML='<h3>확인이 필요한 연결 후보</h3>'+(data.queue.length?data.queue.slice(0,60).map(q=>`<article class="bib-review"><h4>${esc(q.title)}</h4><p>${num(q.count)}회 언급 · ${esc(bibliographyReason(q.reason))}</p>${q.suggestions.map(s=>`<div class="bib-suggestion"><strong>${esc(s.record.title)}</strong><small>${esc(s.record.authors.slice(0,4).join(', '))} · ${esc(s.record.year||'연도 미상')} · ${esc(s.record.provider)} · 제목 유사도 ${s.score.toFixed(2)}</small><a href="${esc(s.record.url)}" target="_blank" rel="noopener noreferrer">논문 근거 ↗</a><button class="button" data-bib-match="${esc(q.id)}" data-record="${esc(s.recordId)}">이 논문으로 연결</button></div>`).join('')}<button class="text-button" data-bib-separate="${esc(q.id)}">연결하지 않고 따로 유지</button></article>`).join(''):'<p class="drawer-help">현재 연결 검토 후보가 없습니다. 서지정보를 조회하면 확실한 항목은 자동 연결하고, 애매한 연결만 이곳에 표시합니다. 정보가 부족한 미연결 항목은 LLM 검토용 JSON에 포함됩니다.</p>');
    if(data.queue.length>60)$('#bibQueue').insertAdjacentHTML('beforeend',`<p class="drawer-help">상위 60개를 표시했습니다. 전체 ${num(data.queue.length)}개는 검토 JSON으로 받을 수 있습니다.</p>`);
    if(bibWasRunning&&!job.running){if(!$('#drawer').hidden)closeDrawer();await load();toast(job.stage==='complete'?'서지정보 조회와 확실한 중복 정리를 마쳤습니다.':'서지 조회가 중단되었습니다. 저장된 결과에서 다시 시작할 수 있습니다.');}
    bibWasRunning=!!job.running;
    if(job.running&&$('#bibliographyDialog').open)bibTimer=setTimeout(refreshBibDialog,1800);
  }catch(e){$('#bibStatus').textContent=e.message;}
}
$('#bibliographyOpen').onclick=()=>{$('#bibliographyDialog').showModal();refreshBibDialog();};
$('#closeBibliography').onclick=()=>$('#bibliographyDialog').close();
$('#bibliographyDialog').addEventListener('close',()=>clearTimeout(bibTimer));
$('#bibSync').onclick=async()=>{try{await post('/api/bibliography/sync',{limit:Number($('#bibLimit').value)});bibWasRunning=true;refreshBibDialog();}catch(e){toast(e.message);}};
$('#bibStop').onclick=async()=>{try{await post('/api/bibliography/stop');await refreshBibDialog();}catch(e){toast(e.message);}};
document.addEventListener('click',async e=>{
  const match=e.target.closest('[data-bib-match]'),separate=e.target.closest('[data-bib-separate]'),unmerge=e.target.closest('[data-unmerge]'),reset=e.target.closest('[data-bib-reset]');
  if(!match&&!separate&&!unmerge&&!reset)return;
  const button=match||separate||unmerge||reset;button.disabled=true;
  const data=reset?{candidateId:reset.dataset.bibReset,action:'reset'}:match?{candidateId:match.dataset.bibMatch,recordId:match.dataset.record,action:'match'}:separate?{candidateId:separate.dataset.bibSeparate,action:'separate'}:{paperId:unmerge.dataset.unmerge,action:'separate'};
  try{await post('/api/bibliography/decision',data);if(!$('#drawer').hidden)closeDrawer();await load();if($('#bibliographyDialog').open)await refreshBibDialog();toast('서지 연결 결정을 저장했습니다. 원본 표기와 근거는 보존됩니다.');}catch(err){toast(err.message);button.disabled=false;}
});
