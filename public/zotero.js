/* All Zotero traffic is server-side. No Local API key reaches this page. */
(()=>{
  let plan=null,connected=false,authorized=false,busy=false;
  const dialog=$('#zoteroDialog'),status=$('#zoteroStatus');
  const selectedProjects=()=>[...$('#zoteroProjects').querySelectorAll('input:checked')].map(el=>el.value);
  const skipReason=reason=>({'no-zotero-item':'일치하는 Zotero 서지 항목 없음','missing-explicit-zotero-item':'직접 연결한 Zotero 항목을 찾지 못함','multiple-zotero-items':'일치하는 Zotero 항목이 여러 개임','conflicting-manual-keys':'수동 연결이 서로 충돌함','conflicting-identifiers':'DOI 또는 arXiv 식별자가 충돌함','identifier-title-conflict':'식별자는 같지만 제목이 충돌함','unverified-bibliography':'정식 서지정보 또는 별칭 검증 필요','alias-needs-confirmation':'약칭 확인 필요','candidate-type-review':'논문 여부 검토 필요'}[reason]||'서지 연결 검토 필요');
  function updateControls(){
    const count=selectedProjects().length,hasProjects=!!$('#zoteroProjects input');
    $('#zoteroSelectionCount').textContent=`${num(count)}개 선택`;
    for(const id of ['zoteroConnect','zoteroSelectAll','zoteroClearSelection','zoteroPaperLimit'])$('#'+id).disabled=busy||(['zoteroSelectAll','zoteroClearSelection'].includes(id)&&!hasProjects);
    $('#zoteroAuthorize').disabled=busy||!connected;$('#zoteroLibrary').disabled=busy||!connected;
    for(const input of $('#zoteroProjects').querySelectorAll('input'))input.disabled=busy;
    $('#zoteroPreview').disabled=busy||!connected||!count;$('#zoteroApply').disabled=busy||!plan||!authorized;
    const badge=$('#zoteroConnectionBadge');badge.textContent=connected?(authorized?'쓰기 승인됨':'읽기 연결됨'):'연결 설정 필요';badge.dataset.state=connected?'connected':'disconnected';
    $('#zoteroPreviewHint').textContent=!connected?'먼저 Zotero 연결을 확인해주세요.':!count?'동기화할 프로젝트를 하나 이상 선택해주세요.':plan&&!authorized?'미리보기를 확인했습니다. 저장하려면 위에서 쓰기 권한을 승인해주세요.':plan?'변경 내용을 확인한 뒤 최종 승인·적용을 누르세요.':'미리보기는 Zotero를 변경하지 않습니다. 처음에는 1~3편으로 확인하세요.';
  }
  function invalidate(){plan=null;$('#zoteroPreviewResult').innerHTML='';updateControls();}
  function failure(error){
    status.textContent=error.message;status.dataset.state='error';
    if(['LOCAL_API_DISABLED','UNAVAILABLE','UNSUPPORTED'].includes(error.code)){connected=false;authorized=false;$('#zoteroSetup').open=true;}
    if(['AUTH_REQUIRED','PERMISSION_DENIED'].includes(error.code))authorized=false;
  }
  async function connect(){
    busy=true;connected=false;authorized=false;invalidate();status.textContent='Zotero 연결 확인 중…';status.dataset.state='';
    try{
      const d=await api('/api/zotero/status');connected=true;authorized=d.authorized;
      status.textContent=`읽기 연결 완료 · ${authorized?'쓰기 승인됨':'저장 전 쓰기 승인 필요'}${d.serverChanged?' · Zotero 데이터베이스 변경 감지: 기존 매핑과 분리됩니다.':''}`;
      const library=$('#zoteroLibrary').value;$('#zoteroLibrary').innerHTML=d.libraries.map(l=>`<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('');if(d.libraries.some(l=>l.id===library))$('#zoteroLibrary').value=library;
      $('#zoteroSetup').open=false;
    }catch(e){failure(e);}finally{busy=false;updateControls();}
  }
  async function open(){
    if(!dialog.open)dialog.showModal();plan=null;connected=false;authorized=false;$('#zoteroProjects').innerHTML='<p>프로젝트 목록 확인 중…</p>';updateControls();
    try{const d=await api('/api/zotero/projects');$('#zoteroProjects').innerHTML=d.projects.filter(p=>p.conversationCount).map(p=>`<label class="zotero-project-option"><input type="checkbox" value="${esc(p.id)}"><span class="zotero-project-name">${esc(p.name)}</span><small>${num(p.conversationCount)}개 대화</small></label>`).join('')||'<p>프로젝트 정보가 있는 대화가 없습니다.</p>';}catch(e){$('#zoteroProjects').textContent=e.message;}
    await connect();
  }
  $('#zoteroOpen').onclick=()=>open().catch(e=>toast(e.message));$('#zoteroClose').onclick=()=>dialog.close();$('#zoteroConnect').onclick=connect;
  $('#zoteroProjects').onchange=invalidate;$('#zoteroLibrary').onchange=invalidate;$('#zoteroPaperLimit').onchange=invalidate;
  $('#zoteroSelectAll').onclick=()=>{for(const input of $('#zoteroProjects').querySelectorAll('input'))input.checked=true;invalidate();};
  $('#zoteroClearSelection').onclick=()=>{for(const input of $('#zoteroProjects').querySelectorAll('input'))input.checked=false;invalidate();};
  $('#zoteroAuthorize').onclick=async()=>{
    if(!connected||busy)return;busy=true;updateControls();status.textContent='Zotero 창에서 Researchscape 쓰기 권한을 승인하거나 거절해주세요. 일회성 허용은 쓰기 요청 한 번에만 유효합니다.';status.dataset.state='';
    try{const d=await post('/api/zotero/authorize');authorized=d.authorized;status.textContent=`쓰기 승인 완료 · ${d.remember?'반복 사용 승인':'일회성 승인'} · 서버 재시작 후에는 다시 승인해야 합니다.`;}catch(e){failure(e);}finally{busy=false;updateControls();}
  };
  $('#zoteroPreview').onclick=async()=>{
    if(busy||!connected||!selectedProjects().length)return;busy=true;invalidate();
    try{
      const d=await post('/api/zotero/sync/preview',{library:$('#zoteroLibrary').value,projectIds:selectedProjects(),paperLimit:Number($('#zoteroPaperLimit').value)});plan=d;
      $('#zoteroPreviewResult').innerHTML=`<p class="zotero-preview-summary">저장 전 미리보기 · 새 Collection ${num(d.collections.filter(c=>c.action==='create').length)}개 · 재사용 ${num(d.collections.filter(c=>c.action==='reuse').length)}개</p><ul>${d.collections.map(c=>`<li>${c.action==='create'?'새로 생성':'재사용'}: ${esc(c.name)}</li>`).join('')}</ul><h4>프로젝트별 논문 추가</h4>${d.rows.map(r=>`<p>${esc(d.collections.find(c=>c.projectId===r.projectId)?.name)} → ${esc(r.title)} · ${r.status==='add'?'추가 예정':'이미 포함됨'}</p>`).join('')||'<p>추가할 논문 항목이 없습니다.</p>'}<h4>건너뛴 논문 ${num(d.skipped.length)}편</h4>${d.skipped.map(r=>`<p>${esc(r.title)} · ${esc(skipReason(r.reason))}</p>`).join('')}`;
    }catch(e){failure(e);$('#zoteroPreviewResult').textContent=e.message;}finally{busy=false;updateControls();}
  };
  $('#zoteroApply').onclick=async()=>{
    if(!plan||!authorized||busy)return;busy=true;updateControls();
    try{const d=await post('/api/zotero/sync/apply',{planId:plan.planId,approved:true});status.textContent=`동기화 완료 · ${num(d.completed)}개 항목 확인 · 기존 Collection 유지`;status.dataset.state='';plan=null;try{authorized=(await api('/api/zotero/status')).authorized;}catch{authorized=false;}}
    catch(e){failure(e);status.textContent+=' 이미 완료된 추가는 유지됩니다. 상태 확인 후 새 미리보기로 이어가세요.';plan=null;}
    finally{busy=false;updateControls();}
  };
  window.researchscapeZotero={open,library:()=>$('#zoteroLibrary').value||'users/0'};
  updateControls();
})();
