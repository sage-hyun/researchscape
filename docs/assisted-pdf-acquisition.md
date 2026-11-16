# 반자동 PDF 확보와 Zotero 저장

기존 PDF 자동 수집기, 읽기 전용 Zotero 스냅샷, Figure/Crop 캐시와 Zotero 10 인증 클라이언트를 확장합니다. 별도 확장 프로그램·데이터베이스·LLM API는 도입하지 않습니다. 자동 다운로드가 실패한 논문은 사용자가 원문 브라우저에서 처리하고 Researchscape로 돌아와 재확인합니다.

## 사용 순서

1. Zotero 10을 실행하고 **설정 → 고급 → 이 컴퓨터의 다른 애플리케이션이 Zotero와 통신하도록 허용**을 켭니다. 기본 Local API는 `http://127.0.0.1:23119/api/`입니다. 포트를 외부에 공개하지 마세요.
2. Chrome·Edge·Firefox·Safari의 [공식 Zotero Connector](https://www.zotero.org/download/)를 사용합니다. Researchscape 자체 확장 프로그램은 필요 없습니다.
3. 상단 **PDF 확보** 팝업에서 PDF 유무·프로젝트·확보 상태를 선택하고 전체/사용자 언급순으로 정렬합니다. 기본은 PDF 없는 논문만, 페이지당 40편입니다.
4. **선택 범위 자동 확보·추출**은 선택한 프로젝트·상태 범위에 있는 미확보 PDF만 대상으로 기존 수집기를 실행합니다. 개별 재시도도 가능하며, 제공자별 cooldown은 건너뛰지 않습니다. 중단 후 재개하면 원래 논문 범위·정렬·한도를 재사용하고 완료한 파일과 Figure를 건너뜁니다.
5. 실패한 논문의 **브라우저에서 열기**를 펼쳐 확인된 PDF/출판사/DOI/arXiv/OpenReview 주소를 선택합니다. 사용자가 로그인·기관 인증·CAPTCHA를 직접 처리합니다. Connector로 원문 페이지에서 저장하는 방법을 우선 권장합니다.
6. Researchscape로 돌아와 **Zotero에서 다시 확인**을 누릅니다. Local API로 새 항목과 첨부파일을 읽고, 확실하게 연결된 PDF는 Figure 캐시를 재사용하거나 추출합니다. 같은 서지정보의 여러 항목은 중복 후보의 제목·Key로 표시하고 자동 병합하지 않습니다.
7. 직접 받은 파일은 **PDF 파일 업로드/연결**에서 고릅니다. 파일·크기·SHA-256과 첫 페이지의 제목/DOI/arXiv를 검사하고, PDF 미리보기를 본 뒤 확인란과 **PDF 연결 승인·Figure 추출**로 연결합니다. 불명확한 파일은 명시적인 사람 확인이 필요하며, 식별자가 충돌하는 파일은 새 업로드 절차에서 연결을 거부합니다.
8. 로컬 PDF를 Zotero로 옮기려면 **PDF 없는 논문만**을 해제하고 **Zotero에 저장**을 누릅니다. 기존 논문·기존 PDF·추가할 파일의 해시를 미리 보고, 필요할 때 쓰기 권한을 요청한 뒤 최종 승인합니다. 노트/주석·기존 PDF는 덮어쓰지 않습니다.

기존 **Zotero 목록 갱신**의 SQLite 스냅샷 방식도 유지됩니다. 실행 중인 Zotero의 쓰기 잠금 때문에 스냅샷을 만들기 어려울 때는 새 **Zotero에서 다시 확인**이 공식 Local API를 사용합니다. 데이터 폴더 설정은 실제 Zotero의 `storage/`가 있는 폴더여야 합니다. 연결 파일이나 다른 폴더의 파일은 자동으로 읽지 않고 직접 업로드를 요청합니다.

PDF 확보와 Figure 추출은 상단의 독립된 팝업으로 분리됩니다. PDF 확보의 처리 수는 최대 20/100/3,000편 중 선택하며, Figure 추출의 처리 수와 별도로 관리합니다. **10편 시험 제한은 폐지했습니다.** 예전 `media/test-scope.json`은 기록으로 보존하지만 `enabled: true`여도 해시 목록으로 접근을 제한하지 않습니다. 서버 시작·팝업 열기만으로 수집·추출·Zotero 쓰기를 시작하지 않습니다. 기존 캐시·PDF 연결·선택 이미지·Crop은 그대로 재사용합니다.

## 상태와 실패 원인

기존 `media/state.json`의 내부 상태를 유지하며 별도 UI 상태를 계산합니다.

| UI 상태 | 의미 |
| --- | --- |
| `available_in_zotero` | 연결된 Zotero PDF 또는 동일 SHA-256 파일 확인 |
| `downloaded_locally` | 로컬 PDF 확보·연결 완료, Zotero 저장 가능 |
| `download_available` | 확인된 자동 다운로드 경로 있음; 속도 제한/네트워크 실패도 원인과 함께 표시 |
| `needs_browser` | HTTP 401/403 또는 PDF 대신 HTML 반환 |
| `needs_manual_upload` | 현재 확인된 원문 주소 없음; 직접 PDF 확보 필요 |
| `needs_identity_review` | 다운로드/업로드 식별 확인 또는 PDF 선택 필요 |
| `unavailable` | 확인된 다운로드 경로가 모두 404로 실패 |

403은 **접근 제한 또는 브라우저 확인 필요**라고만 표시합니다. HTML에 실제 로그인/사람 확인 문구가 있는 경우에만 `login-page`/`human-check`로 분류합니다. 429는 `Retry-After`와 제공자 cooldown을 보존하고, 잘못된 날짜도 안전한 기본 대기 시간으로 처리합니다. 실패한 경로별 HTTP·원인·재시도 시각을 저장합니다. 네트워크 실패는 논문 미존재 판정으로 사용하지 않습니다.

arXiv, OpenReview, ACL, CVF, PMLR, 기존 메타데이터 PDF 링크와 `citation_pdf_url`을 그대로 사용합니다. 기존 서지 조회가 이미 가져온 OpenAlex `best_oa_location`/`locations[].pdf_url`, Semantic Scholar `openAccessPdf`를 재사용하므로 중복 조회기를 만들지 않았습니다. [Unpaywall API](https://data.unpaywall.org/products/api)는 이메일을 요구하므로 별도 자동 호출은 추가하지 않았습니다. 기존 서지 조회 화면에서 검증한 공식 링크를 갱신할 수 있습니다.

## Zotero 10 쓰기 방식

[Local API 공식 문서](https://www.zotero.org/support/dev/web_api/v3/local_api)와 [파일 업로드 문서](https://www.zotero.org/support/dev/web_api/v3/file_upload)의 full-upload 절차를 사용합니다. SQLite에 직접 쓰거나 비공개 내부 API·Connector 내부 메시지에 의존하지 않습니다.

1. 서버 ID와 라이브러리/기존 논문 항목을 확인하고 PDF의 SHA-256·MD5를 계산합니다. MD5는 업로드 프로토콜용이고, 동일 파일 판정은 실제 파일의 SHA-256으로 합니다.
2. 기존 자식 PDF를 읽어 같은 SHA-256이면 쓰기 없이 재사용합니다. 같은 MD5지만 로컬 파일을 읽을 수 없으면 중복 가능성 검토를 요청합니다. 다른 파일은 보존합니다.
3. 기존 서지 항목이 없으면 사용자가 **기존 항목 선택**, **검증된 서지정보로 새 항목 생성 미리보기**, **저장 보류** 중 선택합니다. 새 항목은 검증된 정식 제목과 DOI/arXiv가 있어야 하며 최종 승인 전에는 생성하지 않습니다. 기존 수동 itemKey와 충돌하는 선택은 거부합니다.
4. 새 첨부파일 Key를 먼저 기록하고 `POST <library>/items`로 `imported_file` 자식 첨부파일을 생성합니다. 기존 첨부 Key는 수정 대상으로 쓰지 않습니다.
   직접 Key를 지정하는 새 항목/첨부파일/Collection/노트에는 `version: 0`을 보냅니다. 실환경에서 확인한 생성 전제조건이며, 이미 존재하는 객체를 새 객체로 오인해 갱신하는 것도 막습니다. HTTP 200의 객체별 `failed` 결과도 실패로 처리해 코드·원인을 표시하고 키는 마스킹합니다.
5. `POST <library>/items/<newKey>/file`에 form 형식으로 MD5/파일명/크기/mtime과 `If-None-Match: *`를 보냅니다.
6. 응답이 가리킨 **동일 loopback origin의 `/api/local/uploads/<uploadKey>`**에 파일을 전송합니다. 이 요청에는 Local API Key를 보내지 않으며 업로드 URL·capability key도 브라우저나 상태 JSON에 반환하지 않습니다.
7. 같은 파일 endpoint에 `upload=<uploadKey>`와 `If-None-Match: *`를 보내 등록하고, 실제 저장된 파일을 다시 읽어 SHA-256을 검증합니다.
8. Local API 목록을 다시 읽고 PDF 연결을 갱신한 뒤 Figure 캐시를 재사용합니다.

기존 Collection·노트·PDF·Zotero Annotation을 수정하거나 지우는 요청은 없습니다. 다른 PDF가 들어 있는 기존 첨부파일에 파일을 업로드하는 경로도 없습니다. 412는 파일을 덮어쓰지 않고 재확인을 요청합니다. 401/403·연결 실패는 단계와 함께 보존합니다. 권한은 기존 Zotero 클라이언트를 공유하고 키는 서버 메모리에만 둡니다. 일회성 허용은 쓰기 한 번마다 소모되므로 여러 단계에서는 재승인 후 새 미리보기로 재개하거나 Zotero에서 반복 사용을 승인해야 합니다.

작업 중단/서버 재시작 후에도 예약된 새 항목·첨부 Key를 재사용합니다. 이미 생성한 빈 첨부파일을 자동 삭제하지 않으며 다음 실행에서 채웁니다. 사용자가 그 항목을 옮기거나 바꿨으면 저장을 중지합니다. 브라우저를 닫아도 Node 서버가 실행 중이면 명시적으로 시작한 작업은 이어집니다.

## API와 저장 구조

| API | 용도 |
| --- | --- |
| GET `/api/acquisition` | `projectId`, `missingOnly`, `status`, `sort`, `offset`, `limit`에 따른 목록과 작업 상태 |
| POST `/api/acquisition/collect` | `{projectId, status, sort, limit}` 또는 `{paperId}` 수집, `{resume:true}` 재개 |
| POST `/api/acquisition/recheck` | `{paperId, library, extract}` Local API 재확인·중복 후보·Figure 연계 |
| POST `/api/acquisition/upload?paperId=…&filename=…` | PDF binary, 최대 100MB; 검사 결과와 임시 planId 반환 |
| POST `/api/acquisition/upload/confirm` | `{paperId, planId, approved, identityConfirmed, extract}` 검토 후 연결 |
| POST `/api/acquisition/zotero/preview` | `{paperId, library, itemKey?, createItem?}` 쓰기 없는 저장 미리보기 |
| POST `/api/acquisition/zotero/apply` | `{paperId, planId, approved:true, extract}` 승인한 새 첨부 저장 |
| GET `/api/acquisition/job`, POST `/api/acquisition/stop` | 저장/재확인 진행·중단 |

Host/Origin·JSON/PDF 크기 검사는 기존 서버 경계를 재사용합니다. PDF 파일은 기존 `media/pdfs/<SHA256>.pdf`에 중복 없이 저장합니다. 새 UI의 검토 대기 PDF는 `pendingIdentity`로 표시하고 자동 매칭에서 제외합니다. 기존 `/api/media/upload`의 명시적 수동 연결 API는 하위 호환성을 위해 유지되며, 제품의 파일 업로드 UI는 새 검사·승인 절차를 사용합니다.

새 `.local/pdf-acquisition.json`은 schemaVersion 1, Zotero Server ID → library → 예약 parent/attachment Key·PDF 해시·완료 단계를 저장합니다. `.local/pdf-acquisition-job.json`은 소유 PID·진행·중단 결과를 저장합니다. 모두 Git 제외입니다. `media/zotero.json`에는 API로 확인한 목록의 서버/라이브러리 정보와 해시를 보존합니다. 기존 파일 구조와 키를 읽는 파괴적 마이그레이션은 없습니다. ChatGPT Export·Mention·프로젝트·서지 검토 기록은 수정하지 않습니다.

## 검증 범위

새 회귀 테스트는 프로젝트별 범위·정렬, arXiv 응답 성공, 401/403/429, HTML 로그인, 업로드 검토·잘못된 식별자·중복 파일, Connector가 저장한 형태의 새 PDF/중복 항목 감지, 기존 첨부/주석 보존, 3단계 업로드·SHA 검증, 새 서지 항목의 명시적 생성, 단일 사용 키 재승인, 업로드 중단/재시작·예약 Key 재사용을 확인합니다. HTTP 통합 테스트는 실제 PDF·PDFium/OpenDataLoader Figure 처리와 Mock Zotero를 사용합니다. 기존 Figure·Crop·썸네일·서지·주석 테스트도 함께 실행합니다.

팝업 분리·시험 제한 폐지 후 전체 103개 테스트가 통과했습니다. 예전 시험 설정을 둔 채 로컬 PDF 12편을 처리하고, 재시작 후 허용 목록 밖 썸네일·Crop·수동 선택을 유지하는 회귀 테스트를 포함합니다. 실제 브라우저에서는 Tailscale 하위 경로에서 두 팝업의 독립성, 프로젝트·상태 필터, 자동 확보 버튼 활성화, 버튼 높이 42px 정렬과 좁은 화면의 가로 넘침 없음을 확인했습니다. 이 UI 점검 중 실제 PDF 일괄 수집이나 개인 Zotero 쓰기는 실행하지 않았습니다.

**실제 사용자 Zotero 라이브러리에는 쓰지 않았습니다.** 설치된 Zotero 10.0.8의 별도 빈 프로필·데이터 폴더·포트에서 사용자가 쓰기를 승인한 뒤 합성 논문 1편으로 실제 새 항목 생성, 자식 PDF 3단계 업로드, 저장된 SHA-256 검증, 동일 PDF 재사용, Collection 동기화·재실행, 자식 노트 생성·재적용을 확인했습니다. Zotero 리더에서 표준 Highlight 2개의 원문·색상·코멘트 인식과 Import Annotations를 통한 DB 주석 전환도 확인했고, 기존 합성 PDF 메모 1개와 Researchscape의 원본 사본은 보존됐습니다. 실제 기관 로그인·CAPTCHA·Connector 저장 자체는 별도 확인이 필요합니다. Connector가 단독 첨부파일만 저장했거나 파일이 클라우드에만 있으면 Zotero에서 부모 항목을 연결하거나 파일을 내려받은 뒤 재확인하세요. Linked File 자동 탐색·다운로드 폴더 감시·브라우저 세션/쿠키 접근·접근 제한 우회는 구현하지 않습니다.

실행 결과: 전체 Node 테스트 102개 통과(실패·건너뜀 0), JavaScript 46개와 Python 구문 검사 통과. 브라우저에서 합성 PDF의 업로드 검사·사용자 승인·Mock Zotero 첨부·재확인·동일 해시 재사용·Figure 표시를 확인했습니다. 공개 arXiv MAML PDF 1편의 실제 HTTP 다운로드와 첫 페이지 식별도 성공했으며, 기존 시험 대상 파일과 SHA-256이 같았습니다. 이 실제 논문 파일은 검증 폴더에만 저장했고 Zotero에는 업로드하지 않았습니다. 실환경 Zotero 쓰기 검증에는 합성 PDF만 사용했습니다.
