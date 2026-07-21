# Life Inbox: remaining cognitive-load controls

Principles 1, 2, 4, 5, 7, and 9 are implemented in version 1.13.0. The remaining work should be added in the order 8 → 3 → 6 because confidence must inform risk, and both must inform interruption priority.

## 8. Confidence and evidence policy

Add a shared `decision-envelope` value with `confidence`, `evidence[]`, `missingFacts[]`, `reversible`, and `sourceUpdatedAt`. AI output may summarize evidence but may not create evidence. Use three handling bands:

- 0.85–1.00: perform only reversible local actions and show the evidence source when the fact matters.
- 0.60–0.84: save with visible assumptions; do not schedule, send, purchase, delete, or mutate an external system.
- Below 0.60 or a missing critical fact: hold the action and ask one question only when the answer changes the next action.

Dates, money, eligibility, identity, recipients, and external URLs are always critical facts. Acceptance tests must cover invented dates/URLs, stale evidence, conflicting sources, and low-confidence no-op behavior. Store decisions for calibration, then compare predicted bands with later corrections before tuning thresholds.

## 3. Risk-based confirmation policy

Introduce one central policy module instead of per-app confirmation branches:

| Risk | Examples | Confirmation |
| --- | --- | --- |
| Low | save note/link, local tag, reversible correction | none |
| Medium | create or move reminder/calendar event, change a recurring filter | one compact confirmation showing the assumption/diff |
| High | send to another person, application submission, purchase/payment, credential or destructive change | explicit confirmation every time; never inferred from silence |

The policy receives the confidence envelope, action type, reversibility, external side effect, and cost. It returns `execute`, `propose`, or `block`. Proposed actions expire and are idempotent. Tests must prove that paraphrasing cannot bypass confirmation and a replay cannot execute twice.

## 6. Attention budget

Keep one scheduled weekday briefing. Add an `attention_deliveries` ledger with an event fingerprint, severity, first/last delivery time, and acknowledgement state. Rank candidates by `time pressure × consequence × required user action × confidence`.

- Ordinary information waits for the 09:00 briefing.
- An interrupt is allowed only for a deadline within 24 hours, a material state change, or a user-approved reminder time.
- The same fingerprint cannot interrupt twice unless the deadline or consequence changed.
- The briefing shows the top three next actions, collapses unchanged domains, and leaves the rest behind one natural “더 보여줘” request.
- If no action or material change exists, send one explicit “변경 없음” line, not repeated detail.

Acceptance tests should simulate duplicate crawls, changed deadlines, weekend accumulation, acknowledged items, and a day with more than 100 candidates while keeping user-facing output bounded.

## Token and maintenance guardrails

- Fixed slash commands and callback protocols remain deterministic and use zero model tokens.
- Every free-form message uses exactly one global structured interpretation; no module-level interpretation or semantic-regex fallback is allowed in the same route.
- Prompts receive at most 3,000 characters of user text, bounded public reply labels, and public attachment metadata, never attachment bodies or credentials.
- Provider token totals are not estimated as exact values when the CLI does not expose them.
- New risk, confidence, and attention logic must remain shared policy modules. Domain apps provide facts and execute authorized actions; they do not copy policy branches.
