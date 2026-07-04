# 운동 인증 봇

`#운동인증` 슬랙 채널에 올라온 사진을 매주 자동으로 집계해서, 지난주(월~일)에 2번(30분 이상) 운동을 인증하지 못한 사람을 매주 월요일 오전 11시에 슬랙 채널 + Notion에 자동으로 알려줍니다.

## 판별 규칙
- 사진에 찍혀 있는 타임스탬프(날짜/시간)를 OCR로 읽어서 사용 (예: `2026-07-04 16:29:02` 같은 형식)
- 하루 동안 올라온 사진들의 타임스탬프를 시간순 정렬 → 가장 이른 시각 = 시작, 두 번째로 이른 시각 = 끝 (한 메시지에 여러 장을 한꺼번에 올려도 동일하게 처리됨)
- 끝 - 시작 ≥ 30분이면 그날 1회 인정
- 지난주(월~일) 동안 인정 횟수 2회 이상이면 통과
- 사진의 타임스탬프를 OCR로 못 읽으면(글씨가 흐리거나 형식이 다르면) 슬랙 업로드 시각으로 대체
- 하루에 사진이 1장뿐이면 그날은 미인정 처리되고, 리포트에 참고용으로 표시됨

## 타임스탬프 사진 관련 주의사항
- 지금 코드가 기본으로 인식하는 형식은 "타임스탬프 카메라" 계열 앱이 찍는 형식이에요:
  ```
  2026년 7월 4일 (토)
  오후 4:27
  ```
- 이 외에 `2026-07-04 16:29:02` 같은 영문/숫자 형식도 같이 지원해요.
- 글씨가 너무 작거나 배경과 겹치면 OCR이 실패할 수 있어요. 실패 시 업로드 시각으로 자동 대체되니 완전히 멈추진 않지만, 정확도를 위해 타임스탬프 글씨 크기/대비를 크게 유지해주세요.

## 설정 방법 (한 번만 하면 됨)

### 1. Slack 앱 만들기
1. https://api.slack.com/apps → "Create New App" → "From scratch"
2. 왼쪽 메뉴 "OAuth & Permissions" → **Scopes → Bot Token Scopes**에 아래 권한 추가
   - `channels:history`
   - `channels:read`
   - `users:read`
   - `chat:write`
   - `im:write`
   - `files:read` (사진 파일을 다운로드해서 찍힌 타임스탬프를 읽기 위해 필요)
3. 상단 "Install to Workspace" 클릭 → 나오는 **Bot User OAuth Token** (`xoxb-...`) 복사
4. 만든 앱을 `#운동인증` 채널에 초대: 채널에서 `/invite @앱이름`

### 2. Notion 연동 만들기
1. https://www.notion.so/my-integrations → "New integration" 생성 → **API 키(Secret)** 복사
2. 리포트를 쌓아둘 Notion 페이지를 하나 만들고, 그 페이지에서 우측 상단 `...` → "연결 추가" → 방금 만든 연동 선택
3. 그 페이지 URL에서 페이지 ID 복사 (URL 끝의 32자리 문자열, 하이픈은 있어도 없어도 됨)

### 3. 이 코드를 GitHub 레포에 올리기
1. GitHub에서 새 레포 생성 (예: `workout-bot`)
2. 이 폴더(`workout-bot/`) 전체를 그 레포에 push
   ```bash
   cd workout-bot
   git init
   git add .
   git commit -m "init"
   git branch -M main
   git remote add origin https://github.com/내계정/workout-bot.git
   git push -u origin main
   ```

### 4. GitHub Secrets 등록
레포 페이지 → Settings → Secrets and variables → Actions → "New repository secret" 에서 아래 4개 등록:

| 이름 | 값 |
|---|---|
| `SLACK_BOT_TOKEN` | 1번에서 복사한 `xoxb-...` 토큰 |
| `SLACK_CHANNEL_ID` | `C0BF3QUE41G` (지금 만든 #운동인증 채널) |
| `NOTION_API_KEY` | 2번에서 복사한 Notion 연동 API 키 |
| `NOTION_PAGE_ID` | 2번에서 복사한 Notion 페이지 ID |

### 5. 끝!
- 매주 월요일 11:00(KST)에 지난주(월~일) 기준으로 자동 리포트가 올라옵니다.
- 바로 테스트해보고 싶으면: 레포의 "Actions" 탭 → "Weekly Workout Report" 선택 → "Run workflow" 버튼으로 즉시 실행 가능합니다.

## 필요 시 수정할 부분
- `weekly-report.js`의 `REQUIRED_TIMES_PER_WEEK`: 주당 필요 횟수 (기본 2)
- `lib.js`의 `computeValidDays(messages, 30)`의 `30`: 최소 운동 시간(분) 기준
