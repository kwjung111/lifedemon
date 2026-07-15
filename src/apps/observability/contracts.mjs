function notImplemented(contract, method) {
  throw new Error(`${contract}.${method} is not implemented`);
}

export class LifeSignalCollector {
  async collect(_context) {
    return notImplemented("LifeSignalCollector", "collect");
  }
}

export class ObservationInterpreter {
  async interpret(_signals, _context) {
    return notImplemented("ObservationInterpreter", "interpret");
  }
}

export class ObservabilityPolicy {
  async evaluate(_candidate, _context) {
    return notImplemented("ObservabilityPolicy", "evaluate");
  }
}

export class ObservationRepository {
  async saveCandidate(_candidate) {
    return notImplemented("ObservationRepository", "saveCandidate");
  }

  async confirm(_candidateId, _confirmation) {
    return notImplemented("ObservationRepository", "confirm");
  }

  async reject(_candidateId, _reason) {
    return notImplemented("ObservationRepository", "reject");
  }
}

export class ClarificationGateway {
  async request(_clarification) {
    return notImplemented("ClarificationGateway", "request");
  }

  async receiveAnswer(_clarificationId, _answer) {
    return notImplemented("ClarificationGateway", "receiveAnswer");
  }
}
