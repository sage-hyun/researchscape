# 서지 검토 JSON과 LLM 결과 가져오기

상단 **서지 정리 → 서지 검토 → 통합 검토 목록**에서 사용합니다. 기존 연결 후보와 LLM 검토 결과가 candidateId별로 합쳐지며 별도의 하단 연결 후보 화면은 없습니다. 이 기능 자체는 LLM을 호출하지 않습니다. 대화 본문·발췌·프로젝트명·Zotero Key를 내보내지 않습니다.

기본 화면에는 네 가지만 있습니다.

1. **전체 LLM 검토 JSON 다운로드**: 미연결 후보 전체를 파일 하나로 받습니다.
2. **LLM 검토 결과 JSON 가져오기**: LLM이 작성한 결과 파일을 건수 제한 없이 한 번에 가져옵니다. 파일을 여러 개 선택하면 하나의 가져오기로 합칩니다.
3. **통합 검토 목록**: 상태·LLM 근거·제목으로 필터링하고, 각 행에서 연결할 공식 논문 또는 제외·별도 유지를 선택합니다. 중복은 한 행으로 합치고 50건씩 페이지를 나누므로 60건 이후 후보도 모두 검토할 수 있습니다.
4. **선택한 N건 최종 승인·적용**: 직접 선택한 항목만 저장합니다.

그룹별·묶음별 다운로드, LLM 배치 크기, JSON 직접 붙여넣기, 결과 스키마, 전체 진단 JSON은 **고급 설정**에 있습니다.

## 전체 검토 JSON

`GET /api/bibliography/export?format=bundle` (선택: `&batchSize=50~100`, 기본 80)

```json
{
  "schemaVersion": 2,
  "kind": "llm-review-bundle",
  "snapshot": "64자리 16진수",
  "generatedAt": "2026-11-16T09:00:00.000Z",
  "total": 1220,
  "totals": {"withCandidates": 600, "withoutCandidates": 620},
  "batchSize": 80,
  "batches": [{"batchId": "b001", "index": 1, "offset": 0, "count": 80, "withCandidates": 31, "withoutCandidates": 49}],
  "instructions": {"task": "…", "batching": "…", "decisions": {}, "rules": [], "evidenceTypes": [], "resultSchema": "…"},
  "resultTemplate": {"schemaVersion": 2, "snapshot": "같은 값", "batchIds": [], "decisions": []},
  "items": [
    {"candidateId": "name:example", "title": "Example", "count": 4, "reason": "similar-title-or-alias",
     "candidateStatus": "with-candidates", "batchId": "b001",
     "candidates": [{"recordId": "doi:10.1234/example", "title": "…", "authors": [], "year": 2024, "doi": [], "arxiv": [], "evidenceTypes": []}]}
  ]
}
```

- 연결 후보가 있는 항목과 없는 항목을 한 파일에 담고 candidateId 기준으로 중복을 제거합니다. 이미 연결되었거나 사용자가 분리한 항목은 제외합니다.
- 그룹은 각 항목의 `candidateStatus`(`with-candidates` / `without-candidates`)와 `candidates` 배열로 구분합니다.
- 언급 수 내림차순, 같으면 candidateId 순입니다.
- `batches[]`는 같은 파일 안의 논리 구간입니다. 파일을 나누어 받지 않습니다. LLM이 전체를 한 번에 읽을 수 있다고 가정하지 않으므로 `offset`·`count` 구간(또는 item의 `batchId`)을 따라 한 배치씩 처리하게 합니다. `instructions`와 `resultTemplate`에 작성 방법이 들어 있습니다.
- 항목 필드는 기존 compact와 같은 허용 목록(`candidateId`, `title`, `count`, `reason`, `candidates`)에 `candidateStatus`, `batchId`만 더했습니다. source URL, 조회 시각, 긴 링크 객체, 대화·메시지 ID, 유사도 점수는 넣지 않습니다. `same-conversation`은 약한 문맥 단서이며 신원 확인 증거가 아닙니다.
- 내려받을 때 서버는 그 snapshot의 후보별 요약(제목과 연결 후보 ID의 해시)을 `review-exports/`에 최근 12개까지 기록합니다. 결과를 나중에 가져올 때 후보 단위로 대조하기 위한 기록이며 개인 데이터 폴더에만 저장합니다.

### 이전 형식 (하위 호환)

| 목적 | API | 내용 |
| --- | --- | --- |
| 전체 진단 | `GET /api/bibliography/export` 또는 `?format=full` | queue, queue와 겹치지 않는 unresolved, 서지 레코드, 조회 로그, 진단, Work·Version 제안 |
| 페이지별 compact | `?format=compact&group=with-candidates&limit=40&offset=0` | 그룹별 30~50건 묶음. `nextOffset`, `snapshot` 제공 |
| 결과 스키마 | `GET /api/bibliography/review-schema` | JSON Schema 2020-12 |

페이지별 compact의 snapshot은 같은 상태의 전체 파일과 같습니다. 전체 진단은 크기가 크므로 LLM 입력으로는 권장하지 않습니다.

## LLM 결과 형식

```json
{
  "schemaVersion": 2,
  "snapshot": "내려받은 파일의 snapshot",
  "batchIds": ["b001"],
  "decisions": [
    {"candidateId": "name:example", "decision": "match", "recordId": "doi:10.1234/example",
     "evidence": [{"type": "explicit-alias-expansion", "detail": "약칭이 이 공식 제목의 접두어다."}], "needsManualReview": false},
    {"candidateId": "name:other", "decision": "propose", "recordId": null,
     "proposal": {"doi": "10.1145/3411841", "title": "IMUTube: Automatic Extraction of Virtual on-body Accelerometry from Video for Human Activity Recognition"},
     "evidence": [{"type": "external-identifier", "detail": "이 약칭을 제안한 논문의 DOI."}], "needsManualReview": false}
  ]
}
```

- `decision`: `match`(나열된 candidates 중 하나), `propose`(새 DOI·arXiv ID·공식 제목 제안), `separate`, `defer`. match에만 recordId를 쓰고 나머지는 null입니다.
- `proposal`: `doi`, `arxiv`, `title` 중 아는 값만 적습니다. propose는 schemaVersion 2에서만 사용할 수 있습니다.
- evidence.type: `identifier-match`, `exact-title`, `author-year-match`, `explicit-alias-expansion`, `same-message`, `adjacent-message`, `possible-work-version`, `insufficient-evidence`, `conflicting-identifiers`, `external-identifier`. detail은 1~1000자, 항목당 최대 10개입니다.
- **부분 결과**: 결과에는 처리한 후보만 넣어도 됩니다. 여러 부분 결과는 (1) decisions를 이어 붙이거나, (2) 결과 문서들의 JSON 배열로 만들거나, (3) 화면에서 파일을 여러 개 선택하거나, (4) 시간 차를 두고 따로 가져올 수 있습니다.
- 기존 `schemaVersion: 1` 결과(snapshot 없음)도 그대로 가져올 수 있습니다.

LLM이 쓴 근거는 자동 검증된 사실로 취급하지 않습니다. 최종 승인 전에 내용을 확인하세요.

## 가져오기 작업

가져오기는 서버의 개인 state 폴더에 저장되는 **작업**입니다. 창을 닫거나 서버를 재시작해도 남아 있으며, 서지 정리를 다시 열면 마지막 미완료 작업을 복원합니다.

| API | 설명 |
| --- | --- |
| `POST /api/bibliography/review/import?filename=…` | 결과 JSON 본문을 올려 작업 생성. 202와 작업 요약 반환. 같은 내용이면 200 `duplicate: true`와 기존 작업 반환 |
| `GET /api/bibliography/review/import` | 최근 작업 목록 |
| `GET /api/bibliography/review/import?id=…&status=ready&offset=0&limit=50` | 진행 상태, 분류별 건수, 행 목록(최대 200행씩). `ids=ready`를 더하면 적용 가능한 candidateId 전체 |
| `POST …/import/stop` · `…/import/resume` | 검증 중단 · 체크포인트에서 이어서 검증 (`{"importId": "…"}`) |
| `POST …/import/apply` | `{"importId", "approved": true, "candidateIds": [...], "confirmSnapshot": false}` |
| `POST …/import/discard` | 미리보기와 올린 사본 삭제. 이미 승인한 결정은 유지 |

### 크기와 검증

- 건수 제한: 기존 50건 제한을 없앴습니다. 한 번에 20,000건, 본문 16MB까지 받습니다. 그 밖의 일반 요청은 기존 2MB 제한을 유지합니다. 한도를 넘으면 413과 안내를 반환하며 아무것도 저장하지 않습니다.
- 서버는 결과를 100건씩 나누어 검증하고, 묶음이 끝날 때마다 완료된 행과 진행 위치를 함께 저장합니다(체크포인트). 업로드 응답은 검증을 시작하기 전에 반환됩니다.
- 한 행의 오류는 그 행만 `오류`로 표시합니다. 파일 전체를 거부하는 경우는 JSON이 아니거나, decisions 배열·schemaVersion·snapshot 형식이 잘못된 경우뿐입니다.
- 같은 candidateId가 반복되면 첫 항목만 검토하고 나머지는 `중복`으로 표시합니다. 내용이 서로 다르면 첫 항목도 추가 검토로 돌립니다.
- 같은 JSON(내용 해시 기준)을 다시 가져오면 새 작업을 만들지 않고 기존 작업을 엽니다. 닫은(discard) 작업의 JSON은 다시 가져올 수 있습니다.
- 미리보기는 최근 20개까지 보관합니다. 기존의 10분 만료는 없습니다. 대신 승인 시점에 선택한 행을 현재 상태와 하나씩 다시 대조합니다.

### 미리보기 분류

| 분류 | 의미 |
| --- | --- |
| 검토할 항목 | 아직 최종 결정을 저장하지 않은 항목. 예전의 적용 가능·추가 검토·보류·재검증 필요를 통합 |
| 처리 완료 | 이미 연결·별도 유지·후보 제외했거나 기존 결정을 보존하는 항목. 예전의 기존 결정·적용됨을 통합 |
| 오류 | JSON 필드 형식 또는 후보·레코드 ID에 문제가 있어 수정이 필요한 항목 |
| 전체 | 위 세 그룹을 함께 표시 |

목록의 상태 배지와 요약도 같은 구분을 사용합니다. 처리 완료 항목에는 실제 연결·후보 제외·별도 유지 내용을 표시합니다. 같은 candidateId가 반복된 결과는 한 행으로 합칩니다. 기존 파일의 세부 상태 값과 API의 `ready`, `needs-manual-review`, `deferred`, `preserved`, `applied` 등 필터는 하위 호환을 위해 유지하며 데이터 변환은 하지 않습니다. 통합 API는 `groups` 건수와 행별 `statusGroup`도 반환합니다.

처음에는 아무 항목도 선택되어 있지 않습니다. **현재 필터 N건 전체 선택** 또는 개별 체크박스로 고릅니다. 전체 선택은 현재 페이지뿐 아니라 해당 필터의 모든 선택 가능한 항목을 포함합니다. 선택을 해제하거나, 다른 페이지로 이동해 개별 선택을 조정할 수 있습니다. 행마다 적용 버튼을 두지 않으며 공통 **최종 승인·적용** 버튼에서 한 번에 저장합니다.

### 추가 검토 항목을 직접 승인하기

- **검토할 항목 → external-identifier**로 필터링하면 공식 조회된 약칭 후보를 모아 볼 수 있습니다. CoMA처럼 공식 레코드는 찾았지만 약칭 관계가 자동 확인되지 않은 `weak-link`도 체크할 수 있습니다. 공식 제목·저자·연도·식별자를 보고 확인한 뒤 승인하세요. 이 변경은 자동 연결 기준을 낮추지 않으며 기존 JSON을 다시 작성하거나 가져올 필요가 없습니다.
- 후보가 여러 개이면 드롭다운에서 연결할 논문을 직접 선택합니다. 조회 실패·제목 충돌 때문에 등록되지 않은 레코드는 연결 선택지로 제공하지 않습니다. 연결 가능한 레코드가 없으면 연결 승인이 불가능하며 제외·별도 유지 여부만 직접 결정할 수 있습니다.
- **insufficient-evidence**는 논문이 아니라는 확정 판정이 아닙니다. 이 근거 유형으로 필터링하고 원하는 항목을 선택한 뒤 **선택 항목 처리 → 논문 후보에서 제외**를 고르면, 최종 승인 후 `reviews.json`에 `status: dismissed`를 기록합니다. 원문·Mention·Zotero Key·PDF·Figure를 삭제하지 않습니다.
- **서지 연결 없이 별도 유지**는 `bibliography-decisions.json`의 `separate`이며 후보 제외와 다릅니다. LLM 결과의 기존 `separate` 의미도 변경하지 않습니다. 후보 제외는 논문 상세의 기존 검토 상태에서 되돌릴 수 있습니다.
- 기존 수동 연결·분리 또는 `confirmed`/`dismissed` 검토 상태는 통합 화면에서 덮어쓰지 않습니다. `confirmed` 논문도 서지정보를 연결할 수 있지만 이 화면에서 후보 제외로 바꿀 수는 없습니다. 미리보기 뒤에 바뀐 후보·공식정보도 건너뛰며 다시 확인해야 합니다. 선택 건수 옆에 연결·후보 제외·별도 유지 건수를 나눠 표시합니다.

통합 화면은 `GET /api/bibliography/review/queue`를 사용합니다. `importId`, `status`, `evidence`, `search`, `offset`, `limit` 필터를 지원하며 `ids=selectable`로 필터 전체의 선택 정보를 받을 수 있습니다. `POST /api/bibliography/review/queue/apply`에는 `approved: true`, 선택적으로 `importId`, `confirmSnapshot`, 그리고 `selections: [{candidateId, token, action: "match"|"dismiss"|"separate", recordId?}]`를 보냅니다. token은 현재 후보·서지 레코드·수동 결정의 해시이며 적용 시 다시 비교합니다. LLM이 쓴 근거 유형 자체는 쓰기 권한이 아닙니다.

### snapshot 충돌 확인

결과의 snapshot이 현재와 다르다고 전체를 거부하지 않습니다.

- 서버가 내보낸 기록이 있는 snapshot이면 **후보별로** 대조합니다. 내려받은 뒤 연결 후보가 바뀐 항목과 그 파일에 없던 후보만 추가 검토로 분류하고, 변하지 않은 항목은 그대로 진행합니다. 그래서 배치 일부를 먼저 적용한 뒤에도 나머지 배치의 결과를 가져올 수 있습니다. 언급 수 변화와 검증된 LLM 제안으로 등록된 후보는 변경으로 보지 않습니다.
- 기록이 없는 snapshot(다른 PC나 오래된 내보내기)은 후보별 대조가 불가능합니다. 현재 상태로 검증한 뒤, 미리보기에서 **다른 snapshot의 결과임을 확인**해야 적용할 수 있습니다(`confirmSnapshot: true`).

### 승인과 부분 실패

- `approved: true`와 선택한 candidateId가 있어야만 저장합니다. 미리보기 단계에서는 연결·분리 결정을 쓰지 않습니다.
- 승인 시 각 행을 현재 상태와 다시 대조합니다. 그 사이 수동 결정이 생긴 항목은 보존하고, 후보가 바뀐 항목은 `재검증 필요`로 남깁니다. 나머지는 적용합니다.
- 결정은 200건씩 저장하고 저장할 때마다 작업에 기록합니다. 중간에 저장이 실패하면 그때까지 적용한 건수를 알리고(`PARTIAL_APPLY`), 같은 선택을 다시 보내면 남은 항목만 적용합니다.
- 검증 도중 서버가 멈추거나 조회가 실패하면 작업은 `interrupted`가 되며 완료된 행은 그대로 남습니다. **이어서 검증**은 마지막 체크포인트 다음부터 진행하고, 조회에 실패했던 행만 다시 조회합니다. 중단된 작업에서도 이미 검증된 행은 바로 승인할 수 있습니다.

## 연결 후보가 없는 항목: 제안 식별자 검증

`propose`의 DOI·arXiv ID·제목은 주장일 뿐 메타데이터가 아닙니다.

1. 서버가 기존 조회 경로로 다시 확인합니다. DOI는 Crossref, arXiv ID(및 arXiv DOI)는 arXiv, 식별자가 없거나 찾지 못한 정식 제목은 Crossref → OpenAlex → Semantic Scholar 제목 조회를 사용합니다. 캐시·대기·재시도 규칙은 일반 서지 조회와 같고, 요청에는 식별자나 제안된 제목만 들어갑니다.
2. 제공자가 실제로 반환한 레코드만 저장합니다. LLM이 쓴 DOI·제목은 비교에만 쓰고 공식 메타데이터로 저장하지 않습니다.
3. 결과에 따라 다음과 같이 처리합니다.

| 결과 | 처리 |
| --- | --- |
| 레코드 1건 확인, 대화의 제목(또는 약칭)과 공식 제목이 맞음 | 연결 후보로 등록, **적용 가능** |
| 레코드는 확인했지만 약칭·제목 관계를 자동으로 확인할 수 없음 | 연결 후보로 등록, 추가 검토 |
| 여러 레코드가 일치 (같은 제목 여러 건, DOI와 arXiv ID가 다른 레코드) | 연결 후보로 등록(최대 3건), 추가 검토 |
| 식별자의 공식 제목이 LLM이 적은 제목이나 대화의 제목과 다름 | 등록하지 않음, 추가 검토 |
| 찾지 못함 · 조회 실패 | 추가 검토. 조회 실패는 다시 검증하면 재시도 |

4. 이렇게 들어온 레코드는 **승인 전까지 자동 연결 근거로 쓰지 않습니다.** 제목이 정확히 같아도, 같은 식별자가 대화에 있어도 사람이 승인하거나 일반 서지 조회가 같은 레코드를 따로 반환하기 전에는 연결 후보로만 남습니다. 등록된 후보는 **통합 검토 목록**에 공식 서지정보와 함께 표시되며, 약칭 관계가 불확실해도 사람이 확인하고 체크해 승인할 수 있습니다.
5. 일반 서지 조회가 실행 중이면 제안 검증은 대기(중단)하고, 제안을 조회하는 동안에는 일반 서지 조회를 시작할 수 없습니다. 두 작업이 같은 조회 캐시를 쓰기 때문입니다.

## 약칭과 Work·Version

- MAML·CLIP·SMPL·IMUTube는 curated alias의 식별자와 공식 제목이 모두 맞아야 합니다. **Curated alias 적용 진단**에서 조회 성공 여부와 실제 적용 여부를 따로 표시합니다.
- 같은 대화에서 이름이 등장했다는 사실만으로 약칭을 병합하지 않습니다. 모든 약칭 출현에 동일 메시지의 명시적 확장/식별자 또는 인접 메시지의 명시적 확장이 있어야 합니다. 메시지 순서는 선택된 대화 경로의 activity를 사용하며, 날짜나 ID 형태로 인접성을 추측하지 않습니다.
- 문맥이나 식별자가 충돌하면 검토 큐에 남습니다. 검증된 별칭도 다른 확장과 충돌하면 보류합니다.
- 같은 정식 제목·같은 저자 집합의 arXiv와 출판본은 **Work·Version 관계 제안**으로만 표시합니다. 저자가 빠졌으면 근거 부족, 저자가 다르면 제안에서 제외합니다. 이 제안은 DOI/arXiv 레코드나 Mention을 자동 병합하지 않습니다. 공통 식별자로 이미 확인된 기존 병합 규칙은 유지합니다.

## 저장 위치와 보존

| 파일 | 내용 |
| --- | --- |
| `bibliography-decisions.json` | 승인한 결정. 기존 `action`, `recordId`, `updatedAt`에 `evidence`, `decisionSource: "llm-reviewed"`, `importId`를 더합니다. 이전 파일을 그대로 읽습니다 |
| `bibliography.json` | 제안 검증으로 조회한 공식 레코드(`provisional` 표시)와 `proposedLinks`(후보별 등록 레코드) |
| `review-imports/` | 작업별 원본 사본·미리보기·진행 위치, 가져온 JSON의 해시 목록 |
| `review-exports/` | 내려받은 snapshot의 후보별 요약 |

가져오기는 기존 수동 연결·분리 결정을 덮어쓰지 않습니다. `reviews.json`(검토 상태와 Zotero Key), 대화 Export, Mention·발췌, 프로젝트 매핑과 대화 분류, PDF·Figure 선택 기록은 수정하지 않습니다. 연결된 논문은 원본 후보 ID를 구성원으로 유지하므로 기존 Zotero Key, 직접 고른 대표 Figure, PDF 연결이 그대로 따라옵니다.

## 이전 방식 API

`POST /api/bibliography/review/dry-run`과 `POST /api/bibliography/review/apply`는 하위 호환을 위해 남아 있습니다. schemaVersion 1, 최대 50건, 2MB 본문만 받고 미리보기를 서버 메모리에 10분 보관하며, 한 행이라도 잘못되면 전체를 거부합니다. 화면은 더 이상 이 경로를 사용하지 않습니다.

## 개발용 화면 점검

`node scripts/review-browser-check.mjs`는 가상의 후보 1,220건과 임시 state 폴더, 가짜 조회 제공자로 다운로드 → 여러 파일 가져오기 → 통합 목록·필터·검색 → 전체·개별 선택 → 599건 최종 승인 → 처리 완료 확인 → 새로 고침 뒤 복원과 모바일 배치까지 실제 브라우저에서 확인합니다. 행마다 버튼을 만들지 않는 것과 미리보기 중 쓰기가 없는 것도 검사합니다. `--remote-debugging-port=9337`로 실행한 격리 Chromium/Edge가 필요하며(`RESEARCHSCAPE_CDP_URL`로 변경 가능) 개인 데이터는 사용하지 않습니다. 추가 단위·HTTP 회귀 테스트는 약칭의 명시적 연결·선택한 후보 제외·중복 통합·오래된 token·기존 결정·부분 저장 실패 후 재시도와 상태 그룹의 누락·중복 없음을 확인합니다.
