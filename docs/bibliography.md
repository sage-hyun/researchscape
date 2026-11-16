# 서지 연결과 진단

**서지 정리 → 공식 서지정보 조회**를 누르면 기존 DOI·arXiv·OpenReview ID를 먼저 조회합니다. 검증된 약칭 사전에 있는 MAML·CLIP·SMPL·IMUTube도 사전의 공개 식별자로 조회합니다. 정식 제목은 Crossref의 `query.bibliographic`를 사용하고, 정확한 제목 결과가 없으면 OpenAlex의 `search.title`, Semantic Scholar의 `paper/search/match` 순으로 보완합니다. 현재 dblp는 사용하지 않습니다.

조회 한도 80/160/300은 **아직 조회가 완료되지 않은 제목**에 적용합니다. 다시 누르면 다음 후보로 진행합니다. 기존 Crossref 제목 캐시가 비슷한 결과만 담고 있어도 재요청 없이 fallback부터 이어집니다. Semantic Scholar의 가장 높은 matchScore도 자동 연결 근거로 사용하지 않습니다.

## 자동 연결 기준

- 식별자가 일치하거나, 충분히 구체적인 정식 제목이 정규화 후 정확하게 한 논문과 일치해야 합니다. 문장 유사도만으로 자동 연결하지 않습니다.
- 서로 다른 제공자의 레코드는 공유 식별자로 동일성이 입증될 때만 하나의 표시용 서지 레코드로 묶습니다. 저장된 레코드 ID는 삭제하지 않습니다. 같은 제목에 서로 다른 DOI가 있거나, 제공자들의 식별자·제목이 충돌하면 검토 큐에 남깁니다.
- 단, 원문에 특정 DOI가 명시되어 있으면 같은 제목의 다른 판본이 검색되었다는 이유만으로 그 식별자의 연결을 막지는 않습니다. 해당 식별자와 대화의 제목 자체가 충돌할 때 검토합니다.
- 짧은 약칭은 검증된 사전의 **식별자와 정식 제목이 모두 일치**해야 합니다. 새 약칭은 해당 후보가 등장한 모든 대화에서 유일한 정식 제목 확장이나 명시 식별자를 대조할 수 있어야 합니다. 한 대화의 GraCE를 다른 대화의 GraCE에 근거 없이 연결하지 않습니다.
- 학회명(CHI 등), 데이터셋 이름, 기술명(ZUPT 등), 문서 소제목은 자동 연결에서 제외합니다. 이미 추출된 후보는 검토 상태로 유지할 수 있습니다. 휴리스틱이므로 모든 일반명사를 판별하지는 못합니다.
- 사용자의 연결/별도 유지 결정이 우선합니다. 검토 기록, Zotero Key, 발췌, 날짜와 프로젝트 매핑은 별도 파일에 유지합니다. 병합은 표시용으로 수행하고 원래 후보 ID와 Mention의 원본 위치를 보존합니다.

재추출 시 기존 Mention은 메시지 ID·전체 내용 해시·구절 위치를 대조합니다. 선택된 메시지가 그대로라면 새 추출 규칙에서 빠진 근거도 보존하고, 새 기준에 따라 검토 상태로 둘 수 있습니다. 바뀐 본문·삭제된 대화·선택 경로에서 사라진 메시지는 되살리지 않습니다. 새로운 발견과 동일 위치의 중복 제거 때문에 표시 집계는 달라질 수 있지만, 그대로인 원문 근거를 파서 변경만으로 지우지 않습니다. `node scripts/audit-bibliography.mjs`로 기존 색인과 재추출 결과를 파일 변경 없이 비교할 수 있습니다.

## 저장 구조와 링크

개인 state 폴더(기본 `.local/`)의 기존 `bibliography.json`을 그대로 사용합니다.

- `records`: 공식 제목·식별자·저자·연도·출처. 기존 `url`, `identifiers[].url`도 유지합니다.
- `records[id].links`: `landing`, `doi`, `preprint`, `pdf` 배열. 각 링크는 `url`, `provider`, `sourceUrl`, `fetchedAt`을 보존합니다. 빈 배열은 해당 종류의 링크가 아직 없다는 뜻입니다. 링크가 있다는 사실은 다운로드·HTTP 접근 성공을 뜻하지 않습니다.
- `records[id].sources`: 여러 제공자의 메타데이터 출처. 충돌은 `metadataConflicts`에 남습니다.
- `lookups`: 기존 식별자 캐시와 제목별 종합 결과. 기존 키를 삭제하지 않습니다.
- `providerLookups`: `crossref|title:…`, `openalex|title:…`, `semantic-scholar|title:…`별 응답 상태와 레코드 ID. 기존 Crossref 캐시를 재사용합니다.
- `providerCooldowns`: 401/403/429 이후 제공자별 재시도 가능 시각.

성공 결과는 30일, 검색 결과 없음/일반 오류는 30분 동안 재사용합니다. 429 및 5xx·네트워크 오류에는 최대 2회 재시도하며 지수 대기와 `Retry-After`를 적용합니다. 60초를 넘는 `Retry-After`는 일찍 재요청하지 않고 다음 실행에서도 지킬 대기 상태로 저장합니다. 제공자 제한 후 다른 제목을 통해 우회 재요청하지 않습니다. API마다 순차 요청하고 arXiv에는 최소 3초, Semantic Scholar에는 최소 1.1초의 요청 간 대기를 둡니다.

**조회 중단**으로 진행을 멈출 수 있습니다. 제공자별 단계가 끝날 때마다 저장하므로 서버 종료나 중단 후 같은 조회 버튼으로 이어갑니다. 중단한 서버 프로세스에서 실행 중인 요청 자체는 재사용하지 않으며, 저장된 완료 단계만 건너뜁니다. 다른 서버가 소유한 작업은 해당 서버에서 중단해야 합니다.

선택적으로 PowerShell에서 키를 설정할 수 있습니다. 코드·조회 근거 URL·로그에는 키를 저장하지 않습니다. `.env` 파일을 자동으로 읽지는 않습니다.

```powershell
$env:OPENALEX_API_KEY='발급받은 키'
$env:SEMANTIC_SCHOLAR_API_KEY='발급받은 키'
node server.mjs
```

요청에는 추출한 서지 후보 문자열 또는 식별자만 넣습니다. 발췌·메시지 본문·프로젝트명은 보내지 않으며, LLM을 호출하지 않습니다. 자동 호출 대상은 기존 3개 제공자와 `api.openalex.org`, `api.semanticscholar.org`입니다.

## 미연결 원인 진단

서지 정리의 **미연결 원인 진단**이나 읽기 전용 명령으로 기존 로그를 확인할 수 있습니다.

```powershell
npm.cmd run bibliography:diagnose
node scripts/diagnose-bibliography.mjs --json
```

JSON에는 후보 제목·식별자 키·제공자별 상태만 포함하며 대화 본문은 포함하지 않습니다. `GET /api/bibliography`의 `diagnostics`에도 같은 진단이 있습니다.

| 진단 | 의미 |
| --- | --- |
| `not-searched` | 조회 한도 등에 의해 아직 조회하지 않음 |
| `lookup-failed` | HTTP/접근 제한/네트워크/응답 해석 오류로 조회를 완료하지 못함 |
| `search-miss` | 제공자 검색이 성공했지만 후보 결과가 없거나 해당 식별자가 제공자 색인에 없음 |
| `matching-failed` | 결과는 받았으나 정확한 제목·식별자 기준을 만족하지 못함 |
| `conflict` | 식별자·제목 또는 제공자 레코드 사이에 충돌 |
| `insufficient-evidence` | 약칭·짧은 제목 등 근거 부족 |
| `excluded:*` | 학회·데이터셋·기술명·소제목 후보 |

`lookupSummary`/`byProvider`는 429, 접근 거부, 제공자 대기, HTTP 오류 등을 별도로 집계합니다. 식별자 조회의 구형 404 로그는 `identifier-not-indexed`로 구별합니다. 후보별 원인과 전체 조회 로그 수는 서로 다른 집계입니다. **검색 결과 없음이나 Crossref의 DOI 404는 논문 미존재를 뜻하지 않습니다.** 구형 로그의 HTTP 상태는 오류 문자열에서 복원하며, 상세 상태가 없는 구형 네트워크/파싱 오류는 더 세밀하게 구별할 수 없습니다.

공식 API 참고: [OpenAlex 제목 검색](https://help.openalex.org/api/searching/), [Semantic Scholar Graph API](https://api.semanticscholar.org/api-docs/graphs).

LLM 검토는 미연결 후보 전체를 파일 하나로 내려받고 결과도 한 번에 가져옵니다. 전체 진단과 30~50건 compact 형식은 고급 설정과 API로 유지합니다. LLM이 제안한 DOI·arXiv ID로 조회한 레코드는 사람이 승인하거나 일반 조회가 같은 레코드를 반환하기 전까지 자동 연결 근거로 쓰지 않고 연결 후보로만 둡니다. 같은 대화만의 약칭 병합을 제한하고 Work·Version 관계를 별도 제안합니다. 결과 스키마·미리보기·최종 승인 흐름은 [검토 JSON과 가져오기](bibliography-review.md)를 참고하세요.
