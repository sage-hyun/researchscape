/* All Zotero traffic is server-side. No Local API key reaches this page. */
(()=>{
  let plan=null;
  const skipReason=reason=>({'no-zotero-item':'일치하는 Zotero 서지 항목 없음','missing-explicit-zotero-item':'직접 연결한 Zotero 항목을 찾지 못함','multiple-zotero-items':'일치하는 Zotero 항목이 여러 개임','conflicting-manual-keys':'수동 연결이 서로 충돌함','conflicting-identifiers':'DOI 또는 arXiv 식별자가 충돌함','identifier-title-conflict':'식별자는 같지만 제목이 충돌함','unverified-bibliography':'정식 서지정보 또는 별칭 검증 필요','alias-needs-confirmation':'약칭 확인 필요','candidate-type-review':'논문 여부 검토 필요'}[reason]||'서지 연결 검토 필요');
  const dialog=$('#zoteroDialog'),status=$('#zoteroStatus');
  function invalidate(){plan=null;$('#zoteroApply').disabled=true;}
  async function connect(){
    status.textContent='Zotero 10 Local API 연결 확인 중…';invalidate();
    try{const d=await api('/api/zotero/status');status.textContent=`연결됨 · API ${d.apiVersion} · ${d.authorized?'쓰기 승인됨':'쓰기 승인 필요'} · 키는 서버 메모리에만 보관${d.serverChanged?' · 서버 변경 감지: 기존 매핑과 분리됩니다.':''}`;const library=$('#zoteroLibrary').value;$('#zoteroLibrary').innerHTML=d.libraries.map(l=>`<option value="${esc(l.id)}">${esc(l.name)} (${esc(l.id)})</option>`).join('');if(d.libraries.some(l=>l.id===library))$('#zoteroLibrary').value=library;}
    catch(e){status.textContent=e.message;}
  }
  async function open(){dialog.showModal();const d=await api('/api/zotero/projects');$('#zoteroProjects').innerHTML=d.projects.filter(p=>p.conversationCount).map(p=>`<label><input type="checkbox" value="${esc(p.id)}"> ${esc(p.name)} <small>${num(p.conversationCount)}개 대화</small></label>`).join('');await connect();}
  $('#zoteroOpen').onclick=()=>open().catch(e=>toast(e.message));$('#zoteroClose').onclick=()=>dialog.close();$('#zoteroConnect').onclick=connect;
  $('#zoteroProjects').onchange=invalidate;$('#zoteroLibrary').onchange=invalidate;$('#zoteroPaperLimit').onchange=invalidate;
  $('#zoteroAuthorize').onclick=async event=>{event.target.disabled=true;status.textContent='Zotero 창에서 Researchscape 쓰기 권한을 승인하거나 거절해주세요. 일회성 허용은 요청 한 번에만 유효합니다.';try{const d=await post('/api/zotero/authorize');status.textContent=`쓰기 승인됨 · ${d.remember?'반복 사용 승인':'일회성 승인'} · 서버 재시작 시 키는 폐기됩니다.`;}catch(e){status.textContent=e.message;}finally{event.target.disabled=false;}};
  $('#zoteroPreview').onclick=async event=>{
    event.target.disabled=true;invalidate();try{const d=await post('/api/zotero/sync/preview',{library:$('#zoteroLibrary').value,projectIds:[...$('#zoteroProjects').querySelectorAll('input:checked')].map(el=>el.value),paperLimit:Number($('#zoteroPaperLimit').value)});plan=d;
      $('#zoteroPreviewResult').innerHTML=`<p>변경 저장 없음 · 생성 ${d.collections.filter(c=>c.action==='create').length}개 · 재사용 ${d.collections.filter(c=>c.action==='reuse').length}개</p><ul>${d.collections.map(c=>`<li>${c.action==='create'?'새로 생성':'재사용'}: ${esc(c.name)} · ${esc(c.key)}</li>`).join('')}</ul><h3>프로젝트별 논문 추가</h3>${d.rows.map(r=>`<p>${esc(d.collections.find(c=>c.projectId===r.projectId)?.name)} → ${esc(r.title)} · ${r.status==='add'?'추가 예정':'이미 포함됨'}</p>`).join('')}<h3>건너뛴 논문 ${d.skipped.length}편</h3>${d.skipped.map(r=>`<p>${esc(r.title)} · ${esc(skipReason(r.reason))}</p>`).join('')}`;$('#zoteroApply').disabled=false;
    }catch(e){$('#zoteroPreviewResult').textContent=e.message;}finally{event.target.disabled=false;}
  };
  $('#zoteroApply').onclick=async event=>{if(!plan)return;event.target.disabled=true;try{const d=await post('/api/zotero/sync/apply',{planId:plan.planId,approved:true});status.textContent=`동기화 완료 · ${d.completed}개 항목 확인 · 기존 Collection 유지`;plan=null;}catch(e){status.textContent=e.message+' · 이미 완료된 추가는 유지됩니다. 권한 확인 후 새 미리보기로 이어가세요.';plan=null;}};
  window.researchscapeZotero={open,library:()=>$('#zoteroLibrary').value||'users/0'};
})();
