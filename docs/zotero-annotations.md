# Zotero 10 프로젝트 동기화와 AI 주석

Node.js + Vanilla JavaScript + Python 구조를 그대로 사용합니다. Zotero SQLite와 원본 PDF는 읽기 전용이며, Zotero 변경은 공식 Local API를 통해서만 수행합니다. LLM API 호출·자동 라이브러리 쓰기·전체 논문 일괄 분석은 시작하지 않습니다.

## 최초 설정

1. `npm.cmd run figures:setup`으로 기존 PDF 도구를 설치합니다. pypdfium2와 pypdf를 재사용합니다.
2. Zotero 10을 실행하고 **설정 → 고급 → 이 컴퓨터의 다른 애플리케이션이 Zotero와 통신하도록 허용**을 켭니다.
3. `node server.mjs`를 실행합니다. 상단 **Zotero 동기화 → 연결 확인**에서 라이브러리를 선택합니다.
4. 쓰기 전에 **쓰기 권한 요청**을 누르고 Zotero 창에서 직접 승인합니다. 일회성 허용은 쓰기 요청 한 번에만 유효합니다. 여러 Collection과 항목을 처리하려면 “Always Allow / 항상 허용”을 선택하거나, 권한이 필요할 때 다시 승인하고 새 미리보기로 이어갑니다.

기본 주소는 `http://127.0.0.1:23119/api/`이며 서버 측 Node.js에서만 통신합니다. 격리된 검증 인스턴스는 `RESEARCHSCAPE_ZOTERO_API_URL=http://127.0.0.1:별도포트/api/`로 바꿀 수 있습니다. 외부 호스트·HTTPS 중계·임의 경로·리다이렉트는 허용하지 않습니다. 이 Zotero 포트를 Tailscale Serve나 인터넷으로 노출하지 마세요. 기존 Researchscape Tailscale 주소는 그대로 사용할 수 있습니다.

Local API Key는 클래스의 private 필드에 메모리로만 보관합니다. 서버 응답·export·로그·일반 JSON 파일에는 포함하지 않습니다. OS 자격 증명 저장소 연동은 하지 않았으므로 서버 재시작 후에는 다시 승인해야 합니다. Zotero 자체에 저장한 승인은 Zotero 설정에서 취소할 수 있습니다.

## Phase 1: 프로젝트 → Collection

**Zotero 동기화**에서 프로젝트를 직접 선택하고 처음에는 **1~3편**으로 미리보기합니다. 생성·재사용할 Collection, 프로젝트별 추가 예정 항목, 이미 포함된 항목, 모호해서 건너뛴 논문을 확인한 뒤 **최종 승인·적용**을 누릅니다.

- `Researchscape → 프로젝트명` 구조를 생성하거나 재사용합니다. 프로젝트 ID와 Collection Key를 저장하므로 이후 이름만으로 다시 매칭하지 않습니다. 같은 이름의 서로 다른 프로젝트는 구분된 Collection을 만듭니다.
- 사용자 itemKey/수동 PDF 연결 → 검증된 식별자 → 서지 검증된 정확한 제목 → 검증된 별칭 순으로 기존 매칭 코드를 재사용합니다. PDF 없는 Zotero 서지 항목도 포함합니다. 없는 논문은 자동 생성하지 않습니다.
- 식별자가 같고 제목이 충돌하거나, 명시 식별자가 다르거나, 수동 Key가 충돌하거나, 검증되지 않은 약칭이면 건너뜁니다.
- 적용 직전에 매칭과 최신 항목을 다시 확인하고 **기존 collections 전체 + 추가 Key**를 PATCH합니다. 412는 최신 상태로 최대 3회 재확인합니다. 삭제·제거·사용자 분류 초기화는 하지 않습니다.
- 401은 재승인, 403은 권한/설정 확인, 서버 ID 변경은 새 미리보기를 요구합니다. 부분 성공은 보존하며 재실행은 이미 있는 Collection·멤버십을 재사용합니다. 삭제된 기존 매핑은 임의 재생성하지 않습니다.

## Phase 2: LLM Annotation JSON

논문 상세 **PDF·Figure / AI 주석** 탭에서 **PDF 텍스트·위치 준비**를 누릅니다. 기존 PDF 연결·Figure·대표 썸네일·직접 Crop은 별도 탭에서 그대로 유지됩니다.

1. 중요 주석 수(초기값 8개, 허용 1~20개)와 대상 섹션/페이지 구간을 직접 선택합니다. 자동 감지한 섹션 제목은 텍스트 미리보기로 확인하세요.
2. 기본 **논문만 분석**에서는 개인 대화가 포함되지 않습니다. 선택한 자료 JSON과 프롬프트를 다운로드/복사해 외부 LLM에서 분석합니다. 앱은 LLM을 자동 호출하지 않습니다.
3. 반환 JSON을 파일로 선택하거나 붙여넣고 **항목 검증 후 제안으로 가져오기**를 누릅니다. 오류는 항목별로 표시하며 유효한 제안만 저장합니다.
4. 모든 입력은 `origin: "llm"`, `status: "proposed"`여야 합니다. 가져오기로 승인 상태·좌표·적용 내역을 주입할 수 없습니다. 동일 인용·출처의 재가져오기는 기존 제안·승인·사용자 수정을 보존합니다.

```json
{
  "schemaVersion": 1,
  "requestId": "분석용 JSON의 requestId",
  "paperId": "분석용 JSON의 paperId",
  "zoteroItemKey": "ITEM0001",
  "zoteroAttachmentKey": "PDF00001",
  "pdfHash": "분석용 JSON의 SHA-256",
  "annotations": [{
    "id": "method-1",
    "type": "highlight",
    "quote": "PDF에 실제로 있는 원문을 그대로 사용",
    "pageHint": 3,
    "category": "method",
    "color": "#2ea8e5",
    "comment": "AI 해석은 이 필드에만 기록",
    "reason": "중요한 방법론으로 선택한 이유",
    "origin": "llm",
    "status": "proposed",
    "scope": "paper",
    "contextRefs": []
  }]
}
```

JSON Schema는 `GET /api/annotations/schema`로 확인합니다. 위 예시의 Key·해시·requestId는 내보낸 값으로 바꿉니다. Zotero Key가 없으면 null입니다. requestId가 없는 기존 논문 전용 schemaVersion 1도 받지만, 대화 맥락 주석에는 실제 저장된 requestId와 contextRefs가 필요합니다.

| Category | 의미 | 초기 색상 |
| --- | --- | --- |
| research_question | 연구 문제·가설 | Yellow `#ffd400` |
| method | 방법론·모델 구조 | Blue `#2ea8e5` |
| result | 결과·수치 | Green `#a3e86f` |
| limitation | 한계·Future Work | Orange `#f19837` |

## Phase 3: 원문 위치와 미리보기

**인용 원문 위치 검증**은 PDF 해시를 새로 확인하고 PDFium의 문자 배열 Unicode·문자 Bounding Box를 사용합니다. PDFium의 문자열 인덱스와 문자 배열 인덱스가 달라질 수 있으므로 문자 배열을 직접 사용합니다. 공백·줄바꿈, 줄 끝 하이픈, soft hyphen, NFKC ligature 차이를 처리하되 정규화된 문자열의 각 문자를 원래 문자 위치로 역매핑하고 다시 검증합니다.

- `matched`: 문서 전체에서 유일한 인용 위치와 유효한 좌표를 확인했습니다.
- `ambiguous`: 반복되거나 좌표 근거가 부족합니다. pageHint는 검색 순서일 뿐 반복 위치를 임의 선택하지 않습니다.
- `unmatched`: 원문을 찾지 못했습니다. 인용문을 수정한 뒤 다시 검증하세요.
- `pdf_mismatch`: PDF 해시/연결 버전이 다릅니다. 예전 승인을 새 PDF에 적용하지 않습니다.

반복 인용은 위치 후보를 고르거나 페이지에서 정확한 문장 영역을 드래그해 고릅니다. 이 선택도 실제 검색된 원문 위치 중 유일한 것만 확정합니다. 임의의 사각형을 유효한 인용 좌표로 간주하지 않습니다. 여러 줄·단 사이의 큰 간격을 구분해 QuadPoints를 만들고 PDFium 좌표 변환으로 회전 페이지·화면 크기에 맞춘 정규화 SVG를 표시합니다.

페이지 WebP 렌더러는 기존 Figure Crop 코드를 재사용합니다. 캐시는 Figure와 분리되며 PDF 해시와 파서 버전으로 구분합니다. 페이지 전환은 PDF 전체를 다시 분석하지 않습니다. PDF는 기존과 같이 100MB/500페이지 제한이고 문자 맵은 최대 200만 문자입니다. 이미지 스캔의 OCR, 복잡한 회전/왜곡 텍스트, 페이지를 가로지르는 인용은 자동 확정하지 않을 수 있습니다. 첫 버전의 섹션 구분은 보수적인 텍스트 제목 감지입니다.

원문이 확인된 주석만 승인할 수 있습니다. 인용·코멘트·색상을 수정해 저장하면 다시 제안 상태가 되며, 인용을 바꾸면 위치도 재검증합니다. 안정적인 내부 ID는 사용자 편집으로 바뀌지 않습니다.

## Phase 4: Zotero와 PDF 사본에 반영

**Zotero 자식 노트 변경 미리보기**에서 신규/기존 관리 노트와 변경 전후를 보고 **최종 승인·저장**합니다. 노트는 Paper Annotation과 Research Context Annotation을 구분하고 원문, 페이지, AI 코멘트·근거, 생성 날짜, Researchscape paper/annotation ID, 선택한 대화 출처를 포함합니다.

고유한 출처 마커로 같은 관리 노트를 찾습니다. 반복 적용은 중복 노트를 만들지 않습니다. Zotero가 HTML을 정규화하는 경우도 보존하며, 사용자가 관리 노트를 직접 수정했거나 소유 내역을 확인할 수 없으면 갱신을 막습니다. 다른 사용자 노트는 수정하지 않습니다. 승인된 내용이 미리보기 뒤 바뀌면 다시 확인해야 하며 저장 중에는 같은 주석의 변경을 막습니다.

**승인된 하이라이트 PDF 사본 생성**은 `matched`·`approved`인 highlight만 표준 PDF `/Highlight`·`/QuadPoints`·색상·코멘트로 별도 사본에 삽입합니다. 원본과 기존 `/Annots`를 보존하고 파일을 덮어쓰지 않습니다. 동일 승인 내용은 기존 사본을 재사용합니다. 중단되어 기록이 없는 사본도 덮어쓰지 않고 새 파일로 복구합니다.

사본을 미리보기/다운로드한 뒤 **Zotero에 별도 첨부 → 사본 열기 → 파일 → Import Annotations / 주석 가져오기**로 처리합니다. 원래 첨부파일을 사본으로 교체하지 마세요. Zotero는 가져오기 과정에서 **사본에 포함된 외부 주석**을 자체 DB 주석으로 옮길 수 있습니다. 기존 원본 PDF나 기존 Zotero 주석은 이 앱이 수정·삭제하지 않습니다. 제품 코드는 비공개 내부 Annotation API, UI 자동화, SQLite 수정에 의존하지 않습니다.

## Phase 5: 연구 대화 맥락

**내 연구 맥락 포함 → 대화 맥락 목록 보기**에서 프로젝트·대화와 원문 발췌를 확인합니다. 아무 대화도 자동 선택하지 않습니다. 체크한 발췌의 시작/끝 문자 범위만 JSON에 포함되며, 선택하지 않은 발췌·주변 메시지·원본 전체 대화는 내보내지 않습니다.

연구 맥락 주석은 `scope: "research-context"`, 실제 선택한 `contextRefs: [mentionId]`를 사용합니다. 저장 시 서버가 원래 conversationId, messageId, projectId, mentionId, 선택 범위 원문과 원문 URL을 붙입니다. LLM이 임의의 대화 출처를 만들면 거부합니다. 개인 아이디어의 원문 위치가 명확하지 않으면 `type: "note"`, `quote: ""`로 작성합니다. 이 **위치 없는 연구 노트**만 예외적으로 PDF 좌표 없이 사용자 승인을 받아 자식 노트에 저장할 수 있으며, PDF 하이라이트에는 넣지 않습니다.

## 새 API

모든 mutation은 기존 Host/Origin 검사와 JSON 제한을 거칩니다. API Key는 어떤 응답에도 포함하지 않습니다.

| API | 기능 |
| --- | --- |
| GET `/api/zotero/status`, `/api/zotero/projects` | 연결·Server ID·라이브러리, ChatGPT 프로젝트 목록 |
| POST `/api/zotero/authorize`, `/api/zotero/forget` | 사용자에게 쓰기 승인 요청, 서버 메모리 키 폐기 |
| POST `/api/zotero/sync/preview`, `/api/zotero/sync/apply` | 프로젝트 Collection dry-run, `{planId, approved:true}` 적용 |
| GET `/api/annotations/schema`, `/api/annotations/prompt` | 출력 스키마·프롬프트 |
| GET `/api/annotations/paper?paperId=…` | PDF 준비 상태·제안·승인·사본 목록 |
| GET `/api/annotations/contexts`, `/api/annotations/section` | 명시적 선택용 대화/원문 구간 |
| POST `/api/annotations/prepare`, `/api/annotations/map` | 수동 로컬 텍스트 준비·위치 검증 작업 시작 |
| GET `/api/annotations/job`, POST `/api/annotations/stop` | 진행/중단·재시작 후 복구 상태 |
| POST `/api/annotations/export-input` | `{paperId, sectionIds, annotationLimit, mode, contextSelections}` |
| POST `/api/annotations/import` | `{paperId, payload}` 항목별 검증과 중복 제거 |
| POST `/api/annotations/review` | `{paperId, id, status}` 승인/제외 또는 편집 필드 저장 |
| POST `/api/annotations/resolve` | `{paperId, id, locationId}` 또는 `{page, rect:[x1,y1,x2,y2]}` |
| GET `/api/annotations/page?paperId=…&page=…` | 한 페이지 WebP |
| POST `/api/annotations/note/preview`, `/api/annotations/note/apply` | 자식 노트 dry-run, 명시적 승인 후 저장 |
| POST `/api/annotations/export-pdf`, GET `/api/annotations/download?exportId=…` | 별도 주석 PDF 작업·파일 |

## 저장과 기존 데이터 보존

기존 state 디렉터리(기본 `.local/`) 아래에 역할별로 저장합니다. 별도 데이터베이스·프레임워크나 기존 파일의 파괴적 마이그레이션은 없습니다.

| 경로 | 데이터 |
| --- | --- |
| `zotero-sync.json` | schemaVersion 1, 서버 ID별 라이브러리·프로젝트 ID/Collection Key, 예약 Key·부분 완료 상태 |
| `annotations.json` | schemaVersion 1, 안정적인 Annotation ID, 제안/승인/위치/원문·선택 출처, 입력 request packet, 노트 적용·PDF 사본 이력 |
| `annotation-layout/<SHA256>/pdfium-v2.json` | 문자·좌표 원본 캐시 |
| `annotation-layout/<SHA256>/summary-v2.json`, `page-N.webp` | 섹션/페이지 요약과 페이지 이미지 |
| `annotation-exports/<exportId>.pdf` | 원본을 수정하지 않은 PDF 주석 사본 |
| `annotation-jobs.json` | 로컬 작업 소유 프로세스·진행·중단 상태 |

새 기능은 기존 `media/state.json`, Figure 캐시·썸네일 선택·수동 Crop, Export·Mention·프로젝트 매핑·서지 검토 파일을 갱신하지 않습니다. 10편 시험 모드의 PDF 해시 허용 목록도 그대로 적용하며 이 기능이 시험 범위를 해제하지 않습니다. 새 데이터를 되돌리려면 서버를 종료하고 이 새 파일/폴더만 별도 보관하세요. 기존 파일을 옮길 필요는 없습니다. Server ID가 바뀐 경우 기존 Collection·버전 매핑을 새 라이브러리에 재사용하지 않습니다.

## 검증 수준과 한계

- Mock/격리 테스트: 프로젝트 반복·다중 포함·누락·식별자 충돌·기존 Collection 보존, 401/403/412/서버 변경, 자식 노트 중복 방지·사용자 수정 보호, 전체 API 흐름을 테스트합니다.
- 실제 PDF 도구: 합성 두 단 문서·회전 페이지·반복 문장·줄 끝 하이픈을 pypdfium2로 매핑하고, pypdf로 표준 Highlight 사본을 생성한 뒤 QuadPoints·기존 주석·원본 보존을 검증합니다. Unicode ligature 정규화는 별도 문자 역매핑 테스트로 확인합니다.
- 실제 논문: 기존 10편 시험 대상 중 2편에서 텍스트 준비 → 선택 자료 JSON → 제안 import → 원문 좌표 매핑 → 로컬 승인 → 별도 PDF 생성까지 확인했습니다. 원본 PDF SHA-256과 기존 검토·Figure 상태 파일이 유지됐습니다. 테스트용 승인/사본은 분리된 검증 디렉터리에만 저장했으며, 실제 Zotero에는 쓰지 않았습니다.
- 브라우저: 합성 2단 문서에서 JSON 붙여넣기, 인용 수정, 반복 위치 직접 선택, 승인, PDF 생성, 선택한 대화 범위만 export를 확인했습니다. 780px 화면에서 원문과 SVG 하이라이트가 정렬됐고, Tailscale 하위 경로에서도 새 UI를 불러옵니다.
- 실제 Zotero 10: 설치된 10.0.8의 분리된 빈 프로필(별도 데이터 디렉터리·포트)에서 Local API v3 읽기, Server ID, 라이브러리/Collection 목록과 쓰기 없는 dry-run을 확인했습니다. **실제 쓰기 승인·Collection/노트 쓰기·외부 Highlight 인식/Import는 미검증**입니다. Windows 화면 입력이 접근 거부로 차단되어 화면 검증을 완료하지 못했습니다. Mock 성공을 실제 라이브러리 쓰기 성공으로 표현하지 않습니다.

이번 검증에서 `npm.cmd test`는 87개 통과(실패·건너뜀 0), `npm.cmd run check`는 JavaScript 42개와 Python 구문 검사를 통과했습니다. 기존 Figure·Crop·서지 검토 테스트를 포함합니다. PDF 사본은 PDFium으로 다시 렌더링해 하이라이트 위치와 기존 주석 보존을 시각적으로 확인했습니다.

실환경 후속 확인은 격리된 Zotero 라이브러리의 논문 1편으로 진행하세요. 권한 승인 후 Collection 추가·반복 동기화, 자식 노트 생성·재적용, 별도 PDF 첨부 후 Import Annotations 순서로 확인합니다. 원래 사용자 첨부파일을 교체하거나 테스트를 위해 기존 주석을 삭제하지 마세요. OCR, 복잡한 텍스트 회전, OS 자격 증명 저장소 연동 및 확인된 자동 Annotation 가져오기는 후속 개선 범위입니다.

공식 근거: [Zotero Local API](https://www.zotero.org/support/dev/web_api/v3/local_api), [Write Requests](https://www.zotero.org/support/dev/web_api/v3/write_requests), [PDF 외부 주석과 Import](https://www.zotero.org/support/kb/annotations_in_database), [격리된 프로필/인스턴스](https://www.zotero.org/support/kb/multiple_instances), [pypdfium2 좌표](https://pypdfium2.readthedocs.io/en/stable/python_api.html), [pypdf Highlight](https://pypdf.readthedocs.io/en/stable/user/adding-pdf-annotations.html).
