# Life Daemon architecture

Life Daemon is a personal automation platform, not a single-purpose housing bot.

## Boundaries

- `src/core/`: Telegram polling, authorization, routing, retries, and other shared runtime concerns.
- `src/apps/housing/`: Housing-specific commands and interactions.
- `src/apps/jobs/`: Job-notice collectors, company verification, profile filtering, reports, and interaction state.
- `src/apps/reminders/`: Global event proposals, approval, listing, and delivery shared by every app.
- `src/telegram.mjs`: Shared Telegram client. It has no housing or jobs business rules.
- `src/bot.mjs`: Composition root. It registers enabled app modules with the shared runtime.
- `data/platform.sqlite`: Shared gateway settings, reminder state, Calendar mappings, and synchronization leases; domain-specific housing and job data stay in app-owned databases.

Each app owns its sources, classification rules, database tables, digest formatting, and user actions. Apps must namespace Telegram callback data (`h:` for housing, `j:` for jobs) so one gateway can safely route both.

The manager app starts from a read-only cross-domain projection gathered from app-owned query APIs, private profiles, Calendar/reminder state, and a fixed systemd unit allowlist. Deterministic formatters answer common priority, collection, and health questions immediately. Complex and causal questions enter a bounded autonomous investigation loop: Structured Outputs selects allowlisted diagnostic actions, code maps them to fixed `execFile` arguments or predefined SQLite queries, observations return to the model, and the model may adapt its next read. The loop has strict round/call limits, deduplicates actions, redacts secrets, and cannot accept arbitrary commands, SQL, units, paths, or hosts. Model output can diagnose and recommend but cannot mutate app or infrastructure state.

Housing has a version-controlled base instruction in `src/apps/housing/instructions.mjs`. User rules are stored as structured records in `housing.sqlite`; they are never treated as executable code. Only supported rule types affect collection, which keeps Telegram input from changing arbitrary server behavior.

Housing discovery is a thin completeness sensor. New or changed likely/possible notices enter `review_queue`. The AI reviewer reads untrusted official content as evidence, may request up to two follow-ups, and the orchestrator fulfills those requests only through an HTTPS official-domain allowlist. Missing critical fields force a title-based official detail search even when the model does not request one. Structured reviews and content hashes are retained in SQLite; unchanged notices do not consume another AI call.

Job discovery is deliberately separated from job filtering. The collectors read only public listing/detail routes and store normalized job records in `jobs.sqlite`; they never read the user's profile. The filter stage loads the ignored `JOB_USER_PROFILE_FILE`, first applies deterministic company gates, then gives only surviving job descriptions to the AI evaluator. Company verification is an injected licensed/manual dataset, never a JobPlanet crawler. A missing verification is an exclusion under the current strict policy.

Housing decisions separate hard eligibility from practical value. The score is calculated from bounded components: housing value (40), selection chance (30), and execution readiness (30). When eligibility or official evidence remains uncertain, Telegram retains the component total but labels it `(추정)` and shows the critical user facts and missing official evidence.

Applied housing notices are also scanned by an independent hourly result worker after their announcement date. It conservatively discovers the official result notice, then asks for a one-tap private outcome confirmation when public evidence cannot identify the user safely. Outcome, cutoff, supply count, reached priority, and recommendation feedback stay in `housing.sqlite`. This history may reorder suitable candidates toward larger supply and evidenced second- or third-priority reach, but it never changes hard eligibility.

The private housing profile is loaded from `HOUSING_USER_PROFILE_FILE` and is never committed. A canonical fingerprint, not the profile itself, is stored with reviews. Changing the profile automatically invalidates and requeues active candidate reviews. Because this is a single-user bot, assessment output may retain exact profile values in SQLite and Telegram.

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

Google Calendar integration is optional and remains inside the reminder worker. A dedicated calendar is synchronized in both directions through the Google Calendar REST API: approved/cancelled global reminders are pushed to Google, and Google event creates/updates/deletes are applied to `platform.sqlite`. OAuth credentials are supplied only through the private environment file. When they are absent or the feature flag is off, reminder behavior is unchanged.

Natural-language Telegram reminder requests are routed to the shared structured Codex runner only when reminder intent is detected. It runs an ephemeral Codex CLI process in a temporary directory with a read-only sandbox, a strict JSON schema, and a minimal sanitized environment. The schema output must ask for clarification when an exact date or time is missing. The existing approval callback remains the write boundary, and the strict `/remind` syntax bypasses AI entirely.

Daily collectors retain lightweight operational telemetry in each app database: the last attempt and successful collection times plus per-run new, changed, deactivated, and failed counts. Telegram digests expose this health summary. systemd timers are persistent so a reboot catches a missed weekday run, and every production service routes terminal failures to a Telegram notifier that redacts common credential patterns before including recent logs.

## Codex authentication fallback

`codex-auto` runs new non-interactive tasks with the ChatGPT-authenticated Codex home first. It retries with the separately stored API-authenticated home only for recognizable usage-limit, rate-limit, quota, or HTTP 429 failures, and sends a Telegram notice when it switches. Other failures are returned unchanged. `codex-api` explicitly opens the API-authenticated profile. Interactive sessions are not switched mid-turn.
