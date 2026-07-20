# Changelog

## 1.11.0 - 2026-07-20

### Added

- Added a durable Telegram update inbox with retry/dead-letter handling, private chat-and-user authorization, and replay-safe feedback event keys.
- Added daily atomic SQLite backups with 30-day rotation and a dedicated systemd timer.
- Added an explicit, daily-budgeted Codex API fallback with a once-per-day Telegram cost notice.

### Changed

- All structured Codex jobs now run in an ephemeral read-only workspace with a sanitized environment, stdin prompts, strict schemas, and forced timeout cleanup.
- Application tracking and recommendation visibility are independent: negative feedback can hide a recommendation without erasing an existing application.
- Current preferences use the latest canonical opinion per concept; semantic preference influence is bounded beneath hard eligibility and official assessment scores.
- Housing and job weekday timers no longer catch up during weekends, and batch jobs share one lock to avoid overlapping AI work.

### Fixed

- Rejected unsafe or off-domain Playwright navigation, protected stored browser sessions with owner-only permissions, and retained prior source state when a crawl validates zero rows.
- Preserved valid feedback metadata, all active preference events, mixed feedback aspects, and clarification reply context.
- Prevented future-intent phrases from being recorded as completed applications and prevented duplicate durable-rule proposals.
- Scheduled work is marked complete only after Telegram confirms delivery; truncated job digests no longer claim that repeating `/jobs` reveals a missing next page.

## 1.10.0 - 2026-07-20

### Added

- Added an AI-first structured feedback interpreter for housing and job digest replies, using the linked Codex account first and the configured API key only for quota or authentication fallback.
- Nuanced replies retain target, scope, strength, rationale, and separate positive/negative aspects, so tradeoffs are not collapsed into one binary signal.
- `/feedback` shows the recent preferences the bot understood and currently uses.
- Learned company, role, housing type, location, cost, and eligibility preferences now affect the order of matching future recommendations.

### Safety

- The interpreter receives public digest labels only, has no browsing or file access, and treats message contents as untrusted data.
- Ambiguous or low-confidence feedback asks a short clarification; permanent exclusions require high confidence, explicit future-oriented wording, and the existing approval button.
- A deterministic parser remains available only as an outage fallback, and hard eligibility or company-verification gates always outrank learned preferences.

## 1.9.0 - 2026-07-20

### Added

- Digest feedback now resolves natural references anywhere in a reply, including `2번이`, `두 번째`, a company name, a source name, or a distinctive posting-title term.
- Single-item messages accept context-only replies such as `이건 별로`; multi-item ambiguity produces one short clarification instead of guessing.
- Expanded ordinary Korean preference language for positive, negative, applied, and durable-exclusion intent without routing through `/ask` or consuming an AI call.

### Changed

- Job and housing digest footers now invite normal conversational replies instead of presenting one rigid command grammar.
- Negative feedback handling uses the shared parsed signal, keeping natural synonyms consistent across housing and jobs.

## 1.8.1 - 2026-07-20

### Fixed

- Unhandled numbered messages now explain that Telegram's actual reply gesture is required instead of returning the generic help fallback.
- Replies connected to a job digest but containing an unknown action now show concrete supported examples.
- Telegram routing logs retain only message IDs, reply IDs, item numbers, and the handling module so reply failures can be diagnosed without logging message text.

## 1.8.0 - 2026-07-20

### Added

- Added a durable SQLite-backed Telegram outbox with retry scheduling, delivery deduplication, delayed reply context, and a dedicated recovery worker.
- Added natural feedback undo. `방금 거 취소` reverts the latest feedback, while a numbered reply such as `1번 관심없음 취소` targets one digest item and restores its prior application state.
- Applying to a housing notice now extracts its official result date and time and proposes a global reminder. Exact job interview or result times embedded in a posting use the same flow.
- Housing follow-up reminders resolve the official result link dynamically at delivery time for supported official sources.

### Changed

- The Telegram client now disables network-family autoselection in code and prefers IPv4, so manual Node invocations retain the production connectivity workaround.
- Daily housing/job digests, reminder delivery, and housing-result prompts use stable delivery keys where duplicate suppression is required.
- Undoing an application also cancels any still-pending or approved follow-up reminder created by that action.
- `/ask` operational snapshots and diagnostics now expose Telegram outbox health and the dedicated outbox service.

## 1.7.0 - 2026-07-20

### Added

- Added a shared feedback event store for housing and job recommendations, including positive, negative, applied, and ignored signals with bounded item metadata.
- Natural replies such as `2번 별로야` now hide only that item, while `2번 이 회사는 앞으로 빼` creates a durable company-exclusion proposal.
- Durable preference changes require one explicit `적용` or `취소` confirmation and retain their decision history.

### Changed

- Housing and job digests no longer show a separate `관심없어` button for every item. Only the high-value apply button remains; ordinary feedback is sent as a reply.
- Housing exclusion instructions are proposed first instead of being applied immediately. Approved housing keyword rules feed the existing collector and reviewer, and approved job company rules hide future postings from that company.
- Explicit positive job feedback modestly promotes later postings from the same company without bypassing hard eligibility or verification gates.
- `/ask` snapshots now include recent feedback and active cross-domain feedback rules.

## 1.6.0 - 2026-07-20

### Added

- `/ask` now resumes one persisted Codex app-server thread, so follow-up questions retain their conversation across Telegram messages and bot restarts.
- Every `/ask` turn receives an authoritative `account/rateLimits/read` snapshot, allowing natural questions about remaining Codex usage without a separate model tool or Telegram command.

### Changed

- `/ask` runs as a conversational Codex session with a per-thread and per-turn read-only sandbox, disabled command-network access, a sanitized process environment, and an approval policy that cannot authorize writes.
- `/daemon` and natural operations questions keep the deterministic and bounded diagnostic paths. If app-server is unavailable, `/ask` falls back to the existing allowlisted diagnostic agent and API fallback policy.

## 1.5.2 - 2026-07-20

### Fixed

- Multi-term code diagnostics now rank matches across normalized file paths and nearby source context, preventing a useful implementation match from being discarded because every requested term was not on one line.
- Added a bounded read-only Git history diagnostic and expanded recent deployment history so the agent can confirm exactly when an observed behavior was introduced instead of inferring solely from current code.

## 1.5.1 - 2026-07-20

### Fixed

- The read-only source-search diagnostic now uses a bounded built-in repository walker instead of depending on `rg` being installed on the production host.
- Deployment diagnostics now include commit timestamps so the agent can correlate a scheduled run with the version that was actually available at that time.

## 1.5.0 - 2026-07-20

### Changed

- Replaced snapshot-only answers for complex operations questions with a multi-round autonomous read-only investigation loop.
- Failure and root-cause questions can now adaptively inspect allowlisted systemd state and journals, SQLite health and queues, server resources, deployment state, configuration presence, fixed-host connectivity, unit definitions, and bounded source searches before answering.
- Short follow-up questions such as `왜 실패했지?` reuse the previous in-memory manager exchange or the replied-to bot message as investigation context.

### Security

- Diagnostic actions are selected through a strict schema and mapped to fixed `execFile` argument lists; the model cannot supply commands, SQL, arbitrary units, or filesystem paths.
- Investigations are capped at three adaptive rounds and eight tool calls, duplicate calls are skipped, and diagnostic output is length-bounded and secret-redacted before model use.

## 1.4.0 - 2026-07-20

### Added

- Added a read-only Life Daemon operations assistant to the existing Telegram bot through `/daemon`, `/ask`, and natural Korean questions.
- The assistant can explain private job priorities, current recommendations, collection attempt/success times, next systemd timer runs, housing applications/results, reminders, Calendar health, and service state from a bounded snapshot.
- Common priority, collection, and health questions use deterministic formatters; other questions use a tool-free structured Codex request with the existing authenticated-login and API fallback policy.

### Security

- Natural-language questions cannot execute shell commands or mutate databases. systemd access is limited in code to a fixed read-only unit allowlist, and secrets and raw environment data are excluded from the model snapshot.

## 1.3.0 - 2026-07-20

### Added

- Due housing applications are checked hourly for official result announcements, with one-time Telegram buttons for recording the user's private outcome.
- Application outcomes, cutoff score, supply count, reached priority, and private recommendation feedback are retained in the housing database and shown in `/housing_status`.
- A private admin command records historical housing outcomes without committing personal data.

### Changed

- Housing recommendations now use past outcome feedback to prioritize larger supply and official evidence that allocation reached second or third priority, while keeping eligibility decisions independent.
- SH result matching now requires enough distinctive announcement keywords to avoid associating an unrelated result notice.

## 1.2.5 - 2026-07-20

### Added

- Housing and job digests now report new, changed, deactivated, and failed collection counts together with the last successful collection time.
- Production service failures now send a rate-limited Telegram alert containing redacted status and recent log context.

### Changed

- Weekday housing and job timers now catch up after server downtime instead of silently missing the scheduled run.
- Runtime documentation now reflects Codex CLI authentication, current commands, operational telemetry, and failure handling.

### Removed

- Removed the unused legacy `src/state.mjs` database module.

## 1.2.4 - 2026-07-19

### Added

- Added an interactive Wanted authorization command and automatic storage-state refresh after successful collection.
- Expired Wanted sessions now produce an explicit reauthorization error for the Telegram digest.

## 1.2.3 - 2026-07-19

### Changed

- Restored signed-in JobPlanet company verification in the daily job pipeline using the configured account and private Playwright storage state.

## 1.2.2 - 2026-07-18

### Fixed

- Job discovery now uses query-specific Wanted and public JobKorea search pages instead of opening unrelated generic listings; Wanted remains gated behind an authorized user session.
- JobKorea tracking parameters are removed before deduplication.
- Automated JobPlanet login and scraping is removed from the daily pipeline; only manually supplied or separately licensed verification data is accepted.
- Pull requests and main-branch pushes now run the full Node test and syntax-check suite in GitHub Actions.

## 1.2.1 - 2026-07-18

### Fixed

- Production services now consistently disable Node's network-family autoselection, preserving the deployed connectivity workaround across Git pulls and systemd reinstalls.

## 1.2.0 - 2026-07-16

### Added

- Optional bidirectional synchronization between approved reminders and a dedicated Google Calendar.
- A one-time OAuth and installation flow that creates the private calendar and safely updates the mode-600 service environment without removing existing secrets.
- Natural-language Korean reminder parsing with explicit clarification for missing dates or times.
- Telegram `/calendar` status reporting and a one-off `calendar:sync` command.

### Fixed

- Malformed reminder-model JSON now fails only the current Telegram request instead of crashing the bot process.
- Calendar outages no longer delay due Telegram reminders, and concurrent reminder edits remain pending until Google has the same state.
- Natural-language parsing uses a bounded, tool-free Structured Outputs request instead of a filesystem-capable agent process.
- Calendar authorization now uses the least-privilege app-created-calendar scope and can be installed without exposing unrelated service secrets.

## 1.1.3 - 2026-07-16

### Fixed

- Malformed Codex JSON now fails only the current review instead of crashing the entire review worker.

## 1.1.2 - 2026-07-16

### Changed

- Single-user assessment output now keeps relevant exact profile values instead of replacing them with privacy placeholders.

## 1.1.1 - 2026-07-16

### Changed

- Telegram now displays incomplete recommendation totals with an explicit `(추정)` label instead of hiding them.

## 1.1.0 - 2026-07-16

### Added

- Eligibility-gated housing recommendation scoring with separate value, selection, and execution components.
- Profile fingerprints that automatically invalidate and requeue reviews after private user data changes.
- Review-policy versions and expiring worker claims so stale decisions are hidden and interrupted work is retried.
- Full-range PDF evidence sampling, conservative official-title matching, and an OCR fallback for image PDFs.
- Regression tests for scoring, profile changes, privacy redaction, attachment selection, and ambiguous search results.

### Changed

- Telegram digests hide numeric scores until eligibility and official evidence are complete.
- The daily job enforces a hard 45-minute AI-worker deadline so collection failures or OCR stalls cannot suppress the digest.
- MyHome pagination must return the advertised row count consistently before collection is marked complete.
- Missing official documents and missing user facts are reported separately.
- Stored AI review output removes exact private profile values.
