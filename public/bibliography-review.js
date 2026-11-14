/* Compact exports and explicitly approved LLM review imports. No LLM calls. */
(()=>{
  let totals={withCandidates:0,withoutCandidates:0},preview=null;
  const labels={'applied':'적용됨','partially-applied':'일부 적용','matching-failed':'매칭 실패','lookup-failed':'조회 실패','search-miss':'검색 결과 없음','not-searched':'미조회','not-present':'약칭 후보 없음','user-separated':'사용자가 분리','retrieved':'조회 성공','verified':'제목·식별자 검증','no-record':'레코드 없음'};
  function exportLink(){
    const group=$('#bibExportGroup').value,limit=Number($('#bibExportSize').value),total=totals[group==='with-candidates'?'withCandidates':'withoutCandidates'],pages=Math.max(1,Math.ceil(total/limit)),page=Math.max(1,Math.min(pages,Number($('#bibExportPage').value)||1));
    $('#bibExportPage').max=pages;$('#bibExportPage').value=page;
    $('#bibCompactDownload').href=appUrl('/api/bibliography/export?'+new URLSearchParams({format:'compact',group,limit,offset:(page-1)*limit}));
    $('#bibExportInfo').textContent=`${num(total)}건 · ${page} / ${pages}묶음 · 최대 ${limit}건씩`;
  }
  function refresh(data){
    totals=data.reviewTotals||totals;exportLink();const d=data.diagnostics||{};
    $('#bibAliasDiagnostics').innerHTML='<summary>Curated alias 적용 진단</summary>'+(d.curatedAliases||[]).map(a=>`<p><strong>${esc(a.alias)}</strong> · ${esc(labels[a.lookupStatus]||a.lookupStatus)} → ${esc(labels[a.identityStatus]||a.identityStatus)} → ${esc(labels[a.applicationStatus]||a.applicationStatus)}<br><small>${a.appliedCandidateIds.length} / ${a.candidateIds.length}개 후보 적용 · ${esc(a.reasons.join(', '))}</small></p>`).join('');
    const versions=d.workVersions||[];
    $('#bibWorkVersions').innerHTML=`<summary>Work·Version 관계 제안 ${num(versions.length)}건 · 자동 병합 안 함</summary><p>같은 제목·저자의 arXiv와 출판본 관계를 확인하세요. 저자 정보가 없으면 근거 부족으로 표시합니다. 식별자는 분리된 채 유지됩니다.</p>`+versions.slice(0,60).map(v=>`<article class="bib-review"><strong>${esc(v.title)}</strong><p>${v.reason==='possible-work-versions'?'제목·저자 일치 · 동일 Work의 다른 Version인지 확인':'제목 일치 · 저자 정보 부족으로 수동 확인 필요'}</p>${v.versions.map(r=>`<p>${esc(r.recordId)} · ${esc(r.year||'연도 미상')}<br><small>${esc(r.authors.join(', ')||'저자 정보 없음')}</small></p>`).join('')}</article>`).join('');
  }
  for(const id of ['bibExportGroup','bibExportSize','bibExportPage'])$('#'+id).onchange=exportLink;
  $('#bibExportPage').oninput=()=>{if($('#bibExportPage').value)exportLink();};
  const statuses={ready:'승인 대기',preserved:'기존 결정 보존','needs-manual-review':'추가 수동 검토',deferred:'보류'};
  function approvalButton(){const n=$('#bibReviewPreview').querySelectorAll('input[data-review-approve]:checked').length;$('#bibReviewApply').disabled=!preview||!n;$('#bibReviewApply').textContent=`선택한 ${n}건 최종 승인·적용`;}
  $('#bibReviewPreview').onchange=approvalButton;
  $('#bibReviewInput').oninput=()=>{preview=null;$('#bibReviewPreview').textContent='내용이 변경되었습니다. 미리보기를 다시 실행해주세요.';approvalButton();};
  $('#bibReviewDryRun').onclick=async()=>{
    const button=$('#bibReviewDryRun');button.disabled=true;preview=null;approvalButton();
    try{
      const result=await post('/api/bibliography/review/dry-run',JSON.parse($('#bibReviewInput').value));preview=result;
      $('#bibReviewPreview').innerHTML=`<p>저장된 변경 없음 · 승인 가능한 ${num(result.applicable)}건 중 적용할 항목을 직접 선택하세요. 기존 수동 결정은 덮어쓰지 않습니다.</p>`+result.rows.map(r=>`<article class="bib-review"><label><input type="checkbox" data-review-approve="${esc(r.candidateId)}" ${r.status==='ready'?'':'disabled'}> <strong>${esc(r.title)}</strong></label><p>${esc(r.candidateId)} → ${r.decision==='match'?esc(r.recordTitle)+' · '+esc(r.recordId):r.decision==='separate'?'따로 유지':'보류'}</p><p>${esc(statuses[r.status])} · ${esc(r.reason)}</p>${r.evidence.map(e=>`<small>${esc(e.type)} · ${esc(e.detail)}</small>`).join('<br>')}</article>`).join('');approvalButton();
    }catch(e){$('#bibReviewPreview').textContent=e.message;}
    finally{button.disabled=false;}
  };
  $('#bibReviewApply').onclick=async()=>{
    if(!preview)return;const button=$('#bibReviewApply'),candidateIds=[...$('#bibReviewPreview').querySelectorAll('input[data-review-approve]:checked')].map(el=>el.dataset.reviewApprove);button.disabled=true;
    try{const result=await post('/api/bibliography/review/apply',{dryRunId:preview.dryRunId,approved:true,candidateIds});preview=null;$('#bibReviewPreview').textContent=`최종 승인한 ${num(result.applied)}건을 적용했습니다.`;if(!$('#drawer').hidden)closeDrawer();await load();await refreshBibDialog();toast('승인한 서지 검토 결과를 저장했습니다.');}
    catch(e){preview=null;$('#bibReviewPreview').textContent=e.message;}
    finally{approvalButton();}
  };
  window.ResearchscapeBibliographyReview={refresh};exportLink();
})();
