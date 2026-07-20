# Changelog

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
