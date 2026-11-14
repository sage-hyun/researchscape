/* Local PDF acquisition and Figure gallery. No PDF leaves this computer. */
(()=>{
  const statusLabels={'outside-pilot':'10편 시험 범위 밖',ready:'Figure 준비됨',available:'로컬 PDF 있음',missing:'PDF 미확보','missing-file':'PDF 파일 없음','needs-review':'PDF 연결 확인 필요','needs-pdf-review':'받은 PDF 확인 필요','needs-browser':'브라우저 다운로드 필요','rate-limited':'접근 속도 제한','download-failed':'PDF 다운로드 실패','processing-failed':'Figure 처리 실패'};
  const reasonLabel=reason=>({'no-local-pdf':'연결할 로컬 PDF가 없습니다.','multiple-pdfs':'같은 논문의 PDF가 여러 개입니다. 사용할 파일을 골라주세요.','alias-needs-confirmation':'약칭과 관련된 로컬 PDF를 찾았습니다. 같은 논문인지 확인해 연결해주세요.','identifier-title-conflict':'식별자와 PDF의 제목이 서로 다릅니다.','conflicting-manual-pdfs':'병합 전 연결한 PDF가 서로 다릅니다.','exact-title':'정식 제목이 일치합니다.','same-identifier':'서지 식별자가 일치합니다.','verified-alias':'검증된 약칭의 제목과 식별자가 일치합니다.','zotero-key':'Zotero Key로 연결했습니다.'})[reason]||reason;
  const figureName=f=>f.kind==='page'?'첫 페이지':f.kind==='custom'?'직접 고른 영역':f.number?`Figure ${f.number}`:'이미지 후보';
  function gallery(data){
    const tile=f=>`<button class="figure-tile ${f.id===data.thumbnail?.figureId?'selected':''}" data-figure="${esc(f.id)}" aria-pressed="${f.id===data.thumbnail?.figureId}" title="${esc(f.caption)}"><img src="${esc(appUrl(f.url))}" alt="${esc(figureName(f))}" loading="lazy" decoding="async"><strong>${esc(figureName(f))}${f.id===data.thumbnail?.figureId?' · 대표':''}</strong><small>${f.page}페이지${f.needsReview?' · 자동 감지':''}</small><span>${esc(f.kind==='page'?'논문 첫 페이지 미리보기':f.kind==='image'?'Figure 번호가 확인되지 않은 이미지 후보':f.caption)}</span></button>`;
    const main=data.figures.filter(f=>f.kind!=='image'),other=data.figures.filter(f=>f.kind==='image');
    return (main.length?`<div class="figure-gallery" aria-label="대표 이미지 선택">${main.map(tile).join('')}</div>`:'')+(other.length?`<details class="media-image-candidates"><summary>번호 없는 이미지 후보 ${other.length}개</summary><div class="figure-gallery">${other.map(tile).join('')}</div></details>`:'');
  }
  let timer=null,detailData=null,version=0,wasRunning=false,cropPaperId=null,pilotActive=false;
  const panel=()=>$('#figurePanel');
  function updateSummary(data){
    const paper=state.papers.find(p=>p.id===data.paperId);if(!paper)return;
    paper.media={status:data.status,figureCount:data.figureCount,thumbnail:data.thumbnail};
    // Update the visible row without rebuilding the list or losing its scroll.
    for(const image of document.querySelectorAll('[data-thumb-paper]'))if(image.dataset.thumbPaper===paper.id)image.innerHTML=paperThumbnail(paper);
  }
  async function refreshPaper(id=state.selected){
    if(cropPaperId===id)return;
    const root=panel(),token=++version;if(!root||id!==state.selected)return;
    try{const data=await api('/api/media/paper?'+new URLSearchParams({id}));if(token!==version||id!==state.selected||!panel())return;detailData=data;updateSummary(data);paintPanel(data);}
    catch(e){if(token===version&&root.isConnected)root.innerHTML=`<h3>PDF · Figure</h3><p>${esc(e.message)}</p>`;}
  }
  function paintPanel(data){
    const root=panel();if(!root||data.paperId!==state.selected)return;cropPaperId=null;
    const selected=data.thumbnail,figure=data.figures.find(f=>f.id===selected?.figureId),busy=wasRunning;
    root.innerHTML=`<div class="figure-heading"><h3>PDF · Figure</h3><span class="badge ${data.status==='ready'?'':'amber'}">${esc(statusLabels[data.status]||data.status)}</span></div>
      ${figure?`<figure class="figure-hero"><a href="${esc(appUrl(figure.url))}" target="_blank" rel="noopener"><img src="${esc(appUrl(figure.url))}" alt="${esc(figureName(figure))}" decoding="async"></a><figcaption>${esc(figureName(figure))} · ${figure.page}페이지 · ${selected.mode==='manual'?'직접 선택':'기본 대표 이미지'}${figure.needsReview?' · 자동 감지 영역 확인 권장':''}</figcaption></figure>`:''}
      ${data.selectionConflict?'<p class="media-warning">병합 전 대표 이미지 선택이 서로 다릅니다. 이 논문의 대표 Figure를 다시 선택해주세요.</p>':''}
      ${data.selectionMissing?'<p class="media-warning">직접 선택했던 Figure를 새 결과에서 찾지 못했습니다. 기존 선택 기록은 보존했습니다. 다른 Figure를 고르거나 기본값으로 되돌릴 수 있습니다.</p>':''}
      <div class="media-actions">${data.pdf?`<a class="button" target="_blank" rel="noopener" href="${esc(appUrl("/api/media/pdf?"+new URLSearchParams({pdf:data.pdf.id})))}">연결된 PDF 열기 ↗</a><button class="button" id="extractPaperFigures" ${busy||data.status==='outside-pilot'?'disabled':''}>${data.status==='ready'?'Figure 다시 추출':'Figure 추출'}</button>`:`<button class="button primary" id="acquirePaperPdf" ${data.testMode?'disabled':''}>PDF 자동 확보·추출</button>`}<label class="button media-file-label">PDF 파일 연결<input type="file" accept="application/pdf,.pdf" id="paperPdfUpload"></label>${data.figures.length?'<button class="button" id="autoFigure">Figure 1 기본값</button><button class="button" id="openCrop">영역 직접 선택</button>':''}</div>
      ${data.testMode?'<p class="media-note">현재 10편 시험 모드입니다. 시험 대상 PDF만 Figure를 추출·표시하며, 추가 PDF 자동 수집은 멈춰 있습니다.</p>':''}
      ${data.pdf?`<p class="media-note">${esc(data.pdf.filename)} · ${data.pdf.source==='zotero'?'Zotero 원본 사용':'Researchscape 로컬 보관'}${data.pdf.attachmentKey?' · '+esc(data.pdf.attachmentKey):''}</p>`:'<p class="media-note">Zotero에 있는 PDF부터 연결합니다. 없으면 공개 PDF를 찾고, 로그인·사람 확인이 필요한 경우 브라우저에서 다운로드한 파일을 연결해주세요.</p>'}
      ${data.outcome?.error?`<p class="media-warning">${esc(data.outcome.error)}</p>`:''}
      ${data.downloadCandidates.length?`<details class="media-links"><summary>원문·PDF 다운로드 경로</summary>${data.downloadCandidates.slice(0,6).map(c=>`<a href="${esc(c.url)}" target="_blank" rel="noopener noreferrer">${esc(c.source)} · ${c.kind==='pdf'?'PDF':'논문 페이지'} ↗</a>`).join('')}</details>`:''}
      ${gallery(data)}
      <details class="media-local-choice" ${data.match.status==='needs-review'||data.outcome?.status==='needs-pdf-review'?'open':''}><summary>다른 로컬 PDF 선택${data.match.candidates.length>1?' · '+data.match.candidates.length+'개 후보':''}</summary>${data.match.mode==='manual'?'<button class="button" id="resetPdfChoice">PDF 자동 연결로 되돌리기</button>':''}<div id="paperPdfCandidates">${data.match.candidates.map(pdfCandidate).join('')}</div><label class="media-library-search">Zotero·받은 PDF 제목 검색<input id="pdfLibrarySearch" type="search" placeholder="논문 제목 또는 첨부 Key"></label><div id="pdfLibraryResults"></div></details>`;
    $('#extractPaperFigures')?.addEventListener('click',()=>startJob({mode:'paper',paperId:data.paperId,limit:1,force:data.status==='ready'}));
    $('#acquirePaperPdf')?.addEventListener('click',()=>startJob({mode:'acquire',paperId:data.paperId,limit:1}));
    $('#autoFigure')?.addEventListener('click',async()=>{try{const d=await post('/api/media/thumbnail',{paperId:data.paperId,auto:true});detailData=d;updateSummary(d);paintPanel(d);toast('Figure 1 우선 기본값으로 되돌렸습니다.');}catch(e){toast(e.message);}});
    $('#paperPdfUpload').onchange=async event=>{
      const file=event.target.files[0];if(!file)return;
      if(file.size>100*1024*1024){toast('PDF는 100MB 이하만 지원합니다.');return;}
      event.target.disabled=true;
      try{const response=await fetch(appUrl('/api/media/upload?'+new URLSearchParams({id:data.paperId,filename:file.name})),{method:'POST',headers:{'Content-Type':'application/pdf'},body:file});const d=await response.json();if(!response.ok)throw new Error(d.error);detailData=d;updateSummary(d);paintPanel(d);await startJob({mode:'paper',paperId:data.paperId,limit:1});}
      catch(e){toast(e.message);if(event.target.isConnected)event.target.disabled=false;}
    };
    $('#openCrop')?.addEventListener('click',()=>cropEditor(data));
    $('#resetPdfChoice')?.addEventListener('click',async()=>{try{const d=await post('/api/media/pdf-choice',{paperId:data.paperId,auto:true});detailData=d;updateSummary(d);paintPanel(d);toast('수동 PDF 연결을 해제했습니다.');}catch(e){toast(e.message);}});
    let searchTimer;$('#pdfLibrarySearch').oninput=event=>{clearTimeout(searchTimer);searchTimer=setTimeout(async()=>{try{const d=await api('/api/media/library?'+new URLSearchParams({q:event.target.value}));if(data.paperId===state.selected&&$('#pdfLibraryResults'))$('#pdfLibraryResults').innerHTML=d.records.map(pdfCandidate).join('')||'<p>검색 결과가 없습니다.</p>';}catch(e){toast(e.message);}},220);};
  }
  function pdfCandidate(pdf){return `<div class="pdf-candidate"><strong>${esc(pdf.title||pdf.filename)}</strong><small>${esc(pdf.filename)} · ${esc(pdf.source)}</small><a target="_blank" rel="noopener" href="${esc(appUrl("/api/media/pdf?"+new URLSearchParams({pdf:pdf.id})))}">PDF 확인 ↗</a><button class="button" data-pdf-choice="${esc(pdf.id)}">이 PDF 연결</button></div>`;}
  document.addEventListener('click',async event=>{
    const figure=event.target.closest('[data-figure]'),pdf=event.target.closest('[data-pdf-choice]');if(!figure&&!pdf)return;
    const button=figure||pdf;button.disabled=true;
    try{const d=await post(figure?'/api/media/thumbnail':'/api/media/pdf-choice',{paperId:state.selected,...(figure?{figureId:figure.dataset.figure}:{pdfId:pdf.dataset.pdfChoice})});detailData=d;updateSummary(d);paintPanel(d);toast(figure?'대표 이미지를 저장했습니다.':'PDF 연결을 저장했습니다.');if(pdf&&d.status!=='ready')await startJob({mode:'paper',paperId:d.paperId,limit:1});}
    catch(e){toast(e.message);button.disabled=false;}
  });
  async function startJob(options){
    try{await post('/api/media/job',options);wasRunning=true;toast('PDF·Figure 작업을 시작했습니다.');await poll();}
    catch(e){toast(e.message);}
  }
  async function poll(){
    clearTimeout(timer);
    try{
      const d=await api('/api/media'),job=d.job||{};d.zotero.failures??=[];pilotActive=!!d.testScope?.enabled;
      const jobTitle=job.running?(job.stage==='scanning'?'Zotero 목록 확인 중':job.stage==='hashing'?`PDF 확인 ${num(job.scanned)} / ${num(job.pdfCount)}`:`Figure 처리 ${num(job.completed)} / ${num(job.total)}`):job.stage==='interrupted'?'작업 중단 · 이어서 실행 가능':job.stage==='error'?'작업 오류':pilotActive?'10편 시험 모드':job.mode==='zotero-all'&&job.stage==='complete'?'Zotero 전체 추출 완료':'PDF 라이브러리';
      const jobCounts=job.mode==='zotero-all'?`기존 결과 ${num(job.cached)} · 새 추출 ${num(job.extracted)} · 동일 PDF 중복 ${num(job.duplicates)} · 실패 ${num(job.errors)}`:'';
      const finished=wasRunning&&!job.running;wasRunning=!!job.running;
      if($('#mediaDialog').open){
        $('#zoteroRoot').placeholder=d.zotero.root;if(!$('#zoteroRoot').value)$('#zoteroRoot').value=d.zotero.root;
        $('#mediaJobStatus').innerHTML=`<strong>${esc(jobTitle)}</strong><span>${esc(job.running?job.current||'준비 중':job.error|| (pilotActive?'현재는 선택한 10편만 표시합니다. 아래 전체 추출 버튼을 누르면 Zotero 전체로 범위를 넓힙니다.':'완료된 PDF는 재사용합니다. 실패한 파일은 전체 추출을 다시 누르면 재시도합니다.'))}</span>${jobCounts?`<small>${esc(jobCounts)}</small>`:''}${job.warning?`<small>${esc(job.warning)}</small>`:''}`;
        $('#mediaStats').innerHTML=pilotActive?`<span><strong>${num(d.testScope.pdfHashes.length)}</strong>시험 PDF</span><span><strong>${num(d.testScope.ready)}</strong>추출 준비 완료</span><span><strong>${num(d.testScope.items.reduce((n,p)=>n+(p.figures||0),0))}</strong>번호 있는 Figure</span><span><strong>${num(d.zotero.available)}</strong>Zotero PDF 목록</span>`:`<span><strong>${num(d.zotero.available)}</strong>Zotero PDF</span><span><strong>${num(d.summary.ready)}</strong>Figure 준비</span><span><strong>${num(d.summary.available)}</strong>추출 대기</span><span><strong>${num(d.summary.review)}</strong>PDF 연결 검토</span>`;
        $('#mediaStop').hidden=!job.running;for(const id of ['mediaScan','mediaLocal','mediaAcquire','mediaZoteroAll'])$('#'+id).disabled=!!job.running;
        $('#mediaZoteroAll').textContent=job.running&&job.mode==='zotero-all'?'Zotero 전체 추출 중…':job.stage==='interrupted'&&job.mode==='zotero-all'?'Zotero 전체 추출 이어서 실행':'Zotero 전체 Figure 추출';
        $('#mediaAcquire').disabled=!!job.running||pilotActive;$('#mediaLimit').disabled=pilotActive;if(pilotActive)$('#mediaLimit').value='10';$('#mediaLocal').textContent=pilotActive?'시험 10편 다시 추출':'로컬 PDF Figure 추출';
        $('#mediaQueue').innerHTML='<h3>PDF 확보·연결 대기</h3>'+d.queue.slice(0,70).map(q=>`<article class="media-queue-item"><strong>${esc(q.title)}</strong><small>${esc(statusLabels[q.status]||q.status)} · ${num(q.count)}회 언급</small>${q.reason?`<p>${esc(reasonLabel(q.reason))}</p>`:''}<div>${q.url?`<a class="button" href="${esc(q.url)}" target="_blank" rel="noopener noreferrer">브라우저에서 열기 ↗</a>`:''}<button class="button" data-media-paper="${esc(q.paperId)}">PDF 연결·Figure 보기</button></div></article>`).join('')+(d.queue.length>70?`<p>상위 70개 / 전체 ${num(d.queue.length)}개 · 논문 상세에서도 PDF를 연결할 수 있습니다.</p>`:'');
        if(pilotActive)$('#mediaQueue').innerHTML='<h3>시험 대상 10편</h3>'+d.testScope.items.map(p=>`<article class="media-queue-item"><strong>${esc(p.title)}</strong><small>번호 있는 Figure ${num(p.figures)}개${p.figures===0?' · 첫 페이지 대체 표시':''}</small><button class="button" data-media-paper="${esc(p.paperId)}">Figure 갤러리 열기</button></article>`).join('');
        if(!pilotActive)$('#mediaStats').innerHTML=`<span><strong>${num(d.zotero.available)}</strong>Zotero PDF 파일</span><span><strong>${num(d.zotero.figureReady)}</strong>추출 완료 파일</span><span><strong>${num(d.zotero.figurePending)}</strong>미완료 파일</span><span><strong>${num(d.zotero.failureCount)}</strong>실패 파일</span>`;
        if(d.zotero.failures.length)$('#mediaQueue').insertAdjacentHTML('afterbegin','<h3>Zotero 추출 실패 · 다시 실행하면 재시도</h3>'+d.zotero.failures.map(pdf=>`<article class="media-queue-item"><strong>${esc(pdf.title||pdf.filename)}</strong><small>${esc(pdf.filename)}</small><p>${esc(pdf.error)}</p></article>`).join(''));
      }
      if(!job.running){if(state.selected&&!$('#drawer').hidden)await refreshPaper();if(finished||!$('#drawer').hidden||$('#mediaDialog').open)await load();return;}
      if(state.selected&&!$('#drawer').hidden)await refreshPaper();
      timer=setTimeout(poll,2200);
    }catch(e){toast(e.message);}
  }
  $('#mediaOpen').onclick=()=>{$('#mediaDialog').showModal();poll();};
  $('#closeMedia').onclick=()=>$('#mediaDialog').close();
  $('#mediaDialog').addEventListener('close',()=>{if(!wasRunning)clearTimeout(timer);});
  $('#mediaScan').onclick=()=>startJob({mode:'scan',zoteroRoot:$('#zoteroRoot').value});
  $('#mediaZoteroAll').onclick=()=>startJob({mode:'zotero-all',zoteroRoot:$('#zoteroRoot').value});
  $('#mediaLocal').onclick=()=>startJob({mode:'local',limit:Number($('#mediaLimit').value),force:pilotActive,zoteroRoot:$('#zoteroRoot').value});
  $('#mediaAcquire').onclick=()=>startJob({mode:'all',limit:Number($('#mediaLimit').value),zoteroRoot:$('#zoteroRoot').value});
  $('#mediaStop').onclick=async()=>{try{await post('/api/media/stop');await poll();}catch(e){toast(e.message);}};
  $('#mediaQueue').onclick=event=>{const b=event.target.closest('[data-media-paper]');if(b){$('#mediaDialog').close();openPaper(b.dataset.mediaPaper);}};
  function cropEditor(data){
    const root=panel();cropPaperId=data.paperId;let page=1,rect=null,start=null;
    root.innerHTML=`<div class="figure-heading"><h3>대표 Figure 영역 직접 선택</h3><button class="button" id="cancelCrop">갤러리로</button></div><p class="media-note">페이지 위에서 그림 전체를 드래그한 뒤 저장하세요.</p><label>페이지 <input type="number" id="cropPage" min="1" max="${data.pages}" value="1"> / ${data.pages}</label><div class="crop-surface" id="cropSurface"><img id="cropPageImage" alt="PDF 페이지"><div id="cropRectangle" hidden></div></div><button class="button primary" id="saveCrop" disabled>이 영역을 대표 이미지로 저장</button>`;
    const surface=$('#cropSurface'),image=$('#cropPageImage'),rectangle=$('#cropRectangle');
    const showPage=()=>{image.src=appUrl('/api/media/page?'+new URLSearchParams({id:data.paperId,page}));rect=null;rectangle.hidden=true;$('#saveCrop').disabled=true;};
    $('#cropPage').onchange=event=>{page=Math.max(1,Math.min(data.pages,Number(event.target.value)||1));event.target.value=page;showPage();};
    const position=e=>{const b=surface.getBoundingClientRect();return [Math.max(0,Math.min(1,(e.clientX-b.left)/b.width)),Math.max(0,Math.min(1,(e.clientY-b.top)/b.height))];};
    surface.onpointerdown=e=>{if(!image.complete||!image.naturalWidth)return;start=position(e);surface.setPointerCapture(e.pointerId);e.preventDefault();};
    surface.onpointermove=e=>{if(!start)return;const end=position(e);rect=[Math.min(start[0],end[0]),Math.min(start[1],end[1]),Math.max(start[0],end[0]),Math.max(start[1],end[1])];rectangle.hidden=false;Object.assign(rectangle.style,{left:rect[0]*100+'%',top:rect[1]*100+'%',width:(rect[2]-rect[0])*100+'%',height:(rect[3]-rect[1])*100+'%'});};
    surface.onpointerup=()=>{start=null;$('#saveCrop').disabled=!rect||rect[2]-rect[0]<.01||rect[3]-rect[1]<.01;};surface.onpointercancel=()=>{start=null;};
    $('#cancelCrop').onclick=()=>paintPanel(data);
    $('#saveCrop').onclick=async event=>{event.target.disabled=true;try{const d=await post('/api/media/crop',{paperId:data.paperId,page,rect});detailData=d;updateSummary(d);paintPanel(d);toast('직접 선택한 대표 이미지를 저장했습니다.');}catch(e){toast(e.message);event.target.disabled=false;}};
    showPage();
  }
  window.researchscapeMedia={render(p){cropPaperId=null;let root=panel();if(!root){root=document.createElement('section');root.id='figurePanel';root.className='figure-panel';$('#paperDetail .paper-links').after(root);}root.innerHTML='<h3>PDF · Figure</h3><p>PDF 연결 정보를 확인하는 중…</p>';refreshPaper(p.id);}};
})();
