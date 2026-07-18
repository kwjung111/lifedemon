# Changelog

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
