# Telegram UX validation

Date: 2026-07-21

Three independent read-only reviews covered code integrity, realistic single-user conversations, and menu/document discoverability. The initial Life Inbox scored poorly for later management because lists had no reply targets, old events occupied the briefing, attachments could not be retrieved, and fourteen visible commands obscured the command-free workflow.

## Validated user journeys

| Journey | Expected interaction | Automated evidence |
| --- | --- | --- |
| First save | One user message and one conclusion-first confirmation | `test/inbox.test.mjs` |
| Correct, complete, or cancel now | Reply to the saved-item bubble once | `test/inbox.test.mjs` |
| Manage days later | `/inbox`, then one numbered reply to the list | `test/inbox.test.mjs` |
| More than eight items | Reply `더 보여줘`; receive the next page | `test/inbox.test.mjs` |
| Re-open a link or attachment | Click the list link or reply `N번 보여줘` | `test/inbox.test.mjs` |
| Inbox event versus timed reminder | Confirmation states that no timed reminder exists; reply `알림도 등록해` to propose one | module tests and manual review |
| Morning briefing | At most three non-stale Inbox actions; reply context retained without extra Inbox buttons | `test/morning-briefing.test.mjs` |
| Ambiguous target | No mutation; one short request for an item number | `test/inbox.test.mjs` |
| Impossible date | No JavaScript rollover; item is not saved | `test/inbox.test.mjs` |
| First-time discovery | Seven visible commands and one short `/help` message | `test/manual.test.mjs` |
| Free-form intent and target routing | One global AI call resolves navigation, Inbox, reminder, feedback, tracking, and manager intent; uncertainty makes no mutation | `test/message-interpreter.test.mjs`, `test/bot-runtime.test.mjs` |
| Missing recommendation explanation | Ask with a company/title; receive one evidence-backed reason, or one numbered clarification for ambiguity | `test/visibility.test.mjs` |

## Cognitive-load constraints

- Saving does not require a command, form, or preliminary question.
- The confirmation starts with the result, avoids repeating the title as the next action, and labels missing facts as `확인 안 된 점`.
- The primary menu contains seven choices. Advanced commands remain available under `/help 자세히`.
- Lists show eight items and three example replies, with no per-item buttons.
- The morning message remains the only scheduled weekday briefing.
- Reply context is included in the single global interpretation, so the user does not need domain-specific correction commands.
- Fixed commands stay immediate, while every free-form message uses one bounded global AI interpretation instead of expanding semantic phrase-regex lists or duplicate per-module calls.
- Visibility explanations add no menu or per-item button and never ask the user to understand internal filter states.

## Known limits

- Telegram photos and documents are referenced by Telegram file ID and can be re-sent, but their contents are not OCR'd or semantically analyzed yet.
- Every free-form message takes one bounded Codex interpretation call; fixed commands and button callbacks use none.
- Inbox events do not create weekend or exact-time notifications unless a reminder is separately approved.
- Permanent preference learning still requires the confidence/risk policy described in `docs/LIFE-INBOX-PLAN.md`.
