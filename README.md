# Life Daemon

Life Daemon은 반복적인 탐색, 추적, 기록과 알림을 대신 수행하는 개인용 자동화 시스템입니다.

현재 제공하는 기능:

- LH·SH·청년안심주택·HUG·마이홈 주거 공고 수집
- 서울 거주 1인 청년 관점의 1차 필터링
- Telegram 단일 브리핑과 지원 상태 추적
- 사용자 제외 규칙 저장
- 전역 리마인더 등록·승인·발송
- 발표 시점의 공식 결과 링크 동적 탐색
- 공개 채용 공고 수집, 검증된 기업 필터링, Telegram 브리핑
- 한국어 자연어 리마인더와 전용 Google Calendar 양방향 동기화
- systemd 기반 상시 실행과 평일 스케줄링

향후 면접 일정, 가격 추적 등 다른 생활 자동화 모듈을 같은 런타임에 추가할 수 있습니다.

## Requirements

- Node.js 22 이상
- Playwright Chromium
- Telegram bot token
- 자연어 리마인더 사용 시 OpenAI API key

## Setup

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
```

`.env`에 본인의 Telegram bot token과 허용할 개인 chat ID를 입력합니다. `.env`, SQLite DB, 인증 키는 Git에 포함하지 마세요.

## Run

```bash
npm run bot
npm run reminders
npm run housing:daily
npm run jobs:collect
npm run jobs:filter
npm run jobs:daily
```

## Job notices

The job pipeline has two separate stages. `jobs:collect` accesses only public listing and detail pages from Remember, Wanted, and JobKorea, then normalizes and deduplicates postings. It does not use the private profile or make suitability decisions.

`jobs:filter` loads the private `JOB_USER_PROFILE_FILE`, applies deterministic company gates first, and asks AI to evaluate the remaining job descriptions against the natural-language profile. The profile and company verification import stay under the ignored `data/` directory or an external mode-600 production path. `/jobs` shows the latest filtered digest in Telegram; `jobs:daily` sends one message after collection and filtering.

JobKorea discovery uses its public search and public detail pages without login credentials. Wanted rejects automated server access without an authorized user session, so set `WANTED_STORAGE_STATE_FILE` to an ignored Playwright storage-state file exported from an account allowed to use the service. A missing session or source failure is reported in the digest and does not deactivate previously known postings. Never commit an ID, password, cookie, or storage-state file.

The production `jobs-daily.timer` runs one weekday digest at 09:20 KST. Install it with the other systemd units only after the private profile, company-verification import, and (optionally) Wanted session have been placed outside Git.

JobPlanet company verification uses the configured account (`JOBPLANET_ID`, `JOBPLANET_PASSWORD`) and an ignored Playwright storage-state file (`JOBPLANET_STORAGE_STATE_FILE`). The daily pipeline refreshes active-company ratings and employee counts before filtering. Never commit credentials, cookies, or storage-state files. Missing verification, rating below the configured threshold, or employee count below the configured threshold is an automatic exclusion.

운영 환경에서는 `systemd/`의 서비스와 타이머 예시를 환경에 맞게 수정해서 사용합니다.

## Structure

- `src/core/`: Telegram 라우팅과 플랫폼 상태
- `src/apps/housing/`: 주거 도메인 명령과 공식 링크 탐색
- `src/apps/jobs/`: 채용 공고 수집, 기업 검증, 사용자 적합도 필터링
- `src/apps/reminders/`: 전역 이벤트·리마인더
- `src/collect.mjs`: 주거 공고 수집
- `src/bot.mjs`: 활성 모듈을 조립하는 진입점

자세한 설계는 [ARCHITECTURE.md](./ARCHITECTURE.md)를 참고하세요.

## Development conventions

버전은 Semantic Versioning을 사용하고, 커밋 메시지는 Conventional Commits 형식을 따릅니다. 자세한 규칙은 [CONTRIBUTING.md](./CONTRIBUTING.md)를 참고하세요.

## Security

- 봇은 설정된 `TELEGRAM_CHAT_ID` 한 명의 메시지만 처리합니다.
- Telegram token, API key, SSH key, `auth.json`, 운영 DB를 커밋하지 마세요.
- 사용자 입력은 지원하는 구조화 규칙으로만 저장하며 서버 명령으로 실행하지 않습니다.

## Natural-language reminders

The Telegram gateway accepts natural Korean reminder requests such as
`내일 오후 3시에 병원 예약 알려줘`. A tool-free OpenAI Structured Outputs
request converts relative dates in the
`Asia/Seoul` timezone into a structured reminder. Missing or ambiguous dates and
times cause a clarification question instead of a guessed schedule. The parsed
time and title are shown with the existing approval buttons before registration.
The strict `/remind YYYY-MM-DD HH:MM title` form remains available as a fast,
AI-free fallback. The bot service reads `OPENAI_API_KEY` from the separately
protected `openai-api.env`; the model receives no shell or filesystem tools.

## Google Calendar sync

The global reminder bot can optionally synchronize with a dedicated Google
Calendar in both directions. A local approved reminder becomes a 30-minute
calendar event at the reminder time. Creating, editing, or deleting an event in
that calendar creates, updates, or cancels the matching local reminder.

Create a Google OAuth **Desktop app** client with the Calendar scope
`https://www.googleapis.com/auth/calendar.app.created`. This limits the token to
secondary calendars created by this app instead of every calendar the account
can access. For an external consent app, publish
it to Production before final authorization; refresh tokens from Testing mode
expire after seven days. An Internal Google Workspace app is also suitable.
Obtain a refresh token for the separate Google account, then set the
`GOOGLE_CALENDAR_*` values shown in `telegram.env.example`. Do not commit OAuth
credentials. The one-time authorization helper accepts a private env file that
contains `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`, opens a
loopback OAuth callback and creates the dedicated `Life Daemon` calendar. Run
this helper on the desktop where the browser opens, not on the remote server:

```sh
node --env-file=/path/to/oauth-client.env \
  src/admin/authorize-google-calendar.mjs data/google-calendar.env
```

Open the URL written next to the output file and approve access with the
calendar owner account. Reusing the same output file reuses the existing
calendar instead of creating a duplicate. Copy the generated file to a private
temporary path on the server, then merge only its Google settings into the
service environment (existing Telegram, MyHome, and profile values are
preserved):

```sh
node src/admin/install-google-calendar-env.mjs \
  /private/tmp/google-calendar.env \
  /home/ubuntu/.config/monitor-platform/telegram.env
```

Both helpers force their output to mode `0600`. Remove the temporary upload,
restart `monitor-telegram-bot.service` and `monitor-reminder.service`, then use
`/calendar` in Telegram to check the last synchronization state. A one-off
synchronization can be run with `npm run calendar:sync` on the server.

The installer refuses to replace an existing calendar ID. If the dedicated
calendar was deleted, migrate or clear its existing reminder mappings before
installing credentials for a replacement calendar; otherwise future reminders
would remain attached to the deleted calendar.

If `GOOGLE_CALENDAR_ENABLED` is false or any credential is missing, the existing
reminder bot continues without Calendar access.

## Housing decision engine

- Keep the private profile outside Git and point `HOUSING_USER_PROFILE_FILE` at the mode-600 JSON file.
- A confirmed recommendation is shown after eligibility and official evidence are complete. Otherwise the digest keeps the component total with an explicit `(추정)` label and lists the missing conditions and evidence gaps.
- Profile changes automatically invalidate active reviews. The private profile file stays outside Git, while this single-user bot may include exact values in its stored assessment and Telegram explanation.
- PDF extraction uses Poppler. Image-only PDFs can use `pdftoppm`, `pdfinfo`, and Tesseract with `kor+eng` language data when installed.

## License

MIT
