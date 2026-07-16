# Changelog

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
