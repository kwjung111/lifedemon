# Life Daemon architecture

Life Daemon is a personal automation platform, not a single-purpose housing bot.

## Boundaries

- `src/core/`: Telegram polling, authorization, routing, retries, and other shared runtime concerns.
- `src/apps/housing/`: Housing-specific commands and interactions.
- `src/apps/jobs/`: Job-notice collectors, company verification, profile filtering, reports, and interaction state.
- `src/apps/reminders/`: Global event proposals, approval, listing, and delivery shared by every app.
- `src/apps/feedback/`: Shared explicit feedback parsing, durable-rule proposals, and approval routing; domain adapters apply approved rules.
- `src/telegram.mjs`: Shared Telegram client. It has no housing or jobs business rules.
- `src/bot.mjs`: Composition root. It registers enabled app modules with the shared runtime.
- `data/platform.sqlite`: Shared gateway settings, durable Telegram outbox, feedback state, reminder state, Calendar mappings, and synchronization leases; domain-specific housing and job data stay in app-owned databases.

Each app owns its sources, classification rules, database tables, digest formatting, and user actions. Apps must namespace Telegram callback data (`h:` for housing, `j:` for jobs) so one gateway can safely route both.

The briefing app is a read-only cross-domain presentation layer. Weekday housing and job services prepare all source data before 09:00 without sending standalone digests. `morning-briefing.service` then reads the current domain projections and approved reminders, emits one bounded message, and stores a mixed-domain reply context. Only the top three recommendations per domain are displayed; signatures collapse an unchanged domain to `변경 없음`, while the full analyzed set remains in its owning database. A reply target is resolved across the mixed list and delegated to the owning housing or job module, so application and feedback mutations remain domain-owned. Natural `더 보여줘` requests return the next bounded domain page.

Feedback is explicit and low-friction. Recommendation messages retain only their primary apply action; natural-language replies are interpreted into a bounded schema and stored in `platform.sqlite`. Silence is never interpreted as rejection. Application state and recommendation visibility are independent, so item-level negatives hide only the referenced recommendation and never erase an application being tracked. Durable wording creates a proposal under the `f:` callback namespace, and only an approved proposal is applied through a domain adapter. Housing adapters write the existing keyword-rule store; job company rules are consulted when building every later digest. Natural undo marks the event reverted, restores the prior domain application and visibility state, disables a linked durable rule when present, and cancels follow-up reminders created by an undone application.

Reply interpretation is AI-first and conversational: the structured result contains target, intent, confidence, scope, strength, a Korean paraphrase, and independently scored positive/negative aspects. The prompt receives only public digest labels and treats both labels and reply text as untrusted data. Multiple plausible items, confidence below the safety threshold, and under-specified durable rules never trigger a guessed mutation; the domain module asks one short clarification and carries the original digest context into the next reply. A narrow deterministic parser is used only when the interpreter is unavailable, and future intent is never treated as a completed application. Ordinary feedback is projected by canonical concept with the latest opinion winning; it changes later ordering with a bounded score and never bypasses hard eligibility and verification gates. Durable exclusion still requires explicit future-oriented wording plus one confirmation.

`src/telegram.mjs` persists `sendMessage` calls before network I/O. The outbox claim is retried with capped exponential delay by `monitor-telegram-outbox.service`; callers receive success only after a delivered row has a Telegram result. Successful rows retain Telegram message IDs and domain context so replies to delayed digests remain resolvable. Stable keys are supplied only for scheduled operations that must be idempotent. Interactive responses get unique keys, so an intentional repeated command still produces a new response. Permanent Telegram 4xx errors remain inspectable instead of being retried forever. Incoming updates are journaled in a durable inbox before dispatch, authorized by both private chat and sender ID, retried three times, and only then advance the polling offset. Runtime IPv4 preference complements the systemd network-family flag.

The manager app starts from a read-only cross-domain projection gathered from app-owned query APIs, private profiles, Calendar/reminder state, and a fixed systemd unit allowlist. Deterministic formatters answer common priority, collection, and health questions immediately. `/ask` is backed by one persisted Codex app-server thread. The bot resumes that thread after restarts, injects a fresh cross-domain snapshot and `account/rateLimits/read` result into each turn, and enforces `read-only` at the thread plus turn boundaries with command-network access disabled and approvals set to `never`. The child process receives a sanitized environment, and its durable developer instruction prohibits secret access and all mutations.

If the conversational app-server is unavailable, complex and causal questions fall back to a bounded autonomous investigation loop: Structured Outputs selects allowlisted diagnostic actions, code maps them to fixed `execFile` arguments or predefined SQLite queries, observations return to the model, and the model may adapt its next read. Bounded source search ranks terms across file paths and nearby context, while a fixed Git pickaxe query can identify when an exact identifier changed so incidents can be correlated with the deployed revision. The fallback loop has strict round/call limits, deduplicates actions, redacts secrets, and cannot accept arbitrary commands, SQL, units, paths, or hosts. Neither path can mutate app or infrastructure state.

Housing has a version-controlled base instruction in `src/apps/housing/instructions.mjs`. User rules are stored as structured records in `housing.sqlite`; they are never treated as executable code. Only supported rule types affect collection, which keeps Telegram input from changing arbitrary server behavior.

Housing discovery is a thin completeness sensor. New or changed likely/possible notices enter `review_queue`. The AI reviewer reads untrusted official content as evidence, may request up to two follow-ups, and the orchestrator fulfills those requests only through an HTTPS official-domain allowlist. Missing critical fields force a title-based official detail search even when the model does not request one. Structured reviews and content hashes are retained in SQLite; unchanged notices do not consume another AI call.

Job discovery is deliberately separated from job filtering. The collectors read only public listing/detail routes and store normalized job records in `jobs.sqlite`; they never read the user's profile. The filter stage loads the ignored `JOB_USER_PROFILE_FILE`, first applies deterministic company gates, then gives only surviving job descriptions to the AI evaluator. Company verification is an injected licensed/manual dataset, never a JobPlanet crawler. A missing verification is an exclusion under the current strict policy.

Housing decisions separate hard eligibility from practical value. The score is calculated from bounded components: housing value (40), selection chance (30), and execution readiness (30). When eligibility or official evidence remains uncertain, Telegram retains the component total but labels it `(추정)` and shows the critical user facts and missing official evidence.

Applied housing notices are also scanned by an independent hourly result worker after their announcement date. It conservatively discovers the official result notice, then asks for a one-tap private outcome confirmation when public evidence cannot identify the user safely. Outcome, cutoff, supply count, reached priority, and recommendation feedback stay in `housing.sqlite`. This history may reorder suitable candidates toward larger supply and evidenced second- or third-priority reach, but it never changes hard eligibility.

An application action also performs a bounded deterministic follow-up extraction over the already stored notice text. Exact result/interview times create a proposed global reminder. Housing dates without an official time use a visibly labelled 09:00 KST fallback; job follow-ups require both an exact date and time. Housing reminder metadata drives a fresh official result search at delivery, so the final link does not have to exist when the application is recorded.

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

Daily collectors remain separate systemd one-shot services and timers. They prepare data at 06:30 and 07:40 KST; the independent 09:00 briefing reads the latest completed state, so a slow or failed crawl cannot stop the bot or create multiple scheduled report messages.

Approved reminders are stored in `platform.sqlite` and delivered by the independent `monitor-reminder.service`. App modules propose reminders; they do not schedule or send due events themselves.
Reminder links are optional. Domain events may attach a resolver and structured metadata; the worker resolves an official result link at delivery time. Generic events can have no link at all.

Google Calendar integration is optional and remains inside the reminder worker. A dedicated calendar is synchronized in both directions through the Google Calendar REST API: approved/cancelled global reminders are pushed to Google, and Google event creates/updates/deletes are applied to `platform.sqlite`. OAuth credentials are supplied only through the private environment file. When they are absent or the feature flag is off, reminder behavior is unchanged.

Natural-language Telegram reminder requests are routed to the shared structured Codex runner only when reminder intent is detected. The same runner handles housing assessment, job filtering, Wanted search, and bounded manager analysis. It runs an ephemeral Codex CLI process in a temporary directory with a read-only sandbox, stdin-only untrusted prompts, a strict JSON schema, a minimal sanitized environment, and forced termination after timeout. The schema output must ask for clarification when an exact date or time is missing. The existing approval callback remains the write boundary, and the strict `/remind` syntax bypasses AI entirely.

Daily collectors retain lightweight operational telemetry in each app database: the last attempt and successful collection times plus per-run new, changed, deactivated, and failed counts. Telegram digests expose this health summary. A zero-row validation failure retains the previous active source set. Weekday digest timers deliberately use `Persistent=false`, preventing weekend catch-up, and the housing/job services share a file lock to avoid overlapping AI batches. Every production service routes terminal failures to a Telegram notifier that redacts common credential patterns before including recent logs. A separate daily timer creates SQLite `VACUUM INTO` snapshots with owner-only permissions and 30-day rotation.

## Codex authentication fallback

Structured jobs run with the ChatGPT-authenticated Codex home first. They retry with the separately stored API-authenticated home only when fallback is explicitly enabled, a valid key exists, and the failure is a recognizable usage-limit, rate-limit, quota, authentication, or HTTP 429 error. A SQLite budget caps total fallback calls per KST day and the first switch queues a Telegram notice. Other failures are returned unchanged. Interactive sessions are not switched mid-turn.
