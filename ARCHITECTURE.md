# Life Daemon architecture

Life Daemon is a personal automation platform, not a single-purpose housing bot.

## Boundaries

- `src/core/`: Telegram polling, authorization, routing, retries, and other shared runtime concerns.
- `src/apps/housing/`: Housing-specific commands and interactions.
- `src/apps/jobs/`: Future job-notice collectors, filters, reports, and interaction state.
- `src/apps/reminders/`: Global event proposals, approval, listing, and delivery shared by every app.
- `src/telegram.mjs`: Shared Telegram client. It has no housing or jobs business rules.
- `src/bot.mjs`: Composition root. It registers enabled app modules with the shared runtime.
- `data/platform.sqlite`: Shared gateway checkpoints only; app data stays in app-owned databases.

Each app owns its sources, classification rules, database tables, digest formatting, and user actions. Apps must namespace Telegram callback data (`h:` for housing, `j:` for jobs) so one gateway can safely route both.

Housing has a version-controlled base instruction in `src/apps/housing/instructions.mjs`. User rules are stored as structured records in `housing.sqlite`; they are never treated as executable code. Only supported rule types affect collection, which keeps Telegram input from changing arbitrary server behavior.

Housing discovery is a thin completeness sensor. New or changed likely/possible notices enter `review_queue`. The AI reviewer reads untrusted official content as evidence, may request up to two follow-ups, and the orchestrator fulfills those requests only through an HTTPS official-domain allowlist. Missing critical fields force a title-based official detail search even when the model does not request one. Structured reviews and content hashes are retained in SQLite; unchanged notices do not consume another AI call.

Housing decisions separate hard eligibility from practical value. The score is calculated from bounded components: housing value (40), selection chance (30), and execution readiness (30). When eligibility or official evidence remains uncertain, Telegram retains the component total but labels it `(추정)` and shows the critical user facts and missing official evidence.

The private housing profile is loaded from `HOUSING_USER_PROFILE_FILE` and is never committed. A canonical fingerprint, not the profile itself, is stored with reviews. Changing the profile automatically invalidates and requeues active candidate reviews. Exact private values are removed from persisted AI output before it can reach SQLite or Telegram.

Review rows are also gated by a versioned decision policy. Queue claims carry a unique token and a one-hour fallback lease; a timed-out daily worker releases its claims immediately. The daily service runs review work in a killable child process with a 45-minute hard deadline, preserving time for the Telegram digest inside the two-hour systemd window.

Official evidence retrieval ranks title matches conservatively, classifies official attachments, samples long PDFs across their full page range, and attempts OCR when a PDF has too little extractable text. Retrieval failures remain explicit evidence gaps; they are not converted into user ineligibility. OCR requires `pdftoppm`, `tesseract`, and Korean language data on the worker host.

MyHome collection is considered complete only when every advertised raw row is returned and `totalCount` remains stable across pages. Otherwise the previous active set is retained rather than treating a partial API response as deletions.

## Adding another monitor

An app module exposes:

- `id` and `help`
- `canHandleCallback(query)`
- `handleCallback(query)`
- `handleMessage(message)` returning whether it handled the message

Register the module in `src/bot.mjs`. A separate Telegram bot can use the same module with a different composition root and environment file; no collector or classification code needs to be copied.

Daily collectors remain separate systemd one-shot services and timers. The always-running Telegram gateway handles only interactions, so a slow or failed crawl cannot stop the bot.

Approved reminders are stored in `platform.sqlite` and delivered by the independent `monitor-reminder.service`. App modules propose reminders; they do not schedule or send due events themselves.
Reminder links are optional. Domain events may attach a resolver and structured metadata; the worker resolves an official result link at delivery time. Generic events can have no link at all.

## Codex authentication fallback

`codex-auto` runs new non-interactive tasks with the ChatGPT-authenticated Codex home first. It retries with the separately stored API-authenticated home only for recognizable usage-limit, rate-limit, quota, or HTTP 429 failures, and sends a Telegram notice when it switches. Other failures are returned unchanged. `codex-api` explicitly opens the API-authenticated profile. Interactive sessions are not switched mid-turn.
