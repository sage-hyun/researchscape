/* One-file LLM review export and durable, explicitly approved imports. No LLM calls. */
(()=>{
  const MAX_UPLOAD=16*1024*1024,PAGE=50,route='/api/bibliography/review/import';
  const labels={'applied':'적용됨','partially-applied':'일부 적용','matching-failed':'매칭 실패','lookup-failed':'조회 실패','search-miss':'검색 결과 없음','not-searched':'미조회','not-present':'약칭 후보 없음','user-separated':'사용자가 분리','retrieved':'조회 성공','verified':'제목·식별자 검증','no-record':'레코드 없음'};
  const statuses={ready:'적용 가능','needs-manual-review':'추가 검토 필요',preserved:'기존 결정 보존',duplicate:'중복',error:'오류',deferred:'보류',applied:'적용됨',stale:'재검증 필요'};
  const countKeys={ready:'ready','needs-manual-review':'needsManualReview',preserved:'preserved',duplicate:'duplicate',error:'error',deferred:'deferred',applied:'applied',stale:'stale'};
  // The five outcomes are always shown; the rest appear only when they occur.
  const always=['ready','needs-manual-review','preserved','duplicate','error'];
  let totals={withCandidates:0,withoutCandidates:0},job=null,filter='ready',shown=PAGE,selected=new Set(),confirmed=false,notice='',failure='',working=false,restore=true,timer=null,version=0;

  // ---- downloads ----
  function bundleLink(){
    const size=Number($('#bibBatchSize').value),total=totals.withCandidates+totals.withoutCandidates;
    $('#bibBundleDownload').href=appUrl('/api/bibliography/export?'+new URLSearchParams({format:'bundle',batchSize:size}));
    $('#bibBundleInfo').textContent=total?`미연결 후보 ${num(total)}건 전체 (연결 후보 있음 ${num(totals.withCandidates)} · 없음 ${num(totals.withoutCandidates)}) · 파일 1개 · LLM용 ${size}건 배치 ${num(Math.ceil(total/size))}개 포함`:'지금은 검토할 미연결 후보가 없습니다.';
  }
  function exportLink(){
    const group=$('#bibExportGroup').value,limit=Number($('#bibExportSize').value),total=totals[group==='with-candidates'?'withCandidates':'withoutCandidates'],pages=Math.max(1,Math.ceil(total/limit)),page=Math.max(1,Math.min(pages,Number($('#bibExportPage').value)||1));
    $('#bibExportPage').max=pages;$('#bibExportPage').value=page;
    $('#bibCompactDownload').href=appUrl('/api/bibliography/export?'+new URLSearchParams({format:'compact',group,limit,offset:(page-1)*limit}));
    $('#bibExportInfo').textContent=`${num(total)}건 · ${page} / ${pages}묶음 · 최대 ${limit}건씩`;
  }
  function refresh(data){
    totals=data.reviewTotals||totals;bundleLink();exportLink();const d=data.diagnostics||{};
    $('#bibAliasDiagnostics').innerHTML='<summary>Curated alias 적용 진단</summary>'+(d.curatedAliases||[]).map(a=>`<p><strong>${esc(a.alias)}</strong> · ${esc(labels[a.lookupStatus]||a.lookupStatus)} → ${esc(labels[a.identityStatus]||a.identityStatus)} → ${esc(labels[a.applicationStatus]||a.applicationStatus)}<br><small>${a.appliedCandidateIds.length} / ${a.candidateIds.length}개 후보 적용 · ${esc(a.reasons.join(', '))}</small></p>`).join('');
    const versions=d.workVersions||[];
    $('#bibWorkVersions').innerHTML=`<summary>Work·Version 관계 제안 ${num(versions.length)}건 · 자동 병합 안 함</summary><p>같은 제목·저자의 arXiv와 출판본 관계를 확인하세요. 저자 정보가 없으면 근거 부족으로 표시합니다. 식별자는 분리된 채 유지됩니다.</p>`+versions.slice(0,60).map(v=>`<article class="bib-review"><strong>${esc(v.title)}</strong><p>${v.reason==='possible-work-versions'?'제목·저자 일치 · 동일 Work의 다른 Version인지 확인':'제목 일치 · 저자 정보 부족으로 수동 확인 필요'}</p>${v.versions.map(r=>`<p>${esc(r.recordId)} · ${esc(r.year||'연도 미상')}<br><small>${esc(r.authors.join(', ')||'저자 정보 없음')}</small></p>`).join('')}</article>`).join('');
    // An unfinished import survives reloads and server restarts: reopen it once per page load.
    if(restore&&!job&&!working&&data.reviewImport){restore=false;open(data.reviewImport.id);}
    else if(job?.running&&!timer)poll();
  }
  for(const id of ['bibExportGroup','bibExportSize','bibExportPage'])$('#'+id).onchange=exportLink;
  $('#bibExportPage').oninput=()=>{if($('#bibExportPage').value)exportLink();};
  $('#bibBatchSize').onchange=bundleLink;

  // ---- import job ----
  const query=()=>route+'?'+new URLSearchParams({id:job.id,status:filter,offset:0,limit:shown});
  async function open(id){job={id,rows:[],counts:{},snapshot:{}};selected=new Set();confirmed=false;filter='ready';shown=PAGE;await reload();}
  async function reload(){
    if(!job)return;const current=++version,wasRunning=!!job.running;
    try{
      const data=await api(query());if(current!==version)return;
      job=data;failure='';render();
      if(job.running)poll();
      else if(wasRunning){toast(job.status==='interrupted'?'검증이 중단되었습니다. 완료된 결과는 보존됩니다.':'검토 결과 검증을 마쳤습니다. 미리보기를 확인해주세요.');if($('#bibliographyDialog').open)refreshBibDialog();}
    }catch(e){if(current!==version)return;if(e.code==='IMPORT_NOT_FOUND'){job=null;failure='';}else failure=e.message;render();}
  }
  function poll(){clearTimeout(timer);timer=setTimeout(()=>{timer=null;if($('#bibliographyDialog').open)reload();},900);}
  async function upload(text,fileName){
    if(working)return;working=true;failure='';notice='';render();
    try{
      const result=await api(route+'?'+new URLSearchParams({filename:fileName}),{method:'POST',body:text});
      job=result.job;selected=new Set();confirmed=false;filter='ready';shown=PAGE;restore=false;
      notice=result.duplicate?(job.status==='archived'?'이미 가져와 처리한 JSON입니다. 보관 기간이 지나 미리보기는 남아 있지 않습니다.':'같은 JSON을 이미 가져왔습니다. 새로 만들지 않고 기존 미리보기를 열었습니다.'):'';
      working=false;
      if(job.status==='archived'){render();return;}
      await reload();
    }catch(e){failure=e.message;}
    finally{working=false;render();reveal();}
  }
  // The result of an import started further down (advanced paste) must not stay off-screen.
  const reveal=()=>$('#bibImportStatus').scrollIntoView({block:'nearest'});
  async function readFiles(files){
    if(!files.length)return;
    if(files.reduce((sum,file)=>sum+file.size,0)>MAX_UPLOAD){failure=`검토 결과 JSON은 합쳐서 ${MAX_UPLOAD/1024/1024}MB 이하만 가져올 수 있습니다. 배치별 부분 결과로 나누어 가져와주세요.`;render();reveal();return;}
    const texts=await Promise.all(files.map(file=>file.text())),documents=[];
    for(const [i,text] of texts.entries()){
      try{documents.push(JSON.parse(text));}catch{failure=`${files[i].name}: JSON 형식이 올바르지 않습니다. LLM 응답에서 JSON 부분만 저장했는지 확인해주세요.`;render();reveal();return;}
    }
    // Several partial result files become one import; a single file is sent as it is.
    await upload(files.length===1?texts[0]:JSON.stringify(documents.flat()),files.length===1?files[0].name:`${files[0].name} 외 ${files.length-1}개`);
  }
  async function control(action){
    if(!job||working)return;working=true;render();
    try{
      if(action==='discard'){await post(route+'/discard',{importId:job.id});job=null;selected=new Set();notice='';toast('미리보기를 닫았습니다. 이미 적용한 결정은 유지됩니다.');}
      else{await post(route+'/'+action,{importId:job.id});if(action==='resume')selected=new Set();}
    }catch(e){failure=e.message;}
    finally{working=false;}
    if(job)await reload();else render();
  }

  // ---- rendering ----
  const target=r=>{
    if(r.decision==='match')return `${esc(r.recordTitle||'레코드 확인 불가')} · ${esc(r.recordId)}`;
    if(r.decision==='separate')return '연결하지 않고 따로 유지';
    if(r.decision==='defer')return '보류';
    if(r.decision!=='propose')return '';
    const p=r.proposal||{},proposed=[p.doi&&'DOI '+p.doi,p.arxiv&&'arXiv '+p.arxiv,p.title&&'“'+p.title+'”'].filter(Boolean).join(' · '),record=r.verification?.record;
    return `LLM 제안: ${esc(proposed)}${record?`<br>공식 조회: ${esc(record.title)} · ${esc(record.authors.slice(0,4).join(', ')||'저자 정보 없음')} · ${esc(record.year||'연도 미상')} · ${esc(record.recordId)}`:''}`;
  };
  const rowHTML=r=>`<article class="bib-review bib-row" data-status="${esc(r.status)}"><label><input type="checkbox" data-review-approve="${esc(r.candidateId??'')}" ${r.status==='ready'?(selected.has(r.candidateId)?'checked':''):'disabled'}> <strong>${esc(r.title||r.candidateId||'candidateId 없음')}</strong></label><p>${esc(r.candidateId??'candidateId 없음')}${r.decision?' → '+target(r):''}</p><p><span class="bib-row-status">${esc(statuses[r.status]||r.status)}</span> ${esc(r.reason||'')}</p>${(r.evidence||[]).map(e=>`<small>${esc(e.type)} · ${esc(e.detail)}</small>`).join('<br>')}</article>`;
  function statusHTML(){
    const c=job.counts||{},progress=`${num(job.processed)} / ${num(job.total)}건`,button=(action,text)=>`<button class="button" type="button" data-review-action="${action}" ${working?'disabled':''}>${text}</button>`;
    let title,detail,actions='';
    if(job.status==='archived'){title='이미 처리한 JSON';detail=`적용 ${num(c.applied)}건`;}
    else if(job.running){title=`검증 중 ${progress}`;detail=job.progress?.current?`공식 서지 조회 · ${job.progress.current}`:'형식·후보·기존 결정을 확인하고 있습니다. 창을 닫아도 서버에서 계속 진행합니다.';actions=button('stop','검증 중단');}
    else if(job.processed<job.total){title=`검증 중단 · ${progress} 완료`;detail=job.error||'완료된 결과는 보존됩니다.';actions=button('resume','이어서 검증')+button('discard',c.applied?'미리보기 닫기':'가져오기 취소');}
    else{
      title=job.status==='completed'?`적용 완료 · ${num(c.applied)}건`:`검증 완료 · ${num(job.total)}건`;detail=job.error||(c.applied?`지금까지 ${num(c.applied)}건 적용`:'저장된 연결 변경 없음 · 승인한 항목만 적용합니다.');
      // Closing a preview never undoes approved decisions, so it is not called "cancel" once some exist.
      actions=(job.resumable?button('resume','실패·변경 항목 다시 검증'):'')+button('discard',c.applied?'미리보기 닫기':'가져오기 취소');
    }
    return `<strong>${esc(title)}</strong><span>${esc(job.fileName||'붙여넣은 JSON')}${job.parts>1?` · 부분 결과 ${num(job.parts)}개 병합`:''} · ${esc(detail)}</span>${actions?`<div class="bib-import-actions">${actions}</div>`:''}`;
  }
  function noticesHTML(){
    const c=job.counts||{},s=job.snapshot||{},items=[];
    if(notice)items.push(['',notice]);
    if(s.status==='known')items.push(['',`이전에 내려받은 검토 JSON으로 작성한 결과입니다. 후보별로 대조해 그 뒤 연결 후보가 바뀐 ${num(s.changed)}건은 추가 검토로 분류했습니다.`]);
    if(c.registered)items.push(['',`LLM이 제안한 식별자 중 공식 조회로 확인한 ${num(c.registered)}건을 연결 후보로 등록했습니다. 실제 연결은 승인한 항목만 적용합니다.`]);
    if(c.lookupFailed)items.push(['warn',`공식 조회에 실패한 ${num(c.lookupFailed)}건이 있습니다. 다시 검증하면 이 항목만 재시도합니다.`]);
    if(c.stale)items.push(['warn',`미리보기 뒤에 상태가 바뀐 ${num(c.stale)}건이 있습니다. 다시 검증해주세요.`]);
    for(const warning of job.warnings||[])items.push(['',warning]);
    let html=items.map(([kind,text])=>`<p class="bib-notice ${kind}">${esc(text)}</p>`).join('');
    if(s.requiresConfirmation)html+=`<p class="bib-notice warn">현재 서버에 내보낸 기록이 없는 snapshot으로 작성한 결과입니다. 다른 시점이나 다른 데이터의 결과일 수 있으니 미리보기를 확인해주세요.<label><input type="checkbox" data-review-confirm ${confirmed?'checked':''}> 다른 snapshot의 결과임을 확인했고, 현재 상태로 검증된 항목만 적용합니다.</label></p>`;
    return html;
  }
  function render(){
    const status=$('#bibImportStatus'),preview=$('#bibReviewPreview');
    $('#bibReviewPick').disabled=working||!!job?.running;$('#bibReviewPaste').disabled=working||!!job?.running;
    if(!job){
      status.hidden=!failure&&!working;status.innerHTML=working?'<strong>결과 JSON을 보내는 중…</strong>':`<strong>가져오지 못했습니다</strong><span>${esc(failure)}</span>`;
      preview.innerHTML='<p class="drawer-help">가져온 검토 결과가 없습니다. 결과 JSON을 가져오면 적용 가능·추가 검토 필요·기존 결정 보존·중복·오류 건수와 항목별 근거를 여기에서 확인합니다. 미리보기만으로는 아무것도 연결하지 않습니다.</p>';
      applyButton();return;
    }
    status.hidden=false;status.innerHTML=statusHTML()+(failure?`<span class="bib-import-error">${esc(failure)}</span>`:'');
    const c=job.counts||{},chips=Object.keys(statuses).filter(key=>always.includes(key)||c[countKeys[key]]||filter===key);
    const more=job.rowsTotal-job.rows.length;
    preview.innerHTML=(job.status==='archived'?'':`<div class="bib-summary" role="group" aria-label="검토 결과 분류">${chips.map(key=>`<button type="button" class="bib-chip" data-review-filter="${key}" aria-pressed="${filter===key}">${esc(statuses[key])} <strong>${num(c[countKeys[key]])}</strong></button>`).join('')}<button type="button" class="bib-chip" data-review-filter="all" aria-pressed="${filter==='all'}">전체 <strong>${num(job.processed)}</strong></button></div>`)
      +noticesHTML()
      +(c.ready?`<div class="bib-select-bar"><button type="button" class="text-button" data-review-select="all">적용 가능 ${num(c.ready)}건 전체 선택</button><button type="button" class="text-button" data-review-select="none">선택 해제</button><span id="bibSelectedCount"></span></div>`:'')
      +(job.rows.length?job.rows.map(rowHTML).join(''):job.status==='archived'?'':`<p class="drawer-help">${job.running&&!job.processed?'검증을 시작했습니다…':'이 분류에 해당하는 항목이 없습니다.'}</p>`)
      +(more>0?`<button type="button" class="button load-more" data-review-more>더 보기 (${num(more)}건 남음)</button>`:'');
    applyButton();
  }
  function applyButton(){
    const n=selected.size,button=$('#bibReviewApply'),count=$('#bibSelectedCount');
    button.disabled=working||!job||!!job.running||!n||(job.snapshot?.requiresConfirmation&&!confirmed);
    button.textContent=`선택한 ${num(n)}건 최종 승인·적용`;if(count)count.textContent=`${num(n)}건 선택됨`;
  }

  // ---- events ----
  $('#bibReviewPick').onclick=()=>$('#bibReviewFile').click();
  $('#bibReviewFile').onchange=async e=>{const files=[...e.target.files];e.target.value='';await readFiles(files);};
  $('#bibReviewPaste').onclick=()=>{
    const text=$('#bibReviewInput').value.trim();if(!text)return;
    try{JSON.parse(text);}catch{failure='붙여넣은 내용이 JSON 형식이 아닙니다.';render();reveal();return;}
    upload(text,'붙여넣은 JSON');
  };
  $('#bibImportStatus').onclick=e=>{const button=e.target.closest('[data-review-action]');if(button)control(button.dataset.reviewAction);};
  $('#bibReviewPreview').onclick=async e=>{
    const chip=e.target.closest('[data-review-filter]'),select=e.target.closest('[data-review-select]');
    if(chip){filter=chip.dataset.reviewFilter;shown=PAGE;await reload();}
    else if(e.target.closest('[data-review-more]')){shown=Math.min(200,shown+PAGE);await reload();}
    else if(select){
      if(select.dataset.reviewSelect==='none')selected=new Set();
      else try{selected=new Set((await api(route+'?'+new URLSearchParams({id:job.id,status:'ready',limit:1,ids:'ready'}))).readyIds);}catch(err){failure=err.message;}
      render();
    }
  };
  $('#bibReviewPreview').onchange=e=>{
    if(e.target.matches('[data-review-confirm]'))confirmed=e.target.checked;
    else if(e.target.matches('[data-review-approve]')){if(e.target.checked)selected.add(e.target.dataset.reviewApprove);else selected.delete(e.target.dataset.reviewApprove);}
    applyButton();
  };
  $('#bibReviewApply').onclick=async()=>{
    if(!job||!selected.size||working)return;
    const candidateIds=[...selected];
    if(candidateIds.length>1&&!confirm(`선택한 ${num(candidateIds.length)}건의 연결·분리 결정을 저장합니다. 기존 수동 결정은 덮어쓰지 않습니다. 계속할까요?`))return;
    working=true;render();
    try{
      const result=await post(route+'/apply',{importId:job.id,approved:true,candidateIds,confirmSnapshot:confirmed});
      selected=new Set();notice=`최종 승인한 ${num(result.applied)}건을 적용했습니다.${result.skipped.length?` 미리보기 뒤에 상태가 바뀐 ${num(result.skipped.length)}건은 적용하지 않았습니다.`:''}`;
      toast('승인한 서지 검토 결과를 저장했습니다.');
    }catch(e){failure=e.message;if(e.code==='PARTIAL_APPLY')selected=new Set();}
    finally{working=false;}
    if(!$('#drawer').hidden)closeDrawer();
    await reload();await load();await refreshBibDialog();
  };
  $('#bibliographyDialog').addEventListener('close',()=>{clearTimeout(timer);timer=null;});
  window.ResearchscapeBibliographyReview={refresh};bundleLink();exportLink();render();
})();
