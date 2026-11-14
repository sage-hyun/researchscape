# 서지 검토 JSON과 LLM 결과 가져오기

상단 **서지 정리**에서 사용합니다. 이 기능 자체는 LLM을 호출하지 않습니다. 대화 본문·발췌·프로젝트명·Zotero Key를 내보내지 않습니다.

## 두 가지 내보내기

| 목적 | API | 내용 |
| --- | --- | --- |
| 전체 진단 | `GET /api/bibliography/export` 또는 `?format=full` | 기존 queue, queue와 겹치지 않는 unresolved, 서지 레코드, 조회 로그, 진단, Work·Version 제안 |
| LLM 검토 | `GET /api/bibliography/export?format=compact&group=with-candidates&limit=40&offset=0` | 필요한 필드만 허용 목록으로 투영한 40개 후보 |
| 입력 스키마 | `GET /api/bibliography/review-schema` | JSON Schema 2020-12 |

기존 export URL은 전체 진단으로 유지합니다. queue와 unresolved는 원본 candidateId 기준으로 중복되지 않습니다. 실제 캐시의 links, sources, sourceUrl, fetchedAt 등은 수정하지 않습니다. 전체 진단은 크기가 클 수 있으므로 LLM에는 compact 형식을 사용하세요.

compact의 `group`은 `with-candidates` 또는 `without-candidates`입니다. 두 그룹의 candidateId는 중복되지 않으며, 이미 연결되었거나 사용자가 분리한 항목은 제외합니다. 원본 후보 ID를 사용하므로 응답을 그대로 검토 입력과 연결할 수 있습니다.

화면에서 **연결 후보 있음/없음**, **30/40/50건씩**, **묶음 번호**를 선택합니다. API의 limit은 30~50 사이 정수, offset은 0 이상 정수입니다. 언급 수 내림차순·candidateId 순으로 정렬하며 `nextOffset`과 `snapshot`을 제공합니다. 같은 snapshot의 묶음끼리 사용하세요. 서지 조회·수동 결정이 변경되면 묶음 경계와 snapshot도 달라질 수 있습니다.

각 항목에는 `candidateId`, `title`, `count`, `reason`, `candidates`만 있습니다. 각 서지 후보에는 `recordId`, 공식 `title`, `authors`, `year`, `doi`, `arxiv`, `evidenceTypes`만 있습니다. source URL, 배치 arXiv API 주소, 긴 링크 객체, 조회 시각, 대화·메시지 ID와 유사도 점수는 compact에 넣지 않습니다. `same-conversation`은 약한 문맥 단서이며 신원 확인 증거가 아닙니다.

## 약칭과 Work·Version

- MAML·CLIP·SMPL·IMUTube는 curated alias의 식별자와 공식 제목이 모두 맞아야 합니다. **Curated alias 적용 진단**에서 조회 성공 여부와 실제 적용 여부를 따로 표시합니다.
- 같은 대화에서 이름이 등장했다는 사실만으로 약칭을 병합하지 않습니다. 모든 약칭 출현에 동일 메시지의 명시적 확장/식별자 또는 인접 메시지의 명시적 확장이 있어야 합니다. 메시지 순서는 선택된 대화 경로의 activity를 사용하며, 날짜나 ID 형태로 인접성을 추측하지 않습니다.
- 문맥이나 식별자가 충돌하면 검토 큐에 남습니다. 검증된 별칭도 다른 확장과 충돌하면 보류합니다.
- 같은 정식 제목·같은 저자 집합의 arXiv와 출판본은 **Work·Version 관계 제안**으로만 표시합니다. 저자가 빠졌으면 근거 부족, 저자가 다르면 제안에서 제외합니다. 이 제안은 DOI/arXiv 레코드나 Mention을 자동 병합하지 않습니다. 공통 식별자로 이미 확인된 기존 병합 규칙은 유지합니다.

## LLM 응답 형식

```json
{
  "schemaVersion": 1,
  "decisions": [
    {
      "candidateId": "name:example",
      "decision": "match",
      "recordId": "doi:10.1234/example",
      "evidence": [
        {"type": "identifier-match", "detail": "후보와 서지 레코드의 명시 DOI가 일치한다."}
      ],
      "needsManualReview": false
    }
  ]
}
```

`decision`은 `match`, `separate`, `defer` 중 하나입니다. match에는 기존 캐시에 존재하는 recordId가 필요하고, 나머지에는 null을 사용합니다. 최대 50개를 받으며 candidateId 중복과 알 수 없는 필드를 거부합니다.

evidence.type: `identifier-match`, `exact-title`, `author-year-match`, `explicit-alias-expansion`, `same-message`, `adjacent-message`, `possible-work-version`, `insufficient-evidence`, `conflicting-identifiers`. detail은 1~1000자입니다. LLM이 쓴 근거 자체를 자동 검증된 사실로 취급하지 않으므로 최종 승인 전에 내용을 확인해야 합니다.

## 가져오기와 승인

1. **LLM 검토 결과 가져오기**에 JSON을 붙여넣습니다.
2. **적용 전 미리보기 · dry-run**으로 형식·후보·기존 결정을 검사합니다. 저장 파일은 변경하지 않습니다.
3. 제안의 연결 전후와 근거를 보고 적용할 항목의 체크박스를 직접 선택합니다. 처음에는 아무 항목도 선택되어 있지 않습니다.
4. **선택한 N건 최종 승인·적용**을 눌러 선택한 항목만 기록합니다.

기존 수동 연결·분리 결정은 가져오기로 덮어쓰지 않습니다. needsManualReview=true, 근거 없음, 현재 후보 밖의 연결, 메타데이터 충돌, Work·Version 관계만의 제안은 일괄 적용할 수 없습니다. 해당 항목은 기존 연결 검토 화면에서 직접 확인하세요.

`POST /api/bibliography/review/dry-run`은 위 JSON을 그대로 받으며 rows, applicable, dryRunId, expiresAt, writes:0을 반환합니다. 미리보기는 서버 메모리에 최대 10분 보관합니다. `POST /api/bibliography/review/apply`에는 `{ "dryRunId": "미리보기ID", "approved": true, "candidateIds": ["선택한 원본ID"] }`를 보냅니다. 미리보기 뒤 서지 캐시·수동 결정이 바뀌거나, 서버를 재시작하거나, 같은 미리보기를 재사용하면 409를 반환해 다시 검토하게 합니다.

승인 후에도 기존 `bibliography-decisions.json`에 `action`, `recordId`, `updatedAt`을 기록하는 방식을 유지합니다. 선택한 항목에만 evidence와 decisionSource를 추가합니다. 이전 결정 파일을 그대로 읽을 수 있으며 reviews, Zotero Key, 대화 Export, Mention·발췌, 프로젝트 매핑, PDF/대표 이미지 선택 기록은 가져오기가 수정하지 않습니다.
