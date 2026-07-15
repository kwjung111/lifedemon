# Life Observability

Life Observability is the data-collection layer for Life Daemon. It is not a diary or a manual logging application. Its job is to gather signals about the user, turn them into traceable observation candidates, and ask the user when an interpretation is ambiguous.

This directory currently contains architecture contracts only. The module is disabled and is not registered with the Telegram bot.

## Intended flow

```text
consented source
  -> raw life signal
  -> AI interpretation
  -> observation candidate
  -> policy and confidence check
     -> accept as confirmed observation
     -> ask the user for clarification
     -> reject or quarantine
  -> versioned personal data store
```

## Core concepts

- **Life signal:** Raw data captured from an explicitly enabled source. It is evidence, not yet a fact.
- **Observation candidate:** A normalized claim about the user with confidence, sensitivity, time range, and provenance.
- **Clarification:** A focused question generated when the AI cannot safely choose one interpretation.
- **Confirmed observation:** A candidate accepted by policy or explicitly confirmed by the user.
- **Provenance:** The sources and transformations supporting an observation.

## Planned extension points

- `LifeSignalCollector`: obtains raw signals from one consented source.
- `ObservationInterpreter`: converts signals into structured candidates.
- `ObservabilityPolicy`: decides whether to accept, clarify, reject, or quarantine.
- `ObservationRepository`: stores versioned observations and corrections.
- `ClarificationGateway`: asks the user and receives an answer, initially through Telegram.

Future collectors may cover calendar events, applications, reminders, purchases, location summaries, routines, or user-provided messages. Each collector must be independently enabled and revocable.

## Non-goals for the skeleton

- No actual data collection
- No OpenAI or Codex calls
- No database tables or migrations
- No Telegram commands or background services
- No passive device monitoring
- No automatic activation

## Safety invariants

1. Collection requires an explicitly enabled source.
2. Raw signals are never silently promoted to confirmed facts.
3. Every observation retains provenance and confidence.
4. Ambiguous or sensitive interpretations can require user confirmation.
5. Corrections supersede prior observations instead of erasing history silently.
6. Collection, retention, export, and deletion policies must be configurable.
7. Secrets and raw private data must never enter logs or Git.
