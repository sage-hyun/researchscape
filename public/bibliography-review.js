/* One review workspace for provider candidates and LLM suggestions. No LLM calls. */
(()=>{
  const route='/api/bibliography/review/import',workspace='/api/bibliography/review/queue',PAGE=50,MAX_UPLOAD=16*1024*1024;
  const statuses={pending:'검토할 항목',completed:'처리 완료',error:'오류',all:'전체'};
  const statusHelp={pending:'아직 연결·후보 제외·별도 유지 결정을 저장하지 않은 항목입니다.',completed:'이미 처리했거나 기존 결정을 유지하는 항목입니다. 처리 내용은 각 항목에서 확인하세요.',error:'JSON 형식이나 후보·레코드 ID에 문제가 있는 항목입니다. 근거를 확인해 수정한 결과를 다시 가져와주세요.',all:'검토할 항목, 처리 완료, 오류를 함께 보여줍니다.'};
  let totals={withCandidates:0,withoutCandidates:0},job=null,queue=null,offset=0,selected=new Map(),choices=new Map(),working=false,restore=true,timer=null,searchTimer=null,version=0,confirmed=false,notice='',failure='';
  const selection=s=>({...s,action:s.action||'',recordId:s.recordId||null});
  const filters=()=>({status:$('#bibQueueStatus').value,evidence:$('#bibQueueEvidence').value,search:$('#bibQueueSearch').value});
  function bundleLink(){const size=Number($('#bibBatchSize').value),total=totals.withCandidates+totals.withoutCandidates;$('#bibBundleDownload').href=appUrl('/api/bibliography/export?'+new URLSearchParams({format:'bundle',batchSize:size}));$('#bibBundleInfo').textContent=`미연결 후보 ${num(total)}건 · 파일 1개 · LLM용 ${size}건 배치 ${num(Math.ceil(total/size))}개 포함`;}
  function exportLink(){const group=$('#bibExportGroup').value,limit=Number($('#bibExportSize').value),total=totals[group==='with-candidates'?'withCandidates':'withoutCandidates'],pages=Math.max(1,Math.ceil(total/limit)),page=Math.max(1,Math.min(pages,Number($('#bibExportPage').value)||1));$('#bibExportPage').max=pages;$('#bibExportPage').value=page;$('#bibCompactDownload').href=appUrl('/api/bibliography/export?'+new URLSearchParams({format:'compact',group,limit,offset:(page-1)*limit}));$('#bibExportInfo').textContent=`${num(total)}건 · ${page} / ${pages}묶음`;}
  function refresh(data){
    totals=data.reviewTotals||totals;bundleLink();exportLink();const d=data.diagnostics||{};
    $('#bibAliasDiagnostics').innerHTML='<summary>Curated alias 적용 진단</summary>'+(d.curatedAliases||[]).map(a=>`<p><strong>${esc(a.alias)}</strong> · ${esc(a.lookupStatus)} → ${esc(a.identityStatus)} → ${esc(a.applicationStatus)}<br><small>${a.appliedCandidateIds.length} / ${a.candidateIds.length}개 적용 · ${esc(a.reasons.join(', '))}</small></p>`).join('');
    const versions=d.workVersions||[];
    $('#bibWorkVersions').innerHTML=`<summary>Work·Version 관계 제안 ${num(versions.length)}건 · 자동 병합 안 함</summary><p>같은 제목·저자의 arXiv와 출판본 관계를 확인하세요. 저자 정보가 없으면 근거 부족으로 표시합니다. 식별자는 분리된 채 유지됩니다.</p>`+versions.slice(0,60).map(v=>`<article class="bib-review"><strong>${esc(v.title)}</strong><p>${v.reason==='possible-work-versions'?'제목·저자 일치 · 동일 Work의 다른 Version인지 확인':'제목 일치 · 저자 정보 부족으로 수동 확인 필요'}</p>${v.versions.map(r=>`<p>${esc(r.recordId)} · ${esc(r.year||'연도 미상')}<br><small>${esc(r.authors.join(', ')||'저자 정보 없음')}</small></p>`).join('')}</article>`).join('');
    if(restore&&!job&&!working&&data.reviewImport){restore=false;job={id:data.reviewImport.id};}
    if(!working)reload();
  }
  function query(extra={}){return workspace+'?'+new URLSearchParams({...filters(),...(job?{importId:job.id}:{}),offset,limit:PAGE,...extra});}
  async function reload(){
    clearTimeout(timer);const current=++version;
    try{
      if(job){const data=await api(route+'?'+new URLSearchParams({id:job.id,limit:1}));if(current!==version)return;job=data;}
      const data=await api(query());if(current!==version)return;
      if(offset&&offset>=data.total){offset=data.total?Math.floor((data.total-1)/PAGE)*PAGE:0;return reload();}
      queue=data;render();
      if(queue.running)timer=setTimeout(reload,1200);
    }catch(e){if(current!==version)return;if(e.code==='IMPORT_NOT_FOUND'){job=null;selected.clear();reload();return;}failure=e.message;render();}
  }
  async function upload(text,fileName){
    if(working)return;working=true;failure='';notice='';render();
    try{const result=await api(route+'?'+new URLSearchParams({filename:fileName}),{method:'POST',body:text});job=result.job;selected.clear();choices.clear();$('#bibBulkAction').value='row';confirmed=false;restore=false;offset=0;notice=result.duplicate?'이미 가져온 JSON의 검토 상태를 열었습니다.':'';}
    catch(e){failure=e.message;}
    finally{working=false;}
    if(job)await reload();else render();$(failure?'#bibImportStatus':'#bibPreviewTitle').scrollIntoView({block:'nearest'});
  }
  async function readFiles(files){
    if(!files.length)return;if(files.reduce((n,f)=>n+f.size,0)>MAX_UPLOAD){failure='검토 JSON은 합쳐서 16MB 이하로 가져와주세요.';render();return;}
    const texts=await Promise.all(files.map(f=>f.text())),documents=[];
    for(const [i,text]of texts.entries()){try{documents.push(JSON.parse(text));}catch{failure=`${files[i].name}: 올바른 JSON이 아닙니다.`;render();return;}}
    await upload(files.length===1?texts[0]:JSON.stringify(documents.flat()),files.length===1?files[0].name:`${files[0].name} 외 ${files.length-1}개`);
  }
  async function control(action){
    if(!job||working)return;working=true;failure='';render();
    try{await post(route+'/'+action,{importId:job.id});if(action==='discard'){job=null;selected.clear();choices.clear();confirmed=false;notice='가져온 미리보기는 닫았습니다. 기존 연결 후보와 적용한 결정은 유지됩니다.';}if(action==='resume')selected.clear();}
    catch(e){failure=e.message;}finally{working=false;}
    await reload();
  }
  function statusHTML(){
    if(!job)return failure?`<strong>확인 필요</strong><span>${esc(failure)}</span>`:'';
    const c=job.counts||{},button=(action,text)=>`<button class="text-button" data-review-action="${action}" ${working?'disabled':''}>${text}</button>`;
    const title=job.running?`검증 중 ${num(job.processed)} / ${num(job.total)}건`:`가져온 JSON ${num(job.total)}건 · 적용 ${num(c.applied)}건`;
    return `<strong>${esc(title)}</strong><span>${esc(job.fileName||'결과 JSON')}${job.progress?.current?' · '+esc(job.progress.current):''}</span><div class="bib-import-actions">${job.running?button('stop','검증 중단'):(job.resumable?button('resume','실패 항목 다시 검증'):'')+button('discard','가져온 미리보기 닫기')}</div>${failure?`<span class="bib-import-error">${esc(failure)}</span>`:''}`;
  }
  function rowChoice(r){return choices.get(r.candidateId)||selection({candidateId:r.candidateId,token:r.token,action:r.defaultAction,recordId:r.recordId});}
  const choiceValue=s=>s.action==='match'?'match|'+s.recordId:s.action;
  function rowHTML(r){
    const s=rowChoice(r),value=choiceValue(s),option=(v,text)=>`<option value="${esc(v)}" ${v===value?'selected':''}>${esc(text)}</option>`;
    const options=option('','동작을 선택하세요')+r.candidates.map(c=>option('match|'+c.recordId,'연결 · '+c.title)).join('')+(r.allowedActions?.includes('dismiss')?option('dismiss','논문 후보에서 제외'):'')+option('separate','서지 연결 없이 별도 유지');
    const record=r.candidates.find(c=>c.recordId===s.recordId),recordHTML=record?`<p class="bib-official">${esc(record.title)}<br><small>${esc(record.authors.slice(0,5).join(', ')||'저자 정보 없음')} · ${esc(record.year||'연도 미상')} · ${esc(record.recordId)}${record.url?` · <a href="${esc(record.url)}" target="_blank" rel="noopener noreferrer">원문 ↗</a>`:''}</small></p>`:'';
    const reason=r.manualConfirmation?'공식 논문의 존재는 확인됐습니다. 이 약칭이 해당 논문을 뜻하는지 확인하고 승인하세요.':r.reason;
    return `<article class="bib-review bib-row" data-status="${esc(r.status)}" data-status-group="${esc(r.statusGroup)}"><div class="bib-workspace-row-heading"><label><input type="checkbox" data-review-approve="${esc(r.candidateId)}" ${selected.has(r.candidateId)?'checked':''} ${!r.selectable||working||queue.running?'disabled':''}><strong>${esc(r.title)}</strong></label><span class="bib-row-status">${esc(statuses[r.statusGroup]||'오류')}</span></div><p class="bib-candidate-meta">${num(r.count)}회 언급 · ${esc(r.candidateId)}${r.duplicates?` · 중복 결과 ${num(r.duplicates)}건 통합`:''}</p>${r.selectable?`<select data-review-choice="${esc(r.candidateId)}" aria-label="${esc(r.title)} 검토 동작" ${working||queue.running?'disabled':''}>${options}</select>`:`<p>${r.appliedAction==='dismiss'?'논문 후보에서 제외됨':r.appliedAction==='separate'?'서지 연결 없이 별도 유지':r.appliedAction==='match'?'공식 논문에 연결됨':esc(reason)}</p>`}${recordHTML}${r.selectable?`<p class="bib-row-reason">${esc(reason)}</p>`:''}${r.evidence.length||r.verification?`<details><summary>검토 근거${r.verification?' · '+esc(r.verification.status):''}</summary>${r.evidence.map(e=>`<p><strong>${esc(e.type)}</strong> · ${esc(e.detail)}</p>`).join('')}${r.verification?`<p>${esc(r.verification.detail)}</p>`:''}</details>`:''}</article>`;
  }
  function render(){
    $('#bibReviewPick').disabled=working||!!job?.running;$('#bibReviewPaste').disabled=working||!!job?.running;
    $('#bibImportStatus').hidden=!job&&!failure&&!working;$('#bibImportStatus').innerHTML=working?'<strong>처리 중…</strong>':statusHTML();
    if(!queue){$('#bibReviewPreview').innerHTML='<p>검토 목록을 불러오고 있습니다.</p>';applyButton();return;}
    const groups=queue.groups;
    $('#bibQueueHelp').textContent=statusHelp[$('#bibQueueStatus').value];
    $('#bibQueueSummary').textContent=`검토할 항목 ${num(groups.pending)} · 처리 완료 ${num(groups.completed)} · 오류 ${num(groups.error)} · 현재 필터 ${num(queue.total)}건`;
    let notes=notice?`<p class="bib-notice">${esc(notice)}</p>`:'';
    if(queue.requiresConfirmation)notes+=`<p class="bib-notice warn">현재 서버에 내보낸 기록이 없는 snapshot입니다.<label><input type="checkbox" data-review-confirm ${confirmed?'checked':''}> 다른 snapshot의 결과임을 확인했고 현재 후보를 직접 검토했습니다.</label></p>`;
    $('#bibReviewNotices').innerHTML=notes;
    $('#bibReviewPreview').innerHTML=queue.rows.map(rowHTML).join('')||'<p class="drawer-help">이 조건의 검토 항목이 없습니다.</p>';
    $('#bibQueuePage').textContent=`${queue.total?offset+1:0}–${Math.min(offset+PAGE,queue.total)} / ${num(queue.total)}건`;
    $('#bibQueuePrev').disabled=offset===0;$('#bibQueueNext').disabled=offset+PAGE>=queue.total;
    $('#bibSelectFiltered').disabled=working||queue.running;applyButton();
  }
  function effective(s){const mode=$('#bibBulkAction').value;return mode==='row'?s:{...s,action:mode,recordId:mode==='match'?s.recordId:null};}
  function applyButton(){
    const counts={match:0,dismiss:0,separate:0},list=[...selected.values()].map(effective),invalid=list.some(s=>!['match','dismiss','separate'].includes(s.action)||s.action==='match'&&!s.recordId);
    for(const s of list)if(s.action in counts)counts[s.action]++;
    $('#bibSelectedCount').textContent=`${num(list.length)}건 선택 · 연결 ${num(counts.match)} · 후보 제외 ${num(counts.dismiss)} · 별도 유지 ${num(counts.separate)}${invalid?' · 동작을 선택하지 않은 항목이 있습니다.':''}`;
    const button=$('#bibReviewApply');button.disabled=working||!!queue?.running||!list.length||invalid||(queue?.requiresConfirmation&&!confirmed);button.textContent=`선택한 ${num(list.length)}건 최종 승인·적용`;
    $('#bibSelectFiltered').textContent=`현재 필터 ${num(queue?.total)}건 전체 선택`;
  }
  for(const id of ['bibExportGroup','bibExportSize','bibExportPage'])$('#'+id).onchange=exportLink;
  $('#bibBatchSize').onchange=bundleLink;$('#bibExportPage').oninput=exportLink;
  $('#bibReviewPick').onclick=()=>$('#bibReviewFile').click();$('#bibReviewFile').onchange=async e=>{const files=[...e.target.files];e.target.value='';await readFiles(files);};
  $('#bibReviewPaste').onclick=()=>{const text=$('#bibReviewInput').value.trim();if(text)upload(text,'붙여넣은 JSON');};
  $('#bibImportStatus').onclick=e=>{const b=e.target.closest('[data-review-action]');if(b)control(b.dataset.reviewAction);};
  const resetFilter=()=>{selected.clear();$('#bibBulkAction').value='row';offset=0;failure='';version++;};
  const changedFilter=()=>{clearTimeout(searchTimer);resetFilter();reload();};
  for(const id of ['bibQueueStatus','bibQueueEvidence'])$('#'+id).onchange=changedFilter;
  // Reset selection when input changes, not when the delayed request starts.
  // Otherwise a preceding request can render the new query before this timer
  // fires and erase a selection the user already made on those results.
  $('#bibQueueSearch').oninput=()=>{clearTimeout(searchTimer);resetFilter();render();searchTimer=setTimeout(reload,250);};
  $('#bibQueuePrev').onclick=()=>{offset=Math.max(0,offset-PAGE);reload();};$('#bibQueueNext').onclick=()=>{offset+=PAGE;reload();};
  $('#bibSelectFiltered').onclick=async()=>{const current=version;try{const data=await api(query({ids:'selectable',limit:1}));if(current!==version)return;for(const s of data.selections)selected.set(s.candidateId,choices.get(s.candidateId)||selection(s));render();}catch(e){failure=e.message;render();}};
  $('#bibClearSelected').onclick=()=>{selected.clear();$('#bibBulkAction').value='row';render();};$('#bibBulkAction').onchange=applyButton;
  $('#bibReviewNotices').onchange=e=>{if(e.target.matches('[data-review-confirm]')){confirmed=e.target.checked;applyButton();}};
  $('#bibReviewPreview').onchange=e=>{
    const id=e.target.dataset.reviewApprove||e.target.dataset.reviewChoice,r=queue.rows.find(r=>r.candidateId===id);if(!r)return;
    if(e.target.matches('[data-review-approve]')){if(e.target.checked)selected.set(id,rowChoice(r));else selected.delete(id);applyButton();}
    else if(e.target.matches('[data-review-choice]')){const [action,...parts]=e.target.value.split('|'),s={candidateId:id,token:r.token,action,recordId:action==='match'?parts.join('|'):null};choices.set(id,s);if(selected.has(id))selected.set(id,s);render();}
  };
  $('#bibReviewApply').onclick=async()=>{
    if(working||$('#bibReviewApply').disabled)return;working=true;failure='';render();
    try{const result=await post(workspace+'/apply',{...(job?{importId:job.id}:{}),approved:true,confirmSnapshot:confirmed,selections:[...selected.values()].map(effective)});selected.clear();choices.clear();$('#bibBulkAction').value='row';notice=`연결 ${num(result.matched)} · 후보 제외 ${num(result.dismissed)} · 별도 유지 ${num(result.separated)}건 적용${result.skipped.length?` · ${num(result.skipped.length)}건 보존: ${[...new Set(result.skipped.map(s=>s.reason))].join(' ')}`:''}`;toast('승인한 서지 검토를 저장했습니다.');}
    catch(e){failure=e.message;if(e.code==='PARTIAL_APPLY')selected.clear();}finally{working=false;}
    if(!$('#drawer').hidden)closeDrawer();await reload();await load();await refreshBibDialog();
  };
  $('#bibliographyDialog').addEventListener('close',()=>{clearTimeout(timer);clearTimeout(searchTimer);});
  window.ResearchscapeBibliographyReview={refresh};bundleLink();exportLink();
})();
