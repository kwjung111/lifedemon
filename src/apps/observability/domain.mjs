export const ObservationKind = Object.freeze({
  FACT: "fact",
  EVENT: "event",
  PREFERENCE: "preference",
  COMMITMENT: "commitment",
  ROUTINE: "routine",
  INFERENCE: "inference",
});

export const ObservationStatus = Object.freeze({
  CANDIDATE: "candidate",
  CONFIRMED: "confirmed",
  REJECTED: "rejected",
  SUPERSEDED: "superseded",
});

export const ClarificationStatus = Object.freeze({
  PENDING: "pending",
  ANSWERED: "answered",
  DISMISSED: "dismissed",
  EXPIRED: "expired",
});

export const SensitivityLevel = Object.freeze({
  STANDARD: "standard",
  PERSONAL: "personal",
  SENSITIVE: "sensitive",
  RESTRICTED: "restricted",
});

/**
 * @typedef {object} LifeSignal
 * @property {string} id
 * @property {string} source
 * @property {string} capturedAt ISO-8601 timestamp
 * @property {unknown} payload Raw source data; never treated as a confirmed fact
 * @property {Record<string, unknown>} [metadata]
 */

/**
 * @typedef {object} ObservationCandidate
 * @property {string} id
 * @property {string} subjectId
 * @property {string} kind One of ObservationKind
 * @property {string} category Domain such as career, housing, finance, or routine
 * @property {string} statement Human-readable normalized claim
 * @property {unknown} value Structured value when available
 * @property {number} confidence Value from 0 to 1
 * @property {string} sensitivity One of SensitivityLevel
 * @property {string} status One of ObservationStatus
 * @property {{source: string, signalIds: string[], capturedAt: string}} provenance
 * @property {string} [validFrom]
 * @property {string} [validUntil]
 */

/**
 * @typedef {object} ClarificationRequest
 * @property {string} id
 * @property {string} candidateId
 * @property {string} question
 * @property {string} reason Why the observation cannot be accepted automatically
 * @property {Array<{id: string, label: string, value: unknown}>} [choices]
 * @property {string} status One of ClarificationStatus
 * @property {string} createdAt
 * @property {string} [expiresAt]
 */
