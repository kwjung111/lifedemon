# Life Daemon

Life Daemon은 반복적인 탐색, 추적, 기록과 알림을 대신 수행하는 개인용 자동화 시스템입니다.

현재 제공하는 기능:

- LH·SH·청년안심주택·HUG·마이홈 주거 공고 수집
- 서울 거주 1인 청년 관점의 1차 필터링
- Telegram 단일 브리핑과 지원 상태 추적
- 평일 09:00 오늘 일정·주택·채용 통합 브리핑과 필요할 때만 추가 조회
- 사용자 제외 규칙 저장
- 전역 리마인더 등록·승인·발송
- 발표 시점의 공식 결과 링크 동적 탐색
- 공개 채용 공고 수집, 검증된 기업 필터링, Telegram 브리핑
- 한국어 자연어 리마인더와 전용 Google Calendar 양방향 동기화
- systemd 기반 상시 실행과 평일 스케줄링
- SQLite 상태 일일 백업과 30일 보관
- 형식 없는 Life Inbox 입력과 자연어 수정·취소

향후 면접 일정, 가격 추적 등 다른 생활 자동화 모듈을 같은 런타임에 추가할 수 있습니다.

## Requirements

- Node.js 22 이상
- Playwright Chromium
- Telegram bot token
- 자연어 리마인더 및 Wanted 검색용 서버 Codex CLI 로그인
- 선택 사항: Codex 사용량·인증 오류 시 사용할 API fallback key
- SQLite CLI (`sqlite3`, 운영 백업용)

## Setup

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env
```

`.env`에 본인의 Telegram bot token, 허용할 개인 chat ID와 동일 사용자의
`TELEGRAM_USER_ID`를 입력합니다. 봇은 이 사용자의 private chat만 처리합니다.
`.env`, SQLite DB, 인증 키는 Git에 포함하지 마세요.

## Run

```bash
npm run bot
npm run telegram:outbox
npm run calendar:sync
npm run housing:daily
npm run housing:results
npm run jobs:collect
npm run jobs:filter
npm run jobs:daily
npm run briefing
```

## Morning briefing

The scheduled user-facing report is one weekday message at 09:00 KST. Housing
collection and AI review prepare data at 06:30, and job collection, company
verification, and filtering prepare data at 07:40. These preparation jobs store
all results but do not send separate daily messages.

The briefing includes every actionable event due today, application counts, and
at most the top three housing and top three job recommendations. A domain whose
top recommendations did not change is reduced to `변경 없음`. Reply with normal
language such as `4번 지원했어`; the mixed-domain context routes the number to
the correct tracker. `주택 더 보여줘` or `채용 더 보여줘` returns only the next
recommendations in one additional message. `/housing` and `/jobs` remain
available for their existing detailed views.

## Life Inbox

Send a life event, task, link, memo, photo, or document directly to the Telegram bot without a command. Clear inputs are classified locally; only ambiguous free text uses Codex. The bot responds once with what it saved, the smallest assumptions it made, and the next action. Reply to that confirmation in ordinary Korean to correct, complete, or cancel the item. `/inbox` shows the current bounded list, and at most three active next actions are included in the existing weekday 09:00 briefing rather than generating another scheduled message.

Classifier telemetry records rule/AI call counts and bounded input/output character counts in `platform.sqlite`; it does not store or claim exact provider token usage. Set `INBOX_AI_ENABLED=false` to keep every otherwise ambiguous statement as a reversible note without an AI call.

## Low-friction feedback

Housing and job digests keep only the primary `신청했어` or `지원했어` action
button. Other feedback is sent by replying to the digest with the item number:

```text
2번 별로야
3번 괜찮네
2번 이 회사는 앞으로 빼
두 번째가 제일 나아 보이네
위시켓은 좀 미묘한데
콘텐츠브릿지는 지원해볼 만함
```

The wording is conversational rather than command-only. A reply may identify an
item by number anywhere in the sentence, Korean ordinal, company/source name, or
a distinctive title term. A single-item message also accepts `이건 별로`
without a number. An AI-first interpreter resolves the target and preserves the
meaning, scope, strength, and separate positive/negative aspects of nuanced
feedback. It runs directly from the reply without `/ask`. Only public digest
labels are sent to the interpreter; private posting bodies and credentials are
not included. Low-confidence or ambiguous interpretations produce one short
clarification instead of a guessed mutation. If the interpreter is unavailable,
the narrow deterministic parser remains as a safe fallback.

Item feedback is stored in the shared platform database. A negative reply hides
that item but does not silently become a permanent preference. Wording that
clearly requests a durable rule creates a single `적용`/`취소` confirmation.
Approved company rules hide later job postings from the same normalized company,
and approved housing keyword rules enter the existing housing collection and AI
review instructions. Messages that receive no reply are not treated as negative
feedback. Stored company, role, housing type, location, cost, and eligibility
preferences adjust the ordering of matching later recommendations, while hard
eligibility, role, and company-verification gates remain authoritative. Mixed
feedback such as `회사는 좋은데 직무는 별로` stores both aspects independently
and does not hide the current item. Send `/feedback` to inspect what the bot
understood and is using.
Send `피드백 규칙 보여줘` to review active durable rules and delete one with a
reply such as `J2 규칙 삭제` or `H3 규칙 삭제`.

Feedback can be undone without another button. Send `방금 거 취소` to revert
the latest active feedback, or reply to the original digest with text such as
`1번 관심없음 취소`. The bot restores the item's previous application state;
if the feedback created a durable exclusion rule, that linked rule is disabled
as part of the same undo.

## Reliable Telegram delivery

Every outbound Telegram message is written to `platform.sqlite` before the API
call. Network failures remain pending with exponential retry timing, and the
independent `monitor-telegram-outbox.service` delivers them after connectivity
recovers. A retry reuses the same outbox record, while scheduled digests and
reminders also use stable delivery keys to avoid duplicate sends. Digest item
context is retained with the outbox row, so numbered replies still work when a
message was delivered later by the recovery worker.

Incoming Telegram updates are also journaled before handling. The polling offset
advances only after successful processing (or an explicit three-attempt
dead-letter decision), so a restart during AI interpretation does not silently
discard a reply. Replayed feedback updates use stable source keys and do not add
duplicate preference events.

The client prefers IPv4 and disables Node network-family autoselection both in
code and in systemd. Non-retryable Telegram request errors remain visible as
failed outbox records for `/ask` diagnostics rather than looping forever.

## Application follow-up reminders

When `신청했어` or `지원했어` is recorded, the bot scans the stored official
notice text for an exact result, interview, or selection schedule. A discovered
schedule is proposed through the global reminder approval flow. Housing notices
with a known result date but no official time are explicitly proposed for 09:00
KST instead of silently inventing a time. At delivery, housing reminders search
the official source for the result page and fall back to the original notice
when no safe match exists. Public job postings rarely contain a personalized
interview schedule, so the job flow proposes a reminder only when both date and
time are actually present.

## Life Daemon operations assistant

The existing Telegram gateway includes a read-only operations assistant. Use
`/daemon` for a concise overall health report, or `/ask <question>` for a
persistent conversational Codex thread. The thread ID is stored in the shared
platform database, so follow-up context survives Telegram messages and bot
restarts. Each turn also receives the Codex app-server's authoritative account
rate-limit snapshot; questions such as `/ask 지금 코덱스 얼마나 남았어?` work
without a separate usage command. Common operations questions may also be sent
without a command, such as `채용공고 우선순위가 어떻게 돼?` or
`수집이 마지막으로 언제 돌았지?`.

Common health and priority questions are formatted directly from a bounded
snapshot. More complex or causal questions start an autonomous read-only
investigation. The agent may adaptively inspect an allowlisted Life Daemon
service or timer, bounded journal logs, SQLite integrity and queue state, server
resources, deployment state, configuration presence, fixed upstream network
connectivity, deployed unit definitions, and bounded source-code matches.
Source investigations rank multi-term matches across nearby context and can
inspect bounded Git history for the exact revision that introduced a setting or
behavior, allowing an earlier scheduled run to be correlated with deployed code.

The conversational thread uses read-only sandboxing at both thread and turn
boundaries, disables command-network access, receives a minimal sanitized
environment, and uses an approval policy that cannot authorize writes. It is
explicitly prohibited from inspecting credentials or secret files. If the
app-server is unavailable, `/ask` falls back to the existing bounded diagnostic
agent and API fallback policy.

Every fallback investigation uses strict structured actions, at most three adaptive
rounds and eight tool calls. Tool implementations use fixed command argument
lists: the model cannot supply a shell command, SQL statement, arbitrary unit,
path, or host. Outputs are secret-redacted and bounded before the model sees
them. The assistant can diagnose and recommend a next action, but mutating
operational actions remain intentionally unavailable.

## Housing result feedback

`housing-result-check.timer` checks due applications hourly on weekdays. When an
official result announcement is found, Telegram asks the user to confirm the
private document-screening outcome once. Replying with the housing name, cutoff,
supply count, and how far allocation reached enriches later recommendations.
Past outcomes never override hard eligibility rules; they only influence the
ordering of otherwise relevant candidates. Personal outcomes and preferences
remain in the ignored production SQLite database and are not committed.

If a public result contains no stable personal identifier, the bot deliberately
does not guess whether the user was selected. The official-announcement check is
automatic, while that private outcome requires one Telegram tap.

상시 Telegram gateway, durable outbox worker, reminder worker와 평일 수집 작업은 `systemd/`의 unit으로 운영합니다. 평일 수집 timer는 토·일요일에 누락된 실행을 보충하지 않습니다. 서비스가 실패하면 `monitor-failure-notify@.service`가 최근 상태와 로그 일부를 민감정보 마스킹 후 Telegram으로 알립니다. `monitor-backup.timer`는 매일 03:30 KST에 세 SQLite DB를 일관된 스냅샷으로 백업하고 기본 30일간 보관합니다.

주거·채용 일일 리포트에는 소스별 원본 수집 건수, 신규·변경·종료·오류 건수와 마지막 정상 수집 시각이 포함됩니다.

## Job notices

The job pipeline has two separate stages. `jobs:collect` accesses only public listing and detail pages from Remember, Wanted, and JobKorea, then normalizes and deduplicates postings. It does not use the private profile or make suitability decisions.

`jobs:filter` loads the private `JOB_USER_PROFILE_FILE`, applies deterministic company gates first, and asks AI to evaluate the remaining job descriptions against the natural-language profile. The profile and company verification import stay under the ignored `data/` directory or an external mode-600 production path. `/jobs` shows the latest detailed view in Telegram; the scheduled job stores its results for the combined morning briefing.

JobKorea discovery uses its public search and public detail pages without login credentials. Wanted blocks direct server-side Playwright search even with a renewable user session, so the production collector runs non-interactive `codex --search exec` instead. It searches only official `wanted.co.kr/wd/<id>` pages for DevOps, DevSecOps, SRE, platform, cloud, and infrastructure roles, requires an active-posting signal, canonicalizes the Wanted ID, and then feeds verified results into the same deduplication and filtering pipeline. The Codex child process receives a minimal environment, a read-only sandbox, no repository workspace, and a strict JSON output schema.

The first search attempt uses the server's ChatGPT-linked Codex login. When its error specifically indicates quota or authentication exhaustion, an API-backed retry is allowed only when `CODEX_API_FALLBACK_ENABLED=true` and `CODEX_API_FALLBACK_KEY` (or `OPENAI_API_KEY`) is configured. `CODEX_API_DAILY_CALL_LIMIT` caps fallback calls across processes, and the first switch each day queues a Telegram cost notice. Gmail remains a supplementary discovery channel: URLs found under the read-only `BOT/Wanted` label are passed to the same live verification prompt, but missing or delayed email never blocks web discovery.

The production `jobs-daily.timer` prepares data at 07:40 KST, and `morning-briefing.timer` sends the combined message at 09:00 KST. Install them only after the private profile, company-verification import, Codex login, and optional Gmail credentials have been placed outside Git.

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

- 봇은 설정된 `TELEGRAM_CHAT_ID`의 private chat에서 정확히 일치하는 `TELEGRAM_USER_ID`의 메시지만 처리합니다.
- Telegram token, API key, SSH key, `auth.json`, 운영 DB를 커밋하지 마세요.
- 사용자 입력은 지원하는 구조화 규칙으로만 저장하며 서버 명령으로 실행하지 않습니다.

## Natural-language reminders

The Telegram gateway accepts natural Korean reminder requests such as
`/remind 내일 오후 3시에 병원 예약 알려줘`. A sandboxed, tool-free Codex
request converts relative dates in the
`Asia/Seoul` timezone into a structured reminder. Missing or ambiguous dates and
times cause a clarification question instead of a guessed schedule. The parsed
time and title are shown with the existing approval buttons before registration.
The strict `/remind YYYY-MM-DD HH:MM title` form remains available as a fast,
AI-free fallback. Natural-language parsing uses the server's ChatGPT-linked Codex
login first and only uses `CODEX_API_FALLBACK_KEY` (or `OPENAI_API_KEY`) when a
valid fallback key is configured and the login reports a quota or authentication
failure. The parser has no web search and runs in a temporary read-only sandbox.

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
`/calendar_status` in Telegram to check the last synchronization state. The old
`/calendar` alias remains supported. A one-off
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
