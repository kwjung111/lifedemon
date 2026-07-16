# Life Daemon

Life Daemon은 반복적인 탐색, 추적, 기록과 알림을 대신 수행하는 개인용 자동화 시스템입니다.

현재 제공하는 기능:

- LH·SH·청년안심주택·HUG·마이홈 주거 공고 수집
- 서울 거주 1인 청년 관점의 1차 필터링
- Telegram 단일 브리핑과 지원 상태 추적
- 사용자 제외 규칙 저장
- 전역 리마인더 등록·승인·발송
- 발표 시점의 공식 결과 링크 동적 탐색
- systemd 기반 상시 실행과 평일 스케줄링

향후 채용 공고, 면접 일정, 가격 추적 등 다른 생활 자동화 모듈을 같은 런타임에 추가할 수 있습니다.

## Requirements

- Node.js 22 이상
- Playwright Chromium
- Telegram bot token

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
```

운영 환경에서는 `systemd/`의 서비스와 타이머 예시를 환경에 맞게 수정해서 사용합니다.

## Structure

- `src/core/`: Telegram 라우팅과 플랫폼 상태
- `src/apps/housing/`: 주거 도메인 명령과 공식 링크 탐색
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

## Housing decision engine

- Keep the private profile outside Git and point `HOUSING_USER_PROFILE_FILE` at the mode-600 JSON file.
- A confirmed recommendation is shown after eligibility and official evidence are complete. Otherwise the digest keeps the component total with an explicit `(추정)` label and lists the missing conditions and evidence gaps.
- Profile changes automatically invalidate active reviews. Exact profile values are removed before AI results are stored or sent to Telegram.
- PDF extraction uses Poppler. Image-only PDFs can use `pdftoppm`, `pdfinfo`, and Tesseract with `kor+eng` language data when installed.

## License

MIT
