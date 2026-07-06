# 운동 인증 봇 (Claude Vision API 버전)

`#운동인증` 슬랙 채널에 올라온 사진을 Claude Vision API로 읽어서, 지난주(월~일)에 3번(40분 이상) 운동을 인증하지 못한 사람을 매주 월요일 오전 11시에 슬랙 채널 + Notion에 자동으로 알려줍니다. 이번 주 순위도 함께 표시됩니다.

## 판별 규칙
- 사진에 찍혀 있는 타임스탬프(날짜/시간)를 Claude에게 직접 물어봐서 읽음
- 하루 동안 올라온 사진들의 타임스탬프를 시간순 정렬 → 가장 이른 시각 = 시작, 가장 늦은 시각 = 끝
- 끝 - 시작 ≥ 40분이면 그날 1회 인정
- 자정을 넘긴 운동(예: 23:30 시작 ~ 다음날 01:00 종료)도 인정됨 (간격이 40분~6시간 사이인 경우)
- 지난주(월~일) 동안 인정 횟수 3회 이상이면 통과
- 하루에 사진이 1장뿐이면 그날은 미인정 처리되고, 리포트에 참고용으로 표시됨
- 사진을 그날 못 올리고 나중에 몰아서 올려도, 사진에 찍힌 실제 날짜 기준으로 판별함
- 채널 멤버 전원을 대상으로 인정 횟수 기준 순위를 매겨서 리포트에 표시함

## 설정 방법

### 1. Slack 앱 만들기
1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. 왼쪽 메뉴 "OAuth & Permissions" → **Scopes → Bot Token Scopes**에 아래 권한 추가
   - `channels:history`
   - `channels:read`
   - `users:read`
   - `chat:write`
   - `im:write`
   - `files:read`
3. 상단 "Install to Workspace" 클릭 → **Bot User OAuth Token** (`xoxb-...`) 복사
4. 만든 앱을 `#운동인증` 채널에 초대: 채널에서 `/invite @앱이름`

### 2. Anthropic API 키 만들기 (Vision 기능용)
1. https://console.anthropic.com 접속 → 로그인/가입
2. 왼쪽 메뉴 "Settings" → "API Keys" → "Create Key" → 키 이름 입력 → 생성된 키(`sk-ant-...`) 복사
3. "Billing" 메뉴에서 카드 등록 (사진 처리 비용은 매우 적음, 사진 1장당 1원 미만 수준)

### 3. Notion 연동 만들기
1. https://www.notion.so/my-integrations → "New integration" 생성 → API 키(Secret) 복사
2. 리포트를 쌓아둘 Notion 페이지를 하나 만들고, 그 페이지에서 우측 상단 `...` → "연결 추가" → 방금 만든 연동 선택
3. 그 페이지 URL에서 페이지 ID 복사

### 4. 이 코드를 GitHub 레포에 올리기
레포에 `package.json`, `lib.js`, `weekly-report.js`, `.github/workflows/weekly-report.yml`, `README.md`가 모두 있어야 합니다.

### 5. GitHub Secrets 등록
레포 Settings → Secrets and variables → Actions → "New repository secret"

| 이름 | 값 |
|---|---|
| `SLACK_BOT_TOKEN` | 1번에서 복사한 `xoxb-...` 토큰 |
| `SLACK_CHANNEL_ID` | `#운동인증` 채널 ID |
| `ANTHROPIC_API_KEY` | 2번에서 복사한 `sk-ant-...` 키 |
| `NOTION_API_KEY` | 3번에서 복사한 Notion 연동 API 키 |
| `NOTION_PAGE_ID` | 3번에서 복사한 Notion 페이지 ID |

### 6. 끝!
- 매주 월요일 11:00(KST)에 지난주(월~일) 기준으로 자동 리포트가 올라옵니다.
- 바로 테스트해보고 싶으면: 레포의 "Actions" 탭 → "Weekly Workout Report" → "Run workflow" 버튼으로 즉시 실행 가능합니다.

## 필요 시 수정할 부분
- `weekly-report.js`의 `REQUIRED_TIMES_PER_WEEK`: 주당 필요 횟수 (기본 3)
- `weekly-report.js`의 `computeValidDays(filteredEvents, 40)`의 `40`: 최소 운동 시간(분) 기준
