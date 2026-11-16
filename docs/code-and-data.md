# Git에 넣을 것과 개인 데이터

```text
researchscape/                       Git 저장소
  server.mjs, package.json           앱 실행 코드
  lib/, public/                     추출·서지 처리와 UI
  test/, scripts/                   테스트와 개발 도구
  docs/, examples/                  문서와 직접 작성한 공개 데모
  .githooks/                        커밋 전 데이터 검사
  researchscape.config.example.json 공개 설정 형식 예시

  researchscape.local.json           개인 경로 설정: Git 제외
  data/                             원본 Export: Git 제외
  .local/                           개인 상태·캐시·로그: Git 제외
```

개인 데이터는 지금처럼 제외된 폴더에 두어도 되고, 저장소 밖의 별도 폴더를 지정해도 됩니다. `.gitignore`가 Git 커밋에서 제외하므로 Git을 처음 설정하기 위해 대용량 Export를 옮길 필요는 없습니다.

## 저장소 밖의 데이터 경로 사용

`researchscape.config.example.json`을 `researchscape.local.json`으로 복사한 뒤 실제 경로를 수정합니다. 로컬 설정 파일은 커밋하지 않습니다.

```json
{
  "dataDirectory": "D:/ResearchscapeData/exports",
  "stateDirectory": "D:/ResearchscapeData/state"
}
```

위 경로는 예시입니다. 설정만 바꿔도 기존 데이터가 자동으로 이동되는 것은 아닙니다. 앱을 종료하고 `data/` 및 `.local/` 전체를 각각 새 위치로 복사한 뒤 새 경로로 실행하여 기존 논문·검토 기록을 확인하세요. 정상 동작을 확인하기 전에는 기존 폴더를 지우지 마세요.

상대 경로는 코드 저장소 루트 기준입니다. `RESEARCHSCAPE_DATA_DIR`, `RESEARCHSCAPE_STATE_DIR` 환경 변수를 지정하면 JSON 설정보다 우선합니다. 둘 다 없으면 기존 `data/`, `.local/` 경로를 그대로 사용합니다.

## 개인 데이터의 구분과 백업

| 종류 | 파일·폴더 | 보관 방식 |
| --- | --- | --- |
| 원본 | Export 폴더 전체, 첨부파일 | 별도 개인 백업 |
| 수동 입력·판단 | `sources.json`, `reviews.json`, `projects.json`, `conversation-labels.json`, `bibliography-decisions.json` | 반드시 별도 백업 |
| 서지 결과 | `bibliography.json` | 백업 권장. API로 다시 얻을 수 있지만 재조회가 필요 |
| 파생 데이터 | `index.json`, `bibliography-job.json` | 재구축 가능 |
| LLM 검토 작업 | `review-imports/`, `review-exports/` | 진행 중인 가져오기를 이어가려면 보관. 승인한 결정은 `bibliography-decisions.json`에 있으므로 지워도 결정은 남음 |
| 실행 흔적 | 로그, PID, QA 브라우저 프로필, 스크린샷 | Git 제외 |

저장 잠금으로 생성된 `*.v-*.json` 스냅샷이 있다면 기본 파일과 함께 보관해야 최신 결정이 남습니다. 간단하게는 개인 state 폴더 전체를 백업하는 편이 안전합니다. Git이나 `.gitignore`는 이 백업을 대신하지 않습니다.

현재는 JSON 저장 방식입니다. 이후 SQLite를 도입해도 실제 DB와 journal/WAL 파일은 개인 state 쪽에 두고 Git에는 스키마·마이그레이션 코드만 넣습니다. 실행 중인 DB의 단순 복사 대신 DB가 지원하는 백업 절차를 사용해야 합니다.

## 커밋 전 검사

```powershell
npm run git:setup
npm run git:check
git diff --cached --stat
```

`git:setup`은 이 저장소에만 pre-commit 훅을 활성화합니다. 다른 PC에서 clone한 뒤에도 한 번 실행해야 합니다. 훅은 작업 폴더가 아닌 **Git 인덱스에 올라간 내용**을 검사합니다.

- 코드로 정한 경로 밖의 파일, 개인 데이터·DB·환경 설정·로그·압축 파일을 차단합니다.
- 실제 형태의 ChatGPT 프로젝트 ID, 대화 주소, 업로드 파일 ID를 감지합니다.
- 대화/메시지 ID 형태의 JSON과 2MB 초과 파일을 확인 대상으로 막습니다.
- 검사 실패 시 파일 내용이나 감지한 개인 ID 값은 출력하지 않습니다.

이 검사는 모든 개인정보나 비밀을 알아내는 도구는 아닙니다. 검사를 우회하는 Git 옵션도 있으므로, 공개 저장소로 보낼 때는 커밋 내용도 직접 확인하세요. 이미 커밋한 데이터는 나중에 `.gitignore`를 추가해도 과거 기록에서 없어지지 않습니다.

## 새 PC에서 재현

1. 코드 저장소를 clone합니다.
2. Node.js 20 이상에서 `npm run git:setup`, `npm test`를 실행합니다. 패키지 설치는 필요하지 않습니다.
3. 개인 데이터 없이 확인하려면 `npm run start:demo`를 사용합니다.
4. 개인 앱을 복원하려면 별도 백업한 Export와 state를 연결하고 `npm start`를 실행합니다.

코드의 변경 이력은 Git으로, 개인 데이터 백업은 별도로 관리합니다. SynologyDrive 동기화를 사용하더라도 두 PC가 같은 작업 폴더와 `.git`을 동시에 수정하지 않도록 하고, 여러 PC의 코드 공유에는 Git remote를 사용하는 편이 관리하기 쉽습니다. 이 작업에서는 remote를 만들거나 데이터를 업로드하지 않습니다.
