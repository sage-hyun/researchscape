# PDF 확보와 Figure 대표 이미지

상단 **PDF·Figure**에서 Zotero PDF를 연결하고 Figure를 일괄 추출합니다. **논문 목록**의 썸네일, 논문 상세의 갤러리, 그래프 노드의 마우스 미리보기에서 사용합니다.

현재 개인 환경은 **선택한 PDF 10편의 시험 모드**로 시작합니다. `media/test-scope.json`의 해시 목록에 든 PDF만 추출·크롭·썸네일 표시를 허용하며, 새로운 PDF 자동 수집은 중지합니다. **Zotero 전체 Figure 추출**을 직접 누르면 시험 제한을 해제하고 기존 캐시를 재사용해 Zotero 전체를 처리합니다. 버튼을 누르기 전에는 범위를 늘리거나 새 추출을 시작하지 않습니다.

## Zotero 전체를 백그라운드에서 추출

상단 **PDF·Figure → Zotero 전체 Figure 추출**을 누르세요. 처리 수 선택과 무관하게 Zotero에 실제로 내려받은 로컬 PDF 전체를 대상으로 합니다. 대화에 연결되지 않은 PDF도 추출 캐시를 만들지만, 모호한 논문 후보와 임의로 연결하지 않습니다. 없는 PDF를 추가 다운로드하는 동작은 포함하지 않습니다.

1. Zotero 목록을 읽기 전용으로 갱신합니다.
2. PDF의 SHA-256을 확인해 같은 내용의 첨부파일은 한 번만 처리합니다.
3. 완료된 결과를 재사용하고, 나머지 PDF를 한 편씩 로컬에서 처리합니다.
4. 기존 결과·새 추출·중복·실패 수와 현재 파일을 화면에 표시합니다. 실패 목록에는 이유가 남습니다.
5. **작업 중단** 후 전체 추출을 다시 누르면 완료된 PDF는 건너뛰고 미완료·실패 파일을 재시도합니다. 서버 재시작 후에도 같습니다.

브라우저 창을 닫거나 다른 페이지로 이동해도 **이 PC의 Researchscape Node 서버가 실행 중이면** 계속됩니다. 서버 종료·PC 절전/종료 중에는 처리되지 않으며, 서버가 다시 켜진 뒤 버튼을 눌러 이어갑니다. 별도의 Windows 서비스나 예약 작업을 설치하지 않습니다. LLM 호출·GPU·API 키는 필요하지 않습니다. 스캔 문서처럼 본문 텍스트나 캡션이 없는 PDF는 그림을 못 찾을 수 있으며 첫 페이지 대체 이미지 또는 오류로 남습니다.

## PDF를 확보하는 순서

1. **Zotero 목록 갱신**: 기본 `~/Zotero/zotero.sqlite`와 `storage/`를 읽습니다. 대화의 DOI/arXiv ID, 구체적인 정식 제목, 기존에 입력한 Zotero Key와 비교합니다. 파일명만 비슷하다고 연결하지 않습니다. Zotero 데이터 폴더는 화면에서 바꿀 수 있습니다.
2. **로컬 PDF Figure 추출**: 확실하게 연결된 PDF를 순차 처리합니다. 이미 처리한 동일 PDF는 SHA-256으로 재사용합니다. PDF가 여러 개면 보조자료를 제외한 유일한 본문을 우선하며, 남은 후보가 모호하면 직접 고르게 합니다.
3. **없는 PDF 확보·추출**: 등록된 PDF URL, arXiv·OpenReview·ACL·CVF·PMLR 등의 경로를 사용합니다. 논문 페이지가 `citation_pdf_url`을 제공하면 그 PDF로 이어갑니다. 받은 PDF의 첫 페이지 제목/식별자를 대조하고, 확인되지 않으면 연결 검토 대상으로 남깁니다.
4. **브라우저에서 받기**: 로그인·기관 접근·사람 확인이 필요하면 대기 목록의 링크를 열어 사용자가 직접 완료합니다. PDF를 받은 뒤 논문 상세의 **PDF 파일 연결**에서 선택합니다. 다운로드 폴더나 브라우저 쿠키를 몰래 수집하지 않으며, paywall/CAPTCHA를 우회하지 않습니다. 브라우저 확장 설치도 필요 없습니다.

논문 상세의 **다른 로컬 PDF 선택**에서는 Zotero와 Researchscape가 보관한 PDF를 검색해 수동으로 연결할 수 있습니다. 받은 파일이 실제로 같은 논문인지 확인한 후 연결하세요. 수동 PDF 연결은 자동 대조보다 우선합니다. Zotero 자체의 첨부파일·항목 Key를 덮어쓰지는 않습니다.

약칭은 검증된 별칭 사전의 정식 제목과 식별자가 둘 다 일치할 때만 자동 연결합니다. 사전에 없는 약칭은 관련 PDF가 한 개여도 직접 확인하는 후보로만 제공합니다. 일반 기술·학회·데이터셋 명칭은 논문으로 확인하거나 PDF를 직접 선택하기 전까지 자동 연결하지 않습니다.

## Figure 추출과 대표 이미지

OpenDataLoader PDF의 **로컬 결정적 모드**를 사용합니다. `hybrid="off"`이며 PDF를 AI 서비스에 업로드하지 않습니다. 캡션은 JSON의 `caption`뿐 아니라 문단과 목록 항목에서도 찾습니다. `linked content id`, 같은 페이지의 이미지 위치, 본문 경계를 대조하고 PDFium으로 해당 페이지 영역을 렌더링합니다. 이미지 조각만 추출하는 방식과 달리 벡터 도형·텍스트·여러 패널도 렌더링에 포함됩니다. 중첩 Form XObject의 좌표 변환도 적용합니다.

- 기본 대표 이미지: **Figure 1 → 첫 번째 번호 있는 Figure → 첫 페이지** 순서입니다. 첫 페이지 대체 이미지를 Figure 1이라고 표시하지 않습니다.
- 다른 Figure를 클릭하면 즉시 대표 이미지로 저장합니다. **Figure 1 기본값**으로 수동 선택을 해제할 수 있습니다.
- **영역 직접 선택**: 페이지를 고르고 그림 전체를 드래그해 새 대표 이미지로 저장합니다.
- 사용자 선택과 직접 자른 영역은 자동 추출 결과와 따로 보관하므로, 같은 PDF를 다시 파싱해도 초기화하지 않습니다.
- 자동 연결이 불확실한 영역은 **확인 권장**으로 표시합니다. 모든 PDF에서 Figure 전체를 완벽히 자르는 것은 아닙니다. 복잡한 배치, 스캔, 캡션 위/아래가 뒤섞인 그림은 직접 영역 선택을 사용하세요. OCR·유료/외부 AI backend는 기본 설치에 포함하지 않습니다.

PDF는 최대 100MB/500페이지, 한 번에 한 문서씩 처리합니다. 한 영역의 렌더링은 최대 약 500만 픽셀입니다. PDF와 잘못된 HTML/로그인 응답을 구별하고, 실패한 다운로드를 PDF로 저장하지 않습니다. 요청은 제공자별로 간격을 두고, 401/403/429는 대기 시각을 저장합니다. 실패한 원문은 논문 미존재로 판정하지 않습니다.

## 설치와 실행

Node.js 외에 **Python 3.11+**, **Java 11+**가 필요합니다. 설치 명령은 프로젝트의 Git 제외 폴더에 Python 가상환경을 만듭니다. 기존 Python 환경의 패키지는 재사용할 수 있습니다.

```powershell
npm.cmd run figures:setup
node server.mjs
```

브라우저의 **PDF·Figure** 버튼에서 시작하세요. 개별 논문에 연결된 로컬 PDF 처리의 기본 수는 10편입니다. **Zotero 전체 Figure 추출**은 이 선택과 별개로 Zotero의 모든 로컬 PDF를 처리합니다. 작업 중단 후 다시 시작하면 완료된 PDF를 건너뜁니다. 서버가 종료되어도 완료 단계는 남습니다.

CLI에서도 같은 개인 상태와 추출 캐시를 사용합니다.

```powershell
npm.cmd run figures:scan
node scripts/figures.mjs --zotero-all  # 시험 제한 해제 + Zotero 로컬 PDF 전체 추출
node scripts/figures.mjs --limit 20
node scripts/figures.mjs --limit all
node scripts/figures.mjs --acquire --limit 20
node scripts/figures.mjs --paper "논문ID" --force
```

선택 설정: `RESEARCHSCAPE_ZOTERO_DIR`(Zotero 데이터 폴더), `RESEARCHSCAPE_FIGURE_PYTHON`(사용할 Python 실행파일). `figures:setup`은 `.local/figure-venv/`에 설치합니다.

## 저장 위치와 원본 보존

개인 state 폴더의 `media/`(기본 `.local/media/`)에만 저장합니다. 코드 저장소의 Git 제외 규칙이 적용됩니다.

| 경로 | 내용 |
| --- | --- |
| `zotero.json` | Zotero PDF 목록·파일 위치·메타데이터·해시 |
| `cache/zotero-snapshot.sqlite` | 원본과 분리된 읽기용 DB 사본 |
| `state.json` | PDF 연결, 수동 대표 이미지 선택, 직접 자른 영역, 다운로드 출처와 결과, Zotero 첨부별 추출 성공·실패 |
| `job.json` | 진행 상태·소유 프로세스·오류 |
| `pdfs/<SHA256>.pdf` | 새로 다운로드하거나 직접 연결한 PDF |
| `figures/<SHA256>/` | 레이아웃 JSON·Figure WebP·페이지 미리보기 |

기존 Zotero PDF는 복사하거나 수정하지 않고 원래 경로를 참조합니다. Zotero DB는 읽기 전용 연결로 일관된 사본을 만들고, 독점 잠금이 있으면 WAL이 비어 있고 복사 전후 파일이 그대로인 경우에만 안정된 사본을 사용합니다. 안전한 사본을 만들 수 없으면 재시도 안내를 표시합니다. 연결된 외부 경로의 첨부파일은 임의로 읽지 않고 직접 PDF 연결을 요청합니다.

기존 대화 Export, Mention·발췌·프로젝트 매핑, `reviews.json`, `bibliography-decisions.json`은 PDF 기능이 수정하지 않습니다. 개인 상태를 다른 PC로 옮기면 Zotero 경로를 맞추고 목록을 다시 읽으세요. 수동 선택·크롭이 있는 `media/state.json`과 `media/figures/`도 백업해야 합니다.

원본 PDF와 추출 이미지는 개인 로컬 사용을 위한 데이터입니다. 공개 서비스로 Figure를 재배포할 계획이라면 각 논문의 이용 조건을 별도로 확인해야 합니다.

사용한 도구: [OpenDataLoader PDF](https://github.com/opendataloader-project/opendataloader-pdf), [출력 JSON 스키마](https://github.com/opendataloader-project/opendataloader-pdf/blob/main/schema.json), [pypdfium2](https://pypdfium2.readthedocs.io/en/stable/python_api.html).
